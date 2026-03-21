import {
  type ActorProgressMessage,
  type ActorInterventionAckMessage,
  type ActorInterventionResultMessage,
  type SupervisorFeedbackMessage,
  type SupervisorHaltMessage,
} from "../a2a/protocol.js";
import { type SupervisorInputEnvelope } from "../supervisor/contracts.js";

export interface SupervisorSessionBootstrapRequest {
  pairId: string;
  taskId: string;
  actorAgentId: string;
  supervisorAgentId: string;
  instruction: string;
  occurredAt: string;
}

export interface SupervisorSessionBootstrapResult {
  mode: "in_process" | "separate_session";
  sessionId?: string;
  status: "ready" | "observing" | "failed";
  bootstrappedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SupervisorSessionBootstrapper {
  bootstrap(
    request: SupervisorSessionBootstrapRequest,
  ): SupervisorSessionBootstrapResult | Promise<SupervisorSessionBootstrapResult>;
}

export interface SupervisorSessionProgressDeliveryRequest {
  pairId: string;
  taskId: string;
  supervisorSessionId: string;
  progress?: ActorProgressMessage;
  ack?: ActorInterventionAckMessage;
  result?: ActorInterventionResultMessage;
  input?: SupervisorInputEnvelope;
  occurredAt: string;
}

export interface SupervisorSessionProgressDeliverer {
  deliverProgress(
    request: SupervisorSessionProgressDeliveryRequest,
  ): Promise<void>;
}

export interface SupervisorInterventionListenerRequest {
  pairId: string;
  taskId: string;
  supervisorSessionId: string;
  onFeedback(message: SupervisorFeedbackMessage): void;
  onHalt(message: SupervisorHaltMessage): void;
}

export interface SupervisorSessionInterventionSubscriber {
  attachInterventionListener(
    request: SupervisorInterventionListenerRequest,
  ): () => void;
}

export class InProcessSupervisorSessionBootstrapper implements SupervisorSessionBootstrapper {
  bootstrap(
    request: SupervisorSessionBootstrapRequest,
  ): SupervisorSessionBootstrapResult {
    return {
      mode: "in_process",
      sessionId: `supervisor-${request.taskId}`,
      status: "ready",
      bootstrappedAt: request.occurredAt,
    };
  }
}
