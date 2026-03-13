import { type LogBatch } from "../logging/log-batcher.js";
import {
  type SupervisorDecision,
  SupervisorDecisionSchema,
} from "./decision.js";

export interface SupervisorModelClient {
  decide(batch: LogBatch): Promise<SupervisorDecision>;
}

export class MockSupervisorClient implements SupervisorModelClient {
  constructor(
    private readonly factory:
      | SupervisorDecision
      | ((batch: LogBatch) => SupervisorDecision | Promise<SupervisorDecision>) = {
        status: "ok",
        confidence: 0.99,
        reason: "Mock supervisor allows execution to continue.",
        action: "continue",
      },
  ) {}

  async decide(batch: LogBatch): Promise<SupervisorDecision> {
    const candidate =
      typeof this.factory === "function" ? await this.factory(batch) : this.factory;

    return SupervisorDecisionSchema.parse(candidate);
  }
}

export class HeuristicSupervisorClient implements SupervisorModelClient {
  async decide(batch: LogBatch): Promise<SupervisorDecision> {
    const riskyRecord = batch.batch.find((record) => (record.riskKeywords?.length ?? 0) > 0);
    if (riskyRecord) {
      return {
        status: "critical",
        confidence: 0.95,
        reason: `Risk keyword detected in ${riskyRecord.tool} step ${riskyRecord.step}.`,
        suggestion: "Stop the task and request operator review.",
        action: "halt",
      };
    }

    const failedRecord = batch.batch.find(
      (record) => record.status === "error" || (record.exitCode ?? 0) !== 0,
    );
    if (failedRecord) {
      return {
        status: "warning",
        confidence: 0.8,
        reason: `Command failed in ${failedRecord.tool} step ${failedRecord.step}.`,
        suggestion: "Adjust the command or inspect stderr before continuing.",
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
        suggestion: "Change strategy before repeating the same command again.",
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

  async decide(batch: LogBatch): Promise<SupervisorDecision> {
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
                content: JSON.stringify({
                  taskInstruction: batch.taskInstruction,
                  triggeredBy: batch.triggeredBy,
                  conversationHistory: batch.conversationHistory,
                  batch: batch.batch,
                }),
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

      return SupervisorDecisionSchema.parse(JSON.parse(text));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}
