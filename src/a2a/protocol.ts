import { randomUUID } from "node:crypto";
import {
  type BrowserProgressAssessment,
  type BrowserStateSnapshot,
  type RuntimeAnomaly,
  type TaskStatus,
} from "../domain/task.js";
import { type BottleneckKind } from "../supervisor/bottleneck.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { type TaskPhase, type TaskPhaseAssessment } from "../supervisor/phase.js";

export interface SupervisorFeedbackMessage {
  type: "supervisor-feedback";
  interventionId: string;
  actorSessionId?: string;
  inResponseToProgressId?: string;
  decision: SupervisorDecision;
  bottleneckKind?: BottleneckKind;
  targetPhase?: TaskPhase;
  instructions?: string[];
  shouldEscalateHuman?: boolean;
}

export interface SupervisorHaltMessage {
  type: "supervisor-halt";
  interventionId: string;
  actorSessionId?: string;
  inResponseToProgressId?: string;
  decision: SupervisorDecision;
  bottleneckKind?: BottleneckKind;
  humanActionNeeded: boolean;
  recoverySummary?: string;
}

export interface ActorProgressMessage {
  type: "actor-progress";
  progressId: string;
  actorSessionId?: string;
  sequence?: number;
  taskPattern?: "single_lookup" | "multi_item_collection" | "compare_rank" | "recommendation" | "artifact_drafting";
  collectionState?: {
    itemsCollected: number;
    distinctItems: number;
    fieldsSeen: string[];
    comparisonReady?: boolean;
    recommendationReady?: boolean;
  };
  currentStatus?: TaskStatus;
  currentStep?: number;
  summary?: string;
  anomalies?: RuntimeAnomaly[];
  browserState?: BrowserStateSnapshot;
  browserProgress?: BrowserProgressAssessment;
  taskPhase?: TaskPhaseAssessment;
}

export interface ActorInterventionAckMessage {
  type: "actor-intervention-ack";
  interventionId: string;
  actorSessionId?: string;
  accepted: boolean;
  receivedAt: string;
  reason?: string;
}

export interface ActorInterventionResultMessage {
  type: "actor-intervention-result";
  interventionId: string;
  actorSessionId?: string;
  outcome: "applied" | "failed" | "ignored" | "superseded";
  reportedAt: string;
  summary?: string;
}

export type A2AJsonPayload =
  | SupervisorFeedbackMessage
  | SupervisorHaltMessage
  | ActorProgressMessage
  | ActorInterventionAckMessage
  | ActorInterventionResultMessage
  | Record<string, unknown>;

export type A2APart =
  | { kind: "text"; text: string }
  | { kind: "json"; data: A2AJsonPayload };

export interface A2AMessage {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "system";
  parts: A2APart[];
  sentAt: string;
}

export interface CancelTaskRequest {
  taskId: string;
  reason: string;
  requestedAt: string;
  details?: SupervisorHaltMessage;
}

export interface A2AEnvelope<TPayload> {
  id?: string;
  from: string;
  to: string;
  pairId?: string;
  taskId?: string;
  sessionId?: string;
  correlationId?: string;
  causationId?: string;
  sentAt?: string;
  payload: TPayload;
}

export interface A2AAgentAdapter {
  sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void>;
  cancelTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void>;
  registerMessageHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void;
  registerCancelHandler(
    agentId: string,
    handler: (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void,
  ): void;
}

export function buildSupervisorFeedbackMessage(options: {
  interventionId?: string;
  actorSessionId?: string;
  inResponseToProgressId?: string;
  decision: SupervisorDecision;
  bottleneckKind?: BottleneckKind;
  targetPhase?: TaskPhase;
  instructions?: string[];
  shouldEscalateHuman?: boolean;
}): SupervisorFeedbackMessage {
  return {
    type: "supervisor-feedback",
    interventionId: options.interventionId ?? randomUUID(),
    actorSessionId: options.actorSessionId,
    inResponseToProgressId: options.inResponseToProgressId,
    decision: options.decision,
    bottleneckKind: options.bottleneckKind,
    targetPhase: options.targetPhase,
    instructions: options.instructions,
    shouldEscalateHuman: options.shouldEscalateHuman,
  };
}

export function buildSupervisorHaltMessage(options: {
  interventionId?: string;
  actorSessionId?: string;
  inResponseToProgressId?: string;
  decision: SupervisorDecision;
  bottleneckKind?: BottleneckKind;
  humanActionNeeded: boolean;
  recoverySummary?: string;
}): SupervisorHaltMessage {
  return {
    type: "supervisor-halt",
    interventionId: options.interventionId ?? randomUUID(),
    actorSessionId: options.actorSessionId,
    inResponseToProgressId: options.inResponseToProgressId,
    decision: options.decision,
    bottleneckKind: options.bottleneckKind,
    humanActionNeeded: options.humanActionNeeded,
    recoverySummary: options.recoverySummary,
  };
}

export function buildActorProgressMessage(options: {
  progressId?: string;
  actorSessionId?: string;
  sequence?: number;
  taskPattern?: ActorProgressMessage["taskPattern"];
  collectionState?: ActorProgressMessage["collectionState"];
  currentStatus?: TaskStatus;
  currentStep?: number;
  summary?: string;
  anomalies?: RuntimeAnomaly[];
  browserState?: BrowserStateSnapshot;
  browserProgress?: BrowserProgressAssessment;
  taskPhase?: TaskPhaseAssessment;
}): ActorProgressMessage {
  return {
    type: "actor-progress",
    progressId: options.progressId ?? randomUUID(),
    actorSessionId: options.actorSessionId,
    sequence: options.sequence,
    taskPattern: options.taskPattern,
    collectionState: options.collectionState,
    currentStatus: options.currentStatus,
    currentStep: options.currentStep,
    summary: options.summary,
    anomalies: options.anomalies,
    browserState: options.browserState,
    browserProgress: options.browserProgress,
    taskPhase: options.taskPhase,
  };
}

export function buildActorInterventionAckMessage(options: {
  interventionId: string;
  actorSessionId?: string;
  accepted: boolean;
  receivedAt: string;
  reason?: string;
}): ActorInterventionAckMessage {
  return {
    type: "actor-intervention-ack",
    interventionId: options.interventionId,
    actorSessionId: options.actorSessionId,
    accepted: options.accepted,
    receivedAt: options.receivedAt,
    reason: options.reason,
  };
}

export function buildActorInterventionResultMessage(options: {
  interventionId: string;
  actorSessionId?: string;
  outcome: "applied" | "failed" | "ignored" | "superseded";
  reportedAt: string;
  summary?: string;
}): ActorInterventionResultMessage {
  return {
    type: "actor-intervention-result",
    interventionId: options.interventionId,
    actorSessionId: options.actorSessionId,
    outcome: options.outcome,
    reportedAt: options.reportedAt,
    summary: options.summary,
  };
}
