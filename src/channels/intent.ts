export type IntentKind =
  | "start_task"
  | "followup"
  | "resume"
  | "halt"
  | "status"
  | "clarify";

export type IntentTaskRef = "current" | string | null;

export interface IntentEnvelope {
  intent: IntentKind;
  task_ref: IntentTaskRef;
  instruction: string;
  confidence: number;
  reason: string;
}

export function isIntentEnvelope(value: unknown): value is IntentEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<IntentEnvelope>;
  if (
    candidate.intent !== "start_task" &&
    candidate.intent !== "followup" &&
    candidate.intent !== "resume" &&
    candidate.intent !== "halt" &&
    candidate.intent !== "status" &&
    candidate.intent !== "clarify"
  ) {
    return false;
  }

  if (
    candidate.task_ref !== null &&
    candidate.task_ref !== "current" &&
    typeof candidate.task_ref !== "string"
  ) {
    return false;
  }

  return (
    typeof candidate.instruction === "string" &&
    typeof candidate.confidence === "number" &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    typeof candidate.reason === "string"
  );
}

export function normalizeIntentEnvelope(value: IntentEnvelope): IntentEnvelope {
  return {
    ...value,
    instruction: value.instruction.trim(),
    reason: value.reason.trim(),
    confidence: Math.max(0, Math.min(1, value.confidence)),
  };
}
