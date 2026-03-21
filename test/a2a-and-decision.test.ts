import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessA2AAdapter, StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
import {
  buildActorProgressMessage,
  buildActorInterventionAckMessage,
  buildSupervisorFeedbackMessage,
  buildSupervisorHaltMessage,
} from "../src/a2a/protocol.js";
import { createActorTransport, createSupervisorTransport } from "../src/a2a/transport.js";
import { SupervisorDecisionSchema } from "../src/supervisor/decision.js";

describe("InProcessA2AAdapter", () => {
  it("delivers messages and cancel requests to registered handlers", async () => {
    const adapter = new StubA2AAdapter();
    let delivered = "";
    let cancelled = "";

    adapter.registerMessageHandler("supervisor", (envelope) => {
      delivered = envelope.payload.parts[0]?.kind === "text"
        ? envelope.payload.parts[0].text
        : "";
    });

    adapter.registerCancelHandler("actor", (envelope) => {
      cancelled = envelope.payload.reason;
    });

    await adapter.sendMessage({
      from: "actor",
      to: "supervisor",
      payload: {
        id: "msg-1",
        taskId: "task-1",
        role: "user",
        parts: [{ kind: "text", text: "batch payload" }],
        sentAt: "2026-03-12T00:00:00Z",
      },
    });

    await adapter.cancelTask({
      from: "supervisor",
      to: "actor",
      payload: {
        taskId: "task-1",
        reason: "unsafe action",
        requestedAt: "2026-03-12T00:00:01Z",
      },
    });

    assert.equal(delivered, "batch payload");
    assert.equal(cancelled, "unsafe action");
    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.cancelRequests.length, 1);
  });

  it("throws when an agent has not been registered", async () => {
    const adapter = new InProcessA2AAdapter();
    let failed = false;

    try {
      await adapter.sendMessage({
        from: "actor",
        to: "supervisor",
        payload: {
          id: "msg-1",
          taskId: "task-1",
          role: "user",
          parts: [{ kind: "text", text: "batch payload" }],
          sentAt: "2026-03-12T00:00:00Z",
        },
      });
    } catch {
      failed = true;
    }

    assert.ok(failed, "expected sendMessage to fail without a registered handler");
  });
});

describe("SupervisorDecisionSchema", () => {
  it("accepts a valid warning decision", () => {
    const decision = SupervisorDecisionSchema.parse({
      status: "warning",
      confidence: 0.9,
      reason: "loop detected",
      suggestion: "change strategy",
      action: "feedback",
    });

    assert.equal(decision.action, "feedback");
  });

  it("rejects inconsistent status/action combinations", () => {
    let failed = false;

    try {
      SupervisorDecisionSchema.parse({
        status: "ok",
        confidence: 0.7,
        reason: "fine",
        action: "halt",
      });
    } catch {
      failed = true;
    }

    assert.ok(failed, "expected invalid decision to be rejected");
  });
});

describe("A2A intervention payloads", () => {
  it("builds structured supervisor feedback, halt, and actor progress payloads", () => {
    const decision = SupervisorDecisionSchema.parse({
      status: "warning",
      confidence: 0.92,
      reason: "phase transition required",
      suggestion: "stop browsing and draft the resume",
      action: "feedback",
    });

    const feedback = buildSupervisorFeedbackMessage({
      decision,
      bottleneckKind: "research_without_synthesis",
      targetPhase: "synthesis",
      instructions: ["Extract requirements.", "Draft the resume now."],
      shouldEscalateHuman: false,
    });
    const halt = buildSupervisorHaltMessage({
      decision: {
        ...decision,
        status: "critical",
        action: "halt",
      },
      bottleneckKind: "human_decision_required",
      humanActionNeeded: true,
      recoverySummary: "The actor exhausted recovery attempts.",
    });
    const progress = buildActorProgressMessage({
      actorSessionId: "actor-session-1",
      sequence: 12,
      currentStatus: "running",
      currentStep: 12,
      summary: "Actor reached a relevant job detail page and is extracting requirements.",
    });
    const ack = buildActorInterventionAckMessage({
      interventionId: feedback.interventionId,
      actorSessionId: "actor-session-1",
      accepted: true,
      receivedAt: "2026-03-15T12:00:00Z",
    });

    assert.equal(feedback.type, "supervisor-feedback");
    assert.ok(typeof feedback.interventionId === "string");
    assert.equal(feedback.targetPhase, "synthesis");
    assert.equal(halt.type, "supervisor-halt");
    assert.ok(typeof halt.interventionId === "string");
    assert.equal(halt.humanActionNeeded, true);
    assert.equal(progress.type, "actor-progress");
    assert.ok(typeof progress.progressId === "string");
    assert.equal(progress.sequence, 12);
    assert.equal(progress.currentStep, 12);
    assert.equal(ack.type, "actor-intervention-ack");
    assert.equal(ack.interventionId, feedback.interventionId);
  });

  it("adapts the in-process A2A adapter behind actor/supervisor transport interfaces", async () => {
    const adapter = new StubA2AAdapter();
    const actorTransport = createActorTransport(adapter);
    const supervisorTransport = createSupervisorTransport(adapter);
    let delivered = "";
    let halted = "";

    supervisorTransport.registerFeedbackHandler("actor", (envelope) => {
      delivered = envelope.payload.parts[0]?.kind === "text"
        ? envelope.payload.parts[0].text
        : "";
    });
    supervisorTransport.registerHaltHandler("actor", (envelope) => {
      halted = envelope.payload.reason;
    });

    await actorTransport.sendFeedback({
      id: "feedback-envelope-1",
      from: "supervisor",
      to: "actor",
      taskId: "task-transport",
      correlationId: "feedback-envelope-1",
      sentAt: "2026-03-15T12:00:00Z",
      payload: {
        id: "msg-transport",
        taskId: "task-transport",
        role: "system",
        parts: [{ kind: "text", text: "switch to synthesis now" }],
        sentAt: "2026-03-15T12:00:00Z",
      },
    });
    await actorTransport.haltTask({
      id: "halt-envelope-1",
      from: "supervisor",
      to: "actor",
      taskId: "task-transport",
      correlationId: "halt-envelope-1",
      sentAt: "2026-03-15T12:00:01Z",
      payload: {
        taskId: "task-transport",
        reason: "wait for human review",
        requestedAt: "2026-03-15T12:00:01Z",
      },
    });

    assert.equal(delivered, "switch to synthesis now");
    assert.equal(halted, "wait for human review");
  });
});
