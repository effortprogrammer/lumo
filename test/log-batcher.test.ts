import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LogBatcher } from "../src/logging/log-batcher.js";
import { type TaskContext } from "../src/domain/task.js";

const baseContext: TaskContext = {
  taskId: "task-1",
  instruction: {
    id: "instruction-1",
    text: "Run a supervised task",
    createdAt: "2026-03-12T00:00:00Z",
  },
  conversationHistory: [
    {
      id: "turn-1",
      role: "human",
      text: "Do it carefully.",
      timestamp: "2026-03-12T00:00:01Z",
    },
  ],
};

describe("LogBatcher", () => {
  it("flushes on step threshold", () => {
    const batcher = new LogBatcher(baseContext, {
      maxSteps: 2,
      maxAgeMs: 60_000,
      immediateKeywords: [],
      now: () => 1000,
    });

    batcher.add({
      step: 1,
      timestamp: "2026-03-12T00:00:02Z",
      tool: "bash",
      input: "pwd",
      output: "/tmp",
      durationMs: 5,
    });

    const batch = batcher.add({
      step: 2,
      timestamp: "2026-03-12T00:00:03Z",
      tool: "bash",
      input: "ls",
      output: "file.txt",
      durationMs: 6,
    });

    assert.equal(batch?.triggeredBy, "steps");
    assert.equal(batch?.batch.length, 2);
  });

  it("flushes immediately on risk keyword and preserves screenshot refs", () => {
    const batcher = new LogBatcher(baseContext, {
      maxSteps: 5,
      maxAgeMs: 60_000,
      immediateKeywords: ["sudo"],
      now: () => 1000,
    });

    const batch = batcher.add({
      step: 1,
      timestamp: "2026-03-12T00:00:02Z",
      tool: "agent-browser",
      input: "sudo rm -rf /tmp/demo",
      output: "blocked",
      durationMs: 4,
      screenshotRef: {
        id: "shot-1",
        path: "./shot-1.png",
        capturedAt: "2026-03-12T00:00:02Z",
      },
    });

    assert.equal(batch?.triggeredBy, "risk");
    assert.equal(batch?.batch[0].screenshotRef?.id, "shot-1");
    assert.deepEqual(batch?.batch[0].riskKeywords, ["sudo"]);
  });
});
