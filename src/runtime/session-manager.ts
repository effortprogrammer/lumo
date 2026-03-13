import { type LumoConfig } from "../config/load-config.js";
import {
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { SubprocessCommandRunner, type CommandRunner } from "./subprocess.js";
import {
  initializePiMonoRuntimeSessionAdapter,
  type RuntimeSession,
  type RuntimeSessionEvent,
  type RuntimeSessionAdapter,
} from "./runtime-session-adapter.js";

export interface TaskSession {
  runtime: RuntimeSession;
  decisions: SupervisorDecision[];
}

export interface SessionRuntimeCallbacks {
  onLog?: (record: ToolExecutionRecord) => void;
  onDecision?: (decision: SupervisorDecision) => void;
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
  ): Promise<SessionManager> {
    const runtimeAdapter = await initializePiMonoRuntimeSessionAdapter(config, {
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
    const runtime = this.runtimeAdapter.createSession({
      instruction,
      cwd: process.cwd(),
    });

    this.session = {
      runtime,
      decisions,
    };
    this.unsubscribeCurrentSession = this.runtimeAdapter.subscribe(
      runtime.sessionId,
      (event) => {
        this.handleSessionEvent(event, decisions, callbacks);
      },
    );
    void this.runtimeAdapter.sendInput(runtime.sessionId, instruction);
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

    void this.runtimeAdapter.halt(this.session.runtime.sessionId, reason);
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
      callbacks?.onDecision?.(event.decision);
      return;
    }

    if (event.type === "status") {
      callbacks?.onStatusChange?.(event.status);
    }
  }
}
