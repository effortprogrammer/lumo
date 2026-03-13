import { InProcessA2AAdapter } from "../a2a/in-process-adapter.js";
import { createAlertDispatcher } from "../alerts/create-dispatcher.js";
import { type LumoConfig } from "../config/load-config.js";
import {
  type ConversationTurn,
  type SupervisorProfile,
  type TaskPairing,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import {
  HeuristicSupervisorClient,
  MockSupervisorClient,
  OpenAICompatibleSupervisorClient,
  type SupervisorModelClient,
} from "../supervisor/model-client.js";
import { SupervisorPipeline } from "../supervisor/pipeline.js";
import { ActorRuntime } from "./actor-runtime.js";
import { type CommandRunner, SubprocessCommandRunner } from "./subprocess.js";

export type RuntimeProvider = "pi-mono";

export interface RuntimeSession {
  sessionId: string;
  provider: RuntimeProvider | "legacy";
  task: TaskPairing;
  actorLogs: ToolExecutionRecord[];
}

export type RuntimeSessionEvent =
  | {
    type: "log";
    sessionId: string;
    record: ToolExecutionRecord;
  }
  | {
    type: "status";
    sessionId: string;
    status: TaskStatus;
  }
  | {
    type: "decision";
    sessionId: string;
    decision: SupervisorDecision;
  }
  | {
    type: "conversation";
    sessionId: string;
    turn: ConversationTurn;
  };

export interface RuntimeSessionCreateOptions {
  instruction: string;
  cwd?: string;
}

export interface RuntimeSessionAdapter {
  createSession(options: RuntimeSessionCreateOptions): RuntimeSession;
  sendInput(sessionId: string, text: string): Promise<void>;
  pause(sessionId: string, reason?: string): Promise<void>;
  resume(sessionId: string, text?: string): Promise<void>;
  halt(sessionId: string, reason: string): Promise<void>;
  subscribe(
    sessionId: string,
    listener: (event: RuntimeSessionEvent) => void,
  ): () => void;
}

interface LegacyRuntimeAdapterOptions {
  config: LumoConfig;
  runner?: CommandRunner;
  now?: () => string;
}

interface LegacyRuntimeSessionRecord {
  runtime: ActorRuntime;
  session: RuntimeSession;
  listeners: Set<(event: RuntimeSessionEvent) => void>;
}

export class LegacyRuntimeAdapter implements RuntimeSessionAdapter {
  private readonly runner: CommandRunner;
  private readonly now: () => string;
  private readonly sessions = new Map<string, LegacyRuntimeSessionRecord>();

  constructor(private readonly options: LegacyRuntimeAdapterOptions) {
    this.runner = options.runner ?? new SubprocessCommandRunner();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  createSession(options: RuntimeSessionCreateOptions): RuntimeSession {
    const sessionId = `legacy-${Date.now()}`;
    const adapter = new InProcessA2AAdapter();
    const task = createTaskPairing(this.options.config, this.now, options.instruction);
    const listeners = new Set<(event: RuntimeSessionEvent) => void>();
    const session: RuntimeSession = {
      sessionId,
      provider: "legacy",
      task,
      actorLogs: [],
    };
    const supervisor = new SupervisorPipeline({
      adapter,
      actorAgentId: task.task.actor.id,
      supervisorAgentId: task.task.supervisor.id,
      client: createSupervisorClient(this.options.config),
      alerts: createAlertDispatcher(this.options.config),
      now: this.now,
      onDecision: (decision) => {
        this.emit(listeners, {
          type: "decision",
          sessionId,
          decision,
        });
      },
    });
    const runtime = new ActorRuntime({
      pairing: task,
      config: this.options.config,
      adapter,
      runner: this.runner,
      now: this.now,
      cwd: options.cwd ?? process.cwd(),
      onLog: (record) => {
        session.actorLogs.push(record);
        this.emit(listeners, {
          type: "log",
          sessionId,
          record,
        });
      },
      onStatusChange: (status) => {
        this.emit(listeners, {
          type: "status",
          sessionId,
          status,
        });
      },
      onConversation: (turn) => {
        this.emit(listeners, {
          type: "conversation",
          sessionId,
          turn,
        });
      },
      onBatch: async (batch) => {
        await supervisor.consume(batch);
      },
    });

    this.sessions.set(sessionId, {
      runtime,
      session,
      listeners,
    });

    return session;
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    await this.getRecord(sessionId).runtime.executeInstruction(text);
  }

  async pause(sessionId: string, reason?: string): Promise<void> {
    this.getRecord(sessionId).runtime.pause(reason);
  }

  async resume(sessionId: string, text?: string): Promise<void> {
    await this.getRecord(sessionId).runtime.resume(text);
  }

  async halt(sessionId: string, reason: string): Promise<void> {
    this.getRecord(sessionId).runtime.halt(reason);
  }

  subscribe(
    sessionId: string,
    listener: (event: RuntimeSessionEvent) => void,
  ): () => void {
    const record = this.getRecord(sessionId);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private getRecord(sessionId: string): LegacyRuntimeSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown runtime session ${sessionId}`);
    }
    return record;
  }

  private emit(
    listeners: Set<(event: RuntimeSessionEvent) => void>,
    event: RuntimeSessionEvent,
  ): void {
    for (const listener of listeners) {
      listener(event);
    }
  }
}

export interface PiMonoRuntimeClient {
  isAvailable(): boolean;
  createSession(options: { sessionId: string; instruction: string }): { externalSessionId: string };
  sendInput(externalSessionId: string, text: string): Promise<void>;
  pause(externalSessionId: string, reason?: string): Promise<void>;
  resume(externalSessionId: string, text?: string): Promise<void>;
  halt(externalSessionId: string, reason: string): Promise<void>;
  subscribe(
    externalSessionId: string,
    listener: (event: PiMonoRuntimeEvent) => void,
  ): () => void;
}

export type PiMonoRuntimeEvent =
  | {
    type: "session.started";
    taskId: string;
    startedAt: string;
  }
  | {
    type: "session.status";
    taskId: string;
    status: "running" | "paused" | "halted" | "completed" | "failed";
    occurredAt: string;
  }
  | {
    type: "task.output";
    taskId: string;
    occurredAt: string;
    tool: ToolExecutionRecord["tool"];
    input: string;
    output: ToolExecutionRecord["output"];
    durationMs: number;
    exitCode?: number | null;
  }
  | {
    type: "supervisor.decision";
    taskId: string;
    occurredAt: string;
    decision: SupervisorDecision;
  }
  | {
    type: "conversation.turn";
    taskId: string;
    turn: ConversationTurn;
  };

interface PiMonoSessionAdapterOptions {
  config: LumoConfig;
  client?: PiMonoRuntimeClient;
  now?: () => string;
}

interface PiMonoSessionRecord {
  session: RuntimeSession;
  externalSessionId: string;
  listeners: Set<(event: RuntimeSessionEvent) => void>;
  unsubscribeClient?: () => void;
}

class UnavailablePiMonoRuntimeClient implements PiMonoRuntimeClient {
  isAvailable(): boolean {
    return false;
  }

  createSession(): { externalSessionId: string } {
    throw new Error("pi-mono runtime client is unavailable");
  }

  async sendInput(): Promise<void> {
    throw new Error("pi-mono runtime client is unavailable");
  }

  async pause(): Promise<void> {
    throw new Error("pi-mono runtime client is unavailable");
  }

  async resume(): Promise<void> {
    throw new Error("pi-mono runtime client is unavailable");
  }

  async halt(): Promise<void> {
    throw new Error("pi-mono runtime client is unavailable");
  }

  subscribe(): () => void {
    return () => {};
  }
}

export class PiMonoSessionAdapter implements RuntimeSessionAdapter {
  private readonly now: () => string;
  private readonly client: PiMonoRuntimeClient;
  private readonly sessions = new Map<string, PiMonoSessionRecord>();

  constructor(private readonly options: PiMonoSessionAdapterOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.client = options.client ?? new UnavailablePiMonoRuntimeClient();
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  createSession(options: RuntimeSessionCreateOptions): RuntimeSession {
    if (!this.isAvailable()) {
      throw new Error("pi-mono runtime is not available");
    }

    const sessionId = `pi-mono-${Date.now()}`;
    const session: RuntimeSession = {
      sessionId,
      provider: "pi-mono",
      task: createTaskPairing(this.options.config, this.now, options.instruction),
      actorLogs: [],
    };

    // TODO: Replace the mock client contract with the real pi-mono SDK/session broker.
    const created = this.client.createSession({
      sessionId,
      instruction: options.instruction,
    });

    const listeners = new Set<(event: RuntimeSessionEvent) => void>();
    const unsubscribeClient = this.client.subscribe(
      created.externalSessionId,
      (event) => {
        const mappedEvents = mapPiMonoEventToLumoSessionEvents(event, session);
        for (const mappedEvent of mappedEvents) {
          if (mappedEvent.type === "log") {
            session.actorLogs.push(mappedEvent.record);
          }
          this.emit(listeners, mappedEvent);
        }
      },
    );

    this.sessions.set(sessionId, {
      session,
      externalSessionId: created.externalSessionId,
      listeners,
      unsubscribeClient,
    });

    return session;
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const record = this.getRecord(sessionId);
    // TODO: Route input into the real pi-mono runtime session once integrated.
    await this.client.sendInput(record.externalSessionId, text);
  }

  async pause(sessionId: string, reason?: string): Promise<void> {
    const record = this.getRecord(sessionId);
    // TODO: Map pause semantics to pi-mono checkpointing/backpressure behavior.
    await this.client.pause(record.externalSessionId, reason);
  }

  async resume(sessionId: string, text?: string): Promise<void> {
    const record = this.getRecord(sessionId);
    // TODO: Route resume semantics to pi-mono continuation APIs.
    await this.client.resume(record.externalSessionId, text);
  }

  async halt(sessionId: string, reason: string): Promise<void> {
    const record = this.getRecord(sessionId);
    // TODO: Wire halt into pi-mono cancellation/termination when the runtime is available.
    await this.client.halt(record.externalSessionId, reason);
  }

  subscribe(
    sessionId: string,
    listener: (event: RuntimeSessionEvent) => void,
  ): () => void {
    const record = this.getRecord(sessionId);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private getRecord(sessionId: string): PiMonoSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown runtime session ${sessionId}`);
    }
    return record;
  }

  private emit(
    listeners: Set<(event: RuntimeSessionEvent) => void>,
    event: RuntimeSessionEvent,
  ): void {
    for (const listener of listeners) {
      listener(event);
    }
  }
}

export function mapPiMonoEventToLumoSessionEvents(
  event: PiMonoRuntimeEvent,
  session: RuntimeSession,
): RuntimeSessionEvent[] {
  if (event.type === "session.started") {
    session.task.task.startedAt = event.startedAt;
    session.task.task.lastUpdatedAt = event.startedAt;
    session.task.task.status = "running";
    return [{
      type: "status",
      sessionId: session.sessionId,
      status: "running",
    }];
  }

  if (event.type === "session.status") {
    session.task.task.status = event.status;
    session.task.task.lastUpdatedAt = event.occurredAt;
    if (event.status === "halted") {
      session.task.task.haltedAt = event.occurredAt;
    }
    if (event.status === "completed") {
      session.task.task.completedAt = event.occurredAt;
    }
    return [{
      type: "status",
      sessionId: session.sessionId,
      status: event.status,
    }];
  }

  if (event.type === "task.output") {
    session.task.task.currentStep += 1;
    session.task.task.lastUpdatedAt = event.occurredAt;
    return [{
      type: "log",
      sessionId: session.sessionId,
      record: {
        step: session.task.task.currentStep,
        timestamp: event.occurredAt,
        tool: event.tool,
        input: event.input,
        output: event.output,
        durationMs: event.durationMs,
        exitCode: event.exitCode,
        status: (event.exitCode ?? 0) === 0 ? "ok" : "error",
        metadata: {
          runtimeProvider: "pi-mono",
          sourceTaskId: event.taskId,
        },
      },
    }];
  }

  if (event.type === "supervisor.decision") {
    session.task.task.lastUpdatedAt = event.occurredAt;
    return [{
      type: "decision",
      sessionId: session.sessionId,
      decision: event.decision,
    }];
  }

  session.task.context.conversationHistory.push(event.turn);
  session.task.task.lastUpdatedAt = event.turn.timestamp;
  return [{
    type: "conversation",
    sessionId: session.sessionId,
    turn: event.turn,
  }];
}

export interface RuntimeAdapterSelectionOptions {
  now?: () => string;
  piMonoClient?: PiMonoRuntimeClient;
}

export function initializePiMonoRuntimeSessionAdapter(
  config: LumoConfig,
  options: RuntimeAdapterSelectionOptions = {},
): RuntimeSessionAdapter {
  if (config.runtime.provider !== "pi-mono") {
    throw new Error(
      `Unsupported runtime.provider "${String(config.runtime.provider)}". Lumo requires "pi-mono".`,
    );
  }
  const piMono = new PiMonoSessionAdapter({
    config,
    client: options.piMonoClient,
    now: options.now,
  });

  if (!piMono.isAvailable()) {
    throw new Error(
      "Pi-mono runtime health-check failed during startup. Ensure the pi-mono provider is configured and reachable before launching Lumo.",
    );
  }

  return piMono;
}

export function createTaskPairing(
  config: LumoConfig,
  now: () => string,
  instruction: string,
): TaskPairing {
  const createdAt = now();
  const taskId = `task-${Date.now()}`;
  const supervisorProfile: SupervisorProfile = {
    id: "supervisor",
    model: config.supervisor.model,
    systemPrompt: config.supervisor.systemPrompt,
    maxBatchSteps: config.batch.maxSteps,
    maxBatchAgeMs: config.batch.maxAgeMs,
  };

  return {
    task: {
      taskId,
      actor: {
        id: "actor",
        model: config.actor.model,
        systemPrompt: config.actor.systemPrompt,
        tools: config.actor.tools,
      },
      supervisor: supervisorProfile,
      status: "pending",
      createdAt,
      currentStep: 0,
      lastUpdatedAt: createdAt,
    },
    context: {
      taskId,
      instruction: {
        id: `instruction-${Date.now()}`,
        text: instruction,
        createdAt,
      },
      conversationHistory: [],
    },
  };
}

function createSupervisorClient(config: LumoConfig): SupervisorModelClient {
  if (config.supervisor.client === "heuristic") {
    return new HeuristicSupervisorClient();
  }

  if (config.supervisor.client === "openai-compatible") {
    const openai = config.supervisor.openaiCompatible;
    if (openai.enabled && openai.baseUrl && openai.apiKey && openai.model) {
      return new OpenAICompatibleSupervisorClient({
        baseUrl: openai.baseUrl,
        apiKey: openai.apiKey,
        model: openai.model,
        systemPrompt: config.supervisor.systemPrompt,
        timeoutMs: openai.timeoutMs,
      });
    }

    return new HeuristicSupervisorClient();
  }

  return new MockSupervisorClient();
}
