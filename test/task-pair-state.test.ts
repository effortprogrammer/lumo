import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTaskPairRuntimeState } from "../src/runtime/task-pair-state.js";

describe("createTaskPairRuntimeState", () => {
  it("creates explicit actor/supervisor pair state for a task runtime", () => {
    const state = createTaskPairRuntimeState({
      sessionId: "session-1",
      taskId: "task-1",
      actorAgentId: "actor-1",
      supervisorAgentId: "supervisor-1",
      status: "running",
      currentStep: 3,
    });

    assert.equal(state.taskId, "task-1");
    assert.equal(state.actor.sessionId, "session-1");
    assert.equal(state.actor.agentId, "actor-1");
    assert.equal(state.actor.status, "running");
    assert.equal(state.actor.currentStep, 3);
    assert.equal(state.supervisor.agentId, "supervisor-1");
    assert.equal(state.supervisor.mode, "in_process");
  });
});
