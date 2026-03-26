import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  buildActorProgressMessage,
  type CancelTaskRequest,
} from "../a2a/protocol.js";
import { createActorTransport, type SupervisorTransport } from "../a2a/transport.js";
import { createAlertDispatcher } from "../alerts/create-dispatcher.js";
import { type LumoConfig } from "../config/load-config.js";
import {
  type ConversationTurn,
  type RuntimeAnomaly,
  type SupervisorProfile,
  type TaskPairing,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { LogBatcher, type LogBatch } from "../logging/log-batcher.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { assessBottleneck, type BottleneckAssessment } from "../supervisor/bottleneck.js";
import { type SupervisorOutputEnvelope } from "../supervisor/contracts.js";
import { assessTaskPhase } from "../supervisor/phase.js";
import {
  HeuristicRuntimeAnomalyDetector,
  type RuntimeAnomalyDetector,
  type RuntimeAnomalyDetectorContext,
} from "./anomaly-detector.js";
import { enrichBrowserSituation } from "./browser-situation.js";
import {
  createConfiguredSupervisorClient,
  type SupervisorModelClient,
} from "../supervisor/model-client.js";
import { SupervisorPipeline } from "../supervisor/pipeline.js";
import { createDefaultPiMonoRuntimeClient } from "./pi-rpc-runtime-client.js";
import { type CommandRunner, SubprocessCommandRunner } from "./subprocess.js";
import { createTaskPairRuntimeState, type TaskPairRuntimeState } from "./task-pair-state.js";
import {
  applyArtifactClaim,
  applyCompletionSignal,
  createCompletionState,
  extractCompletionSignalsFromConversation,
  extractCompletionSignalsFromTool,
  extractArtifactClaim,
  inferCompletionContract,
  summarizeCompletionState,
} from "../completion/contract.js";

export type RuntimeProvider = "pi";

export interface RuntimeSession {
  sessionId: string;
  provider: RuntimeProvider;
  task: TaskPairing;
  pairState: TaskPairRuntimeState;
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
    type: "supervisor-output";
    sessionId: string;
    output: SupervisorOutputEnvelope;
  }
  | {
    type: "supervisor-progress";
    sessionId: string;
    progress: ReturnType<typeof buildActorProgressMessage>;
  }
  | {
    type: "conversation";
    sessionId: string;
    turn: ConversationTurn;
  }
  | {
    type: "anomaly";
    sessionId: string;
    anomaly: RuntimeAnomaly;
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

export interface PiMonoRuntimeClient {
  isAvailable(): boolean;
  createSession(options: { sessionId: string; instruction: string }): { externalSessionId: string };
  sendInput(
    externalSessionId: string,
    text: string,
    options?: {
      role?: ConversationTurn["role"];
      deliverAs?: "auto" | "prompt" | "steer" | "follow_up";
      echoConversation?: boolean;
    },
  ): Promise<void>;
  pause(externalSessionId: string, reason?: string): Promise<void>;
  resume(
    externalSessionId: string,
    text?: string,
    options?: {
      role?: ConversationTurn["role"];
      echoConversation?: boolean;
    },
  ): Promise<void>;
  halt(
    externalSessionId: string,
    reason: string,
    options?: {
      role?: ConversationTurn["role"];
      echoConversation?: boolean;
    },
  ): Promise<void>;
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
    metadata?: Record<string, unknown>;
    screenshotRef?: ToolExecutionRecord["screenshotRef"];
  }
  | {
    type: "runtime.anomaly";
    taskId: string;
    occurredAt: string;
    anomaly: RuntimeAnomaly;
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
  supervisorTransport?: SupervisorTransport;
  enableLocalSupervisor?: boolean;
  registryPath?: string;
}

interface PiMonoSessionRecord {
  session: RuntimeSession;
  externalSessionId: string;
  listeners: Set<(event: RuntimeSessionEvent) => void>;
  unsubscribeClient?: () => void;
  batcher: LogBatcher;
  supervisor: SupervisorPipeline;
  runtimeBus: PiSupervisorRuntimeAdapter;
  supervisorTransport?: SupervisorTransport;
  supervisionInterval?: ReturnType<typeof setInterval>;
  anomalyDetector: RuntimeAnomalyDetector;
  recentAnomalyKeys: Map<string, string>;
  lastToolProgressAt?: string;
  progressSequence: number;
  recoveryState: {
    fingerprint?: string;
    attempts: number;
    phase: "idle" | "recovering" | "escalated";
  };
}

class UnavailablePiMonoRuntimeClient implements PiMonoRuntimeClient {
  isAvailable(): boolean {
    return false;
  }

  createSession(): { externalSessionId: string } {
      throw new Error("pi runtime client is unavailable");
  }

  async sendInput(): Promise<void> {
      throw new Error("pi runtime client is unavailable");
  }

  async pause(): Promise<void> {
      throw new Error("pi runtime client is unavailable");
  }

  async resume(): Promise<void> {
      throw new Error("pi runtime client is unavailable");
  }

  async halt(): Promise<void> {
      throw new Error("pi runtime client is unavailable");
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
    this.client = options.client ?? createDefaultPiMonoRuntimeClient({
      cwd: process.cwd(),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      appendSystemPrompt: buildPiBrowserExecutionPolicyPrompt(options.config.actor.systemPrompt),
      registryPath: options.registryPath ?? options.config.runtime.registryPath,
      now: this.now,
    });
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  createSession(options: RuntimeSessionCreateOptions): RuntimeSession {
    if (!this.isAvailable()) {
      throw new Error("pi runtime is not available");
    }

    const sessionId = `pi-${Date.now()}`;
    const completion = createCompletionState(inferCompletionContract(options.instruction));
    const session: RuntimeSession = {
      sessionId,
      provider: "pi",
      task: createTaskPairing(this.options.config, this.now, options.instruction),
      pairState: createTaskPairRuntimeState({
        sessionId,
        taskId: `task-${Date.now()}`,
        actorAgentId: "pending-actor",
        supervisorAgentId: "pending-supervisor",
        status: "pending",
        currentStep: 0,
        completion,
      }),
      actorLogs: [],
    };
    session.pairState = createTaskPairRuntimeState({
      sessionId,
      taskId: session.task.task.taskId,
      actorAgentId: session.task.task.actor.id,
      supervisorAgentId: session.task.task.supervisor.id,
      status: session.task.task.status,
      currentStep: session.task.task.currentStep,
      completion,
    });

  // TODO: Replace the mock client contract with the real pi SDK/session broker.
    const created = this.client.createSession({
      sessionId,
      instruction: options.instruction,
    });

    const listeners = new Set<(event: RuntimeSessionEvent) => void>();
    const runtimeBus = new PiSupervisorRuntimeAdapter({
      client: this.client,
      externalSessionId: created.externalSessionId,
      now: this.now,
      isInterventionAllowed: () => !isTerminalTaskStatus(session.task.task.status),
      onFeedbackInjected: () => {
        record.recoveryState.attempts += 1;
        record.recoveryState.phase = "recovering";
      },
      onEscalated: () => {
        record.recoveryState.phase = "escalated";
      },
    });
    const supervisor = new SupervisorPipeline({
      actorTransport: createActorTransport(runtimeBus),
      actorAgentId: session.task.task.actor.id,
      supervisorAgentId: session.task.task.supervisor.id,
      client: createSupervisorClient(this.options.config),
      alerts: createAlertDispatcher(this.options.config),
      now: this.now,
      onDecision: (decision) => {
        this.emitMappedPiEvent(record, {
          type: "supervisor.decision",
          taskId: created.externalSessionId,
          occurredAt: this.now(),
          decision,
        });
      },
      onOutput: (output) => {
        record.session.pairState.supervisor.lastOutput = output;
        record.session.pairState.supervisor.lastEvaluatedAt = this.now();
        if (output.decision.action === "complete") {
          const occurredAt = this.now();
          this.emit(record.listeners, {
            type: "conversation",
            sessionId: record.session.sessionId,
            turn: {
              id: `turn-${Date.now()}`,
              role: "supervisor",
              text: output.decision.suggestion ?? output.decision.reason,
              timestamp: occurredAt,
            },
          });
          this.emitMappedPiEvent(record, {
            type: "session.status",
            taskId: created.externalSessionId,
            status: "completed",
            occurredAt,
          });
          this.stopSupervision(record);
          void this.client.halt(created.externalSessionId, "Task completed by supervisor", {
            role: "supervisor",
          }).catch(() => {});
          return;
        }
        this.emit(record.listeners, {
          type: "supervisor-output",
          sessionId: record.session.sessionId,
          output,
        });
      },
    });
    const batcher = new LogBatcher(session.task.context, {
      maxSteps: this.options.config.batch.maxSteps,
      maxAgeMs: this.options.config.batch.maxAgeMs,
      immediateKeywords: this.options.config.batch.immediateKeywords,
    });

    const record: PiMonoSessionRecord = {
      session,
      externalSessionId: created.externalSessionId,
      listeners,
      batcher,
      supervisor,
      runtimeBus,
      supervisorTransport: this.options.supervisorTransport,
      anomalyDetector: new HeuristicRuntimeAnomalyDetector({
        noProgressMs: Math.max(this.options.config.batch.maxAgeMs * 2, 5_000),
      }),
      recentAnomalyKeys: new Map(),
      recoveryState: {
        attempts: 0,
        phase: "idle",
      },
      progressSequence: 0,
    };

    record.unsubscribeClient = this.client.subscribe(
      created.externalSessionId,
      (event) => {
        this.emitMappedPiEvent(record, event);
      },
    );
    record.supervisionInterval = setInterval(() => {
      this.detectAndQueueAnomalies(record);
      const batch = record.batcher.flushIfDue();
      if (batch) {
        void this.consumeSupervisorBatch(record, batch);
      }
    }, 1_000);
    record.supervisionInterval.unref?.();

    this.sessions.set(sessionId, record);

    return session;
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    const record = this.getRecord(sessionId);
  // TODO: Route input into the real pi runtime session once integrated.
    await this.client.sendInput(record.externalSessionId, text);
  }

  async pause(sessionId: string, reason?: string): Promise<void> {
    const record = this.getRecord(sessionId);
  // TODO: Map pause semantics to pi checkpointing/backpressure behavior.
    await this.client.pause(record.externalSessionId, reason);
  }

  async resume(sessionId: string, text?: string): Promise<void> {
    const record = this.getRecord(sessionId);
  // TODO: Route resume semantics to pi continuation APIs.
    await this.client.resume(record.externalSessionId, text);
  }

  async halt(sessionId: string, reason: string): Promise<void> {
    const record = this.getRecord(sessionId);
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

  private emitMappedPiEvent(
    record: PiMonoSessionRecord,
    event: PiMonoRuntimeEvent,
  ): void {
    const mappedEvents = mapPiMonoEventToLumoSessionEvents(event, record.session);
    for (const mappedEvent of mappedEvents) {
      if (mappedEvent.type === "log") {
        record.session.actorLogs.push(mappedEvent.record);
        record.lastToolProgressAt = mappedEvent.record.timestamp;
        this.publishSupervisorProgress(record, {
          summary: `${mappedEvent.record.tool} ${mappedEvent.record.input}`.trim(),
        });
        const batch = record.batcher.add(mappedEvent.record);
        if (batch) {
          void this.consumeSupervisorBatch(record, batch);
        }
        this.detectAndQueueAnomalies(record);
      }
      if (mappedEvent.type === "anomaly") {
        this.publishSupervisorProgress(record, {
          anomalies: [mappedEvent.anomaly],
          summary: mappedEvent.anomaly.message,
        });
        record.batcher.queueAnomalies([mappedEvent.anomaly]);
        const anomalyBatch = record.batcher.flush("anomaly");
        if (anomalyBatch) {
          void this.consumeSupervisorBatch(record, anomalyBatch);
        }
      }
      this.emit(record.listeners, mappedEvent);
      if (
        mappedEvent.type === "conversation"
        && mappedEvent.turn.role === "actor"
        && record.session.pairState.completion?.satisfied
      ) {
        this.publishSupervisorProgress(record, {
          summary: mappedEvent.turn.text.slice(0, 200),
        });
        void this.consumeSupervisorBatch(record, {
          taskInstruction: record.session.task.context.instruction.text,
          conversationHistory: record.session.task.context.conversationHistory.map((turn) => turn.text),
          batch: record.session.actorLogs.slice(-10),
          recentLogs: record.session.actorLogs.slice(-10),
          anomalies: [],
          completionState: record.session.pairState.completion,
          triggeredBy: "manual",
        });
      }
    }

    if (event.type === "session.status") {
      this.publishSupervisorProgress(record, {
        summary: `status=${event.status}`,
      });
    }

    if (event.type === "session.status" && isTerminalTaskStatus(event.status)) {
      const trailingBatch = record.batcher.flush("manual");
      if (trailingBatch) {
        void this.consumeSupervisorBatch(record, trailingBatch);
      }
      this.stopSupervision(record);
    }
  }

  private publishSupervisorProgress(
    record: PiMonoSessionRecord,
    options: {
      summary?: string;
      anomalies?: RuntimeAnomaly[];
    } = {},
  ): void {
    record.progressSequence += 1;
    const collectionState = inferCollectionState(record.session.actorLogs);
    const recentLogs = record.session.actorLogs.slice(-20);
    const browserContext = enrichBrowserSituation({
      taskInstruction: record.session.task.context.instruction.text,
      conversationHistory: record.session.task.context.conversationHistory.map((turn) => turn.text),
      batch: recentLogs,
      recentLogs,
      anomalies: options.anomalies ?? [],
      triggeredBy: "manual",
    }, this.now());
    const taskPhase = assessTaskPhase({
      taskInstruction: record.session.task.context.instruction.text,
      browserState: browserContext.browserState,
      browserProgress: browserContext.browserProgress,
      recentLogs,
      collectionState: collectionState ?? undefined,
      completionState: record.session.pairState.completion,
    });
    const progress = buildActorProgressMessage({
      progressId: `progress-${record.session.sessionId}-${record.progressSequence}`,
      actorSessionId: record.session.sessionId,
      sequence: record.progressSequence,
      taskPattern: collectionState ? "multi_item_collection" : undefined,
      collectionState: collectionState ?? undefined,
      currentStatus: record.session.task.task.status,
      currentStep: record.session.task.task.currentStep,
      summary: options.summary ?? summarizeCompletionState(record.session.pairState.completion ?? createCompletionState(inferCompletionContract(record.session.task.context.instruction.text))),
      anomalies: options.anomalies,
      browserState: browserContext.browserState,
      browserProgress: browserContext.browserProgress,
      taskPhase,
      artifacts: record.session.pairState.completion?.artifacts,
      completionState: record.session.pairState.completion,
    });
    record.session.pairState.supervisor.lastProgress = progress;
    if (record.supervisorTransport) {
      void record.supervisorTransport.sendProgress({
        id: progress.progressId,
        from: record.session.task.task.actor.id,
        to: record.session.task.task.supervisor.id,
        pairId: record.session.pairState.pairId,
        taskId: record.session.task.task.taskId,
        sessionId: record.session.sessionId,
        correlationId: progress.progressId,
        sentAt: this.now(),
        payload: {
          id: `progress-${record.session.sessionId}-${Date.now()}`,
          taskId: record.session.task.task.taskId,
          role: "assistant",
          parts: [
            {
              kind: "json",
              data: progress,
            },
          ],
          sentAt: this.now(),
        },
      }).catch(() => {});
    }
    this.emit(record.listeners, {
      type: "supervisor-progress",
      sessionId: record.session.sessionId,
      progress,
    });
  }

  private async consumeSupervisorBatch(
    record: PiMonoSessionRecord,
    batch: LogBatch,
  ): Promise<void> {
    try {
      const enrichedBatch = enrichBrowserSituation({
        ...batch,
        completionState: record.session.pairState.completion,
        recentLogs: record.session.actorLogs.slice(-20),
      }, this.now());
      const bottleneck = assessBottleneck({
        anomalies: enrichedBatch.anomalies,
        browserProgress: enrichedBatch.browserProgress,
        browserState: enrichedBatch.browserState,
        recentLogs: enrichedBatch.recentLogs ?? enrichedBatch.batch,
        taskInstruction: enrichedBatch.taskInstruction,
      });
      record.runtimeBus.setRecoveryContext(
        this.normalizeRecoveryContext(record, bottleneck, enrichedBatch),
      );
      if (this.options.enableLocalSupervisor === false) {
        return;
      }
      await record.supervisor.consume(enrichedBatch);
    } catch (error) {
      this.emit(record.listeners, {
        type: "conversation",
        sessionId: record.session.sessionId,
        turn: {
          id: `turn-${Date.now()}`,
          role: "system",
          text: `Supervisor pipeline error: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: this.now(),
        },
      });
    }
  }

  private stopSupervision(record: PiMonoSessionRecord): void {
    if (record.supervisionInterval) {
      clearInterval(record.supervisionInterval);
      record.supervisionInterval = undefined;
    }
    record.unsubscribeClient?.();
    record.unsubscribeClient = undefined;
  }

  private detectAndQueueAnomalies(record: PiMonoSessionRecord): void {
    const anomalies = record.anomalyDetector.detect(this.buildAnomalyContext(record))
      .filter((anomaly) => this.shouldEmitAnomaly(record, anomaly));
    if (anomalies.length === 0) {
      return;
    }

    record.batcher.queueAnomalies(anomalies);
    for (const anomaly of anomalies) {
      this.emit(record.listeners, {
        type: "anomaly",
        sessionId: record.session.sessionId,
        anomaly,
      });
    }

    const anomalyBatch = record.batcher.flush("anomaly");
    if (anomalyBatch) {
      void this.consumeSupervisorBatch(record, anomalyBatch);
    }
  }

  private buildAnomalyContext(record: PiMonoSessionRecord): RuntimeAnomalyDetectorContext {
    const recentLogs = record.session.actorLogs.slice(-10);
    const latestLog = recentLogs.at(-1);
    return {
      now: this.now(),
      snapshot: {
        taskId: record.session.task.task.taskId,
        sessionId: record.session.sessionId,
        currentStep: record.session.task.task.currentStep,
        status: record.session.task.task.status,
        lastUpdatedAt: record.session.task.task.lastUpdatedAt,
        lastToolProgressAt: record.lastToolProgressAt,
        latestTool: latestLog?.tool,
        latestInput: latestLog?.input,
      },
      recentLogs,
      recentConversation: record.session.task.context.conversationHistory.slice(-10),
    };
  }

  private shouldEmitAnomaly(record: PiMonoSessionRecord, anomaly: RuntimeAnomaly): boolean {
    const key = buildAnomalyKey(anomaly);
    const lastOccurredAt = record.recentAnomalyKeys.get(key);
    if (lastOccurredAt === anomaly.occurredAt) {
      return false;
    }

    const cooldownMs = anomaly.kind === "no_progress" ? 30_000 : 5_000;
    if (lastOccurredAt) {
      const ageMs = Date.parse(anomaly.occurredAt) - Date.parse(lastOccurredAt);
      if (Number.isFinite(ageMs) && ageMs < cooldownMs) {
        return false;
      }
    }

    record.recentAnomalyKeys.set(key, anomaly.occurredAt);
    return true;
  }

  private normalizeRecoveryContext(
    record: PiMonoSessionRecord,
    bottleneck: BottleneckAssessment | undefined,
    batch: LogBatch,
  ): {
    bottleneck?: BottleneckAssessment;
    fingerprint?: string;
    stateSignature?: string;
  } {
    if (!bottleneck) {
      record.recoveryState = {
        attempts: 0,
        phase: "idle",
      };
      return {};
    }

    const fingerprint = [
      bottleneck.kind,
      bottleneck.recoveryPlan.action,
      bottleneck.recoveryPlan.instructions.join("|"),
    ].join("|");
    const stateSignature = [
      batch.browserState?.url ?? "",
      batch.browserState?.title ?? "",
      batch.browserState?.pageKind ?? "",
    ].join("|");

    if (record.recoveryState.fingerprint !== fingerprint) {
      record.recoveryState = {
        fingerprint,
        attempts: 0,
        phase: "idle",
      };
    }

    const maxAttempts = bottleneck.recoveryPlan.maxAttempts ?? 1;
    if (record.recoveryState.attempts >= maxAttempts) {
      const escalated = {
        ...bottleneck,
        kind: "human_decision_required" as const,
        severity: "critical" as const,
        confidence: Math.max(bottleneck.confidence, 0.9),
        summary: `Automatic recovery is exhausted for ${bottleneck.kind}. Human guidance is required.`,
        diagnosis: `The actor already attempted the recovery plan for ${bottleneck.kind} without resolving the bottleneck.`,
        recoveryPlan: {
          action: "halt_and_escalate" as const,
          summary: "Pause automated recovery and ask the human operator how to proceed.",
          instructions: [
            "Stop automatic recovery attempts for this bottleneck.",
            "Report the unresolved state to the operator.",
            "Resume only after human guidance is provided.",
          ],
          humanEscalationNeeded: true,
          maxAttempts: 1,
        },
        recoverable: false,
      };
      record.recoveryState.phase = "escalated";
      return {
        bottleneck: escalated,
        fingerprint,
        stateSignature,
      };
    }

    return {
      bottleneck,
      fingerprint,
      stateSignature,
    };
  }
}

function inferCollectionState(
  actorLogs: ToolExecutionRecord[],
): {
  itemsCollected: number;
  distinctItems: number;
  fieldsSeen: string[];
  comparisonReady?: boolean;
  recommendationReady?: boolean;
} | null {
  const text = actorLogs
    .map((record) => `${record.input}\n${typeof record.output === "string" ? record.output : JSON.stringify(record.output)}`)
    .join("\n");
  const matches = [
    ...text.matchAll(/([가-힣A-Za-z0-9()\/\-\s]{4,80})\s*\n?\s*(?:상품금액\s*)?(\d{1,3}(?:,\d{3})+)\s*원/g),
  ];
  if (matches.length === 0) {
    return null;
  }

  const distinct = new Set(matches.map((match) => `${match[1]?.trim()}|${match[2]}`));
  return {
    itemsCollected: matches.length,
    distinctItems: distinct.size,
    fieldsSeen: ["name", "price"],
    comparisonReady: distinct.size >= 3,
    recommendationReady: distinct.size >= 5,
  };
}

class PiSupervisorRuntimeAdapter implements A2AAgentAdapter {
  private recoveryContext?: {
    bottleneck?: BottleneckAssessment;
    fingerprint?: string;
    stateSignature?: string;
  };
  private lastFeedbackFingerprint?: string;
  private lastFeedbackAt?: string;
  private recoveryPhase: "normal" | "recovering" | "awaiting-human" = "normal";

  constructor(
    private readonly options: {
      client: PiMonoRuntimeClient;
      externalSessionId: string;
      now: () => string;
      isInterventionAllowed: () => boolean;
      onFeedbackInjected: () => void;
      onEscalated: () => void;
    },
  ) {}

  setRecoveryContext(
    recoveryContext: {
      bottleneck?: BottleneckAssessment;
      fingerprint?: string;
      stateSignature?: string;
    },
  ): void {
    if (!recoveryContext.bottleneck) {
      this.recoveryContext = undefined;
      this.recoveryPhase = "normal";
      this.lastFeedbackFingerprint = undefined;
      this.lastFeedbackAt = undefined;
      return;
    }
    const { bottleneck, fingerprint, stateSignature } = recoveryContext;

    if (this.recoveryContext?.stateSignature !== stateSignature) {
      this.lastFeedbackFingerprint = undefined;
      this.lastFeedbackAt = undefined;
      this.recoveryPhase = "normal";
    }

    this.recoveryContext = {
      bottleneck,
      fingerprint,
      stateSignature,
    };
  }

  async sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    if (!this.options.isInterventionAllowed()) {
      return;
    }

    const text = envelope.payload.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (text.length === 0) {
      return;
    }

    if (!this.shouldInjectFeedback()) {
      return;
    }

    const bottleneck = this.recoveryContext?.bottleneck;
    const deliverAs = shouldUseSteeringRecovery(bottleneck) ? "steer" : "follow_up";
    const guidance = bottleneck
      ? buildRecoveryGuidanceText(bottleneck, text)
      : text;

    await this.options.client.sendInput(this.options.externalSessionId, guidance, {
      role: "supervisor",
      deliverAs,
    });
    this.recoveryPhase = "recovering";
    this.lastFeedbackFingerprint = this.recoveryContext?.fingerprint;
    this.lastFeedbackAt = this.options.now();
    this.options.onFeedbackInjected();
  }

  async cancelTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void> {
    if (!this.options.isInterventionAllowed()) {
      return;
    }

    this.recoveryPhase = "awaiting-human";
    this.options.onEscalated();
    await this.options.client.halt(this.options.externalSessionId, envelope.payload.reason, {
      role: "supervisor",
    });
  }

  registerMessageHandler(): void {}

  registerCancelHandler(): void {}

  private shouldInjectFeedback(): boolean {
    const fingerprint = this.recoveryContext?.fingerprint;
    if (!fingerprint) {
      return true;
    }
    if (this.recoveryPhase === "awaiting-human") {
      return false;
    }
    if (this.lastFeedbackFingerprint !== fingerprint || !this.lastFeedbackAt) {
      return true;
    }

    const cooldownMs = 20_000;
    const ageMs = Date.parse(this.options.now()) - Date.parse(this.lastFeedbackAt);
    return !Number.isFinite(ageMs) || ageMs >= cooldownMs;
  }
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "halted" || status === "failed";
}

function buildPiBrowserExecutionPolicyPrompt(actorSystemPrompt: string): string {
  return [
    actorSystemPrompt,
    "Browser work must go through the external agent-browser tool backed by the external agent-browser CLI.",
    "When web browsing, searching, navigation, click, fill, snapshot, or extraction is needed, use the `agent-browser` tool with exact CLI-style commands such as `open <url>`, `get title`, `click <selector>`, `get text <selector>`, or `snapshot`.",
    "Do not use bash for browser steps unless the user explicitly asks for shell scripting around browser output.",
    "Do not use internal browser/web tools even if they appear available.",
  ].join(" ");
}

function buildAnomalyKey(anomaly: RuntimeAnomaly): string {
  return [
    anomaly.kind,
    anomaly.relatedTool ?? "",
    anomaly.evidence?.repeatedInput ?? "",
    anomaly.evidence?.childProcessName ?? "",
  ].join("|");
}

function shouldUseSteeringRecovery(
  bottleneck: BottleneckAssessment | undefined,
): boolean {
  if (!bottleneck) {
    return false;
  }

  return bottleneck.recoveryPlan.action === "switch_to_extraction"
    || bottleneck.recoveryPlan.action === "switch_to_synthesis";
}

function buildRecoveryGuidanceText(
  bottleneck: BottleneckAssessment,
  fallbackText: string,
): string {
  const controlPrefix = shouldUseSteeringRecovery(bottleneck)
    ? "Priority override: stop broad browsing and switch to the next task phase now."
    : "Recovery guidance:";
  const instructionText = bottleneck.recoveryPlan.instructions.join(" ");
  const summary = bottleneck.recoveryPlan.summary || bottleneck.summary;
  return [
    controlPrefix,
    `Recovery goal: ${summary}.`,
    `Diagnosis: ${bottleneck.diagnosis}.`,
    instructionText || fallbackText,
  ].join(" ");
}

export function mapPiMonoEventToLumoSessionEvents(
  event: PiMonoRuntimeEvent,
  session: RuntimeSession,
): RuntimeSessionEvent[] {
  if (event.type === "session.started") {
    session.task.task.startedAt = event.startedAt;
    session.task.task.lastUpdatedAt = event.startedAt;
    session.task.task.status = "running";
    session.pairState.actor.status = "running";
    return [{
      type: "status",
      sessionId: session.sessionId,
      status: "running",
    }];
  }

  if (event.type === "session.status") {
    session.task.task.status = event.status;
    session.task.task.lastUpdatedAt = event.occurredAt;
    session.pairState.actor.status = event.status;
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
    session.pairState.actor.currentStep = session.task.task.currentStep;
    session.pairState.actor.lastOutputAt = event.occurredAt;
    const record: ToolExecutionRecord = {
      step: session.task.task.currentStep,
      timestamp: event.occurredAt,
      tool: event.tool,
      input: event.input,
      output: event.output,
      durationMs: event.durationMs,
      exitCode: event.exitCode,
      status: (event.exitCode ?? 0) === 0 ? "ok" : "error",
      metadata: {
        runtimeProvider: "pi",
        sourceTaskId: event.taskId,
        runtimeSessionId: session.sessionId,
        ...event.metadata,
      },
      screenshotRef: event.screenshotRef,
    };
    const artifactClaim = extractArtifactClaim(record);
    if (artifactClaim) {
      session.pairState.completion = applyArtifactClaim(
        session.pairState.completion ?? createCompletionState(inferCompletionContract(session.task.context.instruction.text)),
        artifactClaim,
      );
    }
    for (const signal of extractCompletionSignalsFromTool(record)) {
      session.pairState.completion = applyCompletionSignal(
        session.pairState.completion ?? createCompletionState(inferCompletionContract(session.task.context.instruction.text)),
        signal,
        event.occurredAt,
      );
    }
    return [{
      type: "log",
      sessionId: session.sessionId,
      record,
    }];
  }

  if (event.type === "runtime.anomaly") {
    session.task.task.lastUpdatedAt = event.occurredAt;
    return [{
      type: "anomaly",
      sessionId: session.sessionId,
      anomaly: event.anomaly,
    }];
  }

  if (event.type === "supervisor.decision") {
    session.task.task.lastUpdatedAt = event.occurredAt;
    session.pairState.supervisor.lastDecision = event.decision;
    session.pairState.supervisor.lastEvaluatedAt = event.occurredAt;
    return [{
      type: "decision",
      sessionId: session.sessionId,
      decision: event.decision,
    }];
  }

  session.task.context.conversationHistory.push(event.turn);
  session.task.task.lastUpdatedAt = event.turn.timestamp;
  if (event.turn.role === "human" || event.turn.role === "supervisor") {
    session.pairState.actor.lastInputAt = event.turn.timestamp;
  }
  if (event.turn.role === "actor") {
    for (const signal of extractCompletionSignalsFromConversation(event.turn.text)) {
      session.pairState.completion = applyCompletionSignal(
        session.pairState.completion ?? createCompletionState(inferCompletionContract(session.task.context.instruction.text)),
        signal,
        event.turn.timestamp,
      );
    }
  }
  return [{
    type: "conversation",
    sessionId: session.sessionId,
    turn: event.turn,
  }];
}

export interface RuntimeAdapterSelectionOptions {
  now?: () => string;
  piMonoClient?: PiMonoRuntimeClient;
  supervisorTransport?: SupervisorTransport;
  enableLocalSupervisor?: boolean;
  bootstrapRunner?: CommandRunner;
  healthCheck?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  cwd?: string;
  registryPath?: string;
}

export interface PiMonoBootstrapCommandAttempt {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

const PI_MONO_STARTUP_FAILURE_MESSAGE =
  "Pi runtime health-check failed during startup. Ensure the installed pi toolchain is configured and reachable before launching Lumo.";

export async function initializePiMonoRuntimeSessionAdapter(
  config: LumoConfig,
  options: RuntimeAdapterSelectionOptions = {},
): Promise<RuntimeSessionAdapter> {
  if (config.runtime.provider !== "pi") {
    throw new Error(
      `Unsupported runtime.provider "${String(config.runtime.provider)}". Lumo requires "pi".`,
    );
  }
  const piMono = new PiMonoSessionAdapter({
    config,
    client: options.piMonoClient,
    now: options.now,
    supervisorTransport: options.supervisorTransport,
    enableLocalSupervisor: options.enableLocalSupervisor,
    registryPath: options.registryPath,
  });

  const healthCheck = options.healthCheck ?? (() => piMono.isAvailable());
  if (healthCheck()) {
    return piMono;
  }

  if (!config.runtime.bootstrap.enabled) {
    throw new Error(PI_MONO_STARTUP_FAILURE_MESSAGE);
  }

  const attempts = await runPiMonoBootstrap(config, {
    cwd: options.cwd ?? process.cwd(),
    runner: options.bootstrapRunner ?? new SubprocessCommandRunner(),
  });

  await (options.sleep ?? defaultSleep)(config.runtime.bootstrap.retryBackoffMs);
  if (healthCheck()) {
    return piMono;
  }

  throw new Error(formatPiMonoBootstrapFailureMessage(attempts));
}

async function runPiMonoBootstrap(
  config: LumoConfig,
  options: {
    cwd: string;
    runner: CommandRunner;
  },
): Promise<PiMonoBootstrapCommandAttempt[]> {
  const attempts: PiMonoBootstrapCommandAttempt[] = [];
  for (const command of config.runtime.bootstrap.commands) {
    try {
      const result = await options.runner.run("sh", ["-lc", command], {
        cwd: options.cwd,
      });
      attempts.push({
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (error) {
      attempts.push({
        command,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return attempts;
}

function formatPiMonoBootstrapFailureMessage(
  attempts: PiMonoBootstrapCommandAttempt[],
): string {
  const summary = attempts.length === 0
    ? "No bootstrap commands were configured or detected."
    : attempts
      .map((attempt, index) => {
        const parts = [
          `[${index + 1}] ${attempt.command}`,
          `exit=${attempt.exitCode === null ? "error" : attempt.exitCode}`,
        ];
        if (attempt.error) {
          parts.push(`error=${attempt.error}`);
        }
        if (attempt.stderr) {
          parts.push(`stderr=${truncateForError(attempt.stderr)}`);
        }
        return parts.join(" ");
      })
      .join("; ");

  return [
    "Pi runtime health-check failed during startup after runtime command checks.",
    summary,
    "Set runtime.bootstrap.commands or LUMO_RUNTIME_BOOTSTRAP_COMMANDS to the correct runtime command list, or disable auto-bootstrap with runtime.bootstrap.enabled=false or LUMO_RUNTIME_AUTO_BOOTSTRAP=0.",
  ].join(" ");
}

function truncateForError(value: string): string {
  return value.length <= 160 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 157))}...`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  return createConfiguredSupervisorClient(config);
}
