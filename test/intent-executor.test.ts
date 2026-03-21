import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeIntentEnvelope } from "../src/channels/intent-executor.js";
import { type SessionManager } from "../src/runtime/session-manager.js";

describe("executeIntentEnvelope", () => {
  it("applies retrieved Memory Harness guidance when starting a task", async () => {
    const created: string[] = [];
    const sessionManager = {
      current: null,
      createTask(instruction: string) {
        created.push(instruction);
        return {};
      },
    } as unknown as SessionManager;

    const result = await executeIntentEnvelope(
      {
        intent: "start_task",
        instruction: "Inspect the browser workflow and summarize the page.",
        confidence: 0.99,
        reason: "start a new task",
        task_ref: null,
      },
      {
        sessionManager,
        prepareTaskInstruction: async () => ({
          taskPattern: "inspect browser workflow summarize page",
          lessons: [],
          skills: [],
          guidanceLines: ["Inspect the browser before repeating the same command."],
        }),
      },
    );

    assert.equal(result, "Started a new task.");
    assert.match(created[0] ?? "", /Memory Harness Guidance/);
    assert.match(created[0] ?? "", /Inspect the browser before repeating the same command/);
  });
});
