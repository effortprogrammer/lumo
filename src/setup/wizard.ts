import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { dirname, join, resolve } from "node:path";
import {
  createDefaultConfig,
  type DeepPartial,
  type LumoConfig,
} from "../config/load-config.js";
import {
  runDiscordGatewayHealthcheck,
  type DiscordGatewayHealthcheckResult,
} from "../channels/discord-adapter.js";

type DiscordInboundMode = LumoConfig["channels"]["adapters"]["discord"]["inbound"]["mode"];
type SupervisorClient = Extract<
  LumoConfig["supervisor"]["client"],
  "anthropic-compatible" | "openai-compatible"
>;
type ModelProviderValue = "anthropic" | "openai" | "google" | "copilot" | "openrouter" | "skip";

interface ModelProviderChoice extends SelectChoice<ModelProviderValue> {
  authKey?: "anthropic" | "openai" | "google" | "openrouter";
  requiresApiKey: boolean;
  oauthLogin: boolean;
}

interface SupervisorSelection {
  provider: SupervisorClient;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MODEL_PROVIDER_CHOICES = [
  { label: "Anthropic (API key)", value: "anthropic", authKey: "anthropic", requiresApiKey: true, oauthLogin: false },
  { label: "OpenAI (API key)", value: "openai", authKey: "openai", requiresApiKey: true, oauthLogin: false },
  { label: "Google Gemini (API key)", value: "google", authKey: "google", requiresApiKey: true, oauthLogin: false },
  { label: "GitHub Copilot (free, OAuth in pi)", value: "copilot", requiresApiKey: false, oauthLogin: true },
  { label: "OpenRouter (API key)", value: "openrouter", authKey: "openrouter", requiresApiKey: true, oauthLogin: false },
  { label: "Skip (configure later in pi)", value: "skip", requiresApiKey: false, oauthLogin: false },
] as const satisfies readonly ModelProviderChoice[];

const SUPERVISOR_DEFAULTS: Record<SupervisorClient, { baseUrl: string; apiKey: string; model: string }> = {
  "anthropic-compatible": {
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-20250514",
  },
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "OPENAI_API_KEY",
    model: "gpt-4o",
  },
};

export interface SetupAnswers {
  configPath: string;
  discordEnabled: boolean;
  discordInboundMode: DiscordInboundMode;
  webhookUrl?: string;
  tokenEnvVar: string;
  allowedChannels: string[];
  allowedUsers: string[];
  mentionPrefix?: string;
  enableTerminalAlerts: boolean;
  modelProvider: ModelProviderValue;
  modelApiKey?: string;
  supervisor?: SupervisorSelection;
}

export interface SetupCliOptions {
  force: boolean;
  help: boolean;
  nonInteractive: boolean;
  configPath?: string;
  discordEnabled?: string;
  discordInboundMode?: string;
  webhookUrl?: string;
  tokenEnvVar?: string;
  allowedChannels?: string;
  allowedUsers?: string;
  mentionPrefix?: string;
  enableTerminalAlerts?: string;
  discordGatewayHealthcheck?: string;
  modelProvider?: string;
  modelApiKey?: string;
  supervisorProvider?: string;
  supervisorBaseUrl?: string;
  supervisorApiKey?: string;
  supervisorModel?: string;
}

export interface SetupCliDependencies {
  env?: Record<string, string | undefined>;
  input?: unknown;
  output?: TextWriter;
  error?: TextWriter;
  createPrompter?: () => SetupPrompter;
  discordGatewayHealthcheck?: (
    tokenEnvVar: string,
    token: string,
  ) => Promise<DiscordGatewayHealthcheckResult>;
}

export interface SetupPrompter {
  ask(question: string): Promise<string>;
  select?(question: string, options: readonly string[], initialIndex?: number): Promise<number>;
  close(): void;
}

export interface TextWriter {
  write(text: string): void;
}

interface InteractiveInput {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
  on(event: "keypress", listener: (text: string, key: KeyPress) => void): void;
  off(event: "keypress", listener: (text: string, key: KeyPress) => void): void;
  resume?(): void;
}

interface InteractiveOutput extends TextWriter {
  isTTY?: boolean;
}

interface KeyPress {
  name?: string;
  ctrl?: boolean;
}

interface SelectChoice<TValue extends string> {
  label: string;
  value: TValue;
}

export interface WriteSetupConfigOptions {
  force: boolean;
  confirmOverwrite?: () => Promise<boolean>;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);
const YES_NO_CHOICES = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
] as const satisfies readonly SelectChoice<"yes" | "no">[];
const silentWriter: TextWriter = {
  write(): void {},
};

export function parseSetupCliArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): SetupCliOptions {
  const options: SetupCliOptions = {
    force: parseBooleanString(env.LUMO_SETUP_FORCE) ?? false,
    help: false,
    nonInteractive: parseBooleanString(env.LUMO_SETUP_NON_INTERACTIVE) ?? false,
    configPath: env.LUMO_SETUP_CONFIG_PATH,
    discordEnabled: env.LUMO_SETUP_DISCORD_ENABLED,
    discordInboundMode: env.LUMO_SETUP_DISCORD_INBOUND_MODE,
    webhookUrl: env.LUMO_SETUP_DISCORD_WEBHOOK_URL,
    tokenEnvVar: env.LUMO_SETUP_DISCORD_TOKEN_ENV_VAR,
    allowedChannels: env.LUMO_SETUP_DISCORD_ALLOWED_CHANNELS,
    allowedUsers: env.LUMO_SETUP_DISCORD_ALLOWED_USERS,
    mentionPrefix: env.LUMO_SETUP_DISCORD_MENTION_PREFIX,
    enableTerminalAlerts: env.LUMO_SETUP_TERMINAL_ALERTS,
    discordGatewayHealthcheck: env.LUMO_SETUP_DISCORD_GATEWAY_HEALTHCHECK,
    modelProvider: env.LUMO_SETUP_MODEL_PROVIDER,
    modelApiKey: env.LUMO_SETUP_MODEL_API_KEY,
    supervisorProvider: env.LUMO_SETUP_SUPERVISOR_PROVIDER,
    supervisorBaseUrl: env.LUMO_SETUP_SUPERVISOR_BASE_URL,
    supervisorApiKey: env.LUMO_SETUP_SUPERVISOR_API_KEY,
    supervisorModel: env.LUMO_SETUP_SUPERVISOR_MODEL,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--non-interactive") {
      options.nonInteractive = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected setup argument: ${arg}`);
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    switch (key) {
      case "config":
        options.configPath = next;
        break;
      case "discord-enabled":
        options.discordEnabled = next;
        break;
      case "discord-inbound-mode":
        options.discordInboundMode = next;
        break;
      case "discord-webhook-url":
        options.webhookUrl = next;
        break;
      case "discord-token-env-var":
        options.tokenEnvVar = next;
        break;
      case "discord-allowed-channels":
        options.allowedChannels = next;
        break;
      case "discord-allowed-users":
        options.allowedUsers = next;
        break;
      case "discord-mention-prefix":
        options.mentionPrefix = next;
        break;
      case "terminal-alerts":
        options.enableTerminalAlerts = next;
        break;
      case "discord-gateway-healthcheck":
        options.discordGatewayHealthcheck = next;
        break;
      case "model-provider":
        options.modelProvider = next;
        break;
      case "model-api-key":
        options.modelApiKey = next;
        break;
      case "supervisor-provider":
        options.supervisorProvider = next;
        break;
      case "supervisor-base-url":
        options.supervisorBaseUrl = next;
        break;
      case "supervisor-api-key":
        options.supervisorApiKey = next;
        break;
      case "supervisor-model":
        options.supervisorModel = next;
        break;
      default:
        throw new Error(`Unknown setup flag: --${key}`);
    }

    index += 1;
  }

  return options;
}

export function resolveSetupAnswers(
  options: SetupCliOptions,
  defaults = createDefaultConfig(),
): SetupAnswers {
  const configPath = requiredTrimmedValue(
    options.configPath ?? "./lumo.config.json",
    "config path",
  );
  const discordEnabled = parseBooleanInput(
    options.discordEnabled,
    defaults.channels.adapters.discord.enabled,
    "discord enablement",
  );
  const discordInboundMode = parseDiscordInboundMode(
    options.discordInboundMode ?? defaults.channels.adapters.discord.inbound.mode,
  );
  const tokenEnvVar = trimOptionalValue(
    options.tokenEnvVar ?? defaults.channels.adapters.discord.inbound.tokenEnvVar,
  );
  const allowedChannels = splitCommaList(options.allowedChannels);
  const allowedUsers = splitCommaList(options.allowedUsers);
  const mentionPrefix = trimOptionalValue(options.mentionPrefix);
  const webhookUrl = trimOptionalValue(options.webhookUrl);
  const enableTerminalAlerts = parseBooleanInput(
    options.enableTerminalAlerts,
    defaults.alerts.channels.terminal.enabled,
    "terminal alerts",
  );
  const modelProvider = parseModelProvider(options.modelProvider);
  const selectedProvider = getModelProviderChoice(modelProvider);
  const modelApiKey = trimOptionalValue(options.modelApiKey);
  if (selectedProvider.requiresApiKey && !modelApiKey) {
    throw new Error(`Model API key is required when provider ${selectedProvider.label} is selected.`);
  }

  const supervisor = parseSupervisorSelection(options);

  if (discordEnabled && discordInboundMode === "gateway") {
    if (!tokenEnvVar) {
      throw new Error("Discord token env var name is required when gateway mode is selected.");
    }

    if (allowedChannels.length === 0) {
      throw new Error("At least one Discord allowed channel is required when gateway mode is selected.");
    }
  }

  return {
    configPath,
    discordEnabled,
    discordInboundMode,
    webhookUrl,
    tokenEnvVar: tokenEnvVar ?? defaults.channels.adapters.discord.inbound.tokenEnvVar,
    allowedChannels,
    allowedUsers,
    mentionPrefix,
    enableTerminalAlerts,
    modelProvider,
    modelApiKey,
    supervisor,
  };
}

export function buildSetupConfig(
  answers: SetupAnswers,
  defaults = createDefaultConfig(),
): DeepPartial<LumoConfig> {
  const inbound = {
    mode: answers.discordInboundMode,
    filePath: defaults.channels.adapters.discord.inbound.filePath,
    tokenEnvVar: answers.tokenEnvVar,
    allowedChannels: answers.allowedChannels,
    allowedUsers: answers.allowedUsers,
    ...(answers.mentionPrefix ? { mentionPrefix: answers.mentionPrefix } : {}),
  };
  const discordWebhookEnabled = Boolean(answers.webhookUrl);
  const config: DeepPartial<LumoConfig> = {
    alerts: {
      enableTerminalBell: answers.enableTerminalAlerts,
      channels: {
        terminal: {
          enabled: answers.enableTerminalAlerts,
        },
        discord: {
          enabled: discordWebhookEnabled,
          ...(answers.webhookUrl ? { webhookUrl: answers.webhookUrl } : {}),
        },
      },
      ...(answers.webhookUrl ? { webhookUrl: answers.webhookUrl } : {}),
    },
    channels: {
      adapters: {
        discord: {
          enabled: answers.discordEnabled,
          ...(answers.webhookUrl ? { webhookUrl: answers.webhookUrl } : {}),
          inbound,
        },
      },
    },
  };

  if (answers.supervisor) {
    config.supervisor = {
      client: answers.supervisor.provider,
      model: answers.supervisor.model,
      openaiCompatible: {
        enabled: answers.supervisor.provider === "openai-compatible",
      },
      anthropicCompatible: {
        enabled: answers.supervisor.provider === "anthropic-compatible",
      },
    };

    if (answers.supervisor.provider === "anthropic-compatible") {
      config.supervisor.anthropicCompatible = {
        enabled: true,
        baseUrl: answers.supervisor.baseUrl,
        apiKey: answers.supervisor.apiKey,
        model: answers.supervisor.model,
      };
    } else {
      config.supervisor.openaiCompatible = {
        enabled: true,
        baseUrl: answers.supervisor.baseUrl,
        apiKey: answers.supervisor.apiKey,
        model: answers.supervisor.model,
      };
    }
  }

  return config;
}

export async function writeSetupConfig(
  configPath: string,
  config: DeepPartial<LumoConfig>,
  options: WriteSetupConfigOptions,
): Promise<{ path: string; overwritten: boolean }> {
  const resolvedPath = resolve(configPath);
  const alreadyExists = existsSync(resolvedPath);

  if (alreadyExists && !options.force) {
    if (!options.confirmOverwrite) {
      throw new Error(`Config file already exists: ${resolvedPath}. Re-run with --force or confirm overwrite interactively.`);
    }

    const confirmed = await options.confirmOverwrite();
    if (!confirmed) {
      throw new Error(`Config file already exists and overwrite was declined: ${resolvedPath}`);
    }
  }

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    path: resolvedPath,
    overwritten: alreadyExists,
  };
}

export async function runSetupCli(
  args: string[],
  dependencies: SetupCliDependencies = {},
): Promise<number> {
  const output: TextWriter = dependencies.output ?? defaultOutput ?? silentWriter;
  const error: TextWriter = dependencies.error ?? output;
  const env = dependencies.env ?? process.env;
  let options: SetupCliOptions;

  try {
    options = parseSetupCliArgs(args, env);
  } catch (cliError) {
    writeLine(error, formatError(cliError));
    writeLine(error, getSetupUsage());
    return 1;
  }

  if (options.help) {
    writeLine(output, getSetupUsage());
    return 0;
  }

  try {
    void shouldRunDiscordGatewayHealthcheck(options);
    const answers = options.nonInteractive
      ? resolveSetupAnswers(options)
      : await runInteractiveWizard(options, dependencies);
    const generatedConfig = buildSetupConfig(answers);
    const result = await writeSetupConfig(answers.configPath, generatedConfig, {
      force: options.force,
      confirmOverwrite: options.force || options.nonInteractive
        ? undefined
        : async () => {
          const prompter = dependencies.createPrompter
            ? dependencies.createPrompter()
            : createReadlinePrompter(
              dependencies.input ?? defaultInput,
              dependencies.output ?? defaultOutput,
            );
          try {
            return await promptBooleanSelect(
              prompter,
              `Config file ${resolve(answers.configPath)} already exists. Overwrite?`,
              false,
            );
          } finally {
            prompter.close();
          }
        },
    });
    await maybeWritePiAuth({
      answers,
      env,
    });
    writeLine(output, `Wrote config to ${result.path}`);
    maybeWriteModelProviderFollowup(output, answers);
    await maybeRunDiscordGatewayHealthcheck({
      answers,
      options,
      env,
      writer: output,
      healthcheck:
        dependencies.discordGatewayHealthcheck ??
        ((tokenEnvVar: string, token: string) =>
          runDiscordGatewayHealthcheck({
            tokenEnvVar,
            token,
          })),
    });
    return 0;
  } catch (setupError) {
    writeLine(error, formatError(setupError));
    return 1;
  }
}

export function getSetupUsage(): string {
  return [
    "Usage: lumo setup [options]",
    "",
    "Options:",
    "  --non-interactive                Generate config without prompts using flags/env",
    "  --force                          Overwrite an existing config file without confirmation",
    "  --config <path>                  Output config path",
    "  --discord-enabled <bool>         true | false",
    "  --discord-inbound-mode <mode>    file | gateway",
    "  --discord-webhook-url <url>      Optional Discord webhook URL",
    "  --discord-token-env-var <name>   Discord bot token env var name",
    "  --discord-allowed-channels <csv> Comma-separated channel scopes",
    "  --discord-allowed-users <csv>    Comma-separated allowed users",
    "  --discord-mention-prefix <text>  Optional required prefix for Discord messages",
    "  --terminal-alerts <bool>         true | false",
    "  --model-provider <name>          anthropic | openai | google | openrouter | copilot | skip",
    "  --model-api-key <key>            API key for the selected pi runtime provider",
    "  --supervisor-provider <type>     anthropic-compatible | openai-compatible | none",
    "  --supervisor-base-url <url>      Supervisor base URL override",
    "  --supervisor-api-key <value>     Supervisor API key or env var name",
    "  --supervisor-model <name>        Supervisor model identifier",
    "  --discord-gateway-healthcheck <bool> Run setup-time Discord gateway check",
    "",
    "Environment fallbacks use the same names prefixed with LUMO_SETUP_.",
  ].join("\n");
}

async function runInteractiveWizard(
  options: SetupCliOptions,
  dependencies: SetupCliDependencies,
): Promise<SetupAnswers> {
  const defaults = createDefaultConfig();
  const writer: TextWriter = dependencies.output ?? defaultOutput ?? silentWriter;
  const prompter = dependencies.createPrompter
    ? dependencies.createPrompter()
    : createReadlinePrompter(
      dependencies.input ?? defaultInput,
      dependencies.output ?? defaultOutput,
    );

  try {
    writeLine(writer, "Welcome to Lumo setup.");
    writeLine(writer, "This setup configures Lumo, pi runtime provider access, and optional supervisor settings.");
    writeLine(writer, "");
    const setupMode = await promptSelectValue(
      prompter,
      "Setup mode",
      [
        { label: "Quickstart (recommended)", value: "quickstart" },
        { label: "Custom", value: "custom" },
      ],
      "quickstart",
    );
    if (setupMode === "quickstart") {
      const answers = await buildQuickstartAnswers(prompter, options, defaults);
      writeLine(writer, "");
      writeLine(writer, formatQuickstartPreview(answers));
      const confirmed = await promptBooleanSelect(
        prompter,
        "Write this quickstart config",
        true,
      );
      if (!confirmed) {
        throw new Error("Setup cancelled before writing config.");
      }
      return answers;
    }

    const configPath = await promptWithDefault(
      prompter,
      "Config path",
      options.configPath ?? "./lumo.config.json",
    );
    const discordEnabled = await promptBoolean(
      prompter,
      "Enable Discord integration",
      parseBooleanInput(
        options.discordEnabled,
        defaults.channels.adapters.discord.enabled,
        "discord enablement",
      ),
    );
    let discordInboundMode = defaults.channels.adapters.discord.inbound.mode;
    let webhookUrl = trimOptionalValue(options.webhookUrl);
    let tokenEnvVar = defaults.channels.adapters.discord.inbound.tokenEnvVar;
    let allowedChannels = splitCommaList(options.allowedChannels);
    let allowedUsers = splitCommaList(options.allowedUsers);
    let mentionPrefix = trimOptionalValue(options.mentionPrefix);
    let enableTerminalAlerts = parseBooleanInput(
      options.enableTerminalAlerts,
      defaults.alerts.channels.terminal.enabled,
      "terminal alerts",
    );
    if (discordEnabled) {
      discordInboundMode = "gateway";
      webhookUrl = trimOptionalValue(
        await promptWithDefault(
          prompter,
          "Discord webhook URL for alerts (optional)",
          options.webhookUrl ?? "",
        ),
      );
      tokenEnvVar = requiredTrimmedValue(
        await promptWithDefault(
          prompter,
          "Discord bot token env var name",
          options.tokenEnvVar ?? defaults.channels.adapters.discord.inbound.tokenEnvVar,
        ),
        "discord token env var name",
      );
      allowedChannels = splitCommaList(
        await promptWithDefault(
          prompter,
          "Allowed Discord channels (comma-separated)",
          options.allowedChannels ?? "",
        ),
      );
      allowedUsers = splitCommaList(
        await promptWithDefault(
          prompter,
          "Allowed Discord users (comma-separated, optional)",
          options.allowedUsers ?? "",
        ),
      );
      mentionPrefix = trimOptionalValue(
        await promptWithDefault(
          prompter,
          "Mention prefix (optional)",
          options.mentionPrefix ?? "",
        ),
      );
    }
    enableTerminalAlerts = await promptBoolean(
      prompter,
      "Enable terminal alerts",
      enableTerminalAlerts,
    );
    const modelProviderSelection = await promptModelProviderSelection(prompter, options);
    const supervisor = await promptSupervisorSelection(prompter, options);

    const answers = resolveSetupAnswers({
      ...options,
      configPath,
      discordEnabled: String(discordEnabled),
      discordInboundMode,
      webhookUrl,
      tokenEnvVar,
      allowedChannels: allowedChannels.join(","),
      allowedUsers: allowedUsers.join(","),
      mentionPrefix,
      enableTerminalAlerts: String(enableTerminalAlerts),
      modelProvider: modelProviderSelection.provider.value,
      modelApiKey: modelProviderSelection.apiKey,
      supervisorProvider: supervisor?.provider ?? "none",
      supervisorBaseUrl: supervisor?.baseUrl,
      supervisorApiKey: supervisor?.apiKey,
      supervisorModel: supervisor?.model,
    });

    writeLine(writer, "");
    writeLine(writer, formatSetupSummary(answers));

    const confirmed = await promptBooleanSelect(
      prompter,
      "Write this config file",
      true,
    );
    if (!confirmed) {
      throw new Error("Setup cancelled before writing config.");
    }

    return answers;
  } finally {
    prompter.close();
  }
}

function createReadlinePrompter(
  input: unknown,
  output: unknown,
): SetupPrompter {
  const readline = createInterface({
    input,
    output,
  });

  return {
    ask(question: string): Promise<string> {
      return readline.question(question);
    },
    async select(question: string, options: readonly string[], initialIndex = 0): Promise<number> {
      const interactiveInput = asInteractiveInput(input);
      const interactiveOutput = asInteractiveOutput(output);
      if (
        !interactiveInput ||
        !interactiveOutput ||
        !interactiveInput.isTTY ||
        !interactiveOutput.isTTY ||
        typeof interactiveInput.setRawMode !== "function"
      ) {
        return fallbackSelectPrompt(readline.question.bind(readline), question, options, initialIndex);
      }

      return renderInteractiveSelect(
        interactiveInput,
        interactiveOutput,
        question,
        options,
        initialIndex,
      );
    },
    close(): void {
      readline.close();
    },
  };
}

async function promptWithDefault(
  prompter: SetupPrompter,
  label: string,
  fallback: string,
): Promise<string> {
  const response = await prompter.ask(`${label} [${fallback}]: `);
  const trimmed = response.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

async function promptBoolean(
  prompter: SetupPrompter,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  return promptBooleanSelect(prompter, label, fallback);
}

async function promptBooleanSelect(
  prompter: SetupPrompter,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  const value = await promptSelectValue(
    prompter,
    label,
    YES_NO_CHOICES,
    fallback ? "yes" : "no",
  );
  return value === "yes";
}

async function promptSelectValue<TValue extends string>(
  prompter: SetupPrompter,
  label: string,
  choices: readonly SelectChoice<TValue>[],
  fallback: TValue,
): Promise<TValue> {
  const fallbackIndex = choices.findIndex((choice) => choice.value === fallback);
  if (prompter.select) {
    const selectedIndex = await prompter.select(
      `${label} (use arrow keys, Enter to confirm)`,
      choices.map((choice) => choice.label),
      fallbackIndex >= 0 ? fallbackIndex : 0,
    );
    return choices[selectedIndex]?.value ?? fallback;
  }

  const selectedValue = await fallbackSelectValue(prompter, label, choices, fallback, false);
  return selectedValue ?? fallback;
}

async function fallbackSelectValue<TValue extends string>(
  prompter: SetupPrompter,
  label: string,
  choices: readonly SelectChoice<TValue>[],
  fallback: string,
  allowCustomInput: boolean,
): Promise<TValue | undefined> {
  const renderedChoices = choices.map((choice, index) => `${index + 1}) ${choice.label}`).join(", ");
  const defaultChoice = choices.find((choice) => choice.value === fallback)?.label ?? fallback;
  while (true) {
    const response = (await prompter.ask(
      `${label} [${defaultChoice}] (${renderedChoices}${allowCustomInput ? ", custom" : ""}): `,
    )).trim();

    if (response.length === 0) {
      const matchedFallback = choices.find((choice) => choice.value === fallback);
      return matchedFallback?.value;
    }

    const byIndex = Number(response);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
      return choices[byIndex - 1]?.value;
    }

    const normalized = response.toLowerCase();
    const matched = choices.find(
      (choice) =>
        choice.label.toLowerCase() === normalized || choice.value.toLowerCase() === normalized,
    );
    if (matched) {
      return matched.value;
    }

    if (allowCustomInput && normalized === "custom") {
      return undefined;
    }
  }
}

async function fallbackSelectPrompt(
  ask: (question: string) => Promise<string>,
  label: string,
  options: readonly string[],
  initialIndex: number,
): Promise<number> {
  const defaultIndex = normalizeSelectedIndex(initialIndex, options.length);
  const defaultOption = options[defaultIndex] ?? options[0] ?? "";
  const renderedChoices = options.map((option, index) => `${index + 1}) ${option}`).join(", ");
  while (true) {
    const response = (await ask(`${label} [${defaultOption}] (${renderedChoices}): `)).trim();
    if (response.length === 0) {
      return defaultIndex;
    }

    const byIndex = Number(response);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= options.length) {
      return byIndex - 1;
    }

    const matchedIndex = options.findIndex(
      (option) => option.toLowerCase() === response.toLowerCase(),
    );
    if (matchedIndex >= 0) {
      return matchedIndex;
    }
  }
}

function parseBooleanInput(
  value: string | undefined,
  fallback: boolean,
  label: string,
): boolean {
  if (value == null) {
    return fallback;
  }

  const parsed = parseBooleanString(value);
  if (parsed == null) {
    throw new Error(`Invalid boolean for ${label}: ${value}`);
  }

  return parsed;
}

function parseBooleanString(value: string | undefined): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }

  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
}

function parseDiscordInboundMode(value: string): DiscordInboundMode {
  if (value === "file" || value === "gateway") {
    return value;
  }

  throw new Error(`Unsupported Discord inbound mode: ${value}`);
}

function requiredTrimmedValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return trimmed;
}

function trimOptionalValue(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitCommaList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function asInteractiveInput(input: unknown): InteractiveInput | undefined {
  if (
    typeof input === "object" &&
    input !== null &&
    "on" in input &&
    "off" in input
  ) {
    return input as InteractiveInput;
  }

  return undefined;
}

function asInteractiveOutput(output: unknown): InteractiveOutput | undefined {
  if (
    typeof output === "object" &&
    output !== null &&
    "write" in output
  ) {
    return output as InteractiveOutput;
  }

  return undefined;
}

async function renderInteractiveSelect(
  input: InteractiveInput,
  output: InteractiveOutput,
  question: string,
  options: readonly string[],
  initialIndex: number,
): Promise<number> {
  const safeInitialIndex = normalizeSelectedIndex(initialIndex, options.length);
  let selectedIndex = safeInitialIndex;
  let renderedLineCount = 0;

  const repaint = (): void => {
    if (renderedLineCount > 0) {
      output.write(`\x1b[${renderedLineCount}F`);
    }

    const lines = [
      question,
      ...options.map((option, index) => `${index === selectedIndex ? ">" : " "} ${option}`),
    ];

    for (const line of lines) {
      output.write("\x1b[2K");
      output.write(line);
      output.write("\n");
    }

    renderedLineCount = lines.length;
  };

  return await new Promise<number>((resolveSelection, rejectSelection) => {
    const onKeypress = (_text: string, key: KeyPress): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        rejectSelection(new Error("Setup cancelled before writing config."));
        return;
      }

      if (key.name === "up") {
        selectedIndex = moveSelectionIndex(selectedIndex, "up", options.length);
        repaint();
        return;
      }

      if (key.name === "down") {
        selectedIndex = moveSelectionIndex(selectedIndex, "down", options.length);
        repaint();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolveSelection(selectedIndex);
      }
    };

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
    };

    emitKeypressEvents(input);
    input.resume?.();
    input.setRawMode?.(true);
    input.on("keypress", onKeypress);
    repaint();
  });
}

export function moveSelectionIndex(
  currentIndex: number,
  direction: "up" | "down",
  optionCount: number,
): number {
  if (optionCount <= 0) {
    return 0;
  }

  if (direction === "up") {
    return (currentIndex - 1 + optionCount) % optionCount;
  }

  return (currentIndex + 1) % optionCount;
}

function normalizeSelectedIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) {
    return 0;
  }

  if (index < 0) {
    return 0;
  }

  if (index >= optionCount) {
    return optionCount - 1;
  }

  return index;
}

function buildQuickstartAnswers(
  prompter: SetupPrompter,
  options: SetupCliOptions,
  defaults: LumoConfig,
): Promise<SetupAnswers> {
  return promptModelProviderSelection(prompter, options).then((modelProviderSelection) => resolveSetupAnswers({
    ...options,
    configPath: options.configPath ?? "./lumo.config.json",
    discordEnabled: "false",
    discordInboundMode: defaults.channels.adapters.discord.inbound.mode,
    enableTerminalAlerts: String(defaults.alerts.channels.terminal.enabled),
    modelProvider: modelProviderSelection.provider.value,
    modelApiKey: modelProviderSelection.apiKey,
  }, defaults));
}

function formatQuickstartPreview(answers: SetupAnswers): string {
  return [
    "Quickstart defaults",
    "-------------------",
    `Config path: ${answers.configPath}`,
    "Discord integration: disabled",
    "Discord webhook alerts: disabled",
    `Terminal alerts: ${answers.enableTerminalAlerts ? "enabled" : "disabled"}`,
    `Model provider: ${formatModelProviderSummary(answers)}`,
    `Supervisor: ${formatSupervisorSummary(answers)}`,
  ].join("\n");
}

export function formatSetupSummary(answers: SetupAnswers): string {
  return [
    "Setup summary",
    "-------------",
    `Config path: ${answers.configPath}`,
    `Discord enabled: ${answers.discordEnabled ? "Yes" : "No"}`,
    `Discord inbound mode: ${answers.discordEnabled ? answers.discordInboundMode : "(disabled)"}`,
    `Discord webhook URL: ${answers.webhookUrl ?? "(none)"}`,
    `Discord token env var: ${answers.discordEnabled ? answers.tokenEnvVar : "(disabled)"}`,
    `Allowed Discord channels: ${formatListSummary(answers.allowedChannels)}`,
    `Allowed Discord users: ${formatListSummary(answers.allowedUsers)}`,
    `Mention prefix: ${answers.mentionPrefix ?? "(none)"}`,
    `Terminal alerts: ${answers.enableTerminalAlerts ? "Yes" : "No"}`,
    `Model provider: ${formatModelProviderSummary(answers)}`,
    `Supervisor: ${formatSupervisorSummary(answers)}`,
  ].join("\n");
}

function parseModelProvider(value: string | undefined): ModelProviderValue {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "skip";
  }

  const matched = MODEL_PROVIDER_CHOICES.find((choice) => choice.value === normalized);
  if (!matched) {
    throw new Error(`Unsupported model provider: ${value}`);
  }

  return matched.value;
}

function getModelProviderChoice(value: ModelProviderValue): ModelProviderChoice {
  const matched = MODEL_PROVIDER_CHOICES.find((choice) => choice.value === value);
  if (!matched) {
    throw new Error(`Unsupported model provider: ${value}`);
  }

  return matched;
}

async function promptModelProviderSelection(
  prompter: SetupPrompter,
  options: SetupCliOptions,
): Promise<{ provider: ModelProviderChoice; apiKey?: string }> {
  const providerValue = await promptSelectValue(
    prompter,
    "Model provider for pi runtime",
    MODEL_PROVIDER_CHOICES,
    parseModelProvider(options.modelProvider),
  );
  const provider = getModelProviderChoice(providerValue);
  if (!provider.requiresApiKey) {
    return { provider };
  }

  const configuredApiKey = trimOptionalValue(options.modelApiKey);
  if (configuredApiKey) {
    return {
      provider,
      apiKey: configuredApiKey,
    };
  }

  const apiKey = requiredTrimmedValue(
    await prompter.ask(`${provider.label.replace(" (API key)", "")} API key: `),
    "model API key",
  );

  return {
    provider,
    apiKey,
  };
}

async function promptSupervisorSelection(
  prompter: SetupPrompter,
  options: SetupCliOptions,
): Promise<SupervisorSelection | undefined> {
  const configureSupervisor = await promptSelectValue(
    prompter,
    "Configure supervisor model?",
    [
      { label: "Yes", value: "yes" },
      { label: "No (use defaults)", value: "no" },
    ],
    parseSupervisorProviderValue(options.supervisorProvider) === "none" ? "no" : "yes",
  );
  if (configureSupervisor === "no") {
    return undefined;
  }

  const provider = await promptSelectValue(
    prompter,
    "Supervisor provider",
    [
      { label: "Anthropic-compatible", value: "anthropic-compatible" },
      { label: "OpenAI-compatible", value: "openai-compatible" },
    ],
    parseSupervisorProviderValue(options.supervisorProvider) === "none"
      ? "anthropic-compatible"
      : parseSupervisorProviderValue(options.supervisorProvider) as SupervisorClient,
  );
  const defaults = SUPERVISOR_DEFAULTS[provider];

  return {
    provider,
    baseUrl: requiredTrimmedValue(
      await promptWithDefault(
        prompter,
        "Base URL",
        trimOptionalValue(options.supervisorBaseUrl) ?? defaults.baseUrl,
      ),
      "supervisor base URL",
    ),
    apiKey: requiredTrimmedValue(
      await promptWithDefault(
        prompter,
        "API key (or env var name)",
        trimOptionalValue(options.supervisorApiKey) ?? defaults.apiKey,
      ),
      "supervisor API key",
    ),
    model: requiredTrimmedValue(
      await promptWithDefault(
        prompter,
        "Model",
        trimOptionalValue(options.supervisorModel) ?? defaults.model,
      ),
      "supervisor model",
    ),
  };
}

function parseSupervisorProviderValue(value: string | undefined): SupervisorClient | "none" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") {
    return "none";
  }

  if (normalized === "anthropic-compatible" || normalized === "openai-compatible") {
    return normalized;
  }

  throw new Error(`Unsupported supervisor provider: ${value}`);
}

function parseSupervisorSelection(options: SetupCliOptions): SupervisorSelection | undefined {
  const provider = parseSupervisorProviderValue(options.supervisorProvider);
  if (provider === "none") {
    return undefined;
  }

  const defaults = SUPERVISOR_DEFAULTS[provider];
  return {
    provider,
    baseUrl: requiredTrimmedValue(
      trimOptionalValue(options.supervisorBaseUrl) ?? defaults.baseUrl,
      "supervisor base URL",
    ),
    apiKey: requiredTrimmedValue(
      trimOptionalValue(options.supervisorApiKey) ?? defaults.apiKey,
      "supervisor API key",
    ),
    model: requiredTrimmedValue(
      trimOptionalValue(options.supervisorModel) ?? defaults.model,
      "supervisor model",
    ),
  };
}

async function maybeWritePiAuth(options: {
  answers: SetupAnswers;
  env: Record<string, string | undefined>;
}): Promise<void> {
  const provider = getModelProviderChoice(options.answers.modelProvider);
  if (!provider.authKey || !options.answers.modelApiKey) {
    return;
  }

  const homeDir = requiredTrimmedValue(
    options.env.HOME ?? process.env.HOME ?? "",
    "HOME",
  );
  const authPath = join(homeDir, ".pi", "agent", "auth.json");
  let existing: Record<string, unknown> = {};

  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      existing = parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(authPath), { recursive: true });
  await writeFile(
    authPath,
    `${JSON.stringify({
      ...existing,
      [provider.authKey]: options.answers.modelApiKey,
    }, null, 2)}\n`,
    "utf8",
  );
}

function maybeWriteModelProviderFollowup(writer: TextWriter, answers: SetupAnswers): void {
  const provider = getModelProviderChoice(answers.modelProvider);
  if (provider.oauthLogin) {
    writeLine(writer, "After setup, run /login in pi to complete OAuth.");
  }
}

function formatModelProviderSummary(answers: SetupAnswers): string {
  const provider = getModelProviderChoice(answers.modelProvider);
  if (provider.value === "skip") {
    return "Skip (configure later in pi)";
  }

  if (provider.oauthLogin) {
    return `${provider.label} (/login required in pi)`;
  }

  return `${provider.label.replace(" (API key)", "")} (API key configured: ${maskSecret(answers.modelApiKey)})`;
}

function formatSupervisorSummary(answers: SetupAnswers): string {
  return answers.supervisor
    ? `${answers.supervisor.provider} (${answers.supervisor.model})`
    : "defaults";
}

function maskSecret(value: string | undefined): string {
  if (!value) {
    return "(missing)";
  }

  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  const tail = value.slice(-4);
  return `${"*".repeat(value.length - 4)}${tail}`;
}

function formatListSummary(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(writer: TextWriter, text: string): void {
  writer.write(`${text}\n`);
}

export function shouldRunDiscordGatewayHealthcheck(
  options: Pick<SetupCliOptions, "discordGatewayHealthcheck" | "nonInteractive">,
): boolean {
  if (options.discordGatewayHealthcheck != null) {
    const explicit = parseBooleanString(options.discordGatewayHealthcheck);
    if (explicit == null) {
      throw new Error(
        `Invalid boolean for discord gateway healthcheck: ${options.discordGatewayHealthcheck}`,
      );
    }
    return explicit;
  }

  return !options.nonInteractive;
}

async function maybeRunDiscordGatewayHealthcheck(
  options: {
    answers: SetupAnswers;
    options: SetupCliOptions;
    env: Record<string, string | undefined>;
    writer: TextWriter;
    healthcheck: (
      tokenEnvVar: string,
      token: string,
    ) => Promise<DiscordGatewayHealthcheckResult>;
  },
): Promise<void> {
  if (
    !options.answers.discordEnabled ||
    options.answers.discordInboundMode !== "gateway" ||
    !shouldRunDiscordGatewayHealthcheck(options.options)
  ) {
    return;
  }

  const tokenEnvVar = options.answers.tokenEnvVar;
  const token = options.env[tokenEnvVar]?.trim() ?? "";
  if (token.length === 0) {
    writeLine(options.writer, `[discord gateway healthcheck] skipped: env var ${tokenEnvVar} is not set`);
    return;
  }

  writeLine(options.writer, `[discord gateway healthcheck] checking Discord connectivity using ${tokenEnvVar}`);

  try {
    const result = await options.healthcheck(tokenEnvVar, token);
    writeLine(
      options.writer,
      `[discord gateway healthcheck] ${result.ok ? "PASS" : "FAIL"}: ${result.detail}`,
    );
  } catch (error) {
    writeLine(
      options.writer,
      `[discord gateway healthcheck] FAIL: ${formatError(error)}`,
    );
  }
}
