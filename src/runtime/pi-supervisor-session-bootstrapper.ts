import {
  type SupervisorFeedbackMessage,
  type SupervisorHaltMessage,
} from "../a2a/protocol.js";
import { type PiMonoRuntimeClient } from "./runtime-session-adapter.js";
import {
  type SupervisorInterventionListenerRequest,
  type SupervisorSessionInterventionSubscriber,
  type SupervisorSessionProgressDeliverer,
  type SupervisorSessionProgressDeliveryRequest,
  type SupervisorSessionBootstrapRequest,
  type SupervisorSessionBootstrapResult,
  type SupervisorSessionBootstrapper,
} from "./supervisor-session-bootstrap.js";

export interface PiSupervisorSessionBootstrapperOptions {
  client: Pick<PiMonoRuntimeClient, "isAvailable" | "createSession" | "sendInput" | "subscribe">;
  now?: () => string;
}

export class PiSupervisorSessionBootstrapper implements
  SupervisorSessionBootstrapper,
  SupervisorSessionProgressDeliverer,
  SupervisorSessionInterventionSubscriber
{
  private readonly now: () => string;

  constructor(private readonly options: PiSupervisorSessionBootstrapperOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async bootstrap(
    request: SupervisorSessionBootstrapRequest,
  ): Promise<SupervisorSessionBootstrapResult> {
    if (!this.options.client.isAvailable()) {
      return {
        mode: "separate_session",
        status: "failed",
        bootstrappedAt: this.now(),
        metadata: {
          error: "pi supervisor runtime is unavailable",
        },
      };
    }

    const created = this.options.client.createSession({
      sessionId: `supervisor-${request.taskId}`,
      instruction: buildSupervisorBootstrapInstruction(request),
    });
    await this.options.client.sendInput(
      created.externalSessionId,
      buildSupervisorBootstrapInstruction(request),
      {
        role: "system",
        deliverAs: "prompt",
        echoConversation: false,
      },
    );

    return {
      mode: "separate_session",
      sessionId: created.externalSessionId,
      status: "ready",
      bootstrappedAt: request.occurredAt,
      metadata: {
        pairId: request.pairId,
        taskId: request.taskId,
        actorAgentId: request.actorAgentId,
        supervisorAgentId: request.supervisorAgentId,
        bootstrap: "pi-supervisor-session",
      },
    };
  }

  async deliverProgress(
    request: SupervisorSessionProgressDeliveryRequest,
  ): Promise<void> {
    debugSupervisorA2A("deliver-progress", {
      supervisorSessionId: request.supervisorSessionId,
      pairId: request.pairId,
      taskId: request.taskId,
      hasProgress: Boolean(request.progress),
      hasAck: Boolean(request.ack),
      hasResult: Boolean(request.result),
      hasInput: Boolean(request.input),
    });
    await this.options.client.sendInput(
      request.supervisorSessionId,
      buildSupervisorProgressDeliveryMessage(request),
      {
        role: "actor",
        deliverAs: "prompt",
        echoConversation: false,
      },
    );
  }

  attachInterventionListener(
    request: SupervisorInterventionListenerRequest,
  ): () => void {
    return this.options.client.subscribe(request.supervisorSessionId, (event) => {
      if (event.type !== "conversation.turn") {
        return;
      }

      const text = event.turn.text.trim();
      debugSupervisorA2A("supervisor-turn", {
        supervisorSessionId: request.supervisorSessionId,
        text,
      });
      const structured = parseStructuredSupervisorIntervention(text);
      if (structured?.type === "supervisor-feedback") {
        request.onFeedback(structured);
        return;
      }
      if (structured?.type === "supervisor-halt") {
        request.onHalt(structured);
      }
    });
  }
}

function buildSupervisorBootstrapInstruction(
  request: SupervisorSessionBootstrapRequest,
): string {
  return [
    "You are the dedicated supervisor for a paired actor session.",
    `Task: ${request.instruction}`,
    `Actor agent id: ${request.actorAgentId}.`,
    `Supervisor agent id: ${request.supervisorAgentId}.`,
    "Your job is to supervise the actor, not to perform the task yourself and not to amplify the actor's local loops.",
    "Prefer interventions that break loops, reduce ambiguity, force synthesis/extraction when browsing has stalled, or halt unsafe behavior.",
    "Do not repeat the actor's current behavior if that behavior appears stalled, repetitive, or low-yield.",
    "Treat repeated get title/get url/snapshot style checks as a sign of being stuck unless the task explicitly requires a one-off verification step.",
    "If the actor is looping, your feedback must change strategy rather than reinforce the same loop.",
    "Do not interpret 'keep checking repeatedly' as permission to endorse an infinite loop. Supervisory policy overrides literal repetition.",
    "When the actor already has enough context, push it toward extraction, synthesis, or a concrete next action.",
    "When intervention is required, emit exactly one JSON object and nothing else. No markdown. No prose before or after the JSON.",
    "When no intervention is required, remain silent.",
    "Recent lifecycle events from the orchestrator are authoritative context. Use them to avoid repeating the same intervention before the actor has had a chance to apply it.",
    "When you emit supervisor-feedback, the instructions must be actionable and should move the actor away from the current stall pattern.",
    "Only include targetPhase when you are explicitly directing a phase transition. Do not set targetPhase to synthesis for simple browser refresh or page-confirmation steps.",
    "Prefer targetPhase=source_selection for page re-orientation and targetPhase=synthesis only when the actor should stop browsing and start drafting/extracting.",
    "When you emit supervisor-halt, reserve it for unsafe, unrecoverable, or human-required situations.",
    "Allowed response shapes:",
    "{\"type\":\"supervisor-feedback\",\"decision\":{\"status\":\"warning\",\"confidence\":0.0,\"reason\":\"...\",\"suggestion\":\"...\",\"action\":\"feedback\"},\"instructions\":[\"...\"],\"targetPhase\":\"source_selection\"}",
    "{\"type\":\"supervisor-halt\",\"decision\":{\"status\":\"critical\",\"confidence\":0.0,\"reason\":\"...\",\"suggestion\":\"...\",\"action\":\"halt\"},\"humanActionNeeded\":true,\"recoverySummary\":\"...\"}",
    "Bad intervention example: telling the actor to continue the same get title/get url loop.",
    "Good intervention example: telling the actor to stop looping, re-orient on the current page once, then either extract from it or switch to synthesis when enough context exists.",
    "Do not emit plain text directives like SUPERVISOR_FEEDBACK unless JSON output is impossible.",
  ].join(" ");
}

function buildSupervisorProgressDeliveryMessage(
  request: SupervisorSessionProgressDeliveryRequest,
): string {
  const payload = request.input
    ?? request.result
    ?? request.ack
    ?? request.progress
    ?? {};
  const recentLifecycleEvents = request.input?.recentLifecycleEvents?.map((event) => ({
    type: event.type,
    source: event.source,
    interventionId: typeof event.payload.interventionId === "string"
      ? event.payload.interventionId
      : undefined,
    timestamp: event.timestamp,
  })) ?? [];
  const recentActorProgressEvents = request.input?.recentActorProgressEvents?.map((event) => ({
    progressId: event.progressId,
    sequence: event.sequence,
    summary: event.summary,
    currentStep: event.currentStep,
    currentStatus: event.currentStatus,
    collectionState: event.collectionState,
    taskPhase: event.taskPhase?.currentPhase,
  })) ?? [];
  return [
    "Actor progress update. Evaluate this update now.",
    "You are evaluating whether the actor is progressing, stuck, looping, or unsafe.",
    "If intervention is required, respond immediately with exactly one JSON object and nothing else.",
    "Use a supervisor-feedback JSON object for recoverable issues.",
    "Use a supervisor-halt JSON object when the actor must stop.",
    "If no intervention is required yet, remain silent.",
    "If recent lifecycle events show that an intervention was already issued and has not settled yet, prefer waiting over issuing a duplicate intervention.",
    "If the actor is repeating the same low-yield browser checks, do not tell it to continue repeating them.",
    "When the actor needs to re-check the page once before moving on, prefer a source_selection-style recovery rather than synthesis.",
    "If the actor already has enough context, push it toward extraction or synthesis instead of more observation.",
    recentLifecycleEvents.length > 0
      ? `Recent lifecycle events: ${JSON.stringify(recentLifecycleEvents)}`
      : "Recent lifecycle events: []",
    recentActorProgressEvents.length > 0
      ? `Recent actor progress events: ${JSON.stringify(recentActorProgressEvents)}`
      : "Recent actor progress events: []",
    JSON.stringify({
      pairId: request.pairId,
      taskId: request.taskId,
      progress: request.progress,
      ack: request.ack,
      result: request.result,
      input: payload,
    }),
  ].join(" ");
}

function parseStructuredSupervisorIntervention(
  text: string,
): SupervisorFeedbackMessage | SupervisorHaltMessage | null {
  const parsedJson = parseJsonObject(text);
  if (isSupervisorFeedbackMessage(parsedJson)) {
    return parsedJson;
  }
  if (isSupervisorHaltMessage(parsedJson)) {
    return parsedJson;
  }

  if (text.startsWith("SUPERVISOR_FEEDBACK:")) {
    return {
      type: "supervisor-feedback",
      interventionId: `feedback-${Date.now()}`,
      decision: {
        status: "warning",
        confidence: 0.9,
        reason: text.slice("SUPERVISOR_FEEDBACK:".length).trim(),
        action: "feedback",
      },
    };
  }

  if (text.startsWith("SUPERVISOR_HALT:")) {
    return {
      type: "supervisor-halt",
      interventionId: `halt-${Date.now()}`,
      decision: {
        status: "critical",
        confidence: 0.95,
        reason: text.slice("SUPERVISOR_HALT:".length).trim(),
        action: "halt",
      },
      humanActionNeeded: true,
    };
  }

  debugSupervisorA2A("parse-miss", {
    text,
  });
  return null;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    const body = lines.slice(1, lines.at(-1)?.startsWith("```") ? -1 : undefined).join("\n").trim();
    candidates.push(body);
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function isSupervisorFeedbackMessage(value: unknown): value is SupervisorFeedbackMessage {
  return isRecord(value)
    && value.type === "supervisor-feedback"
    && isRecord(value.decision)
    && value.decision.action === "feedback";
}

function isSupervisorHaltMessage(value: unknown): value is SupervisorHaltMessage {
  return isRecord(value)
    && value.type === "supervisor-halt"
    && isRecord(value.decision)
    && value.decision.action === "halt"
    && typeof value.humanActionNeeded === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function debugSupervisorA2A(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (process.env.LUMO_DEBUG_SUPERVISOR_A2A !== "1") {
    return;
  }

  console.error(`[lumo supervisor a2a] ${event} ${JSON.stringify(payload)}`);
}
