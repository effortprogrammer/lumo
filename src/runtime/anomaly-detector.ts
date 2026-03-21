import {
  type ConversationTurn,
  type RuntimeAnomaly,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";

export interface RuntimeProgressSnapshot {
  taskId: string;
  sessionId: string;
  currentStep: number;
  status: TaskStatus;
  lastUpdatedAt: string;
  lastToolProgressAt?: string;
  latestTool?: ToolExecutionRecord["tool"];
  latestInput?: string;
}

export interface RuntimeAnomalyDetectorContext {
  now: string;
  snapshot: RuntimeProgressSnapshot;
  recentLogs: ToolExecutionRecord[];
  recentConversation: ConversationTurn[];
}

export interface RuntimeAnomalyDetector {
  detect(context: RuntimeAnomalyDetectorContext): RuntimeAnomaly[];
}

export interface HeuristicRuntimeAnomalyDetectorOptions {
  repeatedActionThreshold?: number;
  browserStuckThreshold?: number;
  retryLoopThreshold?: number;
  noProgressMs?: number;
}

export class HeuristicRuntimeAnomalyDetector implements RuntimeAnomalyDetector {
  private readonly repeatedActionThreshold: number;
  private readonly browserStuckThreshold: number;
  private readonly retryLoopThreshold: number;
  private readonly noProgressMs: number;

  constructor(options: HeuristicRuntimeAnomalyDetectorOptions = {}) {
    this.repeatedActionThreshold = options.repeatedActionThreshold ?? 3;
    this.browserStuckThreshold = options.browserStuckThreshold ?? 4;
    this.retryLoopThreshold = options.retryLoopThreshold ?? 3;
    this.noProgressMs = options.noProgressMs ?? 60_000;
  }

  detect(context: RuntimeAnomalyDetectorContext): RuntimeAnomaly[] {
    const anomalies: RuntimeAnomaly[] = [];
    const repeatedAction = detectRepeatedActionLoop(
      context,
      this.repeatedActionThreshold,
      this.browserStuckThreshold,
    );
    if (repeatedAction) {
      anomalies.push(repeatedAction);
    }

    const retryLoop = detectRetryLoop(context, this.retryLoopThreshold);
    if (retryLoop) {
      anomalies.push(retryLoop);
    }

    const noProgress = detectNoProgress(context, this.noProgressMs);
    if (noProgress) {
      anomalies.push(noProgress);
    }

    return anomalies;
  }
}

function detectRepeatedActionLoop(
  context: RuntimeAnomalyDetectorContext,
  repeatedActionThreshold: number,
  browserStuckThreshold: number,
): RuntimeAnomaly | null {
  const latest = context.recentLogs.at(-1);
  if (!latest) {
    return null;
  }

  const repeatedLogs = collectTrailingMatchingLogs(
    context.recentLogs,
    (record) => record.tool === latest.tool && record.input === latest.input,
  );
  const repeatedCount = repeatedLogs.length;
  if (repeatedCount < repeatedActionThreshold) {
    return null;
  }

  const latestRecord = repeatedLogs[repeatedLogs.length - 1] ?? latest;
  const isBrowserStuck = latest.tool === "agent-browser" && repeatedCount >= browserStuckThreshold;
  return {
    id: buildAnomalyId(isBrowserStuck ? "browser_stuck" : "repeated_action_loop", latestRecord.timestamp),
    kind: isBrowserStuck ? "browser_stuck" : "repeated_action_loop",
    severity: isBrowserStuck ? "critical" : "warning",
    message: isBrowserStuck
      ? "The browser appears stuck repeating the same action without visible progress."
      : "The actor is repeating the same action without changing strategy.",
    taskId: context.snapshot.taskId,
    sessionId: context.snapshot.sessionId,
    occurredAt: context.now,
    relatedStep: latestRecord.step,
    relatedTool: latest.tool,
    evidence: {
      repeatedInput: latest.input,
      repeatedCount,
      screenshotRef: latestRecord.screenshotRef,
      metadata: latestRecord.metadata,
    },
  };
}

function detectRetryLoop(
  context: RuntimeAnomalyDetectorContext,
  retryLoopThreshold: number,
): RuntimeAnomaly | null {
  const latest = context.recentLogs.at(-1);
  if (!latest || latest.status !== "error") {
    return null;
  }

  const repeatedErrors = collectTrailingMatchingLogs(
    context.recentLogs,
    (record) =>
      record.tool === latest.tool
      && record.input === latest.input
      && record.status === "error",
  );
  const retryCount = repeatedErrors.length;
  if (retryCount < retryLoopThreshold) {
    return null;
  }

  return {
    id: buildAnomalyId("retry_loop", latest.timestamp),
    kind: "retry_loop",
    severity: "critical",
    message: "The actor is retrying the same failing operation repeatedly.",
    taskId: context.snapshot.taskId,
    sessionId: context.snapshot.sessionId,
    occurredAt: context.now,
    relatedStep: latest.step,
    relatedTool: latest.tool,
    evidence: {
      repeatedInput: latest.input,
      retryCount,
      exitCode: latest.exitCode,
      metadata: latest.metadata,
    },
  };
}

function detectNoProgress(
  context: RuntimeAnomalyDetectorContext,
  noProgressMs: number,
): RuntimeAnomaly | null {
  if (context.snapshot.status !== "running") {
    return null;
  }

  const baseline = context.snapshot.lastToolProgressAt ?? context.snapshot.lastUpdatedAt;
  const stalledForMs = Date.parse(context.now) - Date.parse(baseline);
  if (!Number.isFinite(stalledForMs) || stalledForMs < noProgressMs) {
    return null;
  }

  const latest = context.recentLogs.at(-1);
  return {
    id: buildAnomalyId("no_progress", baseline),
    kind: "no_progress",
    severity: "warning",
    message: "The task has not made measurable progress within the expected interval.",
    taskId: context.snapshot.taskId,
    sessionId: context.snapshot.sessionId,
    occurredAt: context.now,
    relatedStep: latest?.step,
    relatedTool: latest?.tool,
    evidence: {
      lastProgressAt: baseline,
      stalledForMs,
      metadata: latest?.metadata,
    },
  };
}

function collectTrailingMatchingLogs(
  logs: ToolExecutionRecord[],
  predicate: (record: ToolExecutionRecord) => boolean,
): ToolExecutionRecord[] {
  const matches: ToolExecutionRecord[] = [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const record = logs[index];
    if (!record || !predicate(record)) {
      break;
    }
    matches.unshift(record);
  }
  return matches;
}

function buildAnomalyId(kind: RuntimeAnomaly["kind"], seed: string): string {
  const normalizedSeed = seed.replace(/[^0-9A-Za-z]+/g, "-");
  return `anomaly-${kind}-${normalizedSeed}`;
}
