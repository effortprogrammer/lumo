import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/config/load-config.js";
import { type ConversationTurn, type TaskPairing } from "../src/domain/task.js";
import {
  initializePiMonoRuntimeSessionAdapter,
  LegacyRuntimeAdapter,
  type PiMonoRuntimeClient,
  mapPiMonoEventToLumoSessionEvents,
  type RuntimeSession,
  type RuntimeSessionEvent,
} from "../src/runtime/runtime-session-adapter.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { type CommandRunner } from "../src/runtime/subprocess.js";

class FakeRunner implements CommandRunner {
  async run(command: string, args: string[]) {
    if (command === "sh") {
      return {
        stdout: args.at(-1) ?? "",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      };
    }

    return {
      stdout: JSON.stringify({ command, args }),
      stderr: "",
      exitCode: 0,
      durationMs: 7,
    };
  }
}

class AvailablePiMonoClient implements PiMonoRuntimeClient {
  isAvailable(): boolean {
    return true;
  }

  createSession(options: { sessionId: string }): { externalSessionId: string } {
    return {
      externalSessionId: `external-${options.sessionId}`,
    };
  }

  async sendInput(): Promise<void> {}

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async halt(): Promise<void> {}

  subscribe(): () => void {
    return () => {};
  }
}

class BootstrapRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

  constructor(
    private readonly results: Array<
      | {
        stdout: string;
        stderr: string;
        exitCode: number | null;
        durationMs: number;
      }
      | Error
    >,
  ) {}

  async run(command: string, args: string[], options?: { cwd?: string }) {
    this.calls.push({ command, args, cwd: options?.cwd });
    const next = this.results.shift();
    if (next instanceof Error) {
      throw next;
    }

    return next ?? {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  }
}

describe("LegacyRuntimeAdapter", () => {
  it("implements the runtime session adapter contract for create/send/pause/resume/halt", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    const adapter = new LegacyRuntimeAdapter({
      config,
      runner: new FakeRunner(),
      now: () => "2026-03-13T00:00:00Z",
    });
    const session = adapter.createSession({
      instruction: "/bash echo ready",
      cwd: "/tmp",
    });
    const events: RuntimeSessionEvent[] = [];
    adapter.subscribe(session.sessionId, (event) => {
      events.push(event);
    });

    await adapter.pause(session.sessionId, "Manual pause for test");
    await adapter.sendInput(session.sessionId, "/bash echo paused");
    assert.equal(session.task.task.status, "paused");
    assert.equal(session.actorLogs.length, 0);

    await adapter.resume(session.sessionId);
    assert.equal(session.task.task.status, "completed");
    assert.equal(session.actorLogs.length, 1);
    assert.equal(session.actorLogs[0]?.tool, "bash");
    assert.equal(session.actorLogs[0]?.output, "echo paused");

    await adapter.halt(session.sessionId, "contract halt");
    assert.equal(session.task.task.status, "halted");
    assert.ok(events.some((event) => event.type === "conversation"));
    assert.ok(events.some((event) => event.type === "status" && event.status === "paused"));
    assert.ok(events.some((event) => event.type === "log"));
    assert.ok(events.some((event) => event.type === "status" && event.status === "completed"));
    assert.ok(events.some((event) => event.type === "status" && event.status === "halted"));
  });
});

describe("initializePiMonoRuntimeSessionAdapter", () => {
  it("fails fast when the pi-mono runtime health-check is unavailable and auto-bootstrap is disabled", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.enabled = false;

    await assert.rejects(
      () => initializePiMonoRuntimeSessionAdapter(config),
      /Pi-mono runtime health-check failed during startup/i,
    );
  });

  it("runs configured bootstrap commands, waits, and continues when the health-check recovers", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.commands = [
      "pi-mono bootstrap",
      "pi-mono warmup",
    ];
    config.runtime.bootstrap.retryBackoffMs = 25;
    const runner = new BootstrapRunner([
      {
        stdout: "bootstrapped",
        stderr: "",
        exitCode: 0,
        durationMs: 4,
      },
      {
        stdout: "warmed",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
      },
    ]);
    const sleepCalls: number[] = [];
    const healthSequence = [false, true];

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: new AvailablePiMonoClient(),
      bootstrapRunner: runner,
      healthCheck: () => healthSequence.shift() ?? true,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      cwd: "/tmp/bootstrap",
    });

    assert.equal(runner.calls.length, 2);
    assert.deepEqual(runner.calls[0], {
      command: "sh",
      args: ["-lc", "pi-mono bootstrap"],
      cwd: "/tmp/bootstrap",
    });
    assert.deepEqual(runner.calls[1], {
      command: "sh",
      args: ["-lc", "pi-mono warmup"],
      cwd: "/tmp/bootstrap",
    });
    assert.deepEqual(sleepCalls, [25]);
    const session = adapter.createSession({
      instruction: "summarize repo",
      cwd: "/tmp",
    });
    assert.equal(session.provider, "pi-mono");
  });

  it("includes attempted bootstrap commands in the startup error when health-check still fails", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.commands = [
      "pi-mono bootstrap",
      "pi-mono doctor",
    ];
    const runner = new BootstrapRunner([
      {
        stdout: "",
        stderr: "port 7000 busy",
        exitCode: 1,
        durationMs: 3,
      },
      new Error("spawn ENOENT"),
    ]);

    await assert.rejects(
      () => initializePiMonoRuntimeSessionAdapter(config, {
        piMonoClient: new AvailablePiMonoClient(),
        bootstrapRunner: runner,
        healthCheck: () => false,
        sleep: async () => {},
      }),
      /Pi-mono runtime health-check failed during startup after auto-bootstrap.*pi-mono bootstrap.*port 7000 busy.*pi-mono doctor.*spawn ENOENT/is,
    );
  });

  it("returns pi-mono when the scaffolded client reports availability", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: new AvailablePiMonoClient(),
    });

    const session = adapter.createSession({
      instruction: "summarize repo",
      cwd: "/tmp",
    });
    assert.equal(session.provider, "pi-mono");
    assert.match(session.sessionId, /^pi-mono-/);
  });
});

describe("SessionManager", () => {
  it("fails fast during construction when pi-mono startup health-check fails", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.enabled = false;

    await assert.rejects(
      () => SessionManager.create(config),
      /Pi-mono runtime health-check failed during startup/i,
    );
  });
});

describe("mapPiMonoEventToLumoSessionEvents", () => {
  it("maps hypothetical pi-mono events into deterministic lumo session events", () => {
    const session = createSessionFixture();
    const conversationTurn: ConversationTurn = {
      id: "turn-1",
      role: "supervisor",
      text: "Need approval before proceeding",
      timestamp: "2026-03-13T01:00:03Z",
    };

    const started = mapPiMonoEventToLumoSessionEvents({
      type: "session.started",
      taskId: "pi-task-1",
      startedAt: "2026-03-13T01:00:00Z",
    }, session);
    const output = mapPiMonoEventToLumoSessionEvents({
      type: "task.output",
      taskId: "pi-task-1",
      occurredAt: "2026-03-13T01:00:01Z",
      tool: "coding-agent",
      input: "summarize repo",
      output: { summary: "ok" },
      durationMs: 42,
      exitCode: 0,
    }, session);
    const decision = mapPiMonoEventToLumoSessionEvents({
      type: "supervisor.decision",
      taskId: "pi-task-1",
      occurredAt: "2026-03-13T01:00:02Z",
      decision: {
        status: "warning",
        confidence: 0.8,
        reason: "Needs confirmation",
        action: "feedback",
      },
    }, session);
    const conversation = mapPiMonoEventToLumoSessionEvents({
      type: "conversation.turn",
      taskId: "pi-task-1",
      turn: conversationTurn,
    }, session);

    assert.deepEqual(started, [{
      type: "status",
      sessionId: "session-pi",
      status: "running",
    }]);
    assert.deepEqual(output, [{
      type: "log",
      sessionId: "session-pi",
      record: {
        step: 1,
        timestamp: "2026-03-13T01:00:01Z",
        tool: "coding-agent",
        input: "summarize repo",
        output: { summary: "ok" },
        durationMs: 42,
        exitCode: 0,
        status: "ok",
        metadata: {
          runtimeProvider: "pi-mono",
          sourceTaskId: "pi-task-1",
        },
      },
    }]);
    assert.deepEqual(decision, [{
      type: "decision",
      sessionId: "session-pi",
      decision: {
        status: "warning",
        confidence: 0.8,
        reason: "Needs confirmation",
        action: "feedback",
      },
    }]);
    assert.deepEqual(conversation, [{
      type: "conversation",
      sessionId: "session-pi",
      turn: conversationTurn,
    }]);
    assert.equal(session.task.task.currentStep, 1);
    assert.deepEqual(session.task.context.conversationHistory, [conversationTurn]);
  });
});

function createSessionFixture(): RuntimeSession {
  const task: TaskPairing = {
    task: {
      taskId: "pi-task-1",
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
        maxBatchSteps: 3,
        maxBatchAgeMs: 30_000,
      },
      status: "pending",
      createdAt: "2026-03-13T01:00:00Z",
      currentStep: 0,
      lastUpdatedAt: "2026-03-13T01:00:00Z",
    },
    context: {
      taskId: "pi-task-1",
      instruction: {
        id: "instruction-pi-1",
        text: "summarize repo",
        createdAt: "2026-03-13T01:00:00Z",
      },
      conversationHistory: [],
    },
  };

  return {
    sessionId: "session-pi",
    provider: "pi-mono",
    task,
    actorLogs: [],
  };
}
