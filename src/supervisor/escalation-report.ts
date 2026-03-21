import {
  type ActorToolName,
  type BrowserProgressAssessment,
  type BrowserStateSnapshot,
  type RuntimeAnomaly,
  type RuntimeAnomalyKind,
  type ScreenshotRef,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "./decision.js";
import { assessBottleneck, type BottleneckAssessment } from "./bottleneck.js";
import { assessTaskPhase, type TaskPhaseAssessment } from "./phase.js";

export interface SupervisorEscalationReport {
  taskId: string;
  sessionId?: string;
  severity: "warning" | "critical";
  status: "running" | "paused" | "halted" | "failed";
  title: string;
  summary: string;
  currentActivity?: string;
  lastMeaningfulProgress?: string;
  anomalyKinds: RuntimeAnomalyKind[];
  reasons: string[];
  recommendedAction:
    | "continue"
    | "observe"
    | "feedback"
    | "halted-awaiting-human"
    | "resume-with-guidance"
    | "terminate";
  supervisorDecision: {
    confidence: number;
    reason: string;
    suggestion?: string;
    action: "continue" | "feedback" | "halt" | "complete";
  };
  evidence: {
    latestStep?: number;
    latestTool?: ActorToolName;
    latestInput?: string;
    repeatedCount?: number;
    stalledForMs?: number;
    retryCount?: number;
    url?: string;
    screenshotRef?: ScreenshotRef;
    metadata?: Record<string, unknown>;
  };
  browserState?: BrowserStateSnapshot;
  browserProgress?: BrowserProgressAssessment;
  taskPhase?: TaskPhaseAssessment;
  bottleneck?: BottleneckAssessment;
  occurredAt: string;
}

export function buildSupervisorEscalationReport(
  batch: LogBatch,
  decision: SupervisorDecision,
  options: {
    taskId: string;
    occurredAt: string;
  },
): SupervisorEscalationReport {
  const latestLog = batch.batch.at(-1);
  const latestAnomaly = batch.anomalies.at(-1);
  const taskPhase = assessTaskPhase({
    taskInstruction: batch.taskInstruction,
    browserState: batch.browserState,
    browserProgress: batch.browserProgress,
    recentLogs: batch.recentLogs ?? batch.batch,
  });
  const sessionId = latestAnomaly?.sessionId
    ?? asOptionalString(latestLog?.metadata?.runtimeSessionId);
  const reasons = batch.anomalies.length > 0
    ? batch.anomalies.map((anomaly) => anomaly.message)
    : [decision.reason];
  const currentActivity = buildCurrentActivity(latestLog, latestAnomaly);
  const lastMeaningfulProgress = buildLastMeaningfulProgress(batch.batch);
  const bottleneck = assessBottleneck({
    anomalies: batch.anomalies,
    browserProgress: batch.browserProgress,
    browserState: batch.browserState,
    recentLogs: batch.recentLogs ?? batch.batch,
    taskInstruction: batch.taskInstruction,
    taskPhase,
  });
  const title = buildTitle(decision, latestAnomaly, bottleneck);
  const summary = buildSummary(decision, latestAnomaly, bottleneck, currentActivity, lastMeaningfulProgress);

  return {
    taskId: options.taskId,
    sessionId,
    severity: decision.status === "critical" ? "critical" : "warning",
    status: decision.action === "halt"
      ? "halted"
      : decision.action === "complete"
        ? "paused"
        : "running",
    title,
    summary,
    currentActivity,
    lastMeaningfulProgress,
    anomalyKinds: batch.anomalies.map((anomaly) => anomaly.kind),
    reasons,
    recommendedAction: mapRecommendedAction(decision),
    supervisorDecision: {
      confidence: decision.confidence,
      reason: decision.reason,
      suggestion: decision.suggestion,
      action: decision.action,
    },
    evidence: {
      latestStep: latestLog?.step ?? latestAnomaly?.relatedStep,
      latestTool: latestLog?.tool ?? latestAnomaly?.relatedTool,
      latestInput: latestLog?.input ?? latestAnomaly?.evidence?.repeatedInput,
      repeatedCount: latestAnomaly?.evidence?.repeatedCount,
      stalledForMs: latestAnomaly?.evidence?.stalledForMs,
      retryCount: latestAnomaly?.evidence?.retryCount,
      url: asOptionalString(latestLog?.metadata?.url) ?? latestAnomaly?.evidence?.url,
      screenshotRef: latestLog?.screenshotRef ?? latestAnomaly?.evidence?.screenshotRef,
      metadata: mergeEvidenceMetadata(latestLog, latestAnomaly),
    },
    browserState: batch.browserState,
    browserProgress: batch.browserProgress,
    taskPhase,
    bottleneck,
    occurredAt: options.occurredAt,
  };
}

function buildTitle(
  decision: SupervisorDecision,
  anomaly: RuntimeAnomaly | undefined,
  bottleneck: BottleneckAssessment | undefined,
): string {
  if (bottleneck) {
    return decision.action === "halt"
      ? `Actor was halted due to ${humanizeBottleneckKind(bottleneck.kind)}`
      : `Actor may be blocked by ${humanizeBottleneckKind(bottleneck.kind)}`;
  }

  if (anomaly) {
    return decision.action === "halt"
      ? `Actor was halted due to ${humanizeAnomalyKind(anomaly.kind)}`
      : `Actor may be affected by ${humanizeAnomalyKind(anomaly.kind)}`;
  }

  return decision.action === "halt"
    ? "Actor was halted after supervisor intervention"
    : "Supervisor issued a runtime warning";
}

function buildSummary(
  decision: SupervisorDecision,
  anomaly: RuntimeAnomaly | undefined,
  bottleneck: BottleneckAssessment | undefined,
  currentActivity: string | undefined,
  lastMeaningfulProgress: string | undefined,
): string {
  const lead = bottleneck?.summary ?? anomaly?.message ?? decision.reason;
  const fragments = [lead];
  if (currentActivity) {
    fragments.push(`Current activity: ${currentActivity}`);
  }
  if (lastMeaningfulProgress) {
    fragments.push(`Last progress: ${lastMeaningfulProgress}`);
  }
  return fragments.join(" ");
}

function buildCurrentActivity(
  latestLog: ToolExecutionRecord | undefined,
  latestAnomaly: RuntimeAnomaly | undefined,
): string | undefined {
  if (latestLog) {
    return `${latestLog.tool} ${latestLog.input}`.trim();
  }
  return latestAnomaly?.message;
}

function buildLastMeaningfulProgress(batch: ToolExecutionRecord[]): string | undefined {
  const latestSuccess = [...batch].reverse().find((record) => record.status !== "error");
  if (!latestSuccess) {
    return undefined;
  }
  return `Step ${latestSuccess.step} via ${latestSuccess.tool}`;
}

function mapRecommendedAction(
  decision: SupervisorDecision,
): SupervisorEscalationReport["recommendedAction"] {
  if (decision.action === "halt") {
    return "halted-awaiting-human";
  }
  if (decision.action === "feedback") {
    return "resume-with-guidance";
  }
  if (decision.action === "complete") {
    return "terminate";
  }
  return "observe";
}

function humanizeAnomalyKind(kind: RuntimeAnomalyKind): string {
  return kind.replace(/_/g, " ");
}

function humanizeBottleneckKind(kind: BottleneckAssessment["kind"]): string {
  return kind.replace(/_/g, " ");
}

function mergeEvidenceMetadata(
  latestLog: ToolExecutionRecord | undefined,
  latestAnomaly: RuntimeAnomaly | undefined,
): Record<string, unknown> | undefined {
  const metadata = {
    ...(latestLog?.metadata ?? {}),
    ...(latestAnomaly?.evidence?.metadata ?? {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
