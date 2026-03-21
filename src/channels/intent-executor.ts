import { type SessionRuntimeCallbacks, type SessionManager } from "../runtime/session-manager.js";
import { buildMemoryScope } from "../memory/promotion-policy.js";
import { type RetrievedMemoryContext } from "../memory/types.js";
import { type IntentEnvelope, type IntentTaskRef } from "./intent.js";

export interface ExecuteIntentOptions {
  sessionManager: SessionManager;
  createSessionCallbacks?: () => SessionRuntimeCallbacks | undefined;
  prepareTaskInstruction?: (instruction: string) => Promise<RetrievedMemoryContext | undefined>;
}

export async function executeIntentEnvelope(
  envelope: IntentEnvelope,
  options: ExecuteIntentOptions,
): Promise<string> {
  const currentStatus = options.sessionManager.current?.runtime.task.task.status;

  if (envelope.intent === "clarify") {
    return envelope.reason || "I need a clearer instruction.";
  }

  if (envelope.intent === "start_task") {
    if (envelope.instruction.length === 0) {
      return "Tell me what you want to start.";
    }

    const retrieved = await options.prepareTaskInstruction?.(envelope.instruction);
    const instruction = applyRetrievedGuidance(envelope.instruction, retrieved);

    options.sessionManager.createTask(
      instruction,
      options.createSessionCallbacks?.(),
    );
    return "Started a new task.";
  }

  if (envelope.intent === "status") {
    const current = options.sessionManager.current;
    if (!current) {
      return "No active task.";
    }

    const task = current.runtime.task.task;
    return `task=${task.taskId} status=${task.status} step=${task.currentStep}`;
  }

  assertTaskRef(options.sessionManager, envelope.task_ref);

  if (envelope.intent === "followup") {
    if (currentStatus === "halted") {
      await options.sessionManager.resume(envelope.instruction);
      return "Resumed the halted task with your recovery guidance.";
    }

    await options.sessionManager.followUp(envelope.instruction);
    return "Queued follow-up instruction.";
  }

  if (envelope.intent === "resume") {
    await options.sessionManager.resume(envelope.instruction || undefined);
    return envelope.instruction
      ? "Resumed task with additional instruction."
      : "Resumed task.";
  }

  if (envelope.intent === "halt") {
    options.sessionManager.halt(envelope.instruction || "halt requested from intent router");
    return "Halted current task.";
  }

  return "No active task.";
}

function applyRetrievedGuidance(
  instruction: string,
  retrieved: RetrievedMemoryContext | undefined,
): string {
  if (!retrieved || retrieved.guidanceLines.length === 0) {
    return instruction;
  }
  const scope = buildMemoryScope(instruction);
  return [
    instruction,
    "",
    "[Memory Harness Guidance]",
    `Task pattern: ${scope.taskPattern}`,
    ...retrieved.guidanceLines.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

function assertTaskRef(sessionManager: SessionManager, taskRef: IntentTaskRef): void {
  if (taskRef === null || taskRef === "current") {
    if (!sessionManager.current) {
      throw new Error("No active task");
    }
    return;
  }

  const currentTaskId = sessionManager.current?.runtime.task.task.taskId;
  if (!currentTaskId) {
    throw new Error("No active task");
  }

  if (currentTaskId !== taskRef) {
    throw new Error(`Task ${taskRef} is not active in this session`);
  }
}
