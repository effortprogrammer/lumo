import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessA2AAdapter } from "../src/a2a/in-process-adapter.js";
import { createDefaultConfig } from "../src/config/load-config.js";
import { type TaskPairing, type ToolExecutionRecord } from "../src/domain/task.js";
import { ActorRuntime } from "../src/runtime/actor-runtime.js";
import { type CommandRunner } from "../src/runtime/subprocess.js";

class FakeRunner implements CommandRunner {
  async run(command: string, args: string[]) {
    if (command === "sh") {
      return {
        stdout: "/tmp/workspace",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      };
    }

    return {
      stdout: JSON.stringify({
        command,
        args,
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 7,
    };
  }
}

describe("ActorRuntime", () => {
  it("emits structured logs for bash, browser, and coding-agent commands", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    const adapter = new InProcessA2AAdapter();
    const logs: ToolExecutionRecord[] = [];
    const runtime = new ActorRuntime({
      pairing: createPairing(),
      config,
      adapter,
      runner: new FakeRunner(),
      now: () => "2026-03-12T00:00:00Z",
      onLog: (record) => {
        logs.push(record);
      },
    });

    await runtime.executeInstruction([
      "/bash pwd",
      "/browser capture page",
      "/agent summarize repo state",
    ].join("\n"));

    assert.equal(logs.length, 3);
    assert.equal(logs[0]?.tool, "bash");
    assert.equal(logs[0]?.status, "ok");
    assert.equal(logs[1]?.tool, "agent-browser");
    assert.equal(logs[1]?.screenshotRef?.path, "./artifacts/mock-browser-shot.txt");
    assert.equal(logs[1]?.metadata?.mode, "mock");
    assert.equal(logs[2]?.tool, "coding-agent");
    assert.equal(logs[2]?.metadata?.mode, "mock");
    assert.equal(
      typeof (logs[2]?.output as { command?: string }).command,
      "string",
    );
  });
});

function createPairing(): TaskPairing {
  return {
    task: {
      taskId: "task-actor",
      actor: {
        id: "actor",
        model: "local-actor",
        systemPrompt: "run commands",
        tools: ["bash", "agent-browser", "coding-agent"],
      },
      supervisor: {
        id: "supervisor",
        model: "mock-supervisor",
        systemPrompt: "watch",
        maxBatchSteps: 5,
        maxBatchAgeMs: 60_000,
      },
      status: "pending",
      createdAt: "2026-03-12T00:00:00Z",
      currentStep: 0,
      lastUpdatedAt: "2026-03-12T00:00:00Z",
    },
    context: {
      taskId: "task-actor",
      instruction: {
        id: "instruction-actor",
        text: "Run commands",
        createdAt: "2026-03-12T00:00:00Z",
      },
      conversationHistory: [],
    },
  };
}
