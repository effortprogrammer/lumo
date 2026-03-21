import { type TaskStatus } from "../domain/task.js";
import { type TaskSession } from "../runtime/session-manager.js";
import { buildMemoryScope, deriveTaskPattern } from "../memory/promotion-policy.js";
import {
  type MemoryLessonRecord,
  type MemoryOutcomeRecord,
} from "../memory/types.js";

export function reviewTaskSession(options: {
  session: TaskSession;
  finalStatus: TaskStatus;
  occurredAt: string;
}): {
  outcome: MemoryOutcomeRecord;
  lessons: MemoryLessonRecord[];
} {
  const instruction = options.session.runtime.task.context.instruction.text;
  const taskId = options.session.runtime.task.task.taskId;
  const sessionId = options.session.runtime.sessionId;
  const latestOutput = options.session.supervisorOutputs.at(-1);
  const latestDecision = options.session.decisions.at(-1) ?? latestOutput?.decision;
  const latestReport = latestOutput?.escalationReport;
  const latestEffect = options.session.pairState.supervisor.lastInterventionEffect;
  const hadIntervention = Boolean(options.session.pairState.supervisor.lastInterventionResult);
  const verdict = deriveVerdict(options.finalStatus, {
    hadIntervention,
    lastEffectStatus: latestEffect?.status,
    shouldEscalateHuman: latestOutput?.shouldEscalateHuman,
  });
  const confidence = latestDecision?.confidence
    ?? (verdict === "success" ? 0.9 : verdict === "failed" ? 0.95 : 0.78);
  const outcome: MemoryOutcomeRecord = {
    outcomeId: `outcome-${taskId}-${sanitizeTimestamp(options.occurredAt)}`,
    sessionId,
    taskId,
    finalStatus: options.finalStatus,
    verdict,
    confidence,
    reason: latestDecision?.reason
      ?? latestReport?.summary
      ?? `Supervisor reviewed session with final status ${options.finalStatus}.`,
    evidenceRefs: compact([
      latestReport?.title,
      latestReport?.bottleneck?.kind,
      latestEffect?.reason,
    ]),
    judgedAt: options.occurredAt,
    judgedBy: "supervisor",
    taskPattern: deriveTaskPattern(instruction),
    scope: buildMemoryScope(instruction),
  };

  const lessons: MemoryLessonRecord[] = [];

  if (latestReport?.bottleneck) {
    lessons.push({
      lessonId: `lesson-${taskId}-bottleneck-${sanitizeTimestamp(options.occurredAt)}`,
      sourceSessionId: sessionId,
      taskId,
      kind: verdict === "failed" || verdict === "blocked" ? "anti_pattern" : "recovery_pattern",
      taskPattern: outcome.taskPattern,
      scope: outcome.scope,
      triggerSignals: compact([
        latestReport.bottleneck.kind,
        latestReport.taskPhase?.currentPhase,
        latestReport.browserState?.pageKind,
      ]),
      whatWorked: verdict === "success" || verdict === "assisted_success"
        ? latestReport.bottleneck.recoveryPlan.instructions.join(" ")
        : undefined,
      whatFailed: verdict === "failed" || verdict === "blocked"
        ? latestReport.bottleneck.diagnosis
        : undefined,
      recommendedAction: latestReport.bottleneck.recoveryPlan.instructions.join(" "),
      avoidWhen: latestReport.bottleneck.recoverable ? [] : ["The bottleneck is marked unrecoverable."],
      confidence,
      freshness: options.occurredAt,
      tags: compact([
        latestReport.bottleneck.kind,
        latestReport.taskPhase?.currentPhase,
        latestReport.browserState?.pageKind,
      ]),
      evidenceRefs: compact([latestReport.title, latestReport.summary]),
      promotionCandidate: verdict === "success" || verdict === "assisted_success",
    });
  }

  const taskPatternLesson: MemoryLessonRecord = {
    lessonId: `lesson-${taskId}-pattern-${sanitizeTimestamp(options.occurredAt)}`,
    sourceSessionId: sessionId,
    taskId,
    kind: "task_pattern",
    taskPattern: outcome.taskPattern,
    scope: outcome.scope,
    triggerSignals: compact([
      options.finalStatus,
      latestReport?.taskPhase?.currentPhase,
    ]),
    whatWorked: verdict === "success" || verdict === "assisted_success"
      ? latestDecision?.suggestion ?? latestReport?.lastMeaningfulProgress ?? "Continue with the same task pattern."
      : undefined,
    whatFailed: verdict === "failed" || verdict === "blocked"
      ? latestDecision?.reason ?? latestReport?.summary ?? "The task ended without a reliable result."
      : undefined,
    recommendedAction: latestDecision?.suggestion
      ?? latestReport?.summary
      ?? "Reuse the successful task pattern and escalate earlier when similar friction appears.",
    avoidWhen: verdict === "failed" || verdict === "blocked"
      ? ["The same anomaly pattern is still active."]
      : [],
    confidence,
    freshness: options.occurredAt,
    tags: compact([
      outcome.taskPattern,
      latestReport?.taskPhase?.currentPhase,
      verdict,
    ]),
    evidenceRefs: compact([
      latestDecision?.reason,
      latestReport?.summary,
      latestEffect?.reason,
    ]),
    promotionCandidate: verdict === "success" || verdict === "assisted_success",
  };
  lessons.push(taskPatternLesson);

  return { outcome, lessons };
}

function deriveVerdict(
  finalStatus: TaskStatus,
  signals: {
    hadIntervention: boolean;
    lastEffectStatus?: "pending" | "resolved" | "unresolved";
    shouldEscalateHuman?: boolean;
  },
): MemoryOutcomeRecord["verdict"] {
  if (finalStatus === "completed") {
    return signals.hadIntervention ? "assisted_success" : "success";
  }
  if (finalStatus === "halted") {
    return signals.shouldEscalateHuman ? "safe_stop" : "blocked";
  }
  if (finalStatus === "failed") {
    return signals.lastEffectStatus === "resolved" ? "assisted_success" : "failed";
  }
  return "inconclusive";
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}
