import { setTimeout as sleep } from "node:timers/promises";
import { type ChannelAdapter } from "./adapter.js";
import {
  type ChannelInboundMessage,
  type ChannelMessageHandler,
  type ChannelOutboundEvent,
  type ChannelSendResult,
} from "./model.js";

export interface TelegramAdapterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TelegramChannelAdapterOptions {
  botToken?: string;
  chatId?: string;
  pollIntervalMs?: number;
  timeoutSeconds?: number;
  allowedChatIds?: readonly string[];
  allowedUserIds?: readonly string[];
  mentionPrefix?: string;
  fetchImpl?: typeof fetch;
  logger?: TelegramAdapterLogger;
  now?: () => string;
}

interface TelegramApiResponse<TPayload> {
  ok: boolean;
  result?: TPayload;
  description?: string;
  error_code?: number;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramMessageLike {
  message_id: number;
  date?: number;
  text?: string;
  caption?: string;
  chat: TelegramChat;
  from?: TelegramUser;
}

export interface TelegramUpdateLike {
  update_id: number;
  message?: TelegramMessageLike;
}

export interface NormalizeTelegramUpdateOptions {
  allowedChatIds?: readonly string[];
  allowedUserIds?: readonly string[];
  mentionPrefix?: string;
  defaultAllowedChatId?: string;
  now?: () => string;
}

export function normalizeTelegramUpdate(
  update: TelegramUpdateLike,
  options: NormalizeTelegramUpdateOptions = {},
): ChannelInboundMessage | null {
  const message = update.message;
  if (!message) {
    return null;
  }

  const sender = message.from;
  if (!sender || sender.is_bot) {
    return null;
  }

  const chatId = String(message.chat.id);
  const allowedChatIds = options.allowedChatIds && options.allowedChatIds.length > 0
    ? options.allowedChatIds
    : options.defaultAllowedChatId
      ? [options.defaultAllowedChatId]
      : [];
  if (allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) {
    return null;
  }

  if (
    options.allowedUserIds &&
    options.allowedUserIds.length > 0 &&
    !options.allowedUserIds.includes(String(sender.id))
  ) {
    return null;
  }

  const text = applyMentionPrefix(message.text ?? message.caption ?? "", options.mentionPrefix);
  if (text == null || text.length === 0) {
    return null;
  }

  const displayName = ([sender.first_name, sender.last_name]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    || sender.username
    || "").trim();
  const receivedAt = typeof message.date === "number"
    ? new Date(message.date * 1_000).toISOString()
    : (options.now ?? (() => new Date().toISOString()))();

  return {
    adapter: "telegram",
    messageId: String(message.message_id),
    conversationId: chatId,
    channelId: chatId,
    text,
    sender: {
      userId: String(sender.id),
      displayName: displayName.length > 0 ? displayName : undefined,
      isHuman: true,
    },
    receivedAt,
    raw: {
      updateId: update.update_id,
      chatId,
      chatType: message.chat.type,
      username: sender.username,
    },
  };
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private readonly fetchImpl: typeof fetch;
  private readonly logger: TelegramAdapterLogger;
  private readonly now: () => string;
  private handler: ChannelMessageHandler | null = null;
  private nextOffset = 0;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private activePollController: AbortController | null = null;

  constructor(private readonly options: TelegramChannelAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    const token = this.options.botToken?.trim() ?? "";
    if (token.length === 0) {
      this.logger.warn("[telegram] adapter enabled but bot token is not configured");
      return;
    }

    if (!this.handler) {
      return;
    }

    this.running = true;
    this.logger.info("[telegram] starting long-poll inbound loop");
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.activePollController?.abort();
    try {
      await this.loopPromise;
    } catch {
      // Polling failures are already logged.
    } finally {
      this.loopPromise = null;
      this.activePollController = null;
    }
  }

  async pollOnce(): Promise<number> {
    if (!this.handler) {
      return 0;
    }

    const updates = await this.fetchUpdates();
    let delivered = 0;

    for (const update of updates) {
      this.nextOffset = Math.max(this.nextOffset, update.update_id + 1);
      const normalized = normalizeTelegramUpdate(update, {
        allowedChatIds: this.options.allowedChatIds,
        allowedUserIds: this.options.allowedUserIds,
        mentionPrefix: this.options.mentionPrefix,
        defaultAllowedChatId: this.options.chatId,
        now: this.now,
      });
      if (!normalized) {
        continue;
      }

      try {
        await this.handler(normalized);
        delivered += 1;
      } catch (error) {
        this.logger.error(
          `[telegram] inbound handler failed for update ${update.update_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return delivered;
  }

  async send(event: ChannelOutboundEvent): Promise<ChannelSendResult> {
    const botToken = this.options.botToken?.trim() ?? "";
    if (botToken.length === 0) {
      return {
        channel: this.name,
        status: "skipped",
        detail: "Telegram bot token is not configured",
      };
    }

    const chatId = event.target.conversationId?.trim() || this.options.chatId?.trim() || "";
    if (chatId.length === 0) {
      return {
        channel: this.name,
        status: "skipped",
        detail: "Telegram chat id is not configured",
      };
    }

    const response = await this.fetchImpl(buildTelegramApiUrl(botToken, "sendMessage"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramContent(event),
        ...(event.target.replyToMessageId && Number.isFinite(Number(event.target.replyToMessageId))
          ? {
            reply_parameters: {
              message_id: Number(event.target.replyToMessageId),
            },
          }
          : {}),
      }),
    });

    const parsed = await parseTelegramApiResponse<unknown>(response);
    if (!parsed.ok) {
      return {
        channel: this.name,
        status: "failed",
        detail: parsed.detail,
      };
    }

    return {
      channel: this.name,
      status: "sent",
      detail: `sent Telegram message to ${chatId}`,
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running && isAbortError(error)) {
          break;
        }
        this.logger.error(
          `[telegram] polling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (this.running) {
          await sleep(this.options.pollIntervalMs ?? 1_000);
        }
      }
    }

    this.logger.info("[telegram] inbound loop stopped");
  }

  private async fetchUpdates(): Promise<TelegramUpdateLike[]> {
    const botToken = this.options.botToken?.trim() ?? "";
    if (botToken.length === 0) {
      return [];
    }

    const controller = new AbortController();
    this.activePollController = controller;

    try {
      const response = await this.fetchImpl(buildTelegramApiUrl(botToken, "getUpdates"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          offset: this.nextOffset > 0 ? this.nextOffset : undefined,
          timeout: this.options.timeoutSeconds ?? 30,
          allowed_updates: ["message"],
        }),
        signal: controller.signal,
      });

      const parsed = await parseTelegramApiResponse<TelegramUpdateLike[]>(response);
      if (!parsed.ok) {
        throw new Error(parsed.detail);
      }

      return parsed.result;
    } finally {
      if (this.activePollController === controller) {
        this.activePollController = null;
      }
    }
  }
}

function formatTelegramContent(event: ChannelOutboundEvent): string {
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

  return [
    `Lumo ${event.severity.toUpperCase()} supervisor alert`,
    `task=${event.taskId}`,
    `action=${event.decision.action}`,
    `reason=${event.decision.reason}`,
    event.decision.suggestion ? `suggestion=${event.decision.suggestion}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" | ");
}

async function parseTelegramApiResponse<TPayload>(
  response: Response,
): Promise<
  | { ok: true; result: TPayload }
  | { ok: false; detail: string }
> {
  const rawBody = await response.text();
  let parsedBody: TelegramApiResponse<TPayload> | undefined;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody) as TelegramApiResponse<TPayload>;
    } catch {
      parsedBody = undefined;
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      detail: `HTTP ${response.status}${rawBody ? ` ${rawBody.slice(0, 200)}` : ""}`,
    };
  }

  if (!parsedBody?.ok) {
    return {
      ok: false,
      detail: parsedBody?.description
        ?? `Telegram API request failed${parsedBody?.error_code ? ` (${parsedBody.error_code})` : ""}`,
    };
  }

  return {
    ok: true,
    result: parsedBody.result as TPayload,
  };
}

function buildTelegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
