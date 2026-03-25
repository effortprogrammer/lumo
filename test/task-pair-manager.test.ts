import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/config/load-config.js";
import { InProcessA2AAdapter } from "../src/a2a/in-process-adapter.js";
import {
  buildActorProgressMessage,
  buildSupervisorFeedbackMessage,
  buildSupervisorHaltMessage,
} from "../src/a2a/protocol.js";
import {
  type PiMonoRuntimeClient,
  type RuntimeSessionEvent,
} from "../src/runtime/runtime-session-adapter.js";
import { TaskPairManager } from "../src/runtime/task-pair-manager.js";
import {
  type SupervisorSessionBootstrapper,
  type SupervisorSessionProgressDeliveryRequest,
} from "../src/runtime/supervisor-session-bootstrap.js";
import { type AgentikaEventSink } from "../src/event/agentika-sink.js";

class AvailablePiMonoClient implements PiMonoRuntimeClient {
  private readonly listeners = new Map<string, (event: RuntimeSessionEventLike) => void>();
  readonly sendInputs: string[] = [];
  readonly halts: string[] = [];

  isAvailable(): boolean {
    return true;
  }

  createSession(options: { sessionId: string }): { externalSessionId: string } {
    return {
      externalSessionId: `external-${options.sessionId}`,
    };
  }

  async sendInput(_externalSessionId: string, text: string): Promise<void> {
    this.sendInputs.push(text);
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async halt(_externalSessionId: string, reason: string): Promise<void> {
    this.halts.push(reason);
  }
  subscribe(externalSessionId: string, listener: (event: RuntimeSessionEventLike) => void): () => void {
    this.listeners.set(externalSessionId, listener);
    return () => {
      this.listeners.delete(externalSessionId);
    };
  }

  emit(externalSessionId: string, event: RuntimeSessionEventLike): void {
    this.listeners.get(externalSessionId)?.(event);
  }
}

type RuntimeSessionEventLike = Parameters<PiMonoRuntimeClient["subscribe"]>[1] extends (event: infer T) => void
  ? T
  : never;

describe("TaskPairManager", () => {
  it("wraps SessionManager in pair-oriented accessors", async () => {
    const client = new AvailablePiMonoClient();
    const manager = await TaskPairManager.create(createDefaultConfig(), undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: client,
    });

    const pair = manager.createPair("summarize repo");

    assert.equal(pair.taskId, pair.session.runtime.task.task.taskId);
    assert.equal(pair.actorAgentId, pair.session.runtime.task.task.actor.id);
    assert.equal(pair.supervisorAgentId, pair.session.runtime.task.task.supervisor.id);
    assert.equal(manager.current?.pairState.pairId, pair.pairState.pairId);
    assert.deepEqual(pair.supervisorOutputs, []);
    assert.deepEqual(pair.supervisorProgress, []);
    assert.equal(pair.pairState.supervisor.status, "ready");
    assert.equal(typeof pair.pairState.supervisor.bootstrappedAt, "string");
    assert.equal(pair.pairState.supervisor.sessionId, `supervisor-${pair.taskId}`);
  });

  it("surfaces pair-oriented runtime callbacks with managed pair context", async () => {
    const client = new AvailablePiMonoClient();
    const statuses: string[] = [];
    const progressSummaries: string[] = [];
    const manager = await TaskPairManager.create(createDefaultConfig(), undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: client,
    });

    const pair = manager.createPair("summarize repo", {
      onStatusChange(currentPair, status) {
        statuses.push(`${currentPair.taskId}:${status}`);
      },
      onSupervisorProgress(currentPair, progress) {
        progressSummaries.push(`${currentPair.taskId}:${progress.summary ?? ""}`);
      },
    });
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T10:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T10:00:01Z",
      tool: "bash",
      input: "pwd",
      output: "/tmp",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(statuses.some((entry) => entry.endsWith(":running")));
    assert.ok(progressSummaries.some((entry) => entry.includes("bash pwd")));
    assert.equal(manager.current?.supervisorProgress.length ? true : false, true);
    assert.equal(manager.current?.pairState.supervisor.status, "observing");
    assert.equal(manager.peekSupervisorInbox().length >= 1, true);

    const drained = manager.drainSupervisorInbox();
    assert.equal(drained.length >= 1, true);
    assert.equal(manager.peekSupervisorInbox().length, 0);
    assert.equal(manager.current?.pairState.supervisor.status, "ready");
  });

  it("runs an in-process supervisor observation cycle over the current pair", async () => {
    const client = new AvailablePiMonoClient();
    const manager = await TaskPairManager.create(createDefaultConfig(), undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: client,
    });

    const pair = manager.createPair("inspect the browser workflow");
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T11:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T11:00:01Z",
      tool: "agent-browser",
      input: "get title",
      output: "OpenAI Careers",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const cycle = await manager.observeCurrentPair();

    assert.equal(cycle?.pair.taskId, pair.taskId);
    assert.equal(cycle?.input.currentStep, pair.pairState.actor.currentStep);
    assert.equal(typeof cycle?.output.decision.reason, "string");
    assert.equal(pair.supervisorOutputs.length >= 1, true);
  });

  it("sends observation feedback decisions back into the actor session", async () => {
    const client = new AvailablePiMonoClient();
    const manager = await TaskPairManager.create(createDefaultConfig(), undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: client,
    });
    const pair = manager.createPair("inspect the browser workflow");
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T11:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T11:00:01Z",
      tool: "agent-browser",
      input: "get title",
      output: "OpenAI Careers",
      durationMs: 5,
      exitCode: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const evaluateCalls: number[] = [];
    (manager as unknown as {
      supervisorEngine: {
        evaluate(input: unknown): Promise<{
          decision: {
            status: "warning";
            confidence: number;
            reason: string;
            suggestion: string;
            action: "feedback";
          };
        }>;
      };
    }).supervisorEngine = {
      async evaluate(input) {
        evaluateCalls.push(1);
        return {
          input,
          decision: {
            status: "warning",
            confidence: 0.9,
            reason: "Need to synthesize now",
            suggestion: "Stop browsing and draft the answer",
            action: "feedback",
          },
        };
      },
    };

    await manager.observeCurrentPair();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(evaluateCalls.length, 1);
    assert.ok(client.sendInputs.some((input) => input.includes("Stop browsing and draft the answer")));
    assert.equal(pair.supervisorInterventions.at(-1)?.type, "supervisor-feedback");
  });

  it("shadow-writes supervisor decisions during observation", async () => {
    const client = new AvailablePiMonoClient();
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const eventSink: AgentikaEventSink = {
      async publish(event) {
        published.push({
          type: event.type,
          payload: event.payload,
        });
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        eventSink,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T11:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T11:00:01Z",
      tool: "agent-browser",
      input: "get title",
      output: "OpenAI Careers",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await manager.observeCurrentPair();

    assert.ok(published.some((event) => event.type === "supervisor.decision"));
  });

  it("includes recent Agentika actor.progress events in supervisor input", async () => {
    const client = new AvailablePiMonoClient();
    const eventSink: AgentikaEventSink = {
      async publish() {},
      async fetchRecent() {
        return [
          {
            id: "evt-progress-1",
            offset: "0",
            source: "lumo.actor",
            type: "actor.progress",
            timestamp: Date.now(),
            payload: {
              progressId: "progress-1",
              actorSessionId: "session-1",
              sequence: 4,
              summary: "collected several product prices",
              currentStatus: "running",
              currentStep: 4,
              collectionState: {
                itemsCollected: 4,
                distinctItems: 3,
                fieldsSeen: ["name", "price"],
              },
            },
          },
        ];
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        eventSink,
      },
    );

    manager.createPair("inspect the browser workflow");
    const cycle = await manager.observeCurrentPair();

    assert.equal(cycle?.input.recentActorProgressEvents?.[0]?.summary, "collected several product prices");
    assert.equal(cycle?.input.recentActorProgressEvents?.[0]?.collectionState?.distinctItems, 3);
  });

  it("runs a background supervisor loop that consumes the supervisor inbox", async () => {
    const client = new AvailablePiMonoClient();
    const manager = await TaskPairManager.create(createDefaultConfig(), undefined, undefined, {
      healthCheck: () => true,
      piMonoClient: client,
    });

    const pair = manager.createPair("inspect the browser workflow");
    manager.startSupervisorLoop(5);
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;

    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T11:05:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T11:05:01Z",
      tool: "bash",
      input: "pwd",
      output: "/tmp",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(manager.isSupervisorLoopRunning(), true);
    assert.equal(pair.supervisorOutputs.length >= 1, true);
    assert.equal(manager.peekSupervisorInbox().length, 0);
    manager.stopSupervisorLoop();
    assert.equal(manager.isSupervisorLoopRunning(), false);
  });

  it("supports an async separate-session supervisor bootstrapper", async () => {
    const client = new AvailablePiMonoClient();
    const bootstrapper: SupervisorSessionBootstrapper = {
      async bootstrap(request) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
      },
    );

    const pair = manager.createPair("summarize repo");
    assert.equal(pair.pairState.supervisor.status, "bootstrapping");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(pair.pairState.supervisor.mode, "separate_session");
    assert.equal(pair.pairState.supervisor.status, "ready");
    assert.equal(pair.pairState.supervisor.sessionId, `sup-session-${pair.taskId}`);
  });

  it("keeps the background loop from doing in-process observation when the supervisor is separate-session", async () => {
    const client = new AvailablePiMonoClient();
    const bootstrapper: SupervisorSessionBootstrapper & {
      deliverProgress(request: SupervisorSessionProgressDeliveryRequest): Promise<void>;
    } = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
      async deliverProgress() {},
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    manager.startSupervisorLoop(5);
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T12:10:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T12:10:01Z",
      tool: "bash",
      input: "pwd",
      output: "/tmp",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(pair.pairState.supervisor.mode, "separate_session");
    assert.equal(pair.supervisorOutputs.length, 0);
    assert.equal(manager.peekSupervisorInbox().length, 0);
    assert.equal(typeof pair.pairState.supervisor.lastInboxDrainedAt, "string");
    manager.stopSupervisorLoop();
  });

  it("forwards drained progress into a separate supervisor session when the bootstrapper supports delivery", async () => {
    const client = new AvailablePiMonoClient();
    const delivered: SupervisorSessionProgressDeliveryRequest[] = [];
    const bootstrapper: SupervisorSessionBootstrapper & {
      deliverProgress(request: SupervisorSessionProgressDeliveryRequest): Promise<void>;
    } = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
      async deliverProgress(request) {
        delivered.push(request);
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    manager.startSupervisorLoop(5);
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-16T12:40:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-16T12:40:01Z",
      tool: "bash",
      input: "pwd",
      output: "/tmp",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(delivered.length >= 1, true);
    assert.equal(delivered[0]?.supervisorSessionId, `sup-session-${pair.taskId}`);
    assert.equal(delivered[0]?.taskId, pair.taskId);
    assert.equal(typeof delivered[0]?.input?.taskInstruction, "string");
    assert.equal(Array.isArray(delivered[0]?.input?.recentLogs), true);
    assert.equal(typeof delivered[0]?.input?.taskPhase?.currentPhase, "string");
    manager.stopSupervisorLoop();
  });

  it("sends an intervention ack back to the supervisor session when separate-session feedback is applied", async () => {
    const client = new AvailablePiMonoClient();
    const delivered: SupervisorSessionProgressDeliveryRequest[] = [];
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper & {
      deliverProgress(request: SupervisorSessionProgressDeliveryRequest): Promise<void>;
    } = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
      async deliverProgress(request) {
        delivered.push(request);
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    await transportAdapter.sendMessage({
      from: pair.pairState.supervisor.sessionId ?? "sup-session",
      to: pair.actorAgentId,
      payload: {
        id: "feedback-1",
        taskId: pair.taskId,
        role: "system",
        parts: [
          { kind: "text", text: "stop browsing and synthesize now" },
          {
            kind: "json",
            data: buildSupervisorFeedbackMessage({
              interventionId: "intervention-1",
              decision: {
                status: "warning",
                confidence: 0.9,
                reason: "switch to synthesis",
                suggestion: "use the gathered source now",
                action: "feedback",
              },
            }),
          },
        ],
        sentAt: "2026-03-16T12:30:00Z",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(delivered.length >= 2, true);
    const ackDelivery = delivered.find((item) => item.ack);
    const resultDelivery = delivered.find((item) => item.result);
    assert.equal(ackDelivery?.ack?.type, "actor-intervention-ack");
    assert.equal(ackDelivery?.ack?.interventionId, "intervention-1");
    assert.equal(ackDelivery?.ack?.accepted, true);
    assert.equal(resultDelivery?.result?.type, "actor-intervention-result");
    assert.equal(resultDelivery?.result?.interventionId, "intervention-1");
    assert.equal(resultDelivery?.result?.outcome, "applied");
    assert.equal(pair.supervisorInterventionResults.at(-1)?.outcome, "applied");
    assert.equal(pair.pairState.supervisor.lastInterventionResult?.outcome, "applied");
    assert.equal(pair.pairState.supervisor.lastInterventionEffect?.status, "pending");
  });

  it("marks an applied intervention as resolved when follow-up progress is clean", async () => {
    const client = new AvailablePiMonoClient();
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    pair.pairState.supervisor.lastInterventionResult = {
      type: "actor-intervention-result",
      interventionId: "intervention-2",
      actorSessionId: pair.session.runtime.sessionId,
      outcome: "applied",
      reportedAt: "2026-03-16T12:35:00Z",
      summary: "actor applied the intervention",
    };
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId: "intervention-2",
      status: "pending",
      evaluatedAt: "2026-03-16T12:35:00Z",
    };
    await transportAdapter.sendMessage({
      from: pair.actorAgentId,
      to: pair.supervisorAgentId,
      payload: {
        id: "progress-clean",
        taskId: pair.taskId,
        role: "assistant",
        parts: [{ kind: "json", data: buildActorProgressMessage({
          progressId: "progress-clean",
          actorSessionId: pair.session.runtime.sessionId,
          sequence: 2,
          currentStatus: "running",
          currentStep: 2,
          summary: "actor moved forward cleanly",
          anomalies: [],
        }) }],
        sentAt: "2026-03-16T12:35:10Z",
      },
    });

    assert.equal(pair.pairState.supervisor.lastInterventionEffect?.status, "resolved");
  });

  it("marks an applied intervention as unresolved when follow-up progress still has anomalies", async () => {
    const client = new AvailablePiMonoClient();
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    pair.pairState.supervisor.lastInterventionResult = {
      type: "actor-intervention-result",
      interventionId: "intervention-3",
      actorSessionId: pair.session.runtime.sessionId,
      outcome: "applied",
      reportedAt: "2026-03-16T12:36:00Z",
      summary: "actor applied the intervention",
    };
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId: "intervention-3",
      status: "pending",
      evaluatedAt: "2026-03-16T12:36:00Z",
    };
    await transportAdapter.sendMessage({
      from: pair.actorAgentId,
      to: pair.supervisorAgentId,
      payload: {
        id: "progress-bad",
        taskId: pair.taskId,
        role: "assistant",
        parts: [{ kind: "json", data: buildActorProgressMessage({
          progressId: "progress-bad",
          actorSessionId: pair.session.runtime.sessionId,
          sequence: 3,
          currentStatus: "running",
          currentStep: 3,
          summary: "actor still looks stuck",
          anomalies: [{
            id: "anom-1",
            kind: "no_progress",
            severity: "warning",
            message: "still stuck",
            taskId: pair.taskId,
            occurredAt: "2026-03-16T12:36:10Z",
          }],
        }) }],
        sentAt: "2026-03-16T12:36:10Z",
      },
    });

    assert.equal(pair.pairState.supervisor.lastInterventionEffect?.status, "unresolved");
  });

  it("uses specialized phase-transition hints to mark synthesis-oriented recovery as resolved", async () => {
    const client = new AvailablePiMonoClient();
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    pair.pairState.supervisor.lastDecision = {
      status: "warning",
      confidence: 0.9,
      reason: "switch to synthesis",
      action: "feedback",
    };
    pair.pairState.supervisor.lastInterventionResult = {
      type: "actor-intervention-result",
      interventionId: "intervention-4",
      actorSessionId: pair.session.runtime.sessionId,
      outcome: "applied",
      reportedAt: "2026-03-16T12:37:00Z",
      summary: "actor applied the intervention",
    };
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId: "intervention-4",
      status: "pending",
      evaluatedAt: "2026-03-16T12:37:00Z",
    };
    await transportAdapter.sendMessage({
      from: pair.actorAgentId,
      to: pair.supervisorAgentId,
      payload: {
        id: "progress-synthesis",
        taskId: pair.taskId,
        role: "assistant",
        parts: [{ kind: "json", data: buildActorProgressMessage({
          progressId: "progress-synthesis",
          actorSessionId: pair.session.runtime.sessionId,
          sequence: 4,
          currentStatus: "running",
          currentStep: 4,
          summary: "switching to synthesis and drafting now",
          anomalies: [],
          taskPhase: {
            currentPhase: "synthesis",
            confidence: 0.9,
            summary: "The actor is now synthesizing the final artifact.",
            evidence: [],
          },
        }) }],
        sentAt: "2026-03-16T12:37:10Z",
      },
    });

    assert.equal(pair.pairState.supervisor.lastInterventionEffect?.status, "resolved");
  });

  it("routes separate-session supervisor feedback and halt messages back into the actor session", async () => {
    const client = new AvailablePiMonoClient();
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    const initialSendCount = client.sendInputs.length;
    await transportAdapter.sendMessage({
      from: pair.pairState.supervisor.sessionId ?? "sup-session",
      to: pair.actorAgentId,
      payload: {
        id: "feedback-1",
        taskId: pair.taskId,
        role: "system",
        parts: [
          { kind: "text", text: "stop browsing and synthesize now" },
          {
            kind: "json",
            data: buildSupervisorFeedbackMessage({
              decision: {
                status: "warning",
                confidence: 0.9,
                reason: "switch to synthesis",
                suggestion: "use the gathered source now",
                action: "feedback",
              },
              targetPhase: "synthesis",
              instructions: ["Extract requirements.", "Draft the resume now."],
            }),
          },
        ],
        sentAt: "2026-03-16T12:30:00Z",
      },
    });
    await transportAdapter.cancelTask({
      from: pair.pairState.supervisor.sessionId ?? "sup-session",
      to: pair.actorAgentId,
      payload: {
        taskId: pair.taskId,
        reason: "wait for human review",
        requestedAt: "2026-03-16T12:31:00Z",
        details: buildSupervisorHaltMessage({
          decision: {
            status: "critical",
            confidence: 0.95,
            reason: "human review required",
            action: "halt",
          },
          humanActionNeeded: true,
        }),
      },
    });

    assert.equal(client.sendInputs.length > initialSendCount, true);
    assert.ok(client.sendInputs.some((input) => input.includes("stop browsing and synthesize now")));
    assert.ok(client.halts.includes("wait for human review"));
    assert.equal(pair.supervisorInterventions.length, 2);
  });

  it("applies structured live intervention callbacks from a separate supervisor bootstrapper", async () => {
    const client = new AvailablePiMonoClient();
    let feedbackHandler:
      | ((message: ReturnType<typeof buildSupervisorFeedbackMessage>) => void)
      | undefined;
    let haltHandler:
      | ((message: ReturnType<typeof buildSupervisorHaltMessage>) => void)
      | undefined;
    const bootstrapper: SupervisorSessionBootstrapper & {
      attachInterventionListener(request: {
        onFeedback(message: ReturnType<typeof buildSupervisorFeedbackMessage>): void;
        onHalt(message: ReturnType<typeof buildSupervisorHaltMessage>): void;
      }): () => void;
    } = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
      attachInterventionListener(request) {
        feedbackHandler = request.onFeedback;
        haltHandler = request.onHalt;
        return () => {
          feedbackHandler = undefined;
          haltHandler = undefined;
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    feedbackHandler?.(
      buildSupervisorFeedbackMessage({
        decision: {
          status: "warning",
          confidence: 0.9,
          reason: "switch to synthesis",
          action: "feedback",
        },
        instructions: ["extract requirements now"],
      }),
    );
    haltHandler?.(
      buildSupervisorHaltMessage({
        decision: {
          status: "critical",
          confidence: 0.95,
          reason: "wait for human review",
          action: "halt",
        },
        humanActionNeeded: true,
      }),
    );

    assert.ok(client.sendInputs.some((input) => input.includes("extract requirements now")));
    assert.ok(client.halts.includes("wait for human review"));
    assert.equal(pair.supervisorInterventions.length, 2);
    assert.equal(pair.supervisorInterventions[0]?.type, "supervisor-feedback");
    assert.equal(pair.supervisorInterventions[1]?.type, "supervisor-halt");
  });

  it("shadow-writes actor/supervisor lifecycle events into the optional event sink", async () => {
    const client = new AvailablePiMonoClient();
    const published: Array<{ topic: string; type: string; source: string; payload: Record<string, unknown> }> = [];
    const eventSink: AgentikaEventSink = {
      async publish(event) {
        published.push({
          topic: event.topic,
          type: event.type,
          source: event.source,
          payload: event.payload,
        });
      },
    };
    const transportAdapter = new InProcessA2AAdapter();
    const bootstrapper: SupervisorSessionBootstrapper = {
      bootstrap(request) {
        return {
          mode: "separate_session",
          sessionId: `sup-session-${request.taskId}`,
          status: "ready",
          bootstrappedAt: request.occurredAt,
        };
      },
    };
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        supervisorBootstrapper: bootstrapper,
        transportAdapter,
        eventSink,
      },
    );

    const pair = manager.createPair("inspect the browser workflow");
    await transportAdapter.sendMessage({
      from: pair.pairState.supervisor.sessionId ?? "sup-session",
      to: pair.actorAgentId,
      payload: {
        id: "feedback-shadow",
        taskId: pair.taskId,
        role: "system",
        parts: [
          { kind: "text", text: "stop browsing and synthesize now" },
          {
            kind: "json",
            data: buildSupervisorFeedbackMessage({
              interventionId: "shadow-intervention-1",
              decision: {
                status: "warning",
                confidence: 0.9,
                reason: "switch to synthesis",
                action: "feedback",
              },
            }),
          },
        ],
        sentAt: "2026-03-16T12:30:00Z",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const eventTypes = published.map((event) => event.type);
    assert.ok(eventTypes.includes("task.lifecycle"));
    assert.ok(eventTypes.includes("supervisor.intervention.issued"));
    assert.ok(
      eventTypes.includes("actor.intervention.ack") || eventTypes.includes("actor.intervention.result"),
    );
    assert.ok(eventTypes.includes("actor.intervention.result"));
  });
});
