import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentikaBridge } from "../src/a2a/agentika-bridge.js";
import {
  buildActorProgressMessage,
  type A2AEnvelope,
  type A2AMessage,
} from "../src/a2a/protocol.js";
import { type LumoEventBus } from "../src/event/bus.js";

class MockBridgeAdapter {
  readonly messages: A2AEnvelope<A2AMessage>[] = [];
  readonly handlers = new Map<string, (message: A2AEnvelope<A2AMessage>) => Promise<void> | void>();

  async sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    this.messages.push(envelope);
  }

  async cancelTask(): Promise<void> {
    return;
  }

  registerMessageHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void {
    this.handlers.set(agentId, handler);
  }

  stop(): void {}
}

describe("AgentikaBridge", () => {
  it("publishes actor progress and shadows it to the event bus", async () => {
    const adapter = new MockBridgeAdapter();
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const eventSink: LumoEventBus = {
      async publish(event) {
        published.push({
          type: event.type,
          payload: event.payload,
        });
      },
    };
    const bridge = new AgentikaBridge({
      adapter,
      taskId: "task-bridge",
      eventSink,
    });
    const progress = buildActorProgressMessage({
      progressId: "progress-1",
      summary: "Collected the relevant page state.",
      currentStatus: "running",
      currentStep: 2,
    });

    await bridge.publishActorProgress({
      id: "env-progress-1",
      from: "actor",
      to: "supervisor",
      pairId: "pair-1",
      payload: {
        id: "msg-progress-1",
        taskId: "task-bridge",
        role: "assistant",
        parts: [{ kind: "json", data: progress }],
        sentAt: "2026-03-26T00:00:00Z",
      },
    });

    assert.equal(adapter.messages.length, 1);
    assert.equal(published[0]?.type, "actor.progress");
    assert.equal(published[0]?.payload.progressId, "progress-1");
  });

  it("registers and dispatches a feedback consumer callback", async () => {
    const adapter = new MockBridgeAdapter();
    const bridge = new AgentikaBridge({
      adapter,
      taskId: "task-bridge",
    });
    const delivered: string[] = [];

    await bridge.startFeedbackConsumer("actor-1", async (envelope) => {
      const textPart = envelope.payload.parts.find((part): part is { kind: "text"; text: string } => part.kind === "text");
      if (textPart) {
        delivered.push(textPart.text);
      }
    });

    await adapter.handlers.get("actor-1")?.({
      from: "supervisor",
      to: "actor-1",
      payload: {
        id: "feedback-1",
        taskId: "task-bridge",
        role: "system",
        parts: [{ kind: "text", text: "Switch to synthesis." }],
        sentAt: "2026-03-26T00:00:01Z",
      },
    });

    assert.deepEqual(delivered, ["Switch to synthesis."]);
  });
});
