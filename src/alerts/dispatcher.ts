import { type CommandResult, type CommandRunner } from "../runtime/subprocess.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "../supervisor/decision.js";

export interface AlertEvent {
  decision: SupervisorDecision;
  batch: LogBatch;
  taskId: string;
  actorAgentId: string;
  supervisorAgentId: string;
  occurredAt: string;
}

export interface AlertDispatchResult {
  channel: string;
  status: "sent" | "skipped" | "failed";
  detail: string;
}

export interface AlertChannel {
  readonly name: string;
  send(event: AlertEvent): Promise<AlertDispatchResult>;
}

export interface AlertDispatcherLike {
  dispatch(event: AlertEvent): Promise<AlertDispatchResult[]>;
}

export class AlertDispatcher implements AlertDispatcherLike {
  constructor(private readonly channels: readonly AlertChannel[] = []) {}

  async dispatch(event: AlertEvent): Promise<AlertDispatchResult[]> {
    const results: AlertDispatchResult[] = [];

    for (const channel of this.channels) {
      try {
        results.push(await channel.send(event));
      } catch (error) {
        results.push({
          channel: channel.name,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}

export class TerminalAlertChannel implements AlertChannel {
  readonly name = "terminal";

  constructor(
    private readonly options: {
      bell?: boolean;
      writer?: { write: (text: string) => void };
    } = {},
  ) {}

  async send(event: AlertEvent): Promise<AlertDispatchResult> {
    const writer = this.options.writer ?? process.stdout;
    if (!writer?.write) {
      return {
        channel: this.name,
        status: "skipped",
        detail: "terminal writer is not available",
      };
    }
    const lines = [
      `[lumo alert] ${event.decision.status.toUpperCase()} task=${event.taskId}`,
      `reason=${event.decision.reason}`,
    ];

    if (event.decision.suggestion) {
      lines.push(`suggestion=${event.decision.suggestion}`);
    }

    if (this.options.bell) {
      writer.write("\u0007");
    }
    writer.write(`${lines.join(" ")}\n`);

    return {
      channel: this.name,
      status: "sent",
      detail: `wrote alert to terminal${this.options.bell ? " with bell" : ""}`,
    };
  }
}

export class DiscordWebhookAlertChannel implements AlertChannel {
  readonly name = "discord-webhook";

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(event: AlertEvent): Promise<AlertDispatchResult> {
    if (this.webhookUrl.trim().length === 0) {
      return {
        channel: this.name,
        status: "skipped",
        detail: "webhook URL is not configured",
      };
    }

    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: formatWebhookContent(event),
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
      detail: "posted alert to Discord webhook",
    };
  }
}

export class TelegramBotAlertChannel implements AlertChannel {
  readonly name = "telegram-bot";

  async send(): Promise<AlertDispatchResult> {
    return {
      channel: this.name,
      status: "skipped",
      detail: "Telegram bot dispatch is not implemented yet",
    };
  }
}

export class VoiceCallAlertChannel implements AlertChannel {
  readonly name = "voice-call";

  constructor(
    private readonly options: {
      recipient?: string;
      providerCommandTemplate?: readonly string[];
      executor?: CommandRunner;
      logger?: {
        warn(message: string): void;
      };
    } = {},
  ) {}

  async send(event: AlertEvent): Promise<AlertDispatchResult> {
    if (event.decision.status !== "critical") {
      return {
        channel: this.name,
        status: "skipped",
        detail: "voice-call alerts are only sent for critical decisions",
      };
    }

    const recipient = this.options.recipient?.trim() ?? "";
    const template = this.options.providerCommandTemplate ?? [];
    if (recipient.length === 0 || template.length === 0) {
      const detail = "voice-call provider command template or recipient is not configured";
      this.options.logger?.warn(`[voice-call] ${detail}`);
      return {
        channel: this.name,
        status: "skipped",
        detail,
      };
    }

    if (!this.options.executor) {
      const detail = "voice-call executor is not configured";
      this.options.logger?.warn(`[voice-call] ${detail}`);
      return {
        channel: this.name,
        status: "skipped",
        detail,
      };
    }

    const expanded = expandVoiceCallTemplate(template, event, recipient);
    const [command, ...args] = expanded;
    if (!command || command.trim().length === 0) {
      const detail = "voice-call provider command template did not resolve to a command";
      this.options.logger?.warn(`[voice-call] ${detail}`);
      return {
        channel: this.name,
        status: "skipped",
        detail,
      };
    }

    const result = await this.options.executor.run(command, args);
    if (result.exitCode !== 0) {
      return {
        channel: this.name,
        status: "failed",
        detail: formatVoiceCallFailure(result),
      };
    }

    return {
      channel: this.name,
      status: "sent",
      detail: `invoked voice-call provider for ${recipient}`,
    };
  }
}

function formatWebhookContent(event: AlertEvent): string {
  const summary = [
    `Lumo ${event.decision.status.toUpperCase()} alert`,
    `task=${event.taskId}`,
    `action=${event.decision.action}`,
    `reason=${event.decision.reason}`,
  ];

  if (event.decision.suggestion) {
    summary.push(`suggestion=${event.decision.suggestion}`);
  }

  return summary.join(" | ");
}

function expandVoiceCallTemplate(
  template: readonly string[],
  event: AlertEvent,
  recipient: string,
): string[] {
  const message = formatWebhookContent(event);
  const tokens: Record<string, string> = {
    recipient,
    message,
    taskId: event.taskId,
    severity: event.decision.status,
    action: event.decision.action,
    reason: event.decision.reason,
    suggestion: event.decision.suggestion ?? "",
    actorAgentId: event.actorAgentId,
    supervisorAgentId: event.supervisorAgentId,
  };

  return template.map((part) =>
    part.replace(/\{([a-zA-Z0-9]+)\}/g, (_match, key: string) => tokens[key] ?? ""),
  );
}

function formatVoiceCallFailure(result: CommandResult): string {
  const parts = [`exit code ${result.exitCode ?? "unknown"}`];
  if (result.stderr.length > 0) {
    parts.push(result.stderr.slice(0, 200));
  } else if (result.stdout.length > 0) {
    parts.push(result.stdout.slice(0, 200));
  }

  return parts.join(" ");
}
