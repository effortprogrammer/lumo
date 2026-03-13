import {
  type A2AAgentAdapter,
  type A2AEnvelope,
  type A2AMessage,
  type CancelTaskRequest,
} from "../a2a/protocol.js";
import { type LumoConfig } from "../config/load-config.js";
import {
  type ConversationTurn,
  type TaskPairing,
  type TaskStatus,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { LogBatcher, type LogBatch } from "../logging/log-batcher.js";
import { parseActorInstruction } from "./command-parser.js";
import { type CommandRunner } from "./subprocess.js";

export interface ActorRuntimeOptions {
  pairing: TaskPairing;
  config: LumoConfig;
  adapter: A2AAgentAdapter;
  runner: CommandRunner;
  now?: () => string;
  cwd?: string;
  onLog?: (record: ToolExecutionRecord) => void;
  onStatusChange?: (status: TaskStatus) => void;
  onConversation?: (turn: ConversationTurn) => void;
  onBatch?: (batch: LogBatch) => Promise<void>;
}

export class ActorRuntime {
  private readonly now: () => string;
  private readonly batcher: LogBatcher;
  private readonly pendingInstructions: string[] = [];
  private readonly logs: ToolExecutionRecord[] = [];

  constructor(private readonly options: ActorRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.batcher = new LogBatcher(this.options.pairing.context, {
      maxSteps: options.config.batch.maxSteps,
      maxAgeMs: options.config.batch.maxAgeMs,
      immediateKeywords: options.config.batch.immediateKeywords,
    });

    this.options.adapter.registerMessageHandler(
      this.options.pairing.task.actor.id,
      async (message) => {
        await this.handleSupervisorMessage(message);
      },
    );
    this.options.adapter.registerCancelHandler(
      this.options.pairing.task.actor.id,
      async (request) => {
        await this.handleCancelRequest(request);
      },
    );
  }

  get task(): TaskPairing {
    return this.options.pairing;
  }

  get actorLogs(): ToolExecutionRecord[] {
    return [...this.logs];
  }

  async executeInstruction(text: string): Promise<void> {
    this.appendConversationTurn("human", text);

    if (this.task.task.status === "paused") {
      this.pendingInstructions.push(text);
      return;
    }

    if (this.task.task.status === "halted") {
      throw new Error("Task is halted and cannot accept more instructions");
    }

    await this.runInstruction(text);
  }

  async resume(extraInstruction?: string): Promise<void> {
    if (this.task.task.status === "halted") {
      throw new Error("Task is halted and cannot be resumed");
    }

    if (extraInstruction) {
      this.appendConversationTurn("human", extraInstruction);
      this.pendingInstructions.push(extraInstruction);
    }

    this.setStatus("running");

    while (this.pendingInstructions.length > 0 && this.task.task.status === "running") {
      const nextInstruction = this.pendingInstructions.shift();
      if (!nextInstruction) {
        continue;
      }

      await this.runInstruction(nextInstruction);
    }
  }

  halt(reason: string): void {
    this.appendConversationTurn("system", `Manual halt: ${reason}`);
    this.task.task.haltedAt = this.now();
    this.setStatus("halted");
  }

  pause(reason = "Manual pause"): void {
    if (this.task.task.status === "halted" || this.task.task.status === "completed") {
      return;
    }

    this.appendConversationTurn("system", reason);
    this.setStatus("paused");
  }

  private async runInstruction(text: string): Promise<void> {
    const commands = parseActorInstruction(text);
    if (commands.length === 0) {
      return;
    }

    if (!this.task.task.startedAt) {
      this.task.task.startedAt = this.now();
    }
    this.setStatus("running");

    for (const command of commands) {
      if (this.task.task.status !== "running") {
        break;
      }

      const record = await this.executeCommand(command.tool, command.input);
      this.logs.push(record);
      this.options.onLog?.(record);

      const batch = this.batcher.add(record);
      if (batch) {
        await this.options.onBatch?.(batch);
      }
    }

    if (this.task.task.status === "running") {
      this.task.task.completedAt = this.now();
      this.setStatus("completed");
    }
  }

  private async executeCommand(
    tool: ToolExecutionRecord["tool"],
    input: string,
  ): Promise<ToolExecutionRecord> {
    const startedAt = this.now();
    const step = this.task.task.currentStep + 1;
    this.task.task.currentStep = step;

    try {
      const commandMetadata = this.getCommandMetadata(tool);
      const result =
        tool === "bash"
          ? await this.options.runner.run("sh", ["-lc", input], { cwd: this.options.cwd })
          : tool === "agent-browser"
            ? await this.options.runner.run(
              this.options.config.actor.browserRunner.command,
              [...this.options.config.actor.browserRunner.args, input],
              { cwd: this.options.cwd },
            )
            : await this.runCodingAgent(input);

      return {
        step,
        timestamp: startedAt,
        tool,
        input,
        output: parseCommandOutput(result.stdout, result.stderr),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        status: (result.exitCode ?? 0) === 0 ? "ok" : "error",
        error: result.stderr || undefined,
        screenshotRef: buildScreenshotRef(
          tool,
          input,
          startedAt,
          commandMetadata?.mode === "mock",
        ),
        metadata: {
          taskId: this.task.task.taskId,
          actorModel: this.task.task.actor.model,
          ...commandMetadata,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        step,
        timestamp: startedAt,
        tool,
        input,
        output: message,
        durationMs: 0,
        exitCode: null,
        status: "error",
        error: message,
        metadata: {
          taskId: this.task.task.taskId,
          actorModel: this.task.task.actor.model,
        },
      };
    } finally {
      this.task.task.lastUpdatedAt = this.now();
    }
  }

  private async runCodingAgent(input: string) {
    const provider = this.options.config.actor.codingAgent.provider;
    const command = this.options.config.actor.codingAgent.commands[provider];
    return this.options.runner.run(command.command, [...command.args, input], {
      cwd: this.options.cwd,
    });
  }

  private getCommandMetadata(
    tool: ToolExecutionRecord["tool"],
  ): Record<string, unknown> | undefined {
    if (tool === "agent-browser") {
      return this.options.config.actor.browserRunner.metadata;
    }

    if (tool === "coding-agent") {
      return this.options.config.actor.codingAgent.commands[
        this.options.config.actor.codingAgent.provider
      ].metadata;
    }

    return undefined;
  }

  private async handleSupervisorMessage(
    envelope: A2AEnvelope<A2AMessage>,
  ): Promise<void> {
    const text = envelope.payload.parts
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text)
      .join(" ");

    this.appendConversationTurn("supervisor", text || "Supervisor feedback received.");
    this.setStatus("paused");
  }

  private async handleCancelRequest(
    envelope: A2AEnvelope<CancelTaskRequest>,
  ): Promise<void> {
    this.appendConversationTurn("supervisor", `Supervisor halt: ${envelope.payload.reason}`);
    this.task.task.haltedAt = this.now();
    this.setStatus("halted");
  }

  private appendConversationTurn(
    role: ConversationTurn["role"],
    text: string,
  ): void {
    const turn = {
      id: `turn-${this.task.context.conversationHistory.length + 1}`,
      role,
      text,
      timestamp: this.now(),
    };
    this.task.context.conversationHistory.push(turn);
    this.task.task.lastUpdatedAt = this.now();
    this.options.onConversation?.(turn);
  }

  private setStatus(status: TaskStatus): void {
    this.task.task.status = status;
    this.task.task.lastUpdatedAt = this.now();
    this.options.onStatusChange?.(status);
  }
}

function parseCommandOutput(stdout: string, stderr: string): string | Record<string, unknown> {
  const text = stdout || stderr;
  if (text.length === 0) {
    return "";
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text;
  }
}

function buildScreenshotRef(
  tool: ToolExecutionRecord["tool"],
  input: string,
  timestamp: string,
  isMockCommand: boolean,
) {
  if (tool !== "agent-browser") {
    return undefined;
  }

  if (!/(screenshot|capture|snapshot)/i.test(input)) {
    return undefined;
  }

  return {
    id: `shot-${Date.now()}`,
    path: isMockCommand ? "./artifacts/mock-browser-shot.txt" : undefined,
    mimeType: "text/plain",
    capturedAt: timestamp,
  };
}
