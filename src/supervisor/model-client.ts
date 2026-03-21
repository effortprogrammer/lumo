import {
  type SupervisorDecision,
  SupervisorDecisionSchema,
} from "./decision.js";
import { type SupervisorInputEnvelope } from "./contracts.js";
import { type LumoConfig } from "../config/load-config.js";
import { assessBottleneck } from "./bottleneck.js";
import { assessTaskPhase } from "./phase.js";

export interface SupervisorModelClient {
  decide(input: SupervisorInputEnvelope): Promise<SupervisorDecision>;
}

export class MockSupervisorClient implements SupervisorModelClient {
  constructor(
    private readonly factory:
      | SupervisorDecision
      | ((input: SupervisorInputEnvelope) => SupervisorDecision | Promise<SupervisorDecision>) = {
        status: "ok",
        confidence: 0.99,
        reason: "Mock supervisor allows execution to continue.",
        action: "continue",
      },
  ) {}

  async decide(input: SupervisorInputEnvelope): Promise<SupervisorDecision> {
    const candidate =
      typeof this.factory === "function" ? await this.factory(input) : this.factory;

    return SupervisorDecisionSchema.parse(candidate);
  }
}

export class HeuristicSupervisorClient implements SupervisorModelClient {
  async decide(input: SupervisorInputEnvelope): Promise<SupervisorDecision> {
    const lifecycleCooldown = assessLifecycleCooldown(input.recentLifecycleEvents);
    if (lifecycleCooldown) {
      return lifecycleCooldown;
    }

    const batch = {
      taskInstruction: input.taskInstruction,
      conversationHistory: input.conversationHistory,
      batch: input.recentLogs,
      recentLogs: input.recentLogs,
      anomalies: input.anomalies,
      browserState: input.browserState,
      browserProgress: input.browserProgress,
      triggeredBy: input.triggeredBy,
    };
    const recentLogs = batch.recentLogs ?? batch.batch;
    const memoryGuidance = buildMemoryGuidance(input);
    const taskPhase = input.taskPhase ?? assessTaskPhase({
      taskInstruction: batch.taskInstruction,
      browserState: batch.browserState,
      browserProgress: batch.browserProgress,
      recentLogs,
      collectionState: input.collectionState,
      completionState: input.completionState,
    });
    const latestLog = recentLogs.at(-1);
    if (
      taskPhase.currentPhase === "completed"
      && input.completionState?.contract.requiresArtifacts
      && input.completionState.satisfied
    ) {
      return {
        status: "ok",
        confidence: Math.max(taskPhase.confidence, 0.95),
        reason: "The completion contract is satisfied and the requested deliverables are ready.",
        suggestion: "Finalize the task and stop further browsing or drafting.",
        action: "complete",
      };
    }

    if (taskPhase.currentPhase === "verifying") {
      return {
        status: "warning",
        confidence: Math.max(taskPhase.confidence, 0.84),
        reason: taskPhase.recommendation?.reason ?? taskPhase.summary,
        suggestion: joinGuidance(taskPhase.recommendation?.instructions.join(" ") ?? "Verify the deliverables and finalize the task if complete.", memoryGuidance),
        action: "feedback",
      };
    }
    if (
      taskPhase.currentPhase === "requirement_extraction" &&
      taskPhase.recommendation?.targetPhase === "synthesis" &&
      latestLog?.status !== "error"
    ) {
        return {
          status: "warning",
          confidence: Math.max(taskPhase.confidence, 0.88),
          reason: taskPhase.recommendation.reason,
          suggestion: joinGuidance(taskPhase.recommendation.instructions.join(" "), memoryGuidance),
          action: "feedback",
        };
    }

    const bottleneck = assessBottleneck({
      anomalies: batch.anomalies,
      browserProgress: batch.browserProgress,
      browserState: batch.browserState,
      recentLogs,
      taskInstruction: batch.taskInstruction,
      taskPhase,
      collectionState: input.collectionState,
    });
    if (bottleneck) {
        return {
          status: bottleneck.severity,
          confidence: bottleneck.confidence,
          reason: bottleneck.diagnosis,
          suggestion: joinGuidance(bottleneck.recoveryPlan.instructions.join(" "), memoryGuidance),
          action: bottleneck.recoverable ? "feedback" : "halt",
        };
    }

    const latestAnomaly = [...batch.anomalies]
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .at(-1);
    if (latestAnomaly) {
        return {
          status: latestAnomaly.severity,
          confidence: latestAnomaly.severity === "critical" ? 0.97 : 0.82,
          reason: latestAnomaly.message,
          suggestion: joinGuidance(latestAnomaly.severity === "critical"
            ? "Stop the task and ask the operator to inspect the runtime anomaly."
            : "Adjust the strategy before continuing.", memoryGuidance),
          action: latestAnomaly.severity === "critical" ? "halt" : "feedback",
        };
    }

    const riskyRecord = batch.batch.find((record) => (record.riskKeywords?.length ?? 0) > 0);
    if (riskyRecord) {
        return {
          status: "critical",
          confidence: 0.95,
          reason: `Risk keyword detected in ${riskyRecord.tool} step ${riskyRecord.step}.`,
          suggestion: joinGuidance("Stop the task and request operator review.", memoryGuidance),
          action: "halt",
        };
    }

    const failedRecord = batch.batch.find(
      (record) => record.status === "error" || (record.exitCode ?? 0) !== 0,
    );
    if (failedRecord) {
      if (failedRecord.tool === "agent-browser" && batch.browserProgress) {
        return {
          status: "warning",
          confidence: 0.84,
          reason: batch.browserProgress.reason,
          suggestion: joinGuidance(batch.browserProgress.recommendedNext
            ?? "Inspect the current page state and retry with a more precise browser command.",
            memoryGuidance),
          action: "feedback",
        };
      }

      return {
        status: "warning",
        confidence: 0.8,
        reason: `Command failed in ${failedRecord.tool} step ${failedRecord.step}.`,
        suggestion: joinGuidance("Adjust the command or inspect stderr before continuing.", memoryGuidance),
        action: "feedback",
      };
    }

    const lastTwo = batch.batch.slice(-2);
    if (
      lastTwo.length === 2 &&
      lastTwo[0]?.tool === lastTwo[1]?.tool &&
      lastTwo[0]?.input === lastTwo[1]?.input
    ) {
      return {
        status: "warning",
        confidence: 0.7,
        reason: "Repeated tool input detected in consecutive steps.",
        suggestion: joinGuidance("Change strategy before repeating the same command again.", memoryGuidance),
        action: "feedback",
      };
    }

    return {
      status: "ok",
      confidence: 0.88,
      reason: "Recent actor activity looks consistent with the task.",
      action: "continue",
    };
  }
}

function buildMemoryGuidance(input: SupervisorInputEnvelope): string | undefined {
  const skillLine = input.priorSkills?.[0]?.playbook?.[0];
  const lessonLine = input.priorLessons?.[0]?.recommendedAction;
  const fragments = [skillLine, lessonLine].filter((value): value is string => Boolean(value));
  return fragments.length > 0 ? `Use relevant prior guidance: ${fragments.join(" ")}` : undefined;
}

function joinGuidance(base: string, guidance: string | undefined): string {
  return guidance ? `${base} ${guidance}` : base;
}

function assessLifecycleCooldown(
  events: SupervisorInputEnvelope["recentLifecycleEvents"],
): SupervisorDecision | null {
  if (!events?.length) {
    return null;
  }

  const issuedIds = new Set<string>();
  const resolvedIds = new Set<string>();
  for (const event of events) {
    const interventionId = readInterventionId(event.payload);
    if (!interventionId) {
      continue;
    }
    if (event.type === "supervisor.intervention.issued") {
      issuedIds.add(interventionId);
      continue;
    }
    if (
      event.type === "actor.intervention.result"
      || event.type === "supervisor.intervention.effect"
    ) {
      resolvedIds.add(interventionId);
    }
  }

  const pending = [...issuedIds].filter((id) => !resolvedIds.has(id));
  if (pending.length === 0) {
    return null;
  }

  return {
    status: "ok",
    confidence: 0.76,
    reason: `Waiting for the actor to finish applying recent supervisor intervention(s): ${pending.join(", ")}.`,
    action: "continue",
  };
}

function readInterventionId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.interventionId === "string"
    ? payload.interventionId
    : undefined;
}

export class OpenAICompatibleSupervisorClient implements SupervisorModelClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      systemPrompt: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async decide(input: SupervisorInputEnvelope): Promise<SupervisorDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15_000,
    );

    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        buildChatCompletionsUrl(this.options.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.options.model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: [
                  this.options.systemPrompt,
                  "Return strict JSON with keys: status, confidence, reason, suggestion, action.",
                  "status must be ok, warning, or critical. action must be continue, feedback, or halt.",
                ].join(" "),
              },
              {
                role: "user",
                content: JSON.stringify(input),
              },
            ],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `OpenAI-compatible supervisor request failed with HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
        );
      }

      const payload = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string | Array<{ type?: string; text?: string }>;
          };
        }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("")
        : content;

      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("OpenAI-compatible supervisor response did not include text content");
      }

      return SupervisorDecisionSchema.parse(parseJsonText(text));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class AnthropicCompatibleSupervisorClient implements SupervisorModelClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      systemPrompt: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async decide(input: SupervisorInputEnvelope): Promise<SupervisorDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 30_000,
    );

    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        buildAnthropicMessagesUrl(this.options.baseUrl),
        {
          method: "POST",
          headers: buildAnthropicHeaders(this.options.apiKey),
          body: JSON.stringify({
            model: this.options.model,
            max_tokens: 1024,
            system: [
              this.options.systemPrompt,
              "Return strict JSON only with keys: status, confidence, reason, suggestion, action.",
              "status must be ok, warning, or critical. action must be continue, feedback, or halt.",
            ].join(" "),
            messages: [
              {
                role: "user",
                content: JSON.stringify(input),
              },
            ],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Anthropic-compatible supervisor request failed with HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
        );
      }

      const payload = await response.json() as {
        content?: Array<{
          type?: string;
          text?: string;
        }>;
      };
      const text = payload.content
        ?.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      if (!text) {
        throw new Error("Anthropic-compatible supervisor response did not include text content");
      }

      return SupervisorDecisionSchema.parse(parseJsonText(text));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConfiguredSupervisorClient(config: LumoConfig): SupervisorModelClient {
  if (config.supervisor.client === "heuristic") {
    return new HeuristicSupervisorClient();
  }

  if (config.supervisor.client === "anthropic-compatible") {
    const anthropic = config.supervisor.anthropicCompatible;
    if (anthropic.enabled && anthropic.baseUrl && anthropic.apiKey && anthropic.model) {
      return new AnthropicCompatibleSupervisorClient({
        baseUrl: anthropic.baseUrl,
        apiKey: anthropic.apiKey,
        model: anthropic.model,
        systemPrompt: config.supervisor.systemPrompt,
        timeoutMs: anthropic.timeoutMs,
      });
    }

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

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/messages")
    ? trimmed
    : `${trimmed}/messages`;
}

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  return trimmed.toLowerCase().startsWith("bearer ")
    ? {
      authorization: trimmed,
      "content-type": "application/json",
    }
    : {
      "x-api-key": trimmed,
      "content-type": "application/json",
    };
}

function parseJsonText(text: string): unknown {
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

  return JSON.parse(trimmed);
}
