import { type TaskStatus } from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { type SupervisorOutputEnvelope } from "../supervisor/contracts.js";
import {
  type ActorInterventionAckMessage,
  type ActorInterventionResultMessage,
  type ActorProgressMessage,
} from "../a2a/protocol.js";

export interface ActorRuntimeState {
  sessionId: string;
  agentId: string;
  status: TaskStatus;
  currentStep: number;
  lastInputAt?: string;
  lastOutputAt?: string;
}

export interface SupervisorRuntimeState {
  agentId: string;
  mode: "in_process" | "separate_session";
  status: "bootstrapping" | "ready" | "observing" | "failed";
  sessionId?: string;
  bootstrappedAt?: string;
  bootstrapError?: string;
  lastDecision?: SupervisorDecision;
  lastProgress?: ActorProgressMessage;
  lastProgressAt?: string;
  lastInboxDrainedAt?: string;
  lastOutput?: SupervisorOutputEnvelope;
  lastEvaluatedAt?: string;
  lastInterventionAck?: ActorInterventionAckMessage;
  lastInterventionResult?: ActorInterventionResultMessage;
  lastInterventionEffect?: {
    interventionId: string;
    status: "pending" | "resolved" | "unresolved";
    evaluatedAt: string;
    reason?: string;
  };
}

export interface TaskPairRuntimeState {
  pairId: string;
  taskId: string;
  actor: ActorRuntimeState;
  supervisor: SupervisorRuntimeState;
}

export function createTaskPairRuntimeState(options: {
  sessionId: string;
  taskId: string;
  actorAgentId: string;
  supervisorAgentId: string;
  status: TaskStatus;
  currentStep: number;
  supervisorStatus?: SupervisorRuntimeState["status"];
  bootstrappedAt?: string;
}): TaskPairRuntimeState {
  return {
    pairId: `${options.taskId}:${options.actorAgentId}:${options.supervisorAgentId}`,
    taskId: options.taskId,
    actor: {
      sessionId: options.sessionId,
      agentId: options.actorAgentId,
      status: options.status,
      currentStep: options.currentStep,
    },
    supervisor: {
      agentId: options.supervisorAgentId,
      mode: "in_process",
      status: options.supervisorStatus ?? "ready",
      bootstrappedAt: options.bootstrappedAt,
    },
  };
}
