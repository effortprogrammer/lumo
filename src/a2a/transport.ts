import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
} from "./protocol.js";

export interface ActorTransport {
  sendFeedback(envelope: A2AEnvelope<A2AMessage>): Promise<void>;
  haltTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void>;
}

export interface SupervisorTransport {
  sendProgress(envelope: A2AEnvelope<A2AMessage>): Promise<void>;
  registerProgressHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void;
  registerFeedbackHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void;
  registerHaltHandler(
    agentId: string,
    handler: (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void,
  ): void;
}

export function createActorTransport(adapter: A2AAgentAdapter): ActorTransport {
  return {
    async sendFeedback(envelope) {
      await adapter.sendMessage(envelope);
    },
    async haltTask(envelope) {
      await adapter.cancelTask(envelope);
    },
  };
}

export function createSupervisorTransport(adapter: A2AAgentAdapter): SupervisorTransport {
  return {
    async sendProgress(envelope) {
      await adapter.sendMessage(envelope);
    },
    registerProgressHandler(agentId, handler) {
      adapter.registerMessageHandler(agentId, handler);
    },
    registerFeedbackHandler(agentId, handler) {
      adapter.registerMessageHandler(agentId, handler);
    },
    registerHaltHandler(agentId, handler) {
      adapter.registerCancelHandler(agentId, handler);
    },
  };
}
