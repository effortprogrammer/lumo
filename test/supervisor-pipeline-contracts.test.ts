import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
import { createActorTransport } from "../src/a2a/transport.js";
import { type LogBatch } from "../src/logging/log-batcher.js";
import { MockSupervisorClient } from "../src/supervisor/model-client.js";
import { SupervisorPipeline } from "../src/supervisor/pipeline.js";
import { SupervisorEngine } from "../src/supervisor/engine.js";

describe("SupervisorPipeline contracts", () => {
  it("emits onOutput with a standardized supervisor output envelope", async () => {
    const adapter = new StubA2AAdapter();
    adapter.registerMessageHandler("actor", async () => {});
    let capturedOutput: Awaited<ReturnType<SupervisorPipeline["consume"]>> | undefined;

    const pipeline = new SupervisorPipeline({
      actorTransport: createActorTransport(adapter),
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "warning",
        confidence: 0.82,
        reason: "research is not transitioning into synthesis",
        suggestion: "stop browsing and draft the artifact now",
        action: "feedback",
      }),
      onOutput: (output) => {
        capturedOutput = output;
      },
      now: () => "2026-03-15T12:00:00Z",
    });

    const output = await pipeline.consume(createBatch());

    assert.equal(output.decision.status, "warning");
    assert.equal(output.shouldInterveneActor, true);
    assert.equal(capturedOutput?.decision.reason, output.decision.reason);
    assert.equal(capturedOutput?.escalationReport?.taskId, "task-contract");
    assert.equal(adapter.sentMessages.length, 1);
    assert.ok(typeof adapter.sentMessages[0]?.id === "string");
    assert.ok(typeof adapter.sentMessages[0]?.payload.parts[1] === "object");
    const feedbackJson = adapter.sentMessages[0]?.payload.parts[1];
    if (feedbackJson?.kind === "json" && feedbackJson.data.type === "supervisor-feedback") {
      assert.ok(typeof feedbackJson.data.interventionId === "string");
    } else {
      assert.fail("expected supervisor-feedback JSON payload");
    }
  });

  it("accepts an injected engine and keeps pipeline behavior transport-focused", async () => {
    const adapter = new StubA2AAdapter();
    adapter.registerCancelHandler("actor", async () => {});
    const engine = new SupervisorEngine({
      client: new MockSupervisorClient({
        status: "critical",
        confidence: 0.95,
        reason: "manual intervention required",
        suggestion: "wait for the operator",
        action: "halt",
      }),
    });

    const pipeline = new SupervisorPipeline({
      actorTransport: createActorTransport(adapter),
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      engine,
      now: () => "2026-03-15T12:05:00Z",
    });

    const output = await pipeline.consume(createBatch());

    assert.equal(output.shouldEscalateHuman, true);
    assert.equal(adapter.cancelRequests.length, 1);
    assert.ok(typeof adapter.cancelRequests[0]?.id === "string");
    assert.equal(adapter.cancelRequests[0]?.payload.details?.type, "supervisor-halt");
    assert.ok(typeof adapter.cancelRequests[0]?.payload.details?.interventionId === "string");
  });
});

function createBatch(): LogBatch {
  return {
    taskInstruction: "inspect the supervisor contract flow",
    conversationHistory: ["keep watching the actor"],
    triggeredBy: "manual",
    anomalies: [],
    batch: [
      {
        step: 4,
        timestamp: "2026-03-15T12:00:00Z",
        tool: "agent-browser",
        input: "get title",
        output: "OpenAI Careers",
        durationMs: 8,
        status: "ok",
        metadata: {
          taskId: "task-contract",
        },
      },
    ],
  };
}
