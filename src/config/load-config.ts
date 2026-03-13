import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ActorToolName,
  type CodingAgentProvider,
} from "../domain/task.js";
import {
  resolveBinaryCommand,
  type BinaryResolver,
} from "../runtime/command-resolution.js";

export interface CommandSpec {
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
}

export interface LumoConfig {
  runtime: {
    provider: "pi-mono";
    bootstrap: {
      enabled: boolean;
      commands: string[];
      retryBackoffMs: number;
    };
  };
  actor: {
    model: string;
    systemPrompt: string;
    tools: ActorToolName[];
    browserRunner: CommandSpec;
    codingAgent: {
      provider: CodingAgentProvider;
      commands: Record<CodingAgentProvider, CommandSpec>;
    };
  };
  supervisor: {
    model: string;
    systemPrompt: string;
    client: "mock" | "heuristic" | "openai-compatible";
    openaiCompatible: {
      enabled: boolean;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      timeoutMs: number;
    };
  };
  batch: {
    maxSteps: number;
    maxAgeMs: number;
    immediateKeywords: string[];
  };
  alerts: {
    enableTerminalBell: boolean;
    enableDesktop: boolean;
    webhookUrl?: string;
    channels: {
      terminal: {
        enabled: boolean;
      };
      discord: {
        enabled: boolean;
        webhookUrl?: string;
      };
      telegram: {
        enabled: boolean;
      };
      voiceCall: {
        enabled: boolean;
        recipient?: string;
        providerCommandTemplate: string[];
      };
    };
  };
  channels: {
    commandMapping: {
      new: string[];
      followup: string[];
      resume: string[];
      halt: string[];
      status: string[];
    };
    intentRouting: {
      modelResolver: "mock";
      startTaskConfidenceThreshold: number;
    };
    adapters: {
      discord: {
        enabled: boolean;
        webhookUrl?: string;
        inbound: {
          mode: "file" | "gateway";
          filePath?: string;
          tokenEnvVar: string;
          allowedChannels: string[];
          allowedUsers: string[];
          mentionPrefix?: string;
        };
      };
      telegram: {
        enabled: boolean;
        botToken?: string;
        chatId?: string;
        inbound: {
          pollIntervalMs: number;
          timeoutSeconds: number;
          allowedChatIds: string[];
          allowedUserIds: string[];
          mentionPrefix?: string;
        };
      };
    };
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer TValue>
    ? TValue[]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K];
};

const defaultCommandScript = [
  "const provider = process.argv[1];",
  "const prompt = process.argv.slice(2).join(' ');",
  "console.log(JSON.stringify({ provider, prompt, mocked: true }));",
].join(" ");

const defaultBrowserScript = [
  "const command = process.argv.slice(1).join(' ');",
  "console.log(JSON.stringify({ browserCommand: command, mocked: true, fallback: 'agent-browser binary not detected' }));",
].join(" ");

export interface CreateDefaultConfigOptions {
  env?: Record<string, string | undefined>;
  resolveBinary?: BinaryResolver;
  cwd?: string;
}

const defaultPiToolchainStartupCommands = [
  "pi --version",
  "pi doctor",
];

export function createDefaultConfig(
  options: CreateDefaultConfigOptions = {},
): LumoConfig {
  const env = options.env ?? process.env;
  const resolveBinary = options.resolveBinary ?? resolveBinaryCommand;
  const cwd = options.cwd ?? process.cwd();

  const defaultAgentCommand = (provider: CodingAgentProvider): CommandSpec => {
    const resolved = resolveBinary([provider], { env });
    if (resolved) {
      return {
        command: resolved.path,
        args: provider === "codex"
          ? ["exec", "--skip-git-repo-check"]
          : provider === "claude"
            ? ["-p"]
            : ["run"],
        metadata: {
          mode: "binary",
          candidate: resolved.candidate,
          resolvedPath: resolved.path,
          provider,
        },
      };
    }

    return {
      command: process.execPath,
      args: ["-e", defaultCommandScript, provider],
      metadata: {
        mode: "mock",
        provider,
        fallback: `${provider} binary not detected`,
      },
    };
  };

  const resolvedBrowserRunner = resolveBinary(["agent-browser"], { env });

  return {
    runtime: {
      provider: parseRuntimeProvider(env.LUMO_RUNTIME_PROVIDER),
      bootstrap: {
        enabled: parseBoolean(env.LUMO_RUNTIME_AUTO_BOOTSTRAP, true),
        commands: parseBootstrapCommands(
          env.LUMO_RUNTIME_BOOTSTRAP_COMMANDS,
          detectDefaultPiToolchainStartupCommands(cwd, env, resolveBinary),
        ),
        retryBackoffMs: parsePositiveInteger(
          env.LUMO_RUNTIME_BOOTSTRAP_RETRY_BACKOFF_MS,
          250,
        ),
      },
    },
    actor: {
      model: "local-actor",
      systemPrompt: "Execute local task instructions and report tool results.",
      tools: ["bash", "agent-browser", "coding-agent"],
      browserRunner: resolvedBrowserRunner
        ? {
          command: resolvedBrowserRunner.path,
          args: [],
          metadata: {
            mode: "binary",
            candidate: resolvedBrowserRunner.candidate,
            resolvedPath: resolvedBrowserRunner.path,
          },
        }
        : {
          command: process.execPath,
          args: ["-e", defaultBrowserScript],
          metadata: {
            mode: "mock",
            fallback: "agent-browser binary not detected",
          },
        },
      codingAgent: {
        provider: "codex",
        commands: {
          codex: defaultAgentCommand("codex"),
          claude: defaultAgentCommand("claude"),
          opencode: defaultAgentCommand("opencode"),
        },
      },
    },
    supervisor: {
      model: "mock-supervisor",
      systemPrompt: "Watch tool logs and stop unsafe or stuck behavior.",
      client: "mock",
      openaiCompatible: {
        enabled: false,
        baseUrl: env.LUMO_SUPERVISOR_OPENAI_BASE_URL,
        apiKey: env.LUMO_SUPERVISOR_OPENAI_API_KEY,
        model: env.LUMO_SUPERVISOR_OPENAI_MODEL,
        timeoutMs: parsePositiveInteger(env.LUMO_SUPERVISOR_OPENAI_TIMEOUT_MS, 15_000),
      },
    },
    batch: {
      maxSteps: 3,
      maxAgeMs: 30_000,
      immediateKeywords: ["sudo", "rm -rf", "DROP TABLE", "shutdown"],
    },
    alerts: {
      enableTerminalBell: false,
      enableDesktop: false,
      webhookUrl: env.LUMO_ALERTS_DISCORD_WEBHOOK_URL,
      channels: {
        terminal: {
          enabled: false,
        },
        discord: {
          enabled: false,
          webhookUrl: env.LUMO_ALERTS_DISCORD_WEBHOOK_URL,
        },
        telegram: {
          enabled: false,
        },
        voiceCall: {
          enabled: false,
          recipient: env.LUMO_ALERTS_VOICE_CALL_RECIPIENT,
          providerCommandTemplate: parseStringList(env.LUMO_ALERTS_VOICE_CALL_COMMAND_TEMPLATE),
        },
      },
    },
    channels: {
      commandMapping: {
        new: ["new"],
        followup: ["followup"],
        resume: ["resume"],
        halt: ["halt"],
        status: ["status"],
      },
      intentRouting: {
        modelResolver: "mock",
        startTaskConfidenceThreshold: 0.7,
      },
      adapters: {
        discord: {
          enabled: false,
          webhookUrl: env.LUMO_CHANNELS_DISCORD_WEBHOOK_URL ?? env.LUMO_ALERTS_DISCORD_WEBHOOK_URL,
          inbound: {
            mode: parseDiscordInboundMode(env.LUMO_CHANNELS_DISCORD_INBOUND_MODE),
            filePath: env.LUMO_CHANNELS_DISCORD_INBOUND_FILE ?? "./.lumo/discord-inbound.jsonl",
            tokenEnvVar: env.LUMO_CHANNELS_DISCORD_BOT_TOKEN_ENV_VAR ?? "LUMO_CHANNELS_DISCORD_BOT_TOKEN",
            allowedChannels: parseStringList(env.LUMO_CHANNELS_DISCORD_ALLOWED_CHANNELS),
            allowedUsers: parseStringList(env.LUMO_CHANNELS_DISCORD_ALLOWED_USERS),
            mentionPrefix: env.LUMO_CHANNELS_DISCORD_MENTION_PREFIX,
          },
        },
        telegram: {
          enabled: false,
          botToken: env.LUMO_CHANNELS_TELEGRAM_BOT_TOKEN,
          chatId: env.LUMO_CHANNELS_TELEGRAM_CHAT_ID,
          inbound: {
            pollIntervalMs: parsePositiveInteger(env.LUMO_CHANNELS_TELEGRAM_POLL_INTERVAL_MS, 1_000),
            timeoutSeconds: parsePositiveInteger(env.LUMO_CHANNELS_TELEGRAM_TIMEOUT_SECONDS, 30),
            allowedChatIds: parseStringList(env.LUMO_CHANNELS_TELEGRAM_ALLOWED_CHAT_IDS),
            allowedUserIds: parseStringList(env.LUMO_CHANNELS_TELEGRAM_ALLOWED_USER_IDS),
            mentionPrefix: env.LUMO_CHANNELS_TELEGRAM_MENTION_PREFIX,
          },
        },
      },
    },
  };
}

export async function loadConfig(configPath?: string): Promise<LumoConfig> {
  const defaults = createDefaultConfig();
  if (!configPath) {
    return validateConfig(defaults);
  }

  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    return validateConfig(defaults);
  }

  const raw = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as DeepPartial<LumoConfig>;
  return validateConfig(mergeConfig(defaults, parsed));
}

export function mergeConfig(
  defaults: LumoConfig,
  overrides: DeepPartial<LumoConfig>,
): LumoConfig {
  return {
    runtime: {
      ...defaults.runtime,
      ...overrides.runtime,
      bootstrap: {
        ...defaults.runtime.bootstrap,
        ...overrides.runtime?.bootstrap,
        commands:
          overrides.runtime?.bootstrap?.commands ?? defaults.runtime.bootstrap.commands,
      },
    },
    actor: {
      ...defaults.actor,
      ...overrides.actor,
      tools: overrides.actor?.tools ?? defaults.actor.tools,
      browserRunner: {
        ...defaults.actor.browserRunner,
        ...overrides.actor?.browserRunner,
        args: overrides.actor?.browserRunner?.args ?? defaults.actor.browserRunner.args,
        metadata:
          overrides.actor?.browserRunner?.metadata ?? defaults.actor.browserRunner.metadata,
      },
      codingAgent: {
        ...defaults.actor.codingAgent,
        ...overrides.actor?.codingAgent,
        commands: {
          ...defaults.actor.codingAgent.commands,
          ...overrides.actor?.codingAgent?.commands,
          codex: {
            ...defaults.actor.codingAgent.commands.codex,
            ...overrides.actor?.codingAgent?.commands?.codex,
            args:
              overrides.actor?.codingAgent?.commands?.codex?.args ??
              defaults.actor.codingAgent.commands.codex.args,
            metadata:
              overrides.actor?.codingAgent?.commands?.codex?.metadata ??
              defaults.actor.codingAgent.commands.codex.metadata,
          },
          claude: {
            ...defaults.actor.codingAgent.commands.claude,
            ...overrides.actor?.codingAgent?.commands?.claude,
            args:
              overrides.actor?.codingAgent?.commands?.claude?.args ??
              defaults.actor.codingAgent.commands.claude.args,
            metadata:
              overrides.actor?.codingAgent?.commands?.claude?.metadata ??
              defaults.actor.codingAgent.commands.claude.metadata,
          },
          opencode: {
            ...defaults.actor.codingAgent.commands.opencode,
            ...overrides.actor?.codingAgent?.commands?.opencode,
            args:
              overrides.actor?.codingAgent?.commands?.opencode?.args ??
              defaults.actor.codingAgent.commands.opencode.args,
            metadata:
              overrides.actor?.codingAgent?.commands?.opencode?.metadata ??
              defaults.actor.codingAgent.commands.opencode.metadata,
          },
        },
      },
    },
    supervisor: {
      ...defaults.supervisor,
      ...overrides.supervisor,
      openaiCompatible: {
        ...defaults.supervisor.openaiCompatible,
        ...overrides.supervisor?.openaiCompatible,
      },
    },
    batch: {
      ...defaults.batch,
      ...overrides.batch,
      immediateKeywords:
        overrides.batch?.immediateKeywords ?? defaults.batch.immediateKeywords,
    },
    alerts: {
      ...defaults.alerts,
      ...overrides.alerts,
      channels: {
        ...defaults.alerts.channels,
        ...overrides.alerts?.channels,
        terminal: {
          ...defaults.alerts.channels.terminal,
          ...overrides.alerts?.channels?.terminal,
        },
        discord: {
          ...defaults.alerts.channels.discord,
          ...overrides.alerts?.channels?.discord,
        },
        telegram: {
          ...defaults.alerts.channels.telegram,
          ...overrides.alerts?.channels?.telegram,
        },
        voiceCall: {
          ...defaults.alerts.channels.voiceCall,
          ...overrides.alerts?.channels?.voiceCall,
          providerCommandTemplate:
            overrides.alerts?.channels?.voiceCall?.providerCommandTemplate ??
            defaults.alerts.channels.voiceCall.providerCommandTemplate,
        },
      },
    },
    channels: {
      ...defaults.channels,
      ...overrides.channels,
      commandMapping: {
        ...defaults.channels.commandMapping,
        ...overrides.channels?.commandMapping,
        new:
          overrides.channels?.commandMapping?.new ??
          defaults.channels.commandMapping.new,
        followup:
          overrides.channels?.commandMapping?.followup ??
          defaults.channels.commandMapping.followup,
        resume:
          overrides.channels?.commandMapping?.resume ??
          defaults.channels.commandMapping.resume,
        halt:
          overrides.channels?.commandMapping?.halt ??
          defaults.channels.commandMapping.halt,
        status:
          overrides.channels?.commandMapping?.status ??
          defaults.channels.commandMapping.status,
      },
      intentRouting: {
        ...defaults.channels.intentRouting,
        ...overrides.channels?.intentRouting,
      },
      adapters: {
        ...defaults.channels.adapters,
        ...overrides.channels?.adapters,
        discord: {
          ...defaults.channels.adapters.discord,
          ...overrides.channels?.adapters?.discord,
          inbound: {
            ...defaults.channels.adapters.discord.inbound,
            ...overrides.channels?.adapters?.discord?.inbound,
            allowedChannels:
              overrides.channels?.adapters?.discord?.inbound?.allowedChannels ??
              defaults.channels.adapters.discord.inbound.allowedChannels,
            allowedUsers:
              overrides.channels?.adapters?.discord?.inbound?.allowedUsers ??
              defaults.channels.adapters.discord.inbound.allowedUsers,
          },
        },
        telegram: {
          ...defaults.channels.adapters.telegram,
          ...overrides.channels?.adapters?.telegram,
          inbound: {
            ...defaults.channels.adapters.telegram.inbound,
            ...overrides.channels?.adapters?.telegram?.inbound,
            allowedChatIds:
              overrides.channels?.adapters?.telegram?.inbound?.allowedChatIds ??
              defaults.channels.adapters.telegram.inbound.allowedChatIds,
            allowedUserIds:
              overrides.channels?.adapters?.telegram?.inbound?.allowedUserIds ??
              defaults.channels.adapters.telegram.inbound.allowedUserIds,
          },
        },
      },
    },
  };
}

function validateConfig(config: LumoConfig): LumoConfig {
  if (config.runtime.provider !== "pi-mono") {
    throw new Error(
      `Unsupported runtime.provider "${String(config.runtime.provider)}" in config. Lumo now requires "pi-mono".`,
    );
  }

  return config;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseRuntimeProvider(value: string | undefined): "pi-mono" {
  if (!value || value === "pi-mono") {
    return "pi-mono";
  }

  throw new Error(
    `Unsupported LUMO_RUNTIME_PROVIDER value "${value}". Lumo now requires runtime.provider to be "pi-mono".`,
  );
}

function parseDiscordInboundMode(value: string | undefined): "file" | "gateway" {
  return value === "gateway" ? "gateway" : "file";
}

function parseStringList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBootstrapCommands(
  value: string | undefined,
  fallback: string[],
): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(";;")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function detectDefaultPiToolchainStartupCommands(
  cwd: string,
  env: Record<string, string | undefined>,
  resolveBinary: BinaryResolver,
): string[] {
  const scopedPackages = [
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-tui",
  ];
  const hasInstalledPiToolchainPackage = scopedPackages.some((packageName) => {
    const packageRoot = resolve(cwd, "node_modules", packageName);
    return existsSync(resolve(packageRoot, "package.json"));
  });

  if (hasInstalledPiToolchainPackage || resolveBinary(["pi"], { env })) {
    return [...defaultPiToolchainStartupCommands];
  }

  return [];
}
