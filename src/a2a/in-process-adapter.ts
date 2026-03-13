import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
} from "./protocol.js";

type MessageHandler = (message: A2AEnvelope<A2AMessage>) => Promise<void> | void;
type CancelHandler = (
  request: A2AEnvelope<CancelTaskRequest>,
) => Promise<void> | void;

export class InProcessA2AAdapter implements A2AAgentAdapter {
  private readonly messageHandlers = new Map<string, MessageHandler>();
  private readonly cancelHandlers = new Map<string, CancelHandler>();

  registerMessageHandler(agentId: string, handler: MessageHandler): void {
    this.messageHandlers.set(agentId, handler);
  }

  registerCancelHandler(agentId: string, handler: CancelHandler): void {
    this.cancelHandlers.set(agentId, handler);
  }

  async sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    const handler = this.messageHandlers.get(envelope.to);
    if (!handler) {
      throw new Error(`No message handler registered for agent "${envelope.to}"`);
    }

    await handler(envelope);
  }

  async cancelTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void> {
    const handler = this.cancelHandlers.get(envelope.to);
    if (!handler) {
      throw new Error(`No cancel handler registered for agent "${envelope.to}"`);
    }

    await handler(envelope);
  }
}

export class StubA2AAdapter extends InProcessA2AAdapter {
  readonly sentMessages: A2AEnvelope<A2AMessage>[] = [];
  readonly cancelRequests: A2AEnvelope<CancelTaskRequest>[] = [];

  override async sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    this.sentMessages.push(envelope);
    await super.sendMessage(envelope);
  }

  override async cancelTask(
    envelope: A2AEnvelope<CancelTaskRequest>,
  ): Promise<void> {
    this.cancelRequests.push(envelope);
    await super.cancelTask(envelope);
  }
}
