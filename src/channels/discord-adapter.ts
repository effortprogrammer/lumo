import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type ChannelAdapter,
} from "./adapter.js";
import {
  type ChannelInboundMessage,
  type ChannelMessageHandler,
  type ChannelOutboundEvent,
  type ChannelParticipant,
  type ChannelSendResult,
} from "./model.js";

export interface DiscordInboundBridge {
  pollMessages(): Promise<ChannelInboundMessage[]>;
  start?(handler: ChannelMessageHandler): Promise<void>;
  stop?(): Promise<void>;
}

export interface FileDiscordBridgeOptions {
  filePath: string;
  now?: () => string;
}

export class FileDiscordInboundBridge implements DiscordInboundBridge {
  private consumedLines = 0;
  private readonly now: () => string;

  constructor(private readonly options: FileDiscordBridgeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async pollMessages(): Promise<ChannelInboundMessage[]> {
    if (!existsSync(this.options.filePath)) {
      return [];
    }

    const raw = await readFile(this.options.filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const pending = lines.slice(this.consumedLines);
    this.consumedLines = lines.length;

    return pending.map((line, index) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const messageId = asString(parsed.messageId) ?? `discord-file-${this.consumedLines - pending.length + index + 1}`;
      const conversationId = asString(parsed.conversationId) ?? "discord-local";
      const text = asString(parsed.text) ?? "";
      const userId = asString(parsed.userId) ?? "local-user";
      const displayName = asString(parsed.displayName);
      const receivedAt = asString(parsed.receivedAt) ?? this.now();

      return {
        adapter: "discord",
        messageId,
        conversationId,
        guildId: asString(parsed.guildId),
        channelId: asString(parsed.channelId),
        threadId: asString(parsed.threadId),
        text,
        sender: {
          userId,
          displayName,
          isHuman: parsed.isHuman === false ? false : true,
        },
        receivedAt,
        raw: parsed,
      };
    });
  }
}

export interface DiscordGatewayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DiscordGatewayHealthcheckOptions {
  token: string;
  tokenEnvVar: string;
  fetchImpl?: typeof fetch;
}

export interface DiscordGatewayHealthcheckResult {
  ok: boolean;
  detail: string;
}

export interface DiscordGatewayUser {
  id: string;
}

export interface DiscordGatewayMember {
  displayName?: string;
}

export interface DiscordGatewayChannelLike {
  id?: string;
  parentId?: string | null;
  isThread?(): boolean;
}

export interface DiscordGatewayAuthor {
  id: string;
  username?: string;
  globalName?: string | null;
  bot?: boolean;
}

export interface DiscordGatewayMessageLike {
  id: string;
  content?: string;
  createdAt?: Date;
  createdTimestamp?: number;
  webhookId?: string | null;
  guildId?: string | null;
  channelId?: string;
  author: DiscordGatewayAuthor;
  member?: DiscordGatewayMember | null;
  channel?: DiscordGatewayChannelLike | null;
}

export interface DiscordGatewayClient {
  user?: DiscordGatewayUser | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): void;
}

export interface NormalizeDiscordGatewayMessageOptions {
  ownUserId?: string;
  allowedChannels?: readonly string[];
  allowedUsers?: readonly string[];
  mentionPrefix?: string;
  now?: () => string;
}

export interface DiscordGatewayBridgeOptions extends NormalizeDiscordGatewayMessageOptions {
  token: string;
  tokenEnvVar: string;
  logger?: DiscordGatewayLogger;
  createClient?: () => Promise<DiscordGatewayClient>;
}

export function normalizeDiscordGatewayMessage(
  message: DiscordGatewayMessageLike,
  options: NormalizeDiscordGatewayMessageOptions = {},
): ChannelInboundMessage | null {
  const ownUserId = options.ownUserId?.trim();
  if (ownUserId && message.author.id === ownUserId) {
    return null;
  }

  if (message.author.bot || message.webhookId) {
    return null;
  }

  if (
    options.allowedUsers &&
    options.allowedUsers.length > 0 &&
    !options.allowedUsers.includes(message.author.id)
  ) {
    return null;
  }

  const scope = getDiscordScope(message);
  if (!matchesAllowedDiscordScopes(scope, options.allowedChannels ?? [])) {
    return null;
  }

  const text = applyMentionPrefix(message.content ?? "", options.mentionPrefix);
  if (text == null || text.length === 0) {
    return null;
  }

  const sender = normalizeSender(message.author, message.member);
  const receivedAt = message.createdAt?.toISOString()
    ?? (typeof message.createdTimestamp === "number"
      ? new Date(message.createdTimestamp).toISOString()
      : (options.now ?? (() => new Date().toISOString()))());

  return {
    adapter: "discord",
    messageId: message.id,
    conversationId: scope.threadId ?? scope.channelId ?? scope.guildId ?? `discord-${message.id}`,
    guildId: scope.guildId,
    channelId: scope.channelId,
    threadId: scope.threadId,
    text,
    sender,
    receivedAt,
    raw: {
      id: message.id,
      guildId: scope.guildId,
      channelId: scope.channelId,
      threadId: scope.threadId,
      authorId: message.author.id,
    },
  };
}

export class DiscordGatewayInboundBridge implements DiscordInboundBridge {
  private readonly logger: DiscordGatewayLogger;
  private readonly createClient: () => Promise<DiscordGatewayClient>;
  private client: DiscordGatewayClient | null = null;
  private started = false;

  constructor(private readonly options: DiscordGatewayBridgeOptions) {
    this.logger = options.logger ?? console;
    this.createClient = options.createClient ?? createDiscordJsGatewayClient;
  }

  async start(handler: ChannelMessageHandler): Promise<void> {
    if (this.started) {
      return;
    }

    const token = this.options.token.trim();
    if (token.length === 0) {
      this.logger.warn(
        `[discord.gateway] inbound mode is enabled but token env var ${this.options.tokenEnvVar} is empty`,
      );
      return;
    }

    const client = await this.createClient();
    this.client = client;
    this.started = true;

    client.on("ready", () => {
      this.logger.info(`[discord.gateway] connected as ${client.user?.id ?? "unknown-user"}`);
    });
    client.on("shardReconnecting", () => {
      this.logger.warn("[discord.gateway] reconnecting to Discord gateway");
    });
    client.on("shardResume", (_replayedEvents: number, shardId: number) => {
      this.logger.info(`[discord.gateway] resumed gateway session for shard ${shardId}`);
    });
    client.on("shardDisconnect", (event: { code?: number }, shardId: number) => {
      this.logger.warn(
        `[discord.gateway] disconnected shard ${shardId}${event?.code != null ? ` code=${event.code}` : ""}`,
      );
    });
    client.on("error", (error: unknown) => {
      this.logger.error(
        `[discord.gateway] client error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    client.on("warn", (message: string) => {
      this.logger.warn(`[discord.gateway] ${message}`);
    });
    client.on("messageCreate", (message: DiscordGatewayMessageLike) => {
      const normalized = normalizeDiscordGatewayMessage(message, {
        ownUserId: client.user?.id,
        allowedChannels: this.options.allowedChannels,
        allowedUsers: this.options.allowedUsers,
        mentionPrefix: this.options.mentionPrefix,
        now: this.options.now,
      });
      if (!normalized) {
        return;
      }
      void Promise.resolve(handler(normalized)).catch((error: unknown) => {
        this.logger.error(
          `[discord.gateway] inbound handler failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });

    this.logger.info("[discord.gateway] logging in with bot token");
    await client.login(token);
  }

  async stop(): Promise<void> {
    if (!this.client) {
      this.started = false;
      return;
    }

    this.logger.info("[discord.gateway] shutting down client");
    this.client.destroy();
    this.client = null;
    this.started = false;
  }

  async pollMessages(): Promise<ChannelInboundMessage[]> {
    return [];
  }
}

export async function runDiscordGatewayHealthcheck(
  options: DiscordGatewayHealthcheckOptions,
): Promise<DiscordGatewayHealthcheckResult> {
  const token = options.token.trim();
  if (token.length === 0) {
    return {
      ok: false,
      detail: `token env var ${options.tokenEnvVar} is empty`,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl("https://discord.com/api/v10/users/@me", {
    headers: {
      authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      detail: `HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
    };
  }

  const raw = await response.text().catch(() => "");
  let parsed: Record<string, unknown> | undefined;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }

  const userId = asString(parsed?.id) ?? "unknown-user";
  const username = asString(parsed?.username);
  return {
    ok: true,
    detail: `authenticated Discord bot ${username ? `${username} ` : ""}(${userId}) via ${options.tokenEnvVar}`,
  };
}

export interface DiscordChannelAdapterOptions {
  webhookUrl?: string;
  inboundBridge?: DiscordInboundBridge;
  fetchImpl?: typeof fetch;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly name = "discord";
  private readonly fetchImpl: typeof fetch;
  private handler: ChannelMessageHandler | null = null;

  constructor(private readonly options: DiscordChannelAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.options.inboundBridge?.start || !this.handler) {
      return;
    }

    await this.options.inboundBridge.start(this.handler);
  }

  async stop(): Promise<void> {
    await this.options.inboundBridge?.stop?.();
  }

  async pollOnce(): Promise<number> {
    if (!this.options.inboundBridge || !this.handler) {
      return 0;
    }

    const messages = await this.options.inboundBridge.pollMessages();
    for (const message of messages) {
      await this.handler(message);
    }
    return messages.length;
  }

  async send(event: ChannelOutboundEvent): Promise<ChannelSendResult> {
    const webhookUrl = this.options.webhookUrl?.trim() ?? "";
    if (webhookUrl.length === 0) {
      return {
        channel: this.name,
        status: "skipped",
        detail: "Discord webhook URL is not configured",
      };
    }

    const response = await this.fetchImpl(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: formatDiscordContent(event),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        channel: this.name,
        status: "failed",
        detail: `HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      };
    }

    return {
      channel: this.name,
      status: "sent",
      detail: "posted outbound event to Discord webhook",
    };
  }
}

function formatDiscordContent(event: ChannelOutboundEvent): string {
  if (event.type === "router.reply") {
    return event.text;
  }

  if (event.type === "task.lifecycle") {
    return [
      "Lumo task update",
      `task=${event.taskId}`,
      `status=${event.status}`,
      `step=${event.step}`,
      event.summary,
    ].join(" | ");
  }

  const parts = [
    `Lumo ${event.severity.toUpperCase()} supervisor alert`,
    `task=${event.taskId}`,
    `action=${event.decision.action}`,
    `reason=${event.decision.reason}`,
    event.decision.suggestion ? `suggestion=${event.decision.suggestion}` : undefined,
  ];

  if (event.report?.bottleneck) {
    parts.push(`bottleneck=${event.report.bottleneck.kind}`);
  }

  const browserUrl = event.report?.browserState?.url ?? event.report?.evidence.url;
  if (browserUrl) {
    parts.push(`url=${browserUrl}`);
  }

  const screenshot = event.report?.browserState?.screenshotRef?.url
    ?? event.report?.evidence.screenshotRef?.url
    ?? event.report?.browserState?.screenshotRef?.path
    ?? event.report?.evidence.screenshotRef?.path;
  if (screenshot) {
    parts.push(`screenshot=${screenshot}`);
  }

  return parts
    .filter((part): part is string => Boolean(part))
    .join(" | ");
}

function normalizeSender(
  author: DiscordGatewayAuthor,
  member?: DiscordGatewayMember | null,
): ChannelParticipant {
  return {
    userId: author.id,
    displayName: member?.displayName ?? author.globalName ?? author.username,
    isHuman: !author.bot,
  };
}

function applyMentionPrefix(text: string, mentionPrefix: string | undefined): string | null {
  const trimmed = text.trim();
  if (!mentionPrefix || mentionPrefix.trim().length === 0) {
    return trimmed;
  }

  const prefix = mentionPrefix.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  return trimmed.slice(prefix.length).trim();
}

function getDiscordScope(message: DiscordGatewayMessageLike): {
  guildId?: string;
  channelId?: string;
  threadId?: string;
} {
  const guildId = asString(message.guildId);
  const channel = message.channel;
  const rawChannelId = asString(message.channelId) ?? asString(channel?.id);
  const isThread = channel?.isThread?.() === true;

  if (isThread) {
    return {
      guildId,
      channelId: asString(channel?.parentId) ?? rawChannelId,
      threadId: rawChannelId,
    };
  }

  return {
    guildId,
    channelId: rawChannelId,
  };
}

function matchesAllowedDiscordScopes(
  scope: { guildId?: string; channelId?: string; threadId?: string },
  allowedChannels: readonly string[],
): boolean {
  if (allowedChannels.length === 0) {
    return true;
  }

  const candidates = new Set<string>();
  if (scope.guildId) {
    candidates.add(scope.guildId);
    candidates.add(`guild:${scope.guildId}`);
  }
  if (scope.channelId) {
    candidates.add(scope.channelId);
    candidates.add(`channel:${scope.channelId}`);
  }
  if (scope.threadId) {
    candidates.add(scope.threadId);
    candidates.add(`thread:${scope.threadId}`);
  }
  if (scope.guildId && scope.channelId) {
    candidates.add(`guild:${scope.guildId}/channel:${scope.channelId}`);
  }
  if (scope.channelId && scope.threadId) {
    candidates.add(`channel:${scope.channelId}/thread:${scope.threadId}`);
  }
  if (scope.guildId && scope.channelId && scope.threadId) {
    candidates.add(`guild:${scope.guildId}/channel:${scope.channelId}/thread:${scope.threadId}`);
  }

  return allowedChannels.some((entry) => candidates.has(entry));
}

async function createDiscordJsGatewayClient(): Promise<DiscordGatewayClient> {
  const moduleName = "discord.js";
  const discord = await import(moduleName) as {
    Client: new (options: { intents: number[] }) => DiscordGatewayClient;
    GatewayIntentBits: Record<string, number>;
  };

  return new discord.Client({
    intents: [
      discord.GatewayIntentBits.Guilds,
      discord.GatewayIntentBits.GuildMessages,
      discord.GatewayIntentBits.MessageContent,
    ],
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
