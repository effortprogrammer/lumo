import { type LumoConfig } from "../config/load-config.js";
import {
  type ConversationTurn,
  type RuntimeAnomaly,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { type ActorProgressMessage } from "../a2a/protocol.js";
import { type SupervisorOutputEnvelope } from "../supervisor/contracts.js";
import { SubprocessCommandRunner, type CommandRunner } from "./subprocess.js";
import { type TaskPairRuntimeState } from "./task-pair-state.js";
import {
  initializePiMonoRuntimeSessionAdapter,
  type RuntimeAdapterSelectionOptions,
  type RuntimeSession,
  type RuntimeSessionEvent,
  type RuntimeSessionAdapter,
} from "./runtime-session-adapter.js";

export interface TaskSession {
  runtime: RuntimeSession;
  pairState: TaskPairRuntimeState;
  decisions: SupervisorDecision[];
  supervisorOutputs: SupervisorOutputEnvelope[];
  supervisorProgress: ActorProgressMessage[];
}

export interface SessionRuntimeCallbacks {
  onLog?: (record: ToolExecutionRecord) => void;
  onDecision?: (decision: SupervisorDecision) => void;
  onSupervisorOutput?: (output: SupervisorOutputEnvelope) => void;
  onSupervisorProgress?: (progress: ActorProgressMessage) => void;
  onConversation?: (turn: ConversationTurn) => void;
  onAnomaly?: (anomaly: RuntimeAnomaly) => void;
  onStatusChange?: (status: RuntimeSession["task"]["task"]["status"]) => void;
}

export class SessionManager {
  private session: TaskSession | null = null;
  private unsubscribeCurrentSession: (() => void) | null = null;
  private readonly runtimeAdapter: RuntimeSessionAdapter;

  private constructor(
    private readonly config: LumoConfig,
    private readonly runner: CommandRunner = new SubprocessCommandRunner(),
    private readonly now: () => string = () => new Date().toISOString(),
    runtimeAdapter: RuntimeSessionAdapter,
  ) {
    this.runtimeAdapter = runtimeAdapter;
  }

  static async create(
    config: LumoConfig,
    runner: CommandRunner = new SubprocessCommandRunner(),
    now: () => string = () => new Date().toISOString(),
    runtimeOptions: RuntimeAdapterSelectionOptions = {},
  ): Promise<SessionManager> {
    const runtimeAdapter = await initializePiMonoRuntimeSessionAdapter(config, {
      ...runtimeOptions,
      now,
    });
    return new SessionManager(config, runner, now, runtimeAdapter);
  }

  get current(): TaskSession | null {
    return this.session as TaskSession;
  }

  createTask(
    instruction: string,
    callbacks?: SessionRuntimeCallbacks,
  ): TaskSession {
    this.unsubscribeCurrentSession?.();

    const decisions: SupervisorDecision[] = [];
    const supervisorOutputs: SupervisorOutputEnvelope[] = [];
    const supervisorProgress: ActorProgressMessage[] = [];
    const runtime = this.runtimeAdapter.createSession({
      instruction,
      cwd: process.cwd(),
    });

    this.session = {
      runtime,
      pairState: runtime.pairState,
      decisions,
      supervisorOutputs,
      supervisorProgress,
    };
    this.unsubscribeCurrentSession = this.runtimeAdapter.subscribe(
      runtime.sessionId,
      (event) => {
        this.handleSessionEvent(event, decisions, callbacks);
      },
    );
    void this.runtimeAdapter.sendInput(runtime.sessionId, instruction).catch((error) => {
      runtime.task.task.status = "failed";
      runtime.task.task.lastUpdatedAt = this.now();
      runtime.pairState.actor.status = "failed";
      callbacks?.onStatusChange?.("failed");
      callbacks?.onLog?.({
        step: runtime.task.task.currentStep + 1,
        timestamp: this.now(),
        tool: "coding-agent",
        input: instruction,
        output: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        exitCode: null,
        status: "error",
      });
    });
    return this.session;
  }

  async followUp(text: string): Promise<void> {
    if (!this.session) {
      throw new Error("No active task");
    }

    await this.runtimeAdapter.sendInput(this.session.runtime.sessionId, text);
  }

  async resume(text?: string): Promise<void> {
    if (!this.session) {
      throw new Error("No active task");
    }

    await this.runtimeAdapter.resume(this.session.runtime.sessionId, text);
  }

  halt(reason: string): void {
    if (!this.session) {
      throw new Error("No active task");
    }

    void this.runtimeAdapter.halt(this.session.runtime.sessionId, reason).catch(() => {});
  }

  private handleSessionEvent(
    event: RuntimeSessionEvent,
    decisions: SupervisorDecision[],
    callbacks?: SessionRuntimeCallbacks,
  ): void {
    if (event.type === "log") {
      callbacks?.onLog?.(event.record);
      return;
    }

    if (event.type === "decision") {
      decisions.push(event.decision);
      if (this.session) {
        this.session.pairState.supervisor.lastDecision = event.decision;
        this.session.pairState.supervisor.lastEvaluatedAt = this.now();
      }
      callbacks?.onDecision?.(event.decision);
      return;
    }

    if (event.type === "supervisor-output") {
      this.session?.supervisorOutputs.push(event.output);
      if (this.session) {
        this.session.pairState.supervisor.lastOutput = event.output;
        this.session.pairState.supervisor.lastEvaluatedAt = this.now();
      }
      callbacks?.onSupervisorOutput?.(event.output);
      return;
    }

    if (event.type === "supervisor-progress") {
      this.session?.supervisorProgress.push(event.progress);
      if (this.session) {
        this.session.pairState.supervisor.lastProgress = event.progress;
      }
      callbacks?.onSupervisorProgress?.(event.progress);
      return;
    }

    if (event.type === "status") {
      if (this.session) {
        this.session.pairState.actor.status = event.status;
      }
      callbacks?.onStatusChange?.(event.status);
      return;
    }

    if (event.type === "anomaly") {
      callbacks?.onAnomaly?.(event.anomaly);
      return;
    }

    callbacks?.onConversation?.(event.turn);
  }
}
