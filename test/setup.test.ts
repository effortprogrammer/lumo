import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildSetupConfig,
  formatSetupSummary,
  moveSelectionIndex,
  parseSetupCliArgs,
  resolveSetupAnswers,
  runSetupCli,
  shouldRunDiscordGatewayHealthcheck,
  type SetupCliOptions,
  type SetupPrompter,
  writeSetupConfig,
} from "../src/setup/wizard.js";

describe("setup wizard", () => {
  it("generates config JSON from non-interactive flags", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-"));
    const configPath = join(tempDir, "lumo.config.json");
    const homeDir = join(tempDir, "home");

    try {
      const exitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        configPath,
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-webhook-url",
        " https://discord.example/webhook ",
        "--discord-token-env-var",
        " BOT_TOKEN ",
        "--discord-allowed-channels",
        " guild:1/channel:2 , thread:3 ",
        "--discord-allowed-users",
        " user-1 , user-2 ",
        "--discord-mention-prefix",
        " @lumo ",
        "--terminal-alerts",
        "true",
        "--model-provider",
        "openrouter",
        "--model-api-key",
        " sk-or-v1-12345678 ",
        "--supervisor-provider",
        "openai-compatible",
        "--supervisor-base-url",
        " https://api.openai.com/v1 ",
        "--supervisor-api-key",
        " OPENAI_API_KEY ",
        "--supervisor-model",
        " gpt-4o-mini ",
      ], {
        env: {
          HOME: homeDir,
        },
        output: createWriter(),
        error: createWriter(),
      });

      assert.equal(exitCode, 0);

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      assert.deepEqual(parsed, {
        agentika: {
          enabled: false,
          eventBus: false,
        },
        alerts: {
          enableTerminalBell: true,
          channels: {
            terminal: {
              enabled: true,
            },
            discord: {
              enabled: true,
              webhookUrl: "https://discord.example/webhook",
            },
          },
          webhookUrl: "https://discord.example/webhook",
        },
        channels: {
          adapters: {
            discord: {
              enabled: true,
              webhookUrl: "https://discord.example/webhook",
              inbound: {
                mode: "gateway",
                filePath: "./.lumo/discord-inbound.jsonl",
                tokenEnvVar: "BOT_TOKEN",
                allowedChannels: ["guild:1/channel:2", "thread:3"],
                allowedUsers: ["user-1", "user-2"],
                mentionPrefix: "@lumo",
              },
            },
          },
        },
        supervisor: {
          client: "openai-compatible",
          model: "gpt-4o-mini",
          openaiCompatible: {
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            apiKey: "OPENAI_API_KEY",
            model: "gpt-4o-mini",
          },
          anthropicCompatible: {
            enabled: false,
          },
        },
      });

      const authRaw = await readFile(join(homeDir, ".pi", "agent", "auth.json"), "utf8");
      assert.deepEqual(JSON.parse(authRaw), {
        openrouter: "sk-or-v1-12345678",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("guards overwrites unless force is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-overwrite-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(configPath, "{\n  \"existing\": true\n}\n");

      await assert.rejects(
        () =>
          writeSetupConfig(
            configPath,
            buildSetupConfig(
              resolveSetupAnswers(createOptions({
                force: false,
                help: false,
                nonInteractive: true,
                configPath,
                discordEnabled: "false",
                discordInboundMode: "file",
              })),
            ),
            {
              force: false,
            },
          ),
        /already exists/i,
      );

      const overwritten = await writeSetupConfig(
        configPath,
        buildSetupConfig(
          resolveSetupAnswers(createOptions({
            force: true,
            help: false,
            nonInteractive: true,
            configPath,
            discordEnabled: "false",
            discordInboundMode: "file",
            enableTerminalAlerts: "false",
          })),
        ),
        {
          force: true,
        },
      );

      assert.equal(overwritten.overwritten, true);
      const raw = await readFile(configPath, "utf8");
      assert.match(raw, /"enableTerminalBell": false/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses setup inputs and validates gateway requirements", () => {
    const options = parseSetupCliArgs([
      "--non-interactive",
      "--config",
      " ./custom.json ",
      "--discord-enabled",
      "yes",
      "--discord-inbound-mode",
      "gateway",
      "--discord-token-env-var",
      " DISCORD_TOKEN ",
      "--discord-allowed-channels",
      " guild:1/channel:2 , thread:3 ",
      "--discord-allowed-users",
      " user-1 , user-2 ",
      "--discord-mention-prefix",
      " @lumo ",
      "--terminal-alerts",
      "no",
    ]);

    const answers = resolveSetupAnswers(options);
    assert.equal(answers.configPath, "./custom.json");
    assert.deepEqual(answers.allowedChannels, ["guild:1/channel:2", "thread:3"]);
    assert.deepEqual(answers.allowedUsers, ["user-1", "user-2"]);
    assert.equal(answers.mentionPrefix, "@lumo");
    assert.equal(answers.enableTerminalAlerts, false);

    assert.throws(
      () =>
        resolveSetupAnswers(createOptions({
          force: false,
          help: false,
          nonInteractive: true,
          configPath: "./lumo.config.json",
          discordEnabled: "true",
          discordInboundMode: "gateway",
          tokenEnvVar: "   ",
          allowedChannels: "   ",
          enableTerminalAlerts: "false",
        })),
      /required when gateway mode is selected/i,
    );
  });

  it("defaults Discord gateway healthcheck on for interactive setup and off for non-interactive", () => {
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: false,
      }),
      true,
    );
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: true,
      }),
      false,
    );
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: true,
        discordGatewayHealthcheck: "true",
      }),
      true,
    );
  });

  it("keeps selection helpers deterministic and summary output stable", () => {
    assert.equal(moveSelectionIndex(0, "up", 2), 1);
    assert.equal(moveSelectionIndex(1, "down", 2), 0);
    assert.equal(moveSelectionIndex(0, "down", 3), 1);

    const summary = formatSetupSummary({
      configPath: "./lumo.config.json",
      discordEnabled: false,
      discordInboundMode: "file",
      tokenEnvVar: "DISCORD_TOKEN",
      allowedChannels: [],
      allowedUsers: [],
      enableTerminalAlerts: false,
      modelProvider: "anthropic",
      modelApiKey: "sk-ant-1234",
      supervisor: {
        provider: "anthropic-compatible",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-20250514",
      },
      agentikaEnabled: true,
      agentikaUrl: "http://127.0.0.1:7200",
      agentikaToken: "dev",
      agentikaBinaryPath: "/tmp/agentika",
    });

    assert.match(summary, /^Setup summary/m);
    assert.match(summary, /Discord enabled: No/);
    assert.match(summary, /Allowed Discord channels: \(none\)/);
    assert.match(summary, /Model provider: Anthropic \(API key configured: .*1234\)/);
    assert.match(summary, /Supervisor: anthropic-compatible \(claude-sonnet-4-20250514\)/);
    assert.match(summary, /Agentika: http:\/\/127\.0\.0\.1:7200 \(event bus enabled, binary: \/tmp\/agentika\)/);
  });

  it("shows a summary and stops before writing when final confirmation is declined", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-confirm-"));
    const configPath = join(tempDir, "lumo.config.json");
    const writer = createBufferingWriter();

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        output: writer,
        error: writer,
        createPrompter: () =>
          createScriptedPrompter({
            asks: [],
            selects: [0, 5, 1],
          }),
      });

      assert.equal(exitCode, 1);
      assert.match(writer.buffer, /Welcome to Lumo setup\./);
      assert.match(writer.buffer, /Quickstart defaults/);
      assert.match(writer.buffer, /Setup cancelled before writing config\./);
      await assert.rejects(() => readFile(configPath, "utf8"), /ENOENT|no such file/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves previous interactive defaults while adding selection prompts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-defaults-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        output: createWriter(),
        error: createWriter(),
        createPrompter: () =>
          createScriptedPrompter({
            asks: [],
            selects: [0, 5, 0],
          }),
      });

      assert.equal(exitCode, 0);

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        channels: { adapters: { discord: { enabled: boolean } } };
        alerts: { channels: { terminal: { enabled: boolean } } };
      };

      assert.equal(parsed.channels.adapters.discord.enabled, false);
      assert.equal(parsed.alerts.channels.terminal.enabled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports interactive setup with focused Lumo integration prompts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-quickstart-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        output: createWriter(),
        error: createWriter(),
        createPrompter: () =>
          createScriptedPrompter({
            asks: [],
            selects: [0, 5, 0],
          }),
      });

      assert.equal(exitCode, 0);

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        channels: { adapters: { discord: { enabled: boolean } } };
      };

      assert.equal(parsed.channels.adapters.discord.enabled, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shows quickstart defaults before writing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-quickstart-preview-"));
    const configPath = join(tempDir, "lumo.config.json");
    const writer = createBufferingWriter();

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        output: writer,
        error: writer,
        createPrompter: () =>
          createScriptedPrompter({
            asks: [],
            selects: [0, 5, 0],
          }),
      });

      assert.equal(exitCode, 0);
      assert.match(writer.buffer, /Quickstart defaults/);
      assert.match(writer.buffer, /Discord integration: disabled/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports Discord gateway healthcheck pass and fail without failing setup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-healthcheck-"));
    const passPath = join(tempDir, "pass.config.json");
    const failPath = join(tempDir, "fail.config.json");

    try {
      const passWriter = createBufferingWriter();
      const passExitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        passPath,
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-token-env-var",
        "BOT_TOKEN",
        "--discord-allowed-channels",
        "channel:1",
        "--discord-gateway-healthcheck",
        "true",
        "--terminal-alerts",
        "false",
      ], {
        env: {
          BOT_TOKEN: "secret",
        },
        output: passWriter,
        error: passWriter,
        discordGatewayHealthcheck: async (tokenEnvVar, token) => ({
          ok: true,
          detail: `${tokenEnvVar}:${token.length}`,
        }),
      });

      const failWriter = createBufferingWriter();
      const failExitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        failPath,
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-token-env-var",
        "BOT_TOKEN",
        "--discord-allowed-channels",
        "channel:1",
        "--discord-gateway-healthcheck",
        "true",
        "--terminal-alerts",
        "false",
      ], {
        env: {
          BOT_TOKEN: "secret",
        },
        output: failWriter,
        error: failWriter,
        discordGatewayHealthcheck: async () => ({
          ok: false,
          detail: "HTTP 401 invalid token",
        }),
      });

      assert.equal(passExitCode, 0);
      assert.equal(failExitCode, 0);
      assert.match(passWriter.buffer, /PASS: BOT_TOKEN:6/);
      assert.match(failWriter.buffer, /FAIL: HTTP 401 invalid token/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports quickstart with provider selection and writes pi auth.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-provider-"));
    const configPath = join(tempDir, "lumo.config.json");
    const homeDir = join(tempDir, "home");
    const writer = createBufferingWriter();

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        env: {
          HOME: homeDir,
        },
        output: writer,
        error: writer,
        createPrompter: () =>
          createScriptedPrompter({
            asks: ["sk-ant-quick-1234"],
            selects: [0, 0, 0],
          }),
      });

      assert.equal(exitCode, 0);
      assert.match(writer.buffer, /Model provider: Anthropic \(API key configured: .*1234\)/);

      const authRaw = await readFile(join(homeDir, ".pi", "agent", "auth.json"), "utf8");
      assert.deepEqual(JSON.parse(authRaw), {
        anthropic: "sk-ant-quick-1234",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports custom setup with supervisor configuration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-supervisor-"));
    const configPath = join(tempDir, "lumo.config.json");
    const homeDir = join(tempDir, "home");

    try {
      const exitCode = await runSetupCli(["--config", configPath], {
        env: {
          HOME: homeDir,
        },
        output: createWriter(),
        error: createWriter(),
        createPrompter: () =>
          createScriptedPrompter({
            asks: ["", "", "", "", "", "", ""],
            selects: [1, 1, 1, 5, 0, 1, 0, 0],
          }),
      });

      assert.equal(exitCode, 0);

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(parsed, {
        agentika: {
          enabled: true,
          eventBus: true,
          baseUrl: "http://127.0.0.1:7200",
          token: "dev",
        },
        alerts: {
          enableTerminalBell: false,
          channels: {
            terminal: {
              enabled: false,
            },
            discord: {
              enabled: false,
            },
          },
        },
        channels: {
          adapters: {
            discord: {
              enabled: false,
              inbound: {
                mode: "file",
                filePath: "./.lumo/discord-inbound.jsonl",
                tokenEnvVar: "LUMO_CHANNELS_DISCORD_BOT_TOKEN",
                allowedChannels: [],
                allowedUsers: [],
              },
            },
          },
        },
        supervisor: {
          client: "openai-compatible",
          model: "gpt-4o",
          openaiCompatible: {
            enabled: true,
            baseUrl: "https://api.openai.com/v1",
            apiKey: "OPENAI_API_KEY",
            model: "gpt-4o",
          },
          anthropicCompatible: {
            enabled: false,
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges auth.json without overwriting other providers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-auth-merge-"));
    const configPath = join(tempDir, "lumo.config.json");
    const homeDir = join(tempDir, "home");
    const authPath = join(homeDir, ".pi", "agent", "auth.json");

    try {
      await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
      await writeFile(authPath, `${JSON.stringify({ openai: "existing-openai" }, null, 2)}\n`);

      const exitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        configPath,
        "--discord-enabled",
        "false",
        "--discord-inbound-mode",
        "file",
        "--terminal-alerts",
        "false",
        "--model-provider",
        "anthropic",
        "--model-api-key",
        "sk-ant-merge-9999",
      ], {
        env: {
          HOME: homeDir,
        },
        output: createWriter(),
        error: createWriter(),
      });

      assert.equal(exitCode, 0);
      const authRaw = await readFile(authPath, "utf8");
      assert.deepEqual(JSON.parse(authRaw), {
        openai: "existing-openai",
        anthropic: "sk-ant-merge-9999",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves auth.json untouched when provider setup is skipped", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-auth-skip-"));
    const configPath = join(tempDir, "lumo.config.json");
    const homeDir = join(tempDir, "home");
    const authPath = join(homeDir, ".pi", "agent", "auth.json");

    try {
      await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
      await writeFile(authPath, `${JSON.stringify({ openai: "existing-openai" }, null, 2)}\n`);

      const exitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        configPath,
        "--discord-enabled",
        "false",
        "--discord-inbound-mode",
        "file",
        "--terminal-alerts",
        "false",
        "--model-provider",
        "skip",
      ], {
        env: {
          HOME: homeDir,
        },
        output: createWriter(),
        error: createWriter(),
      });

      assert.equal(exitCode, 0);
      const authRaw = await readFile(authPath, "utf8");
      assert.deepEqual(JSON.parse(authRaw), {
        openai: "existing-openai",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses non-interactive agentika setup flags", () => {
    const options = parseSetupCliArgs([
      "--non-interactive",
      "--config",
      "./lumo.config.json",
      "--discord-enabled",
      "false",
      "--discord-inbound-mode",
      "file",
      "--terminal-alerts",
      "false",
      "--agentika-enabled",
      "true",
      "--agentika-url",
      " http://localhost:9876 ",
      "--agentika-token",
      " dev-token ",
      "--agentika-binary",
      " /opt/agentika ",
    ]);

    const answers = resolveSetupAnswers(options);
    assert.equal(answers.agentikaEnabled, true);
    assert.equal(answers.agentikaUrl, "http://localhost:9876");
    assert.equal(answers.agentikaToken, "dev-token");
    assert.equal(answers.agentikaBinaryPath, "/opt/agentika");
    assert.deepEqual(buildSetupConfig(answers).agentika, {
      enabled: true,
      eventBus: true,
      baseUrl: "http://localhost:9876",
      token: "dev-token",
      binaryPath: "/opt/agentika",
    });
  });
});

function createOptions(overrides: Partial<SetupCliOptions>): SetupCliOptions {
  return {
    force: false,
    help: false,
    nonInteractive: false,
    ...overrides,
  };
}

function createWriter(): { write: (_text: string) => void } {
  return {
    write(): void {},
  };
}

function createBufferingWriter(): { buffer: string; write: (text: string) => void } {
  return {
    buffer: "",
    write(text: string): void {
      this.buffer += text;
    },
  };
}

function createScriptedPrompter(script: {
  asks: string[];
  selects: number[];
}): SetupPrompter {
  return {
    async ask(): Promise<string> {
      return script.asks.shift() ?? "";
    },
    async select(question: string, _options: readonly string[], initialIndex = 0): Promise<number> {
      const selectedIndex = script.selects.shift();
      if (selectedIndex == null) {
        return initialIndex;
      }

      return selectedIndex;
    },
    close(): void {},
  };
}
