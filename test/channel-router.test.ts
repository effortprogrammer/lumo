import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationRouter } from "../src/channels/conversation-router.js";
import { type ChannelAdapter } from "../src/channels/adapter.js";
import { type ChannelInboundMessage, type ChannelOutboundEvent } from "../src/channels/model.js";
import { type TaskPairing } from "../src/domain/task.js";
import { type SessionManager } from "../src/runtime/session-manager.js";

class StubChannelAdapter implements ChannelAdapter {
  readonly name = "discord";
  readonly sent: ChannelOutboundEvent[] = [];

  onMessage(): void {}

  async pollOnce(): Promise<number> {
    return 0;
  }

  async send(event: ChannelOutboundEvent) {
    this.sent.push(event);
    return {
      channel: this.name,
      status: "sent" as const,
      detail: "ok",
    };
  }
}

describe("ConversationRouter", () => {
  it("routes natural-language intents and preserves alias compatibility", async () => {
    const adapter = new StubChannelAdapter();
    const calls: string[] = [];
    const currentSession = {
      runtime: {
        task: createPairing(),
      },
    };
    const stubSessionManager = {
      current: currentSession,
      createTask(instruction: string) {
        calls.push(`new:${instruction}`);
        return currentSession;
      },
      async followUp(text: string) {
        calls.push(`followup:${text}`);
      },
      async resume(text?: string) {
        calls.push(`resume:${text ?? ""}`);
      },
      halt(reason: string) {
        calls.push(`halt:${reason}`);
      },
    } as unknown as SessionManager;

    const router = new ConversationRouter({
      sessionManager: stubSessionManager,
      adapters: [adapter],
      commandMapping: {
        new: ["new"],
        followup: ["followup", "reply"],
        resume: ["resume"],
        halt: ["halt"],
        status: ["status"],
      },
      now: () => "2026-03-12T00:00:00Z",
    });

    await router.handleInboundMessage(createMessage("Investigate failing tests"));
    await router.handleInboundMessage(createMessage("continue"));
    await router.handleInboundMessage(createMessage("stop unsafe command"));
    await router.handleInboundMessage(createMessage("what's the status?"));
    await router.handleInboundMessage(createMessage("reply collect stack trace"));
    await router.handleInboundMessage(createMessage("new compare alias compatibility"));

    assert.deepEqual(calls, [
      "new:Investigate failing tests",
      "resume:",
      "halt:unsafe command",
      "followup:collect stack trace",
      "new:compare alias compatibility",
    ]);
    assert.deepEqual(
      adapter.sent.map((event) => event.type),
      ["router.reply", "router.reply", "router.reply", "router.reply", "router.reply", "router.reply"],
    );
    assert.equal(adapter.sent[3]?.type, "router.reply");
    if (adapter.sent[3]?.type === "router.reply") {
      assert.equal(adapter.sent[3].text, "task=task-router status=pending step=0");
    }
  });

  it("asks for clarification on ambiguous requests", async () => {
    const adapter = new StubChannelAdapter();
    const stubSessionManager = {
      current: null,
    } as SessionManager;
    const router = new ConversationRouter({
      sessionManager: stubSessionManager,
      adapters: [adapter],
      commandMapping: {
        new: ["new"],
        followup: ["followup"],
        resume: ["resume"],
        halt: ["halt"],
        status: ["status"],
      },
      now: () => "2026-03-12T00:00:00Z",
    });

    await router.handleInboundMessage(createMessage("do it"));

    assert.equal(adapter.sent[0]?.type, "router.reply");
    if (adapter.sent[0]?.type === "router.reply") {
      assert.match(adapter.sent[0].text, /ambiguous|clear/i);
    }
  });

  it("emits lifecycle and supervisor alert updates to the current target", async () => {
    const adapter = new StubChannelAdapter();
    const stubSessionManager = {
      current: {
        runtime: {
          task: createPairing(),
        },
      },
    } as SessionManager;
    const router = new ConversationRouter({
      sessionManager: stubSessionManager,
      adapters: [adapter],
      commandMapping: {
        new: ["new"],
        followup: ["followup"],
        resume: ["resume"],
        halt: ["halt"],
        status: ["status"],
      },
      now: () => "2026-03-12T00:00:00Z",
    });

    await router.handleInboundMessage(createMessage("status"));
    await router.emitTaskLifecycle("running");
    await router.emitSupervisorAlert({
      status: "warning",
      confidence: 0.6,
      reason: "command failed",
      suggestion: "check stderr",
      action: "feedback",
    });

    assert.deepEqual(
      adapter.sent.map((event) => event.type),
      ["router.reply", "task.lifecycle", "supervisor.alert"],
    );
  });

  it("routes halted-task guidance into a resume with extra instruction", async () => {
    const adapter = new StubChannelAdapter();
    const calls: string[] = [];
    const stubSessionManager = {
      current: {
        runtime: {
          task: {
            ...createPairing(),
            task: {
              ...createPairing().task,
              status: "halted" as const,
            },
          },
        },
      },
      async resume(text?: string) {
        calls.push(`resume:${text ?? ""}`);
      },
    } as SessionManager;
    const router = new ConversationRouter({
      sessionManager: stubSessionManager,
      adapters: [adapter],
      commandMapping: {
        new: ["new"],
        followup: ["followup", "reply"],
        resume: ["resume"],
        halt: ["halt"],
        status: ["status"],
      },
      now: () => "2026-03-12T00:00:00Z",
    });

    await router.handleInboundMessage(createMessage("search again but avoid the modal flow"));

    assert.deepEqual(calls, ["resume:search again but avoid the modal flow"]);
    assert.equal(adapter.sent[0]?.type, "router.reply");
    if (adapter.sent[0]?.type === "router.reply") {
      assert.match(adapter.sent[0].text, /resumed|recovery/i);
    }
  });
});

function createMessage(text: string): ChannelInboundMessage {
  return {
    adapter: "discord",
    messageId: "msg-1",
    conversationId: "conv-1",
    text,
    sender: {
      userId: "user-1",
      displayName: "Operator",
      isHuman: true,
    },
    receivedAt: "2026-03-12T00:00:00Z",
  };
}

function createPairing(): TaskPairing {
  return {
    task: {
      taskId: "task-router",
      actor: {
        id: "actor",
        systemPrompt: "run commands",
        tools: ["bash", "agent-browser", "coding-agent"],
      },
      supervisor: {
        id: "supervisor",
        model: "mock-supervisor",
        systemPrompt: "watch",
        maxBatchSteps: 3,
        maxBatchAgeMs: 30_000,
      },
      status: "pending",
      createdAt: "2026-03-12T00:00:00Z",
      currentStep: 0,
      lastUpdatedAt: "2026-03-12T00:00:00Z",
    },
    context: {
      taskId: "task-router",
      instruction: {
        id: "instruction-router",
        text: "do work",
        createdAt: "2026-03-12T00:00:00Z",
      },
      conversationHistory: [],
    },
  };
}
