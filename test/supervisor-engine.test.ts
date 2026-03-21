import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSupervisorInputEnvelope } from "../src/supervisor/contracts.js";
import { SupervisorEngine } from "../src/supervisor/engine.js";
import { MockSupervisorClient } from "../src/supervisor/model-client.js";
import { type LogBatch } from "../src/logging/log-batcher.js";

describe("SupervisorEngine", () => {
  it("evaluates a standardized input into a standardized output envelope", async () => {
    const batch: LogBatch = {
      taskInstruction: "inspect the browser workflow",
      conversationHistory: ["continue with the current task"],
      batch: [
        {
          step: 3,
          timestamp: "2026-03-15T11:00:00Z",
          tool: "agent-browser",
          input: "snapshot",
          output: "ok",
          durationMs: 10,
          status: "ok",
          metadata: { taskId: "task-123" },
        },
      ],
      anomalies: [],
      triggeredBy: "time",
    };
    const input = buildSupervisorInputEnvelope(batch, {
      occurredAt: "2026-03-15T11:00:01Z",
      currentStatus: "running",
      currentStep: 3,
    });
    const engine = new SupervisorEngine({
      client: new MockSupervisorClient({
        status: "warning",
        confidence: 0.84,
        reason: "command failed",
        suggestion: "inspect stderr",
        action: "feedback",
      }),
    });

    const output = await engine.evaluate({
      batch,
      input,
      taskId: "task-123",
      occurredAt: "2026-03-15T11:00:01Z",
    });

    assert.equal(output.decision.status, "warning");
    assert.equal(output.shouldInterveneActor, true);
    assert.equal(output.escalationReport?.taskId, "task-123");
  });
});
