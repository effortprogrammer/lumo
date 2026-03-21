import { type BrowserProgressAssessment, type BrowserStateSnapshot, type TaskStatus, type ToolExecutionRecord } from "../domain/task.js";
import { type CompletionState } from "../completion/types.js";
import { type LumoStoredEvent } from "../event/types.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type MemoryLessonRecord, type MemorySkillRecord } from "../memory/types.js";
import { type BottleneckAssessment, type RecoveryPlan } from "./bottleneck.js";
import { type SupervisorDecision } from "./decision.js";
import { type SupervisorEscalationReport } from "./escalation-report.js";
import { type TaskPhaseAssessment } from "./phase.js";

export interface SupervisorInputEnvelope {
  taskInstruction: string;
  conversationHistory: string[];
  recentLogs: ToolExecutionRecord[];
  anomalies: LogBatch["anomalies"];
  recentLifecycleEvents?: LumoStoredEvent[];
  recentSupervisorDecisionEvents?: Array<{
    status?: "ok" | "warning" | "critical";
    action?: "continue" | "feedback" | "halt" | "complete";
    confidence?: number;
    reason?: string;
    suggestion?: string;
    occurredAt?: string;
  }>;
  recentAnomalyEvents?: Array<{
    kind?: string;
    severity?: string;
    message?: string;
    occurredAt?: string;
  }>;
  recentActorProgressEvents?: Array<{
    progressId?: string;
    actorSessionId?: string;
    sequence?: number;
    summary?: string;
    currentStatus?: TaskStatus;
    currentStep?: number;
    collectionState?: SupervisorInputEnvelope["collectionState"];
    taskPhase?: TaskPhaseAssessment;
    anomalies?: LogBatch["anomalies"];
  }>;
  priorLessons?: MemoryLessonRecord[];
  priorSkills?: MemorySkillRecord[];
  completionState?: CompletionState;
  collectionState?: {
    itemsCollected: number;
    distinctItems: number;
    fieldsSeen: string[];
    comparisonReady?: boolean;
    recommendationReady?: boolean;
  };
  browserState?: BrowserStateSnapshot;
  browserProgress?: BrowserProgressAssessment;
  taskPhase?: TaskPhaseAssessment;
  currentStatus?: TaskStatus;
  currentStep?: number;
  triggeredBy: LogBatch["triggeredBy"];
  occurredAt: string;
}

export function buildSupervisorInputEnvelope(
  batch: LogBatch,
  options: {
    occurredAt: string;
    currentStatus?: TaskStatus;
    currentStep?: number;
    taskPhase?: TaskPhaseAssessment;
    collectionState?: SupervisorInputEnvelope["collectionState"];
    recentLifecycleEvents?: LumoStoredEvent[];
    recentSupervisorDecisionEvents?: SupervisorInputEnvelope["recentSupervisorDecisionEvents"];
    recentAnomalyEvents?: SupervisorInputEnvelope["recentAnomalyEvents"];
    recentActorProgressEvents?: SupervisorInputEnvelope["recentActorProgressEvents"];
    priorLessons?: SupervisorInputEnvelope["priorLessons"];
    priorSkills?: SupervisorInputEnvelope["priorSkills"];
    completionState?: SupervisorInputEnvelope["completionState"];
  },
): SupervisorInputEnvelope {
  const recentLogs = batch.recentLogs ?? batch.batch;
  return {
    taskInstruction: batch.taskInstruction,
    conversationHistory: batch.conversationHistory,
    recentLogs,
    anomalies: batch.anomalies,
    recentLifecycleEvents: options.recentLifecycleEvents,
    recentSupervisorDecisionEvents: options.recentSupervisorDecisionEvents,
    recentAnomalyEvents: options.recentAnomalyEvents,
    recentActorProgressEvents: options.recentActorProgressEvents,
    priorLessons: options.priorLessons,
    priorSkills: options.priorSkills,
    completionState: options.completionState,
    collectionState: options.collectionState,
    browserState: batch.browserState,
    browserProgress: batch.browserProgress,
    taskPhase: options.taskPhase,
    currentStatus: options.currentStatus,
    currentStep: options.currentStep ?? recentLogs.at(-1)?.step,
    triggeredBy: batch.triggeredBy,
    occurredAt: options.occurredAt,
  };
}

export interface SupervisorOutputEnvelope {
  decision: SupervisorDecision;
  bottleneck?: BottleneckAssessment;
  recoveryPlan?: RecoveryPlan;
  escalationReport?: SupervisorEscalationReport;
  shouldEscalateHuman: boolean;
  shouldInterveneActor: boolean;
}

export function buildSupervisorOutputEnvelope(options: {
  decision: SupervisorDecision;
  report?: SupervisorEscalationReport;
}): SupervisorOutputEnvelope {
  const bottleneck = options.report?.bottleneck;
  const recoveryPlan = bottleneck?.recoveryPlan;
  return {
    decision: options.decision,
    bottleneck,
    recoveryPlan,
    escalationReport: options.report,
    shouldEscalateHuman: Boolean(
      options.report?.recommendedAction === "halted-awaiting-human"
      || recoveryPlan?.humanEscalationNeeded,
    ),
    shouldInterveneActor: options.decision.action === "feedback" || options.decision.action === "halt" || options.decision.action === "complete",
  };
}
