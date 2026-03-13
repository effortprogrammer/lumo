export type A2APart =
  | { kind: "text"; text: string }
  | { kind: "json"; data: Record<string, unknown> };

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
}

export interface A2AEnvelope<TPayload> {
  from: string;
  to: string;
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
