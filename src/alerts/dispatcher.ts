import { type CommandResult, type CommandRunner } from "../runtime/subprocess.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { type SupervisorEscalationReport } from "../supervisor/escalation-report.js";

export interface AlertEvent {
  decision: SupervisorDecision;
  batch: LogBatch;
  taskId: string;
  actorAgentId: string;
  supervisorAgentId: string;
  occurredAt: string;
  report: SupervisorEscalationReport;
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
      `[lumo alert] ${event.report.severity.toUpperCase()} task=${event.taskId}`,
      `title=${event.report.title}`,
      `summary=${event.report.summary}`,
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
      body: JSON.stringify(buildDiscordWebhookPayload(event)),
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

function buildDiscordWebhookPayload(event: AlertEvent): {
  content: string;
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    footer: { text: string };
    url?: string;
    image?: { url: string };
  }>;
  allowed_mentions: { parse: [] };
} {
  const browserUrl = event.report.browserState?.url ?? event.report.evidence.url;
  const screenshotUrl = asWebhookUrl(
    event.report.browserState?.screenshotRef?.url ?? event.report.evidence.screenshotRef?.url,
  );
  const embed = {
    title: truncateForDiscord(event.report.title, 256),
    description: truncateForDiscord(buildDiscordDescription(event), 4096),
    color: event.report.severity === "critical" ? 0xed4245 : 0xfee75c,
    timestamp: event.occurredAt,
    fields: buildDiscordFields(event),
    footer: {
      text: truncateForDiscord(
        `task=${event.taskId} actor=${event.actorAgentId} supervisor=${event.supervisorAgentId}`,
        2048,
      ),
    },
    ...(browserUrl ? { url: browserUrl } : {}),
    ...(screenshotUrl ? { image: { url: screenshotUrl } } : {}),
  };

  return {
    content: formatWebhookContent(event),
    embeds: [embed],
    allowed_mentions: {
      parse: [],
    },
  };
}

function formatWebhookContent(event: AlertEvent): string {
  const summary = [
    `Lumo ${event.report.severity.toUpperCase()} alert`,
    `task=${event.taskId}`,
    `title=${event.report.title}`,
    `action=${event.decision.action}`,
    `reason=${event.report.summary}`,
  ];

  if (event.decision.suggestion) {
    summary.push(`suggestion=${event.decision.suggestion}`);
  }

  return summary.join(" | ");
}

function buildDiscordDescription(event: AlertEvent): string {
  const parts = [event.report.summary];
  if (event.report.currentActivity) {
    parts.push(`Current activity: ${event.report.currentActivity}`);
  }
  if (event.report.lastMeaningfulProgress) {
    parts.push(`Last progress: ${event.report.lastMeaningfulProgress}`);
  }
  if (event.decision.suggestion) {
    parts.push(`Suggested operator action: ${event.decision.suggestion}`);
  }
  return parts.join("\n\n");
}

function buildDiscordFields(event: AlertEvent): Array<{ name: string; value: string; inline?: boolean }> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: "Decision",
      value: truncateForDiscord(`${event.decision.status} -> ${event.decision.action}`, 1024),
      inline: true,
    },
    {
      name: "Recommended action",
      value: truncateForDiscord(event.report.recommendedAction, 1024),
      inline: true,
    },
    {
      name: "Confidence",
      value: truncateForDiscord(`${Math.round(event.decision.confidence * 100)}%`, 1024),
      inline: true,
    },
  ];

  if (event.report.bottleneck) {
    fields.push({
      name: "Bottleneck",
      value: truncateForDiscord(
        `${event.report.bottleneck.kind}: ${event.report.bottleneck.summary}`,
        1024,
      ),
    });
  }

  const browserState = event.report.browserState;
  const browserUrl = browserState?.url ?? event.report.evidence.url;
  if (browserUrl || browserState?.title || browserState?.pageKind) {
    fields.push({
      name: "Browser",
      value: truncateForDiscord(
        [
          browserUrl ? `URL: ${browserUrl}` : undefined,
          browserState?.title ? `Title: ${browserState.title}` : undefined,
          browserState?.pageKind ? `Page: ${browserState.pageKind}` : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n"),
        1024,
      ),
    });
  }

  if (event.report.evidence.latestTool || event.report.evidence.latestStep || event.report.evidence.latestInput) {
    fields.push({
      name: "Latest execution",
      value: truncateForDiscord(
        [
          event.report.evidence.latestStep != null ? `Step: ${event.report.evidence.latestStep}` : undefined,
          event.report.evidence.latestTool ? `Tool: ${event.report.evidence.latestTool}` : undefined,
          event.report.evidence.latestInput ? `Input: ${event.report.evidence.latestInput}` : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n"),
        1024,
      ),
    });
  }

  const screenshotRef = event.report.browserState?.screenshotRef ?? event.report.evidence.screenshotRef;
  const screenshotLocation = screenshotRef?.url ?? screenshotRef?.path;
  if (screenshotLocation) {
    fields.push({
      name: "Screenshot",
      value: truncateForDiscord(screenshotLocation, 1024),
    });
  }

  return fields.slice(0, 25);
}

function asWebhookUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return /^https?:\/\//i.test(value) ? value : undefined;
}

function truncateForDiscord(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
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
