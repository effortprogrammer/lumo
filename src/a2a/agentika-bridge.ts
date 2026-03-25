import {
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
} from "./protocol.js";
import { type LumoEventBus } from "../event/bus.js";
import { type SupervisorDecision } from "../supervisor/decision.js";

type AgentikaBridgeAdapter = {
  sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void>;
  cancelTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void>;
  registerMessageHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void;
  stop?(): void;
};

export interface AgentikaBridgeOptions {
  adapter: AgentikaBridgeAdapter;
  taskId: string;
  eventSink?: LumoEventBus;
}

export class AgentikaBridge {
  constructor(private readonly options: AgentikaBridgeOptions) {}

  async publishActorProgress(
    envelope: A2AEnvelope<A2AMessage>,
    options: { shadowOnly?: boolean; emitEvent?: boolean } = {},
  ): Promise<void> {
    if (!options.shadowOnly) {
      await this.options.adapter.sendMessage(envelope);
    }
    if (options.emitEvent === false) {
      return;
    }
    await this.options.eventSink?.publish({
      topic: `task.${this.options.taskId}.events`,
      type: "actor.progress",
      source: "lumo.bridge",
      correlationId: envelope.pairId,
      idempotencyKey: this.extractProgressId(envelope) ?? envelope.id,
      payload: this.extractJsonPayload(envelope),
    });
  }

  async publishSupervisorDecision(
    envelope: A2AEnvelope<A2AMessage> | A2AEnvelope<CancelTaskRequest>,
    decision: SupervisorDecision,
    options: { shadowOnly?: boolean; emitEvent?: boolean } = {},
  ): Promise<void> {
    if (!options.shadowOnly) {
      if (this.isCancelEnvelope(envelope)) {
        await this.options.adapter.cancelTask(envelope);
      } else {
        await this.options.adapter.sendMessage(envelope);
      }
    }
    if (options.emitEvent === false) {
      return;
    }
    await this.options.eventSink?.publish({
      topic: `task.${this.options.taskId}.events`,
      type: "supervisor.decision",
      source: "lumo.bridge",
      correlationId: envelope.pairId,
      idempotencyKey: envelope.id,
      payload: {
        ...decision,
        occurredAt: envelope.sentAt ?? this.extractMessageSentAt(envelope),
      },
    });
  }

  async startFeedbackConsumer(
    actorAgentId: string,
    onFeedback: (envelope: A2AEnvelope<A2AMessage>) => Promise<void>,
  ): Promise<void> {
    this.options.adapter.registerMessageHandler(actorAgentId, onFeedback);
  }

  stop(): void {
    this.options.adapter.stop?.();
  }

  private isCancelEnvelope(
    envelope: A2AEnvelope<A2AMessage> | A2AEnvelope<CancelTaskRequest>,
  ): envelope is A2AEnvelope<CancelTaskRequest> {
    return "reason" in envelope.payload;
  }

  private extractJsonPayload(envelope: A2AEnvelope<A2AMessage>): Record<string, unknown> {
    const jsonPart = envelope.payload.parts.find((part): part is { kind: "json"; data: Record<string, unknown> } =>
      part.kind === "json" && typeof part.data === "object" && part.data !== null);
    return jsonPart?.data ?? {
      messageId: envelope.payload.id,
      sentAt: envelope.payload.sentAt,
    };
  }

  private extractProgressId(envelope: A2AEnvelope<A2AMessage>): string | undefined {
    const payload = this.extractJsonPayload(envelope);
    return typeof payload.progressId === "string" ? payload.progressId : undefined;
  }

  private extractMessageSentAt(
    envelope: A2AEnvelope<A2AMessage> | A2AEnvelope<CancelTaskRequest>,
  ): string | undefined {
    if (this.isCancelEnvelope(envelope)) {
      return envelope.payload.requestedAt;
    }
    return envelope.payload.sentAt;
  }
}
