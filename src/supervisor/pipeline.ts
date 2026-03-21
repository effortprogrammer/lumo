import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
  buildSupervisorFeedbackMessage,
  buildSupervisorHaltMessage,
} from "../a2a/protocol.js";
import { createActorTransport, type ActorTransport } from "../a2a/transport.js";
import { type AlertDispatcherLike } from "../alerts/dispatcher.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "./decision.js";
import {
  buildSupervisorInputEnvelope,
  type SupervisorInputEnvelope,
  type SupervisorOutputEnvelope,
} from "./contracts.js";
import { SupervisorEngine, type SupervisorEngineOptions } from "./engine.js";
import { type SupervisorModelClient } from "./model-client.js";

export interface SupervisorPipelineOptions {
  actorTransport?: ActorTransport;
  adapter?: A2AAgentAdapter;
  client?: SupervisorModelClient;
  engine?: SupervisorEngine;
  actorAgentId: string;
  supervisorAgentId: string;
  now?: () => string;
  onDecision?: (decision: SupervisorDecision) => void;
  onOutput?: (output: SupervisorOutputEnvelope) => void;
  alerts?: AlertDispatcherLike;
}

export class SupervisorPipeline {
  private readonly now: () => string;
  private readonly engine: SupervisorEngine;
  private readonly actorTransport: ActorTransport;

  constructor(private readonly options: SupervisorPipelineOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.engine = options.engine ?? new SupervisorEngine({
      client: requireClient(options),
    });
    this.actorTransport = options.actorTransport ?? requireActorTransport(options);
  }

  async consume(batch: LogBatch): Promise<SupervisorOutputEnvelope> {
    const taskId = (batch.batch[0]?.metadata?.taskId as string | undefined)
      ?? batch.anomalies[0]?.taskId
      ?? "unknown-task";
    const input = this.buildInputEnvelope(batch);
    const output = await this.engine.evaluate({
      batch,
      input,
      taskId,
      occurredAt: this.now(),
    });
    this.options.onDecision?.(output.decision);
    this.options.onOutput?.(output);

    if (this.options.alerts && output.escalationReport) {
      await this.options.alerts.dispatch({
        decision: output.decision,
        batch,
        taskId,
        actorAgentId: this.options.actorAgentId,
        supervisorAgentId: this.options.supervisorAgentId,
        occurredAt: this.now(),
        report: output.escalationReport,
      });
    }

    if (output.decision.action === "feedback") {
      await this.actorTransport.sendFeedback(
        this.buildFeedbackEnvelope(batch, output),
      );
    }

    if (output.decision.action === "halt") {
      await this.actorTransport.haltTask(this.buildCancelEnvelope(batch, output));
    }

    return output;
  }

  private buildInputEnvelope(batch: LogBatch): SupervisorInputEnvelope {
    const recentLogs = batch.recentLogs ?? batch.batch;
    const latestLog = recentLogs.at(-1);
    return buildSupervisorInputEnvelope(batch, {
      occurredAt: this.now(),
      currentStatus: latestLog?.status === "error" ? "failed" : "running",
      currentStep: latestLog?.step,
    });
  }

  private buildFeedbackEnvelope(
    batch: LogBatch,
    output: SupervisorOutputEnvelope,
  ): A2AEnvelope<A2AMessage> {
    const taskId = batch.batch[0]?.metadata?.taskId as string ?? "unknown-task";
    const interventionId = `feedback-${taskId}-${Date.now()}`;
    const latestProgressId = batch.batch.at(-1)?.metadata?.progressId as string | undefined;
    const instructions = output.recoveryPlan?.instructions;
    const feedback = buildSupervisorFeedbackMessage({
      interventionId,
      actorSessionId: this.options.actorAgentId,
      inResponseToProgressId: latestProgressId,
      decision: output.decision,
      bottleneckKind: output.bottleneck?.kind,
      targetPhase: output.recoveryPlan?.targetPhase,
      instructions,
      shouldEscalateHuman: output.shouldEscalateHuman,
    });
    return {
      id: interventionId,
      from: this.options.supervisorAgentId,
      to: this.options.actorAgentId,
      taskId,
      correlationId: interventionId,
      causationId: latestProgressId,
      sentAt: this.now(),
      payload: {
        id: `msg-${batch.batch[batch.batch.length - 1]?.step ?? 0}-${Date.now()}`,
        taskId,
        role: "system",
        parts: [
          {
            kind: "text",
            text: output.decision.suggestion ?? output.decision.reason,
          },
          {
            kind: "json",
            data: feedback,
          },
        ],
        sentAt: this.now(),
      },
    };
  }

  private buildCancelEnvelope(
    batch: LogBatch,
    output: SupervisorOutputEnvelope,
  ): A2AEnvelope<CancelTaskRequest> {
    const taskId = batch.batch[0]?.metadata?.taskId as string ?? "unknown-task";
    const interventionId = `halt-${taskId}-${Date.now()}`;
    const latestProgressId = batch.batch.at(-1)?.metadata?.progressId as string | undefined;
    const halt = buildSupervisorHaltMessage({
      interventionId,
      actorSessionId: this.options.actorAgentId,
      inResponseToProgressId: latestProgressId,
      decision: output.decision,
      bottleneckKind: output.bottleneck?.kind,
      humanActionNeeded: output.shouldEscalateHuman,
      recoverySummary: output.recoveryPlan?.summary,
    });
    return {
      id: interventionId,
      from: this.options.supervisorAgentId,
      to: this.options.actorAgentId,
      taskId,
      correlationId: interventionId,
      causationId: latestProgressId,
      sentAt: this.now(),
      payload: {
        taskId,
        reason: output.decision.suggestion ?? output.decision.reason,
        requestedAt: this.now(),
        details: halt,
      },
    };
  }
}

function requireClient(options: SupervisorPipelineOptions): SupervisorModelClient {
  if (options.client) {
    return options.client;
  }
  throw new Error("SupervisorPipeline requires either a client or an engine");
}

function requireActorTransport(options: SupervisorPipelineOptions): ActorTransport {
  if (options.actorTransport) {
    return options.actorTransport;
  }
  if (options.adapter) {
    return createActorTransport(options.adapter);
  }
  throw new Error("SupervisorPipeline requires either an actorTransport or an adapter");
}
