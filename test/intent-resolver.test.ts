import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IntentResolverPipeline } from "../src/channels/intent-resolver.js";

describe("IntentResolverPipeline", () => {
  const resolver = new IntentResolverPipeline({
    commandMapping: {
      new: ["new"],
      followup: ["followup"],
      resume: ["resume"],
      halt: ["halt"],
      status: ["status"],
    },
    startTaskConfidenceThreshold: 0.7,
  });

  it("defaults natural language requests to start_task", async () => {
    const envelope = await resolver.resolve("Investigate the failing checkout tests", {
      hasActiveTask: false,
      currentTaskId: null,
    });

    assert.equal(envelope.intent, "start_task");
    assert.equal(envelope.task_ref, null);
    assert.equal(envelope.instruction, "Investigate the failing checkout tests");
  });

  it("returns clarify for ambiguous prompts", async () => {
    const envelope = await resolver.resolve("do it", {
      hasActiveTask: false,
      currentTaskId: null,
    });

    assert.equal(envelope.intent, "clarify");
    assert.match(envelope.reason, /ambiguous|clearer/i);
  });

  it("detects resume, halt, and status control phrases without aliases", async () => {
    const resume = await resolver.resolve("continue with the last plan", {
      hasActiveTask: true,
      currentTaskId: "task-123",
    });
    const halt = await resolver.resolve("stop this run", {
      hasActiveTask: true,
      currentTaskId: "task-123",
    });
    const status = await resolver.resolve("what's the status?", {
      hasActiveTask: true,
      currentTaskId: "task-123",
    });

    assert.equal(resume.intent, "resume");
    assert.equal(halt.intent, "halt");
    assert.equal(status.intent, "status");
  });
});
