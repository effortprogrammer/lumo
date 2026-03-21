import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/config/load-config.js";
import { type ConversationTurn, type TaskPairing } from "../src/domain/task.js";
import {
  initializePiMonoRuntimeSessionAdapter,
  type PiMonoRuntimeClient,
  mapPiMonoEventToLumoSessionEvents,
  type RuntimeSession,
  type RuntimeSessionEvent,
} from "../src/runtime/runtime-session-adapter.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { type CommandRunner } from "../src/runtime/subprocess.js";
import { createTaskPairRuntimeState } from "../src/runtime/task-pair-state.js";
import { type A2AEnvelope, type A2AMessage, type CancelTaskRequest } from "../src/a2a/protocol.js";
import { type SupervisorTransport } from "../src/a2a/transport.js";

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

class SupervisablePiMonoClient implements PiMonoRuntimeClient {
  readonly sendCalls: Array<{
    externalSessionId: string;
    text: string;
    options?: {
      role?: ConversationTurn["role"];
      deliverAs?: "auto" | "prompt" | "steer" | "follow_up";
      echoConversation?: boolean;
    };
  }> = [];
  readonly haltCalls: Array<{
    externalSessionId: string;
    reason: string;
    options?: {
      role?: ConversationTurn["role"];
      echoConversation?: boolean;
    };
  }> = [];
  private readonly listeners = new Map<string, (event: RuntimeSessionEventLike) => void>();

  isAvailable(): boolean {
    return true;
  }

  createSession(options: { sessionId: string }): { externalSessionId: string } {
    return {
      externalSessionId: `external-${options.sessionId}`,
    };
  }

  async sendInput(
    externalSessionId: string,
    text: string,
    options?: {
      role?: ConversationTurn["role"];
      deliverAs?: "auto" | "prompt" | "steer" | "follow_up";
      echoConversation?: boolean;
    },
  ): Promise<void> {
    this.sendCalls.push({ externalSessionId, text, options });
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async halt(
    externalSessionId: string,
    reason: string,
    options?: {
      role?: ConversationTurn["role"];
      echoConversation?: boolean;
    },
  ): Promise<void> {
    this.haltCalls.push({ externalSessionId, reason, options });
  }

  subscribe(
    externalSessionId: string,
    listener: (event: RuntimeSessionEventLike) => void,
  ): () => void {
    this.listeners.set(externalSessionId, listener);
    return () => {
      this.listeners.delete(externalSessionId);
    };
  }

  emit(externalSessionId: string, event: RuntimeSessionEventLike): void {
    this.listeners.get(externalSessionId)?.(event);
  }
}

class RecordingSupervisorTransport implements SupervisorTransport {
  readonly progressMessages: Array<A2AEnvelope<A2AMessage>> = [];

  async sendProgress(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    this.progressMessages.push(envelope);
  }

  registerProgressHandler(
    _agentId: string,
    _handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void {}

  registerFeedbackHandler(
    _agentId: string,
    _handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void {}

  registerHaltHandler(
    _agentId: string,
    _handler: (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void,
  ): void {}
}

type RuntimeSessionEventLike = Parameters<PiMonoRuntimeClient["subscribe"]>[1] extends (event: infer T) => void
  ? T
  : never;

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

describe("initializePiMonoRuntimeSessionAdapter", () => {
  it("fails fast when the pi runtime health-check is unavailable and auto-bootstrap is disabled", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.enabled = false;

    await assert.rejects(
      () => initializePiMonoRuntimeSessionAdapter(config, {
        healthCheck: () => false,
      }),
      /Pi runtime health-check failed during startup/i,
    );
  });

  it("runs configured bootstrap commands, waits, and continues when the health-check recovers", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.commands = [
      "pi --version",
      "pi doctor",
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
      args: ["-lc", "pi --version"],
      cwd: "/tmp/bootstrap",
    });
    assert.deepEqual(runner.calls[1], {
      command: "sh",
      args: ["-lc", "pi doctor"],
      cwd: "/tmp/bootstrap",
    });
    assert.deepEqual(sleepCalls, [25]);
    const session = adapter.createSession({
      instruction: "summarize repo",
      cwd: "/tmp",
    });
    assert.equal(session.provider, "pi");
    assert.equal(session.pairState.taskId, session.task.task.taskId);
    assert.equal(session.pairState.actor.agentId, session.task.task.actor.id);
    assert.equal(session.pairState.supervisor.agentId, session.task.task.supervisor.id);
  });

  it("includes attempted bootstrap commands in the startup error when health-check still fails", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.commands = [
      "pi --version",
      "pi doctor",
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
      /Pi runtime health-check failed during startup after runtime command checks.*pi --version.*port 7000 busy.*pi doctor.*spawn ENOENT/is,
    );
  });

  it("returns pi when the scaffolded client reports availability", async () => {
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
    assert.equal(session.provider, "pi");
    assert.match(session.sessionId, /^pi-/);
  });

  it("feeds pi runtime batches through the supervisor and injects feedback on warnings", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.supervisor.client = "heuristic";
    config.batch.maxSteps = 2;
    const client = new SupervisablePiMonoClient();

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
    });

    const session = adapter.createSession({
      instruction: "inspect the failing workflow",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;
    const events: RuntimeSessionEvent[] = [];
    adapter.subscribe(session.sessionId, (event) => {
      events.push(event);
    });

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: session.task.task.taskId,
      startedAt: "2026-03-13T01:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:01Z",
      tool: "bash",
      input: "ls -la",
      output: "ok",
      durationMs: 15,
      exitCode: 0,
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:02Z",
      tool: "bash",
      input: "ls -la",
      output: "ok",
      durationMs: 16,
      exitCode: 0,
    });

    await waitForAsyncWork();

    assert.ok(events.some((event) =>
      event.type === "decision"
      && event.decision.status === "warning"
      && event.decision.action === "feedback"
    ));
    const supervisorOutput = events.find((event) => event.type === "supervisor-output");
    assert.equal(supervisorOutput?.type, "supervisor-output");
    assert.equal(supervisorOutput?.output.decision.status, "warning");
    assert.equal(session.pairState.supervisor.lastOutput?.decision.status, "warning");
    assert.equal(client.sendCalls.length, 1);
    assert.equal(client.sendCalls[0]?.externalSessionId, externalSessionId);
    assert.equal(client.sendCalls[0]?.options?.role, "supervisor");
  });

  it("publishes actor progress snapshots to the configured supervisor transport", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    const client = new SupervisablePiMonoClient();
    const supervisorTransport = new RecordingSupervisorTransport();
    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
      supervisorTransport,
    });

    const session = adapter.createSession({
      instruction: "inspect the browser workflow",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;
    const events: RuntimeSessionEvent[] = [];
    adapter.subscribe(session.sessionId, (event) => {
      events.push(event);
    });

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: session.task.task.taskId,
      startedAt: "2026-03-13T01:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:01Z",
      tool: "agent-browser",
      input: "get title",
      output: "OpenAI Careers",
      durationMs: 10,
      exitCode: 0,
    });

    await waitForAsyncWork();

    assert.ok(events.some((event) => event.type === "supervisor-progress"));
    assert.equal(supervisorTransport.progressMessages.length >= 1, true);
    const latest = supervisorTransport.progressMessages.at(-1);
    assert.ok(typeof latest?.id === "string");
    assert.ok(typeof latest?.pairId === "string");
    const jsonPart = latest?.payload.parts.find((part) => part.kind === "json");
    assert.equal(jsonPart?.kind, "json");
    if (jsonPart?.kind === "json" && jsonPart.data.type === "actor-progress") {
      assert.ok(typeof jsonPart.data.progressId === "string");
      assert.equal(typeof jsonPart.data.sequence, "number");
      assert.equal(jsonPart.data.taskPattern, undefined);
    }
    assert.equal(session.pairState.supervisor.lastProgress?.type, "actor-progress");
  });

  it("halts the pi runtime when the supervisor marks the current state as requiring human escalation", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.supervisor.client = "heuristic";
    const client = new SupervisablePiMonoClient();

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
    });

    const session = adapter.createSession({
      instruction: "clean up the temp directory carefully",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;
    const events: RuntimeSessionEvent[] = [];
    adapter.subscribe(session.sessionId, (event) => {
      events.push(event);
    });

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: session.task.task.taskId,
      startedAt: "2026-03-13T01:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "runtime.anomaly",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:01Z",
      anomaly: {
        id: "anomaly-retry-loop",
        kind: "retry_loop",
        severity: "critical",
        message: "The actor is retrying the same failure pattern without recovering.",
        taskId: session.task.task.taskId,
        sessionId: externalSessionId,
        occurredAt: "2026-03-13T01:00:01Z",
        evidence: {
          retryCount: 3,
          repeatedInput: "curl https://api.example.com",
        },
      },
    });

    await waitForAsyncWork();

    assert.equal(client.haltCalls.length, 1);
    assert.equal(client.haltCalls[0]?.externalSessionId, externalSessionId);
    assert.equal(client.haltCalls[0]?.options?.role, "supervisor");
  });

  it("escalates pi-internal browser tool usage as an unsupported browser-path anomaly", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.supervisor.client = "heuristic";
    const client = new SupervisablePiMonoClient();

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
    });

    const session = adapter.createSession({
      instruction: "search the web for browser usage",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;
    const events: RuntimeSessionEvent[] = [];
    adapter.subscribe(session.sessionId, (event) => {
      events.push(event);
    });

    client.emit(externalSessionId, {
      type: "runtime.anomaly",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:05Z",
      anomaly: {
        id: "anomaly-browser-boundary",
        kind: "unsupported_browser_path",
        severity: "critical",
        message: "Pi attempted to use its internal browser tool.",
        taskId: session.task.task.taskId,
        sessionId: externalSessionId,
        occurredAt: "2026-03-13T01:00:05Z",
      },
    });

    await waitForAsyncWork();

    assert.ok(events.some((event) =>
      event.type === "anomaly"
      && event.anomaly.kind === "unsupported_browser_path"
    ));
  });

  it("does not inject the same recovery feedback repeatedly while a recovery is already in progress", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.supervisor.client = "heuristic";
    const client = new SupervisablePiMonoClient();

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
    });

    const session = adapter.createSession({
      instruction: "recover a stalled browser task",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: session.task.task.taskId,
      startedAt: "2026-03-13T01:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "runtime.anomaly",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:05Z",
      anomaly: {
        id: "anomaly-no-progress-1",
        kind: "no_progress",
        severity: "warning",
        message: "The task has not made measurable progress within the expected interval.",
        taskId: session.task.task.taskId,
        sessionId: externalSessionId,
        occurredAt: "2026-03-13T01:00:05Z",
      },
    });
    await waitForAsyncWork();
    client.emit(externalSessionId, {
      type: "runtime.anomaly",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:06Z",
      anomaly: {
        id: "anomaly-no-progress-2",
        kind: "no_progress",
        severity: "warning",
        message: "The task has not made measurable progress within the expected interval.",
        taskId: session.task.task.taskId,
        sessionId: externalSessionId,
        occurredAt: "2026-03-13T01:00:06Z",
      },
    });
    await waitForAsyncWork();

    assert.equal(client.sendCalls.length, 1);
    assert.equal(client.sendCalls[0]?.options?.deliverAs, "follow_up");
  });

  it("uses steering recovery guidance when the bottleneck indicates a phase transition into synthesis", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.supervisor.client = "heuristic";
    const client = new SupervisablePiMonoClient();

    const adapter = await initializePiMonoRuntimeSessionAdapter(config, {
      piMonoClient: client,
    });

    const session = adapter.createSession({
      instruction: "OpenAI 공고를 보고 필요한 역량을 정리하고 가상의 이력서를 작성해줘",
      cwd: "/tmp",
    });
    const externalSessionId = `external-${session.sessionId}`;

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: session.task.task.taskId,
      startedAt: "2026-03-13T01:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:01Z",
      tool: "agent-browser",
      input: "open https://openai.com/careers",
      output: { title: "Careers at OpenAI" },
      durationMs: 10,
      exitCode: 0,
      metadata: {
        url: "https://openai.com/careers",
        title: "Careers at OpenAI",
      },
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:02Z",
      tool: "agent-browser",
      input: "snapshot",
      output: { title: "Careers at OpenAI" },
      durationMs: 10,
      exitCode: 0,
      metadata: {
        url: "https://openai.com/careers",
        title: "Careers at OpenAI",
      },
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:03Z",
      tool: "agent-browser",
      input: "get title",
      output: { title: "Careers at OpenAI" },
      durationMs: 10,
      exitCode: 0,
      metadata: {
        url: "https://openai.com/careers",
        title: "Careers at OpenAI",
      },
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: session.task.task.taskId,
      occurredAt: "2026-03-13T01:00:04Z",
      tool: "agent-browser",
      input: "snapshot",
      output: { title: "Careers at OpenAI" },
      durationMs: 10,
      exitCode: 0,
      metadata: {
        url: "https://openai.com/careers",
        title: "Careers at OpenAI",
      },
    });

    await waitForAsyncWork();

    assert.ok(client.sendCalls.some((call) => call.options?.deliverAs === "steer"));
    assert.ok(client.sendCalls.some((call) =>
      /Stop broad navigation and use the current page as the primary source|Extract the required skills, responsibilities, and qualifications/i.test(call.text),
    ));
  });
});

describe("SessionManager", () => {
  it("fails fast during construction when pi startup health-check fails", async () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });
    config.runtime.bootstrap.enabled = false;

    await assert.rejects(
      () => SessionManager.create(config, undefined, undefined, {
        healthCheck: () => false,
      }),
      /Pi runtime health-check failed during startup/i,
    );
  });

  it("exposes explicit actor/supervisor pair state for the current task session", async () => {
    const config = createDefaultConfig();
    const manager = await SessionManager.create(config, undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: new AvailablePiMonoClient(),
    });

    const session = manager.createTask("summarize repo");

    assert.equal(session.pairState.taskId, session.runtime.task.task.taskId);
    assert.equal(session.pairState.actor.agentId, session.runtime.task.task.actor.id);
    assert.equal(session.pairState.supervisor.agentId, session.runtime.task.task.supervisor.id);
    assert.equal(manager.current?.pairState.actor.sessionId, session.runtime.sessionId);
    assert.deepEqual(session.supervisorOutputs, []);
  });
});

describe("mapPiMonoEventToLumoSessionEvents", () => {
  it("maps hypothetical pi events into deterministic lumo session events", () => {
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
      metadata: {
        url: "https://example.com",
      },
      screenshotRef: {
        id: "shot-1",
        path: "/tmp/shot-1.png",
        capturedAt: "2026-03-13T01:00:01Z",
      },
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
    const anomaly = mapPiMonoEventToLumoSessionEvents({
      type: "runtime.anomaly",
      taskId: "pi-task-1",
      occurredAt: "2026-03-13T01:00:04Z",
      anomaly: {
        id: "anomaly-1",
        kind: "unsupported_browser_path",
        severity: "critical",
        message: "Pi attempted to use its internal browser tool.",
        taskId: "pi-task-1",
        occurredAt: "2026-03-13T01:00:04Z",
      },
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
          runtimeProvider: "pi",
          sourceTaskId: "pi-task-1",
          runtimeSessionId: "session-pi",
          url: "https://example.com",
        },
        screenshotRef: {
          id: "shot-1",
          path: "/tmp/shot-1.png",
          capturedAt: "2026-03-13T01:00:01Z",
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
    assert.deepEqual(anomaly, [{
      type: "anomaly",
      sessionId: "session-pi",
      anomaly: {
        id: "anomaly-1",
        kind: "unsupported_browser_path",
        severity: "critical",
        message: "Pi attempted to use its internal browser tool.",
        taskId: "pi-task-1",
        occurredAt: "2026-03-13T01:00:04Z",
      },
    }]);
    assert.equal(session.task.task.currentStep, 1);
    assert.equal(session.pairState.actor.status, "running");
    assert.equal(session.pairState.actor.currentStep, 1);
    assert.equal(session.pairState.supervisor.lastDecision?.action, "feedback");
    assert.equal(session.pairState.actor.lastInputAt, "2026-03-13T01:00:03Z");
    assert.deepEqual(session.task.context.conversationHistory, [conversationTurn]);
  });
});

function createSessionFixture(): RuntimeSession {
  const task: TaskPairing = {
    task: {
      taskId: "pi-task-1",
      actor: {
        id: "actor",
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
    provider: "pi",
    task,
    pairState: createTaskPairRuntimeState({
      sessionId: "session-pi",
      taskId: "pi-task-1",
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      status: "pending",
      currentStep: 0,
    }),
    actorLogs: [],
  };
}

async function waitForAsyncWork(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
