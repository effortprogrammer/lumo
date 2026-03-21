import { type ToolExecutionRecord } from "../domain/task.js";
import { type SessionManager } from "../runtime/session-manager.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { type SupervisorEscalationReport } from "../supervisor/escalation-report.js";
import { type ChannelAdapter } from "./adapter.js";
import { executeIntentEnvelope } from "./intent-executor.js";
import { IntentResolverPipeline, type IntentResolver } from "./intent-resolver.js";
import {
  type ChannelInboundMessage,
  type ChannelMessageHandler,
  type ChannelReplyTarget,
} from "./model.js";

export interface ConversationRouterOptions {
  sessionManager: SessionManager;
  adapters: readonly ChannelAdapter[];
  commandMapping: {
    new: string[];
    followup: string[];
    resume: string[];
    halt: string[];
    status: string[];
  };
  intentResolver?: IntentResolver;
  startTaskConfidenceThreshold?: number;
  now?: () => string;
  createSessionCallbacks?: (target: ChannelReplyTarget) => {
    onLog?: (record: ToolExecutionRecord) => void;
    onDecision?: (decision: SupervisorDecision) => void;
    onStatusChange?: (status: "pending" | "running" | "paused" | "halted" | "completed" | "failed") => void;
  };
}

export class ConversationRouter {
  private readonly now: () => string;
  private readonly intentResolver: IntentResolver;
  private currentTarget: ChannelReplyTarget | null = null;

  constructor(private readonly options: ConversationRouterOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.intentResolver = options.intentResolver ?? new IntentResolverPipeline({
      commandMapping: options.commandMapping,
      startTaskConfidenceThreshold: options.startTaskConfidenceThreshold,
    });
  }

  createHandler(): ChannelMessageHandler {
    return async (message) => {
      await this.handleInboundMessage(message);
    };
  }

  async handleInboundMessage(message: ChannelInboundMessage): Promise<void> {
    if (!message.sender.isHuman) {
      return;
    }

    this.currentTarget = {
      adapter: message.adapter,
      conversationId: message.conversationId,
      guildId: message.guildId,
      channelId: message.channelId,
      threadId: message.threadId,
      replyToMessageId: message.messageId,
    };

    try {
      const envelope = await this.intentResolver.resolve(message.text, {
        hasActiveTask: Boolean(this.options.sessionManager.current),
        currentTaskId: this.options.sessionManager.current?.runtime.task.task.taskId ?? null,
        currentTaskStatus: this.options.sessionManager.current?.runtime.task.task.status ?? null,
      });
      const reply = await executeIntentEnvelope(envelope, {
        sessionManager: this.options.sessionManager,
        createSessionCallbacks: () => this.options.createSessionCallbacks?.(this.currentTarget!),
      });
      await this.reply(this.currentTarget, reply);
    } catch (error) {
      await this.reply(
        this.currentTarget,
        `Intent routing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async emitTaskLifecycle(status: "pending" | "running" | "paused" | "halted" | "completed" | "failed"): Promise<void> {
    const current = this.options.sessionManager.current;
    if (!current || !this.currentTarget) {
      return;
    }

    const task = current.runtime.task.task;
    await this.sendToCurrentTarget({
      type: "task.lifecycle",
      target: this.currentTarget,
      occurredAt: this.now(),
      taskId: task.taskId,
      status,
      step: task.currentStep,
      summary: `task=${task.taskId} status=${status} step=${task.currentStep}`,
    });
  }

  async emitSupervisorAlert(
    decision: SupervisorDecision,
    report?: SupervisorEscalationReport,
  ): Promise<void> {
    const current = this.options.sessionManager.current;
    if (!current || !this.currentTarget) {
      return;
    }

    if (decision.status !== "warning" && decision.status !== "critical") {
      return;
    }

    await this.sendToCurrentTarget({
      type: "supervisor.alert",
      target: this.currentTarget,
      occurredAt: this.now(),
      taskId: current.runtime.task.task.taskId,
      severity: decision.status,
      decision,
      report,
    });
  }

  private async reply(target: ChannelReplyTarget, text: string): Promise<void> {
    await this.sendToCurrentTarget({
      type: "router.reply",
      target,
      occurredAt: this.now(),
      text,
    });
  }

  private async sendToCurrentTarget(event: {
    type: "router.reply";
    target: ChannelReplyTarget;
    occurredAt: string;
    text: string;
  } | {
    type: "task.lifecycle";
    target: ChannelReplyTarget;
    occurredAt: string;
    taskId: string;
    status: "pending" | "running" | "paused" | "halted" | "completed" | "failed";
    step: number;
    summary: string;
  } | {
    type: "supervisor.alert";
    target: ChannelReplyTarget;
    occurredAt: string;
    taskId: string;
    severity: "warning" | "critical";
    decision: SupervisorDecision;
    report?: SupervisorEscalationReport;
  }): Promise<void> {
    const adapter = this.options.adapters.find((candidate) => candidate.name === event.target.adapter);
    if (!adapter) {
      return;
    }
    await adapter.send(event);
  }
}
