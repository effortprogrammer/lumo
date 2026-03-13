import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessA2AAdapter, StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
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
