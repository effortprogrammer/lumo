import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
import { createDefaultConfig } from "../src/config/load-config.js";
import { type TaskPairing } from "../src/domain/task.js";
import { type LogBatch } from "../src/logging/log-batcher.js";
import { ActorRuntime } from "../src/runtime/actor-runtime.js";
import { type CommandRunner } from "../src/runtime/subprocess.js";
import { MockSupervisorClient } from "../src/supervisor/model-client.js";
import { SupervisorPipeline } from "../src/supervisor/pipeline.js";

const runner: CommandRunner = {
  async run() {
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  },
};

describe("SupervisorPipeline", () => {
  it("routes feedback decisions to the actor over A2A and pauses the task", async () => {
    const adapter = new StubA2AAdapter();
    const runtime = new ActorRuntime({
      pairing: createPairing(),
      config: createDefaultConfig(),
      adapter,
      runner,
      now: () => "2026-03-12T00:00:00Z",
    });
    const pipeline = new SupervisorPipeline({
      adapter,
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "warning",
        confidence: 0.8,
        reason: "loop detected",
        suggestion: "change approach",
        action: "feedback",
      }),
      now: () => "2026-03-12T00:00:00Z",
    });

    await pipeline.consume(createBatch());

    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(runtime.task.task.status, "paused");
    assert.equal(
      runtime.task.context.conversationHistory.at(-1)?.text,
      "change approach",
    );
  });

  it("routes halt decisions to the actor over A2A cancel flow", async () => {
    const adapter = new StubA2AAdapter();
    const runtime = new ActorRuntime({
      pairing: createPairing(),
      config: createDefaultConfig(),
      adapter,
      runner,
      now: () => "2026-03-12T00:00:00Z",
    });
    const pipeline = new SupervisorPipeline({
      adapter,
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "critical",
        confidence: 0.95,
        reason: "unsafe command",
        suggestion: "stop immediately",
        action: "halt",
      }),
      now: () => "2026-03-12T00:00:00Z",
    });

    await pipeline.consume(createBatch());

    assert.equal(adapter.cancelRequests.length, 1);
    assert.equal(runtime.task.task.status, "halted");
    assert.equal(
      runtime.task.context.conversationHistory.at(-1)?.text,
      "Supervisor halt: stop immediately",
    );
  });
});

function createBatch(): LogBatch {
  return {
    taskInstruction: "test",
    conversationHistory: [],
    triggeredBy: "manual",
    batch: [
      {
        step: 1,
        timestamp: "2026-03-12T00:00:00Z",
        tool: "bash",
        input: "echo hi",
        output: "hi",
        durationMs: 1,
        metadata: {
          taskId: "task-supervisor",
        },
      },
    ],
  };
}

function createPairing(): TaskPairing {
  return {
    task: {
      taskId: "task-supervisor",
      actor: {
        id: "actor",
        model: "local-actor",
        systemPrompt: "run",
        tools: ["bash", "agent-browser", "coding-agent"],
      },
      supervisor: {
        id: "supervisor",
        model: "mock-supervisor",
        systemPrompt: "watch",
        maxBatchSteps: 2,
        maxBatchAgeMs: 1_000,
      },
      status: "running",
      createdAt: "2026-03-12T00:00:00Z",
      startedAt: "2026-03-12T00:00:00Z",
      currentStep: 1,
      lastUpdatedAt: "2026-03-12T00:00:00Z",
    },
    context: {
      taskId: "task-supervisor",
      instruction: {
        id: "instruction-supervisor",
        text: "watch actor",
        createdAt: "2026-03-12T00:00:00Z",
      },
      conversationHistory: [],
    },
  };
}
