import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
} from "../a2a/protocol.js";
import { type AlertDispatcherLike } from "../alerts/dispatcher.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "./decision.js";
import { type SupervisorModelClient } from "./model-client.js";

export interface SupervisorPipelineOptions {
  adapter: A2AAgentAdapter;
  client: SupervisorModelClient;
  actorAgentId: string;
  supervisorAgentId: string;
  now?: () => string;
  onDecision?: (decision: SupervisorDecision) => void;
  alerts?: AlertDispatcherLike;
}

export class SupervisorPipeline {
  private readonly now: () => string;

  constructor(private readonly options: SupervisorPipelineOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async consume(batch: LogBatch): Promise<SupervisorDecision> {
    const decision = await this.options.client.decide(batch);
    this.options.onDecision?.(decision);

    if (
      (decision.status === "warning" || decision.status === "critical") &&
      this.options.alerts
    ) {
      await this.options.alerts.dispatch({
        decision,
        batch,
        taskId: (batch.batch[0]?.metadata?.taskId as string | undefined) ?? "unknown-task",
        actorAgentId: this.options.actorAgentId,
        supervisorAgentId: this.options.supervisorAgentId,
        occurredAt: this.now(),
      });
    }

    if (decision.action === "feedback") {
      await this.options.adapter.sendMessage(
        this.buildFeedbackEnvelope(batch, decision),
      );
    }

    if (decision.action === "halt") {
      await this.options.adapter.cancelTask(this.buildCancelEnvelope(batch, decision));
    }

    return decision;
  }

  private buildFeedbackEnvelope(
    batch: LogBatch,
    decision: SupervisorDecision,
  ): A2AEnvelope<A2AMessage> {
    return {
      from: this.options.supervisorAgentId,
      to: this.options.actorAgentId,
      payload: {
        id: `msg-${batch.batch[batch.batch.length - 1]?.step ?? 0}-${Date.now()}`,
        taskId: batch.batch[0]?.metadata?.taskId as string ?? "unknown-task",
        role: "system",
        parts: [
          {
            kind: "text",
            text: decision.suggestion ?? decision.reason,
          },
          {
            kind: "json",
            data: {
              type: "supervisor-feedback",
              decision,
            },
          },
        ],
        sentAt: this.now(),
      },
    };
  }

  private buildCancelEnvelope(
    batch: LogBatch,
    decision: SupervisorDecision,
  ): A2AEnvelope<CancelTaskRequest> {
    return {
      from: this.options.supervisorAgentId,
      to: this.options.actorAgentId,
      payload: {
        taskId: batch.batch[0]?.metadata?.taskId as string ?? "unknown-task",
        reason: decision.suggestion ?? decision.reason,
        requestedAt: this.now(),
      },
    };
  }
}
