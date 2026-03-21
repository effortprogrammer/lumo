import { type LogBatch } from "../logging/log-batcher.js";
import {
  buildSupervisorOutputEnvelope,
  type SupervisorInputEnvelope,
  type SupervisorOutputEnvelope,
} from "./contracts.js";
import { buildSupervisorEscalationReport } from "./escalation-report.js";
import { type SupervisorModelClient } from "./model-client.js";

export interface SupervisorEngineEvaluateOptions {
  batch: LogBatch;
  input: SupervisorInputEnvelope;
  taskId: string;
  occurredAt: string;
}

export interface SupervisorEngineOptions {
  client: SupervisorModelClient;
}

export class SupervisorEngine {
  constructor(private readonly options: SupervisorEngineOptions) {}

  async evaluate(options: SupervisorEngineEvaluateOptions): Promise<SupervisorOutputEnvelope> {
    const decision = await this.options.client.decide(options.input);
    const report = (decision.status === "warning" || decision.status === "critical")
      ? buildSupervisorEscalationReport(options.batch, decision, {
        taskId: options.taskId,
        occurredAt: options.occurredAt,
      })
      : undefined;

    return buildSupervisorOutputEnvelope({
      decision,
      report,
    });
  }
}
