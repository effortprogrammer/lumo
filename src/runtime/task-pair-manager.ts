import { type LumoConfig } from "../config/load-config.js";
import { type LumoEventBus } from "../event/bus.js";
import { createAgentikaEventBus } from "../event/agentika-adapter.js";
import { InProcessA2AAdapter } from "../a2a/in-process-adapter.js";
import {
  AgentikaA2AAdapter,
  type AgentikaA2AAdapterOptions,
} from "../a2a/agentika-adapter.js";
import {
  type ActorProgressMessage,
  buildActorInterventionAckMessage,
  buildActorInterventionResultMessage,
  type ActorInterventionResultMessage,
  type A2AMessage,
  type A2AEnvelope,
  type CancelTaskRequest,
  type SupervisorFeedbackMessage,
  type SupervisorHaltMessage,
} from "../a2a/protocol.js";
import {
  type ConversationTurn,
  type RuntimeAnomaly,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type SupervisorOutputEnvelope } from "../supervisor/contracts.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { SupervisorEngine } from "../supervisor/engine.js";
import { createConfiguredSupervisorClient } from "../supervisor/model-client.js";
import { buildSupervisorInputEnvelope } from "../supervisor/contracts.js";
import { type LogBatch } from "../logging/log-batcher.js";
import { type CommandRunner } from "./subprocess.js";
import { type SupervisorTransport } from "../a2a/transport.js";
import {
  SessionManager,
  type SessionRuntimeCallbacks,
  type TaskSession,
} from "./session-manager.js";
import { type RuntimeAdapterSelectionOptions } from "./runtime-session-adapter.js";
import { type TaskPairRuntimeState } from "./task-pair-state.js";
import { type TaskPhaseAssessment, assessTaskPhase } from "../supervisor/phase.js";
import { enrichBrowserSituation } from "./browser-situation.js";
import { MemoryHarness } from "../memory/harness.js";
import { type RetrievedMemoryContext } from "../memory/types.js";
import {
  InProcessSupervisorSessionBootstrapper,
  type SupervisorInterventionListenerRequest,
  type SupervisorSessionInterventionSubscriber,
  type SupervisorSessionBootstrapper,
  type SupervisorSessionProgressDeliverer,
  type SupervisorSessionBootstrapResult,
} from "./supervisor-session-bootstrap.js";

export interface ManagedTaskPair {
  taskId: string;
  actorAgentId: string;
  supervisorAgentId: string;
  session: TaskSession;
  pairState: TaskPairRuntimeState;
  decisions: TaskSession["decisions"];
  supervisorOutputs: TaskSession["supervisorOutputs"];
  supervisorProgress: TaskSession["supervisorProgress"];
  supervisorInbox: ActorProgressMessage[];
  supervisorInterventions: Array<SupervisorFeedbackMessage | SupervisorHaltMessage>;
  supervisorInterventionResults: ActorInterventionResultMessage[];
}

export interface SupervisorObservationCycleResult {
  pair: ManagedTaskPair;
  input: ReturnType<typeof buildSupervisorInputEnvelope>;
  output: SupervisorOutputEnvelope;
}

export interface TaskPairRuntimeCallbacks {
  onLog?: (pair: ManagedTaskPair, record: ToolExecutionRecord) => void;
  onDecision?: (pair: ManagedTaskPair, decision: SupervisorDecision) => void;
  onSupervisorOutput?: (pair: ManagedTaskPair, output: SupervisorOutputEnvelope) => void;
  onSupervisorProgress?: (pair: ManagedTaskPair, progress: ActorProgressMessage) => void;
  onConversation?: (pair: ManagedTaskPair, turn: ConversationTurn) => void;
  onAnomaly?: (pair: ManagedTaskPair, anomaly: RuntimeAnomaly) => void;
  onStatusChange?: (pair: ManagedTaskPair, status: TaskStatus) => void;
}

type ManagedA2AAdapter = InProcessA2AAdapter | AgentikaA2AAdapter;

class MutableSupervisorTransport implements SupervisorTransport {
  private adapter: ManagedA2AAdapter;
  private readonly progressHandlers = new Map<string, (message: A2AEnvelope<A2AMessage>) => Promise<void> | void>();
  private readonly feedbackHandlers = new Map<string, (message: A2AEnvelope<A2AMessage>) => Promise<void> | void>();
  private readonly haltHandlers = new Map<string, (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void>();

  constructor(adapter: ManagedA2AAdapter) {
    this.adapter = adapter;
  }

  async sendProgress(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    await this.adapter.sendMessage(envelope);
  }

  registerProgressHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void {
    this.progressHandlers.set(agentId, handler);
    this.adapter.registerMessageHandler(agentId, handler);
  }

  registerFeedbackHandler(
    agentId: string,
    handler: (message: A2AEnvelope<A2AMessage>) => Promise<void> | void,
  ): void {
    this.feedbackHandlers.set(agentId, handler);
    this.adapter.registerMessageHandler(agentId, handler);
  }

  registerHaltHandler(
    agentId: string,
    handler: (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void,
  ): void {
    this.haltHandlers.set(agentId, handler);
    this.adapter.registerCancelHandler(agentId, handler);
  }

  reset(adapter: ManagedA2AAdapter): void {
    this.stopCurrentAdapter();
    this.adapter = adapter;
    this.progressHandlers.clear();
    this.feedbackHandlers.clear();
    this.haltHandlers.clear();
  }

  swapAdapter(adapter: ManagedA2AAdapter): void {
    this.stopCurrentAdapter();
    this.adapter = adapter;
    for (const [agentId, handler] of this.progressHandlers) {
      this.adapter.registerMessageHandler(agentId, handler);
    }
    for (const [agentId, handler] of this.feedbackHandlers) {
      this.adapter.registerMessageHandler(agentId, handler);
    }
    for (const [agentId, handler] of this.haltHandlers) {
      this.adapter.registerCancelHandler(agentId, handler);
    }
  }

  stopCurrentAdapter(): void {
    if (this.adapter instanceof AgentikaA2AAdapter) {
      this.adapter.stop();
    }
  }
}

export class TaskPairManager {
  private currentSupervisorInbox: ActorProgressMessage[] | null = null;
  private currentSupervisorInterventions: Array<SupervisorFeedbackMessage | SupervisorHaltMessage> | null = null;
  private currentSupervisorInterventionResults: ActorInterventionResultMessage[] | null = null;
  private currentSupervisorAnomalies: RuntimeAnomaly[] | null = null;
  private supervisorLoopHandle?: ReturnType<typeof setInterval>;
  private supervisorLoopActive = false;
  private supervisorObservationInFlight = false;
  private supervisorInterventionUnsubscribe: (() => void) | null = null;
  private readonly memoryContextCache = new Map<string, RetrievedMemoryContext>();
  private readonly reviewedSessions = new Set<string>();
  private readonly transportController: MutableSupervisorTransport;
  private readonly originalAdapter: InProcessA2AAdapter;

  private constructor(
    private readonly config: LumoConfig,
    private readonly sessionManager: SessionManager,
    supervisorTransport: MutableSupervisorTransport,
    originalAdapter: InProcessA2AAdapter,
    private readonly now: () => string,
    private readonly supervisorEngine: SupervisorEngine,
    private readonly supervisorBootstrapper: SupervisorSessionBootstrapper,
    private readonly eventBus?: LumoEventBus,
    private readonly memoryHarness?: MemoryHarness,
    private readonly agentikaAdapterFactory: (options: AgentikaA2AAdapterOptions) => AgentikaA2AAdapter = (options) =>
      new AgentikaA2AAdapter(options),
  ) {
    this.transportController = supervisorTransport;
    this.originalAdapter = originalAdapter;
  }

  static async create(
    config: LumoConfig,
    runner?: CommandRunner,
    now?: () => string,
    runtimeOptions: RuntimeAdapterSelectionOptions = {},
    options?: {
      supervisorBootstrapper?: SupervisorSessionBootstrapper;
      transportAdapter?: InProcessA2AAdapter;
      eventSink?: LumoEventBus;
      agentikaAdapterFactory?: (options: AgentikaA2AAdapterOptions) => AgentikaA2AAdapter;
    },
  ): Promise<TaskPairManager> {
    const nowFn = now ?? (() => new Date().toISOString());
    const originalAdapter = options?.transportAdapter ?? new InProcessA2AAdapter();
    const transportController = new MutableSupervisorTransport(originalAdapter);
    const eventSink = options?.eventSink ?? createAgentikaEventBus(config.agentika);
    const useLocalSupervisor = options?.supervisorBootstrapper
      ? options.supervisorBootstrapper instanceof InProcessSupervisorSessionBootstrapper
      : true;
    const sessionManager = await SessionManager.create(config, runner, now, {
      ...runtimeOptions,
      supervisorTransport: runtimeOptions.supervisorTransport ?? transportController,
      enableLocalSupervisor: runtimeOptions.enableLocalSupervisor ?? useLocalSupervisor,
    });
    return new TaskPairManager(
      config,
      sessionManager,
      transportController,
      originalAdapter,
      nowFn,
      new SupervisorEngine({
        client: createConfiguredSupervisorClient(config),
      }),
      options?.supervisorBootstrapper ?? new InProcessSupervisorSessionBootstrapper(),
      eventSink,
      eventSink
        ? new MemoryHarness(eventSink, nowFn)
        : undefined,
      options?.agentikaAdapterFactory,
    );
  }

  get current(): ManagedTaskPair | null {
    return toManagedTaskPair(
      this.sessionManager.current,
      this.currentSupervisorInbox,
      this.currentSupervisorInterventions,
      this.currentSupervisorInterventionResults,
    );
  }

  createPair(
    instruction: string,
    callbacks?: TaskPairRuntimeCallbacks,
  ): ManagedTaskPair {
    this.stopSupervisorLoop();
    this.supervisorInterventionUnsubscribe?.();
    this.supervisorInterventionUnsubscribe = null;
    this.transportController.reset(this.originalAdapter);
    const supervisorInbox: ActorProgressMessage[] = [];
    const supervisorInterventions: Array<SupervisorFeedbackMessage | SupervisorHaltMessage> = [];
    const supervisorInterventionResults: ActorInterventionResultMessage[] = [];
    this.currentSupervisorInbox = supervisorInbox;
    this.currentSupervisorInterventions = supervisorInterventions;
    this.currentSupervisorInterventionResults = supervisorInterventionResults;
    this.currentSupervisorAnomalies = [];
    const session = this.sessionManager.createTask(
      instruction,
      this.createSessionCallbacks(callbacks),
    );
    const pair = toManagedTaskPair(
      session,
      supervisorInbox,
      supervisorInterventions,
      supervisorInterventionResults,
    )!;
    void this.eventBus?.publish({
      topic: `task.${pair.taskId}.events`,
      type: "task.lifecycle",
      source: "lumo.actor",
      correlationId: pair.pairState.pairId,
      idempotencyKey: `created:${pair.taskId}`,
      payload: {
        taskId: pair.taskId,
        sessionId: pair.session.runtime.sessionId,
        status: pair.pairState.actor.status,
        currentStep: pair.pairState.actor.currentStep,
        instruction,
        occurredAt: this.now(),
      },
    });
    pair.pairState.supervisor.status = "bootstrapping";
    this.bootstrapSupervisorPair(pair, instruction);
    this.transportController.registerProgressHandler(
      pair.supervisorAgentId,
      (envelope) => {
        const progress = extractActorProgress(envelope);
        if (progress) {
          supervisorInbox.push(progress);
          pair.pairState.supervisor.lastProgress = progress;
          pair.pairState.supervisor.lastProgressAt = envelope.payload.sentAt;
          pair.pairState.supervisor.status = "observing";
          this.evaluateInterventionEffect(pair, progress);
          void this.eventBus?.publish({
            topic: `task.${pair.taskId}.events`,
            type: "actor.progress",
            source: "lumo.actor",
            correlationId: pair.pairState.pairId,
            idempotencyKey: progress.progressId,
            payload: progress as unknown as Record<string, unknown>,
          });
        }
      },
    );
    this.transportController.registerFeedbackHandler(pair.actorAgentId, (envelope) => {
      const feedback = extractSupervisorFeedback(envelope);
      if (!feedback) {
        return;
      }
      supervisorInterventions.push(feedback);
      pair.pairState.supervisor.lastDecision = feedback.decision;
      pair.pairState.supervisor.lastEvaluatedAt = envelope.payload.sentAt;
      void this.eventBus?.publish({
        topic: `task.${pair.taskId}.events`,
        type: "supervisor.intervention.issued",
        source: "lumo.supervisor",
        correlationId: pair.pairState.pairId,
        idempotencyKey: feedback.interventionId,
        payload: feedback as unknown as Record<string, unknown>,
      });
      if (pair.pairState.supervisor.mode === "separate_session") {
        void this.sendSupervisorInterventionAck(pair, feedback.interventionId, true);
        const nextInstruction = envelope.payload.parts.find((part): part is { kind: "text"; text: string } => part.kind === "text")?.text
          ?? feedback.instructions?.join(" ")
          ?? feedback.decision.suggestion
          ?? feedback.decision.reason;
        void this.sessionManager.followUp(nextInstruction)
          .then(() => this.sendSupervisorInterventionResult(pair, feedback.interventionId, "applied", "Actor follow-up was queued successfully."))
          .catch((error) =>
            this.sendSupervisorInterventionResult(
              pair,
              feedback.interventionId,
              "failed",
              error instanceof Error ? error.message : String(error),
            ));
      }
    });
    this.transportController.registerHaltHandler(pair.actorAgentId, (envelope) => {
      const halt = extractSupervisorHalt(envelope);
      supervisorInterventions.push(halt);
      pair.pairState.supervisor.lastDecision = halt.decision;
      pair.pairState.supervisor.lastEvaluatedAt = envelope.payload.requestedAt;
      void this.eventBus?.publish({
        topic: `task.${pair.taskId}.events`,
        type: "supervisor.intervention.issued",
        source: "lumo.supervisor",
        correlationId: pair.pairState.pairId,
        idempotencyKey: halt.interventionId,
        payload: halt as unknown as Record<string, unknown>,
      });
      if (pair.pairState.supervisor.mode === "separate_session") {
        void this.sendSupervisorInterventionAck(pair, halt.interventionId, true);
        this.sessionManager.halt(envelope.payload.reason);
        void this.sendSupervisorInterventionResult(pair, halt.interventionId, "applied", "Actor halt was applied.");
      }
    });
    this.maybePromoteTransportToAgentika(pair.taskId);
    this.startSupervisorLoop();
    return pair;
  }

  async followUp(text: string): Promise<void> {
    await this.sessionManager.followUp(text);
  }

  async resume(text?: string): Promise<void> {
    await this.sessionManager.resume(text);
  }

  halt(reason: string): void {
    this.sessionManager.halt(reason);
  }

  isSupervisorLoopRunning(): boolean {
    return this.supervisorLoopActive;
  }

  startSupervisorLoop(intervalMs = 1_000): void {
    this.stopSupervisorLoop();
    this.supervisorLoopActive = true;
    this.supervisorLoopHandle = setInterval(() => {
      void this.runSupervisorLoopTick();
    }, intervalMs);
    this.supervisorLoopHandle.unref?.();
  }

  stopSupervisorLoop(): void {
    if (this.supervisorLoopHandle) {
      clearInterval(this.supervisorLoopHandle);
      this.supervisorLoopHandle = undefined;
    }
    this.supervisorLoopActive = false;
    this.supervisorObservationInFlight = false;
  }

  drainSupervisorInbox(): ActorProgressMessage[] {
    return this.drainSupervisorInboxInternal(true);
  }

  private drainSupervisorInboxInternal(markReady: boolean): ActorProgressMessage[] {
    const inbox = this.currentSupervisorInbox ?? [];
    const drained = [...inbox];
    inbox.length = 0;
    const current = this.current;
    if (current) {
      current.pairState.supervisor.lastInboxDrainedAt = this.now();
      if (markReady) {
        current.pairState.supervisor.status = "ready";
      }
    }
    return drained;
  }

  peekSupervisorInbox(): readonly ActorProgressMessage[] {
    return [...(this.currentSupervisorInbox ?? [])];
  }

  private createSessionCallbacks(
    callbacks?: TaskPairRuntimeCallbacks,
  ): SessionRuntimeCallbacks {
    const safeCallbacks = callbacks ?? {};
    const currentPair = (): ManagedTaskPair => {
      const pair = this.current;
      if (!pair) {
        throw new Error("No managed task pair is active");
      }
      return pair;
    };

    return {
      onLog: safeCallbacks.onLog
        ? (record) => safeCallbacks.onLog?.(currentPair(), record)
        : undefined,
      onDecision: safeCallbacks.onDecision
        ? (decision) => {
    const pair = currentPair();
          void this.eventBus?.publish({
            topic: `task.${pair.taskId}.events`,
            type: "supervisor.decision",
            source: "lumo.supervisor",
            correlationId: pair.pairState.pairId,
            idempotencyKey: `${decision.action}:${pair.pairState.actor.currentStep}:${pair.decisions.length + 1}`,
            payload: {
              ...decision,
              occurredAt: this.now(),
            },
          });
          safeCallbacks.onDecision?.(pair, decision);
        }
        : (decision) => {
          const pair = currentPair();
          void this.eventBus?.publish({
            topic: `task.${pair.taskId}.events`,
            type: "supervisor.decision",
            source: "lumo.supervisor",
            correlationId: pair.pairState.pairId,
            idempotencyKey: `${decision.action}:${pair.pairState.actor.currentStep}:${pair.decisions.length + 1}`,
            payload: {
              ...decision,
              occurredAt: this.now(),
            },
          });
        },
      onSupervisorOutput: safeCallbacks.onSupervisorOutput
        ? (output) => safeCallbacks.onSupervisorOutput?.(currentPair(), output)
        : undefined,
      onSupervisorProgress: safeCallbacks.onSupervisorProgress
        ? (progress) => safeCallbacks.onSupervisorProgress?.(currentPair(), progress)
        : undefined,
      onConversation: safeCallbacks.onConversation
        ? (turn) => safeCallbacks.onConversation?.(currentPair(), turn)
        : undefined,
      onAnomaly: (anomaly) => {
        this.currentSupervisorAnomalies?.push(anomaly);
        const pair = currentPair();
        void this.eventBus?.publish({
          topic: `task.${pair.taskId}.events`,
          type: "runtime.anomaly",
          source: "lumo.runtime",
          correlationId: pair.pairState.pairId,
          idempotencyKey: anomaly.id,
          payload: {
            ...anomaly,
            occurredAt: this.now(),
          } as unknown as Record<string, unknown>,
        });
        safeCallbacks.onAnomaly?.(pair, anomaly);
      },
      onStatusChange: (status) => {
        const pair = currentPair();
        void this.eventBus?.publish({
          topic: `task.${pair.taskId}.events`,
          type: "task.lifecycle",
          source: "lumo.actor",
          correlationId: pair.pairState.pairId,
          idempotencyKey: `${status}:${pair.session.runtime.task.task.currentStep}`,
          payload: {
            taskId: pair.taskId,
            sessionId: pair.session.runtime.sessionId,
            status,
            currentStep: pair.session.runtime.task.task.currentStep,
            occurredAt: this.now(),
          },
        });
        if (isTerminalTaskStatus(status)) {
          void this.reviewCompletedPair(pair, status);
        }
        safeCallbacks.onStatusChange?.(pair, status);
      },
    };
  }

  async observeCurrentPair(): Promise<SupervisorObservationCycleResult | null> {
    const pair = this.current;
    if (!pair) {
      return null;
    }

    const recentLogs = pair.session.runtime.actorLogs.slice(-20);
    const latestProgress = pair.supervisorProgress.at(-1);
    const recentEventContext = await this.readRecentAgentikaEventContext(pair);
    const memoryContext = await this.getMemoryContext(pair, "supervisor_observation");
    const input = buildSupervisorInputEnvelope(createObservationBatch(pair, recentLogs), {
      occurredAt: this.now(),
      currentStatus: pair.pairState.actor.status,
      currentStep: pair.pairState.actor.currentStep,
      collectionState: pair.pairState.supervisor.lastProgress?.collectionState,
      completionState: pair.pairState.supervisor.lastProgress?.completionState ?? pair.pairState.completion,
      recentLifecycleEvents: recentEventContext.lifecycleEvents,
      recentSupervisorDecisionEvents: recentEventContext.supervisorDecisionEvents,
      recentAnomalyEvents: recentEventContext.anomalyEvents,
      recentActorProgressEvents: recentEventContext.actorProgressEvents,
      priorLessons: memoryContext?.lessons,
      priorSkills: memoryContext?.skills,
    });
    const output = await this.supervisorEngine.evaluate({
      batch: createObservationBatch(pair, recentLogs),
      input,
      taskId: pair.taskId,
      occurredAt: this.now(),
    });
    pair.supervisorOutputs.push(output);
    pair.pairState.supervisor.lastOutput = output;
    pair.pairState.supervisor.lastEvaluatedAt = this.now();
    if (output.decision.action === "complete") {
      this.finalizePair(pair, output.decision.reason);
    }
    if (latestProgress) {
      pair.pairState.supervisor.lastProgress = latestProgress;
    }
    return {
      pair,
      input,
      output,
    };
  }

  private async runSupervisorLoopTick(): Promise<void> {
    if (!this.supervisorLoopActive || this.supervisorObservationInFlight) {
      return;
    }

    const pair = this.current;
    if (!pair) {
      return;
    }

    const actorStatus = pair.pairState.actor.status;
    if (actorStatus === "completed" || actorStatus === "halted" || actorStatus === "failed") {
      this.stopSupervisorLoop();
      return;
    }

    const pendingAnomalies = this.currentSupervisorAnomalies?.length ?? 0;
    if ((this.currentSupervisorInbox?.length ?? 0) === 0 && pendingAnomalies === 0) {
      return;
    }

    this.supervisorObservationInFlight = true;
    try {
      if (pair.pairState.supervisor.mode === "separate_session") {
        const drained = this.drainSupervisorInboxInternal(false);
        await this.forwardProgressToSupervisorSession(pair, drained);
        return;
      }
      await this.observeCurrentPair();
      this.drainSupervisorInboxInternal(true);
    } finally {
      this.supervisorObservationInFlight = false;
    }
  }

  private bootstrapSupervisorPair(pair: ManagedTaskPair, instruction: string): void {
    const request = {
      pairId: pair.pairState.pairId,
      taskId: pair.taskId,
      actorAgentId: pair.actorAgentId,
      supervisorAgentId: pair.supervisorAgentId,
      instruction,
      occurredAt: this.now(),
    };
    const result = this.supervisorBootstrapper.bootstrap(request);
    if (isPromiseLike(result)) {
      void result.then(
        (value) => {
          this.applySupervisorBootstrap(pair, value);
        },
        (error) => {
          pair.pairState.supervisor.status = "failed";
          pair.pairState.supervisor.bootstrapError = error instanceof Error ? error.message : String(error);
        },
      );
      return;
    }
    this.applySupervisorBootstrap(pair, result);
  }

  private applySupervisorBootstrap(
    pair: ManagedTaskPair,
    result: SupervisorSessionBootstrapResult,
  ): void {
    pair.pairState.supervisor.mode = result.mode;
    pair.pairState.supervisor.sessionId = result.sessionId;
    pair.pairState.supervisor.status = result.status;
    pair.pairState.supervisor.bootstrappedAt = result.bootstrappedAt;
    pair.pairState.supervisor.bootstrapError = undefined;
    this.attachSeparateSupervisorInterventionListener(pair);
  }

  private async forwardProgressToSupervisorSession(
    pair: ManagedTaskPair,
    drained: ActorProgressMessage[],
  ): Promise<void> {
    if (drained.length === 0 && (this.currentSupervisorAnomalies?.length ?? 0) === 0) {
      return;
    }
    if (!pair.pairState.supervisor.sessionId) {
      return;
    }
    if (!isSupervisorSessionProgressDeliverer(this.supervisorBootstrapper)) {
      return;
    }

    const recentLogs = pair.session.runtime.actorLogs.slice(-20);
    const fromProgresses = buildSupervisorInputBatchFromProgresses(
      pair,
      recentLogs,
      drained,
      {
        anomalies: this.drainSupervisorAnomalies(),
      },
    );
    const enrichedBatch = enrichBrowserSituation(fromProgresses, this.now());
    const latestProgressPhase = lastTaskPhaseFromProgresses(drained);
    const taskPhase = latestProgressPhase
      ?? assessTaskPhase({
        taskInstruction: enrichedBatch.taskInstruction,
        browserState: enrichedBatch.browserState,
        browserProgress: enrichedBatch.browserProgress,
        recentLogs: enrichedBatch.recentLogs ?? enrichedBatch.batch,
      });
    const recentEventContext = await this.readRecentAgentikaEventContext(pair);
    const memoryContext = await this.getMemoryContext(pair, "bottleneck_recovery");
    const input = buildSupervisorInputEnvelope(enrichedBatch, {
      occurredAt: this.now(),
      currentStatus: pair.pairState.actor.status,
      currentStep: pair.pairState.actor.currentStep,
      taskPhase,
      collectionState: drained.at(-1)?.collectionState,
      completionState: drained.at(-1)?.completionState ?? pair.pairState.completion,
      recentLifecycleEvents: recentEventContext.lifecycleEvents,
      recentSupervisorDecisionEvents: recentEventContext.supervisorDecisionEvents,
      recentAnomalyEvents: recentEventContext.anomalyEvents,
      recentActorProgressEvents: recentEventContext.actorProgressEvents,
      priorLessons: memoryContext?.lessons,
      priorSkills: memoryContext?.skills,
    });
    await this.supervisorBootstrapper.deliverProgress({
      pairId: pair.pairState.pairId,
      taskId: pair.taskId,
      supervisorSessionId: pair.pairState.supervisor.sessionId,
      input,
      progress: drained.at(-1),
      occurredAt: this.now(),
    });
  }

  private drainSupervisorAnomalies(): RuntimeAnomaly[] {
    const anomalies = this.currentSupervisorAnomalies ?? [];
    const drained = [...anomalies];
    anomalies.length = 0;
    return drained;
  }

  private async readRecentAgentikaEventContext(pair: ManagedTaskPair) {
    const events = await this.eventBus?.fetchRecent?.({
      topic: `task.${pair.taskId}.events`,
      limit: 16,
    }) ?? [];
    return {
      lifecycleEvents: events.filter((event) => event.type !== "actor.progress"),
      supervisorDecisionEvents: events
        .filter((event) => event.type === "supervisor.decision")
        .map((event) => ({
          status: isSupervisorDecisionStatus(event.payload.status) ? event.payload.status : undefined,
          action: isSupervisorDecisionAction(event.payload.action) ? event.payload.action : undefined,
          confidence: typeof event.payload.confidence === "number" ? event.payload.confidence : undefined,
          reason: typeof event.payload.reason === "string" ? event.payload.reason : undefined,
          suggestion: typeof event.payload.suggestion === "string" ? event.payload.suggestion : undefined,
          occurredAt: typeof event.payload.occurredAt === "string" ? event.payload.occurredAt : undefined,
        })),
      anomalyEvents: events
        .filter((event) => event.type === "runtime.anomaly")
        .map((event) => ({
          kind: typeof event.payload.kind === "string" ? event.payload.kind : undefined,
          severity: typeof event.payload.severity === "string" ? event.payload.severity : undefined,
          message: typeof event.payload.message === "string" ? event.payload.message : undefined,
          occurredAt: typeof event.payload.occurredAt === "string" ? event.payload.occurredAt : undefined,
        })),
      actorProgressEvents: events
        .filter((event) => event.type === "actor.progress")
        .map((event) => ({
          progressId: typeof event.payload.progressId === "string" ? event.payload.progressId : undefined,
          actorSessionId: typeof event.payload.actorSessionId === "string" ? event.payload.actorSessionId : undefined,
          sequence: typeof event.payload.sequence === "number" ? event.payload.sequence : undefined,
          summary: typeof event.payload.summary === "string" ? event.payload.summary : undefined,
          currentStatus: isTaskStatus(event.payload.currentStatus) ? event.payload.currentStatus : undefined,
          currentStep: typeof event.payload.currentStep === "number" ? event.payload.currentStep : undefined,
          collectionState: isCollectionState(event.payload.collectionState)
            ? event.payload.collectionState
            : undefined,
          taskPhase: isTaskPhaseAssessment(event.payload.taskPhase)
            ? event.payload.taskPhase
            : undefined,
          anomalies: Array.isArray(event.payload.anomalies)
            ? event.payload.anomalies as RuntimeAnomaly[]
            : undefined,
        })),
    };
  }

  private async getMemoryContext(
    pair: ManagedTaskPair,
    appliedTo: "task_start" | "supervisor_observation" | "bottleneck_recovery",
  ): Promise<RetrievedMemoryContext | undefined> {
    if (!this.memoryHarness) {
      return undefined;
    }
    const cacheKey = `${pair.session.runtime.sessionId}:${appliedTo}`;
    const cached = this.memoryContextCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const context = await this.memoryHarness.retrieveForInstruction({
      taskId: pair.taskId,
      sessionId: pair.session.runtime.sessionId,
      instruction: pair.session.runtime.task.context.instruction.text,
      appliedTo,
    });
    this.memoryContextCache.set(cacheKey, context);
    return context;
  }

  private async reviewCompletedPair(pair: ManagedTaskPair, status: TaskStatus): Promise<void> {
    if (!this.memoryHarness) {
      return;
    }
    const reviewKey = `${pair.session.runtime.sessionId}:${status}`;
    if (this.reviewedSessions.has(reviewKey)) {
      return;
    }
    this.reviewedSessions.add(reviewKey);
    await this.memoryHarness.reviewCompletedSession({
      session: pair.session,
      finalStatus: status,
    });
  }

  private finalizePair(pair: ManagedTaskPair, reason: string): void {
    pair.session.runtime.task.task.status = "completed";
    pair.session.runtime.task.task.completedAt = this.now();
    pair.session.runtime.task.task.lastUpdatedAt = this.now();
    pair.pairState.actor.status = "completed";
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId: `complete-${Date.now()}`,
      status: "resolved",
      evaluatedAt: this.now(),
      reason,
    };
    this.stopSupervisorLoop();
    this.transportController.stopCurrentAdapter();
    void this.reviewCompletedPair(pair, "completed");
  }

  private maybePromoteTransportToAgentika(taskId: string): void {
    if (!this.config.agentika.enabled) {
      return;
    }

    const adapter = this.agentikaAdapterFactory({
      baseUrl: this.config.agentika.baseUrl,
      token: this.config.agentika.token,
      taskId,
      pollIntervalMs: this.config.agentika.pollIntervalMs,
    });
    void adapter.start()
      .then(() => {
        this.transportController.swapAdapter(adapter);
      })
      .catch((error) => {
        console.warn(
          `[lumo.a2a] falling back to in-process A2A transport: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private attachSeparateSupervisorInterventionListener(pair: ManagedTaskPair): void {
    if (pair.pairState.supervisor.mode !== "separate_session") {
      return;
    }
    if (!pair.pairState.supervisor.sessionId) {
      return;
    }
    if (!isSupervisorSessionInterventionSubscriber(this.supervisorBootstrapper)) {
      return;
    }

    this.supervisorInterventionUnsubscribe?.();
    this.supervisorInterventionUnsubscribe = this.supervisorBootstrapper.attachInterventionListener({
      pairId: pair.pairState.pairId,
      taskId: pair.taskId,
      supervisorSessionId: pair.pairState.supervisor.sessionId,
      onFeedback: (message) => {
        this.currentSupervisorInterventions?.push(message);
        pair.pairState.supervisor.lastDecision = message.decision;
        pair.pairState.supervisor.lastEvaluatedAt = this.now();
        void this.sendSupervisorInterventionAck(pair, message.interventionId, true);
        const nextInstruction = message.instructions?.join(" ")
          ?? message.decision.suggestion
          ?? message.decision.reason;
        void this.sessionManager.followUp(nextInstruction)
          .then(() => this.sendSupervisorInterventionResult(pair, message.interventionId, "applied", "Actor follow-up was queued successfully."))
          .catch((error) =>
            this.sendSupervisorInterventionResult(
              pair,
              message.interventionId,
              "failed",
              error instanceof Error ? error.message : String(error),
            ));
      },
      onHalt: (message) => {
        this.currentSupervisorInterventions?.push(message);
        pair.pairState.supervisor.lastDecision = message.decision;
        pair.pairState.supervisor.lastEvaluatedAt = this.now();
        void this.sendSupervisorInterventionAck(pair, message.interventionId, true);
        this.sessionManager.halt(message.decision.reason);
        void this.sendSupervisorInterventionResult(pair, message.interventionId, "applied", "Actor halt was applied.");
      },
    });
  }

  private async sendSupervisorInterventionAck(
    pair: ManagedTaskPair,
    interventionId: string,
    accepted: boolean,
    reason?: string,
  ): Promise<void> {
    if (pair.pairState.supervisor.mode !== "separate_session") {
      return;
    }
    if (!pair.pairState.supervisor.sessionId) {
      return;
    }
    const ack = buildActorInterventionAckMessage({
      interventionId,
      actorSessionId: pair.session.runtime.sessionId,
      accepted,
      receivedAt: this.now(),
      reason,
    });
    if (isSupervisorSessionProgressDeliverer(this.supervisorBootstrapper)) {
      await this.supervisorBootstrapper.deliverProgress({
        pairId: pair.pairState.pairId,
        taskId: pair.taskId,
        supervisorSessionId: pair.pairState.supervisor.sessionId,
        ack,
        occurredAt: this.now(),
      });
    }
    debugSupervisorLoop("ack-sent", {
      taskId: pair.taskId,
      interventionId,
      accepted,
    });
    pair.pairState.supervisor.lastInterventionAck = ack;
    void this.eventBus?.publish({
      topic: `task.${pair.taskId}.events`,
      type: "actor.intervention.ack",
      source: "lumo.actor",
      correlationId: pair.pairState.pairId,
      idempotencyKey: interventionId,
      payload: pair.pairState.supervisor.lastInterventionAck as unknown as Record<string, unknown>,
    });
  }

  private async sendSupervisorInterventionResult(
    pair: ManagedTaskPair,
    interventionId: string,
    outcome: ActorInterventionResultMessage["outcome"],
    summary?: string,
  ): Promise<void> {
    if (pair.pairState.supervisor.mode !== "separate_session") {
      return;
    }
    if (!pair.pairState.supervisor.sessionId) {
      return;
    }
    const result = buildActorInterventionResultMessage({
      interventionId,
      actorSessionId: pair.session.runtime.sessionId,
      outcome,
      reportedAt: this.now(),
      summary,
    });
    this.currentSupervisorInterventionResults?.push(result);
    pair.pairState.supervisor.lastInterventionResult = result;
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId,
      status: outcome === "applied" ? "pending" : "unresolved",
      evaluatedAt: result.reportedAt,
      reason: summary,
    };

    if (isSupervisorSessionProgressDeliverer(this.supervisorBootstrapper)) {
      await this.supervisorBootstrapper.deliverProgress({
        pairId: pair.pairState.pairId,
        taskId: pair.taskId,
        supervisorSessionId: pair.pairState.supervisor.sessionId,
        result,
        occurredAt: this.now(),
      });
    }
    debugSupervisorLoop("result-sent", {
      taskId: pair.taskId,
      interventionId,
      outcome,
      summary,
    });
    void this.eventBus?.publish({
      topic: `task.${pair.taskId}.events`,
      type: "actor.intervention.result",
      source: "lumo.actor",
      correlationId: pair.pairState.pairId,
      idempotencyKey: interventionId,
      payload: result as unknown as Record<string, unknown>,
    });
  }

  private evaluateInterventionEffect(
    pair: ManagedTaskPair,
    progress: ActorProgressMessage,
  ): void {
    const lastResult = pair.pairState.supervisor.lastInterventionResult;
    if (!lastResult || lastResult.outcome !== "applied") {
      return;
    }
    const current = pair.pairState.supervisor.lastInterventionEffect;
    if (!current || current.interventionId !== lastResult.interventionId || current.status !== "pending") {
      return;
    }

    const specialized = evaluateSpecializedInterventionEffect(
      pair.pairState.supervisor.lastDecision,
      progress,
    );
    const unresolved = specialized != null
      ? specialized === "unresolved"
      : (progress.anomalies?.length ?? 0) > 0;
    pair.pairState.supervisor.lastInterventionEffect = {
      interventionId: lastResult.interventionId,
      status: unresolved ? "unresolved" : "resolved",
      evaluatedAt: this.now(),
      reason: unresolved
        ? specialized != null
          ? "Specialized intervention check indicates the follow-up state does not match the intended recovery."
          : "Follow-up progress still contains anomalies after the intervention."
        : specialized != null
          ? "Specialized intervention check indicates the intended recovery outcome was reached."
          : "Follow-up progress arrived without anomalies after the intervention.",
    };
    debugSupervisorLoop("effect-evaluated", {
      taskId: pair.taskId,
      interventionId: lastResult.interventionId,
      status: pair.pairState.supervisor.lastInterventionEffect.status,
      reason: pair.pairState.supervisor.lastInterventionEffect.reason,
    });
    void this.eventBus?.publish({
      topic: `task.${pair.taskId}.events`,
      type: "supervisor.intervention.effect",
      source: "lumo.supervisor",
      correlationId: pair.pairState.pairId,
      idempotencyKey: lastResult.interventionId,
      payload: pair.pairState.supervisor.lastInterventionEffect as unknown as Record<string, unknown>,
    });
  }
}

function evaluateSpecializedInterventionEffect(
  decision: SupervisorDecision | undefined,
  progress: ActorProgressMessage,
): "resolved" | "unresolved" | undefined {
  const summary = `${progress.summary ?? ""} ${progress.taskPhase?.summary ?? ""}`.toLowerCase();

  if (decision?.action === "halt") {
    return progress.currentStatus === "halted" ? "resolved" : "unresolved";
  }

  if (decision?.action === "complete") {
    return progress.completionState?.satisfied || progress.currentStatus === "completed"
      ? "resolved"
      : "unresolved";
  }

  if (summary.includes("synthes") || progress.taskPhase?.currentPhase === "synthesis") {
    return "resolved";
  }

  if (summary.includes("extract") || summary.includes("draft")) {
    return "resolved";
  }

  if ((progress.anomalies?.length ?? 0) > 0) {
    return "unresolved";
  }

  return undefined;
}

function debugSupervisorLoop(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (process.env.LUMO_DEBUG_SUPERVISOR_A2A !== "1") {
    return;
  }

  console.error(`[lumo supervisor loop] ${event} ${JSON.stringify(payload)}`);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "halted";
}

function isTerminalTaskStatus(value: TaskStatus): boolean {
  return value === "completed" || value === "failed" || value === "halted";
}

function isCollectionState(
  value: unknown,
): value is {
  itemsCollected: number;
  distinctItems: number;
  fieldsSeen: string[];
  comparisonReady?: boolean;
  recommendationReady?: boolean;
} {
  return typeof value === "object"
    && value !== null
    && typeof (value as { itemsCollected?: unknown }).itemsCollected === "number"
    && typeof (value as { distinctItems?: unknown }).distinctItems === "number"
    && Array.isArray((value as { fieldsSeen?: unknown }).fieldsSeen);
}

function isTaskPhaseAssessment(value: unknown): value is TaskPhaseAssessment {
  return typeof value === "object"
    && value !== null
    && typeof (value as { currentPhase?: unknown }).currentPhase === "string"
    && typeof (value as { confidence?: unknown }).confidence === "number"
    && typeof (value as { summary?: unknown }).summary === "string"
    && Array.isArray((value as { evidence?: unknown }).evidence);
}

function isSupervisorDecisionStatus(value: unknown): value is "ok" | "warning" | "critical" {
  return value === "ok" || value === "warning" || value === "critical";
}

function isSupervisorDecisionAction(value: unknown): value is "continue" | "feedback" | "halt" | "complete" {
  return value === "continue" || value === "feedback" || value === "halt" || value === "complete";
}

function toManagedTaskPair(
  session: TaskSession | null,
  supervisorInbox: ActorProgressMessage[] | null,
  supervisorInterventions: Array<SupervisorFeedbackMessage | SupervisorHaltMessage> | null,
  supervisorInterventionResults: ActorInterventionResultMessage[] | null,
): ManagedTaskPair | null {
  if (!session) {
    return null;
  }

  return {
    taskId: session.runtime.task.task.taskId,
    actorAgentId: session.runtime.task.task.actor.id,
    supervisorAgentId: session.runtime.task.task.supervisor.id,
    session,
    pairState: session.pairState,
    decisions: session.decisions,
    supervisorOutputs: session.supervisorOutputs,
    supervisorProgress: session.supervisorProgress,
    supervisorInbox: supervisorInbox ?? [],
    supervisorInterventions: supervisorInterventions ?? [],
    supervisorInterventionResults: supervisorInterventionResults ?? [],
  };
}

function extractActorProgress(
  envelope: { payload: A2AMessage },
): ActorProgressMessage | null {
  const progressPart = envelope.payload.parts.find(
    (part): part is { kind: "json"; data: ActorProgressMessage } =>
      part.kind === "json"
      && typeof part.data === "object"
      && part.data !== null
      && "type" in part.data
      && part.data.type === "actor-progress",
  );
  return progressPart?.data ?? null;
}

function createObservationBatch(
  pair: ManagedTaskPair,
  recentLogs: ManagedTaskPair["session"]["runtime"]["actorLogs"],
  options: {
    anomalies?: RuntimeAnomaly[];
  } = {},
): LogBatch {
  return {
    taskInstruction: pair.session.runtime.task.context.instruction.text,
    conversationHistory: pair.session.runtime.task.context.conversationHistory.map((turn) => turn.text),
    triggeredBy: "manual",
    anomalies: options.anomalies ?? [],
    batch: recentLogs.slice(-5),
    recentLogs,
  };
}

function buildSupervisorInputBatchFromProgresses(
  pair: ManagedTaskPair,
  recentLogs: ManagedTaskPair["session"]["runtime"]["actorLogs"],
  progresses: ActorProgressMessage[],
  options: {
    anomalies?: RuntimeAnomaly[];
  } = {},
): LogBatch {
  const progressAnomalies = progresses.flatMap((progress) => progress.anomalies ?? []);
  const mergedAnomalies = [
    ...(options.anomalies ?? []),
    ...progressAnomalies,
  ];
  return createObservationBatch(pair, recentLogs, {
    anomalies: mergedAnomalies,
  });
}

function lastTaskPhaseFromProgresses(
  progresses: ActorProgressMessage[],
): TaskPhaseAssessment | undefined {
  return progresses.at(-1)?.taskPhase;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function isSupervisorSessionProgressDeliverer(
  value: SupervisorSessionBootstrapper,
): value is SupervisorSessionBootstrapper & SupervisorSessionProgressDeliverer {
  return "deliverProgress" in value && typeof value.deliverProgress === "function";
}

function isSupervisorSessionInterventionSubscriber(
  value: SupervisorSessionBootstrapper,
): value is SupervisorSessionBootstrapper & SupervisorSessionInterventionSubscriber {
  return "attachInterventionListener" in value
    && typeof value.attachInterventionListener === "function";
}

function extractSupervisorFeedback(
  envelope: A2AEnvelope<A2AMessage>,
): SupervisorFeedbackMessage | null {
  const feedbackPart = envelope.payload.parts.find(
    (part): part is { kind: "json"; data: SupervisorFeedbackMessage } =>
      part.kind === "json"
      && typeof part.data === "object"
      && part.data !== null
      && "type" in part.data
      && part.data.type === "supervisor-feedback",
  );
  return feedbackPart?.data ?? null;
}

function extractSupervisorHalt(
  envelope: A2AEnvelope<CancelTaskRequest>,
): SupervisorHaltMessage {
  return envelope.payload.details ?? {
    type: "supervisor-halt",
    interventionId: `halt-${Date.now()}`,
    decision: {
      status: "critical",
      confidence: 1,
      reason: envelope.payload.reason,
      action: "halt",
    },
    humanActionNeeded: true,
  };
}
