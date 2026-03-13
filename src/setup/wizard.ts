import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { dirname, resolve } from "node:path";
import {
  createDefaultConfig,
  type DeepPartial,
  type LumoConfig,
} from "../config/load-config.js";
import {
  runDiscordGatewayHealthcheck,
  type DiscordGatewayHealthcheckResult,
} from "../channels/discord-adapter.js";

type SupervisorClient = LumoConfig["supervisor"]["client"];
type DiscordInboundMode = LumoConfig["channels"]["adapters"]["discord"]["inbound"]["mode"];

export interface SetupAnswers {
  configPath: string;
  actorModel: string;
  supervisorModel: string;
  supervisorClient: SupervisorClient;
  discordEnabled: boolean;
  discordInboundMode: DiscordInboundMode;
  webhookUrl?: string;
  tokenEnvVar: string;
  allowedChannels: string[];
  allowedUsers: string[];
  mentionPrefix?: string;
  enableTerminalAlerts: boolean;
}

export interface SetupCliOptions {
  force: boolean;
  help: boolean;
  nonInteractive: boolean;
  configPath?: string;
  actorModel?: string;
  supervisorModel?: string;
  supervisorClient?: string;
  discordEnabled?: string;
  discordInboundMode?: string;
  webhookUrl?: string;
  tokenEnvVar?: string;
  allowedChannels?: string;
  allowedUsers?: string;
  mentionPrefix?: string;
  enableTerminalAlerts?: string;
  discordGatewayHealthcheck?: string;
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
    actorModel: env.LUMO_SETUP_ACTOR_MODEL,
    supervisorModel: env.LUMO_SETUP_SUPERVISOR_MODEL,
    supervisorClient: env.LUMO_SETUP_SUPERVISOR_CLIENT,
    discordEnabled: env.LUMO_SETUP_DISCORD_ENABLED,
    discordInboundMode: env.LUMO_SETUP_DISCORD_INBOUND_MODE,
    webhookUrl: env.LUMO_SETUP_DISCORD_WEBHOOK_URL,
    tokenEnvVar: env.LUMO_SETUP_DISCORD_TOKEN_ENV_VAR,
    allowedChannels: env.LUMO_SETUP_DISCORD_ALLOWED_CHANNELS,
    allowedUsers: env.LUMO_SETUP_DISCORD_ALLOWED_USERS,
    mentionPrefix: env.LUMO_SETUP_DISCORD_MENTION_PREFIX,
    enableTerminalAlerts: env.LUMO_SETUP_TERMINAL_ALERTS,
    discordGatewayHealthcheck: env.LUMO_SETUP_DISCORD_GATEWAY_HEALTHCHECK,
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
      case "actor-model":
        options.actorModel = next;
        break;
      case "supervisor-model":
        options.supervisorModel = next;
        break;
      case "supervisor-client":
        options.supervisorClient = next;
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
  const actorModel = requiredTrimmedValue(
    options.actorModel ?? defaults.actor.model,
    "actor model",
  );
  const supervisorModel = requiredTrimmedValue(
    options.supervisorModel ?? defaults.supervisor.model,
    "supervisor model",
  );
  const supervisorClient = parseSupervisorClient(
    options.supervisorClient ?? defaults.supervisor.client,
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
    actorModel,
    supervisorModel,
    supervisorClient,
    discordEnabled,
    discordInboundMode,
    webhookUrl,
    tokenEnvVar: tokenEnvVar ?? defaults.channels.adapters.discord.inbound.tokenEnvVar,
    allowedChannels,
    allowedUsers,
    mentionPrefix,
    enableTerminalAlerts,
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

  return {
    actor: {
      model: answers.actorModel,
    },
    supervisor: {
      model: answers.supervisorModel,
      client: answers.supervisorClient,
      openaiCompatible: {
        enabled: answers.supervisorClient === "openai-compatible",
      },
    },
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
    writeLine(output, `Wrote config to ${result.path}`);
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
    "  --actor-model <model>            Default actor model",
    "  --supervisor-model <model>       Supervisor model",
    "  --supervisor-client <client>     mock | heuristic | openai-compatible",
    "  --discord-enabled <bool>         true | false",
    "  --discord-inbound-mode <mode>    file | gateway",
    "  --discord-webhook-url <url>      Optional Discord webhook URL",
    "  --discord-token-env-var <name>   Discord bot token env var name",
    "  --discord-allowed-channels <csv> Comma-separated channel scopes",
    "  --discord-allowed-users <csv>    Comma-separated allowed users",
    "  --discord-mention-prefix <text>  Optional required prefix for Discord messages",
    "  --terminal-alerts <bool>         true | false",
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
    const configPath = await promptWithDefault(
      prompter,
      "Config path",
      options.configPath ?? "./lumo.config.json",
    );
    const actorModel = await promptWithDefault(
      prompter,
      "Actor model default",
      options.actorModel ?? defaults.actor.model,
    );
    const supervisorClient = await promptSelectWithCustomInput(
      prompter,
      "Supervisor client",
      [
        { label: "mock", value: "mock" },
        { label: "heuristic", value: "heuristic" },
        { label: "openai-compatible", value: "openai-compatible" },
      ],
      options.supervisorClient ?? defaults.supervisor.client,
    );
    const supervisorModel = await promptWithDefault(
      prompter,
      "Supervisor model",
      options.supervisorModel ?? defaults.supervisor.model,
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

    if (discordEnabled) {
      discordInboundMode = parseDiscordInboundMode(
        await promptSelectWithCustomInput(
          prompter,
          "Discord inbound mode",
          [
            { label: "file", value: "file" },
            { label: "gateway", value: "gateway" },
          ],
          options.discordInboundMode ?? defaults.channels.adapters.discord.inbound.mode,
        ),
      );
      webhookUrl = trimOptionalValue(
        await promptWithDefault(
          prompter,
          "Discord webhook URL (optional)",
          options.webhookUrl ?? "",
        ),
      );
      tokenEnvVar = requiredTrimmedValue(
        await promptWithDefault(
          prompter,
          "Discord token env var name",
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

    const enableTerminalAlerts = await promptBoolean(
      prompter,
      "Enable terminal alerts",
      parseBooleanInput(
        options.enableTerminalAlerts,
        defaults.alerts.channels.terminal.enabled,
        "terminal alerts",
      ),
    );

    const answers = resolveSetupAnswers({
      ...options,
      configPath,
      actorModel,
      supervisorModel,
      supervisorClient,
      discordEnabled: String(discordEnabled),
      discordInboundMode,
      webhookUrl,
      tokenEnvVar,
      allowedChannels: allowedChannels.join(","),
      allowedUsers: allowedUsers.join(","),
      mentionPrefix,
      enableTerminalAlerts: String(enableTerminalAlerts),
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

async function promptSelectWithCustomInput<TValue extends string>(
  prompter: SetupPrompter,
  label: string,
  choices: readonly SelectChoice<TValue>[],
  fallback: string,
): Promise<string> {
  const customLabel = "Custom input...";
  const fallbackIndex = choices.findIndex((choice) => choice.value === fallback);
  const options = [
    ...choices.map((choice) => choice.label),
    customLabel,
  ];

  if (prompter.select) {
    const selectedIndex = await prompter.select(
      `${label} (use arrow keys, Enter to confirm)`,
      options,
      fallbackIndex >= 0 ? fallbackIndex : choices.length,
    );
    if (selectedIndex < choices.length) {
      return choices[selectedIndex].value;
    }
  } else {
    const selectedValue = await fallbackSelectValue(prompter, label, choices, fallback, true);
    if (selectedValue != null) {
      return selectedValue;
    }
  }

  return requiredTrimmedValue(
    await prompter.ask(`Custom value for ${label}: `),
    label,
  );
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

function parseSupervisorClient(value: string): SupervisorClient {
  if (value === "mock" || value === "heuristic" || value === "openai-compatible") {
    return value;
  }

  throw new Error(`Unsupported supervisor client: ${value}`);
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

export function formatSetupSummary(answers: SetupAnswers): string {
  return [
    "Setup summary",
    "-------------",
    `Config path: ${answers.configPath}`,
    `Actor model: ${answers.actorModel}`,
    `Supervisor client: ${answers.supervisorClient}`,
    `Supervisor model: ${answers.supervisorModel}`,
    `Discord enabled: ${answers.discordEnabled ? "Yes" : "No"}`,
    `Discord inbound mode: ${answers.discordEnabled ? answers.discordInboundMode : "(disabled)"}`,
    `Discord webhook URL: ${answers.webhookUrl ?? "(none)"}`,
    `Discord token env var: ${answers.discordEnabled ? answers.tokenEnvVar : "(disabled)"}`,
    `Allowed Discord channels: ${formatListSummary(answers.allowedChannels)}`,
    `Allowed Discord users: ${formatListSummary(answers.allowedUsers)}`,
    `Mention prefix: ${answers.mentionPrefix ?? "(none)"}`,
    `Terminal alerts: ${answers.enableTerminalAlerts ? "Yes" : "No"}`,
  ].join("\n");
}

function formatListSummary(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
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
