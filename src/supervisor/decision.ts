export type SupervisorStatus = "ok" | "warning" | "critical";
export type SupervisorAction = "continue" | "feedback" | "halt";

export interface SupervisorDecision {
  status: SupervisorStatus;
  confidence: number;
  reason: string;
  suggestion?: string;
  action: SupervisorAction;
}

export const SupervisorDecisionSchema = {
  parse(value: unknown): SupervisorDecision {
    if (!isRecord(value)) {
      throw new Error("Supervisor decision must be an object");
    }

    const { status, confidence, reason, suggestion, action } = value;
    if (status !== "ok" && status !== "warning" && status !== "critical") {
      throw new Error("Supervisor decision status must be ok, warning, or critical");
    }

    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new Error("Supervisor decision confidence must be between 0 and 1");
    }

    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error("Supervisor decision reason must be a non-empty string");
    }

    if (
      suggestion !== undefined &&
      (typeof suggestion !== "string" || suggestion.trim().length === 0)
    ) {
      throw new Error("Supervisor decision suggestion must be a non-empty string");
    }

    if (action !== "continue" && action !== "feedback" && action !== "halt") {
      throw new Error(
        "Supervisor decision action must be continue, feedback, or halt",
      );
    }

    if (status === "ok" && action !== "continue") {
      throw new Error('Status "ok" must use action "continue"');
    }

    if (status === "critical" && action === "continue") {
      throw new Error('Status "critical" cannot use action "continue"');
    }

    return {
      status,
      confidence,
      reason,
      suggestion,
      action,
    };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
