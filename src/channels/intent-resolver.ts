import { type TaskStatus } from "../domain/task.js";
import { type IntentEnvelope, isIntentEnvelope, normalizeIntentEnvelope } from "./intent.js";

export interface IntentResolverContext {
  hasActiveTask: boolean;
  currentTaskId: string | null;
  currentTaskStatus: TaskStatus | null;
}

export interface IntentResolver {
  resolve(text: string, context: IntentResolverContext): Promise<IntentEnvelope>;
}

export interface ModelIntentResolver {
  resolve(text: string, context: IntentResolverContext): Promise<IntentEnvelope>;
}

export interface IntentResolverPipelineOptions {
  commandMapping: {
    new: string[];
    followup: string[];
    resume: string[];
    halt: string[];
    status: string[];
  };
  modelResolver?: ModelIntentResolver;
  startTaskConfidenceThreshold?: number;
}

type RoutedCommand = "new" | "followup" | "resume" | "halt" | "status";

export class IntentResolverPipeline implements IntentResolver {
  private readonly modelResolver: ModelIntentResolver;
  private readonly startTaskConfidenceThreshold: number;

  constructor(private readonly options: IntentResolverPipelineOptions) {
    this.modelResolver = options.modelResolver ?? new MockModelIntentResolver();
    this.startTaskConfidenceThreshold = options.startTaskConfidenceThreshold ?? 0.7;
  }

  async resolve(text: string, context: IntentResolverContext): Promise<IntentEnvelope> {
    const ruleResult = resolveRuleBasedIntent(text, context, this.options.commandMapping);
    if (ruleResult) {
      return ruleResult;
    }

    const modelResult = await this.modelResolver.resolve(text, context);
    if (!isIntentEnvelope(modelResult)) {
      return clarify("I couldn't classify that request into the intent schema.");
    }

    const normalized = normalizeIntentEnvelope(modelResult);
    if (
      (normalized.intent === "start_task" || normalized.intent === "followup") &&
      normalized.confidence < this.startTaskConfidenceThreshold
    ) {
      return clarify(normalized.reason || "I need a clearer instruction before starting work.");
    }

    if (
      (normalized.intent === "start_task" || normalized.intent === "followup") &&
      normalized.instruction.length === 0
    ) {
      return clarify("Tell me what you want the task to do.");
    }

    return normalized;
  }
}

export class MockModelIntentResolver implements ModelIntentResolver {
  async resolve(text: string, context: IntentResolverContext): Promise<IntentEnvelope> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return clarify("Tell me what you want to do.");
    }

    if (isAmbiguousPrompt(trimmed)) {
      return clarify("That request is ambiguous. Say what task to start or which control action you want.");
    }

    if (
      context.hasActiveTask &&
      context.currentTaskStatus !== "halted" &&
      /^(also|next|then|and|follow up)\b/i.test(trimmed)
    ) {
      return {
        intent: "followup",
        task_ref: "current",
        instruction: trimmed,
        confidence: 0.82,
        reason: "Detected follow-up phrasing for the active task.",
      };
    }

    if (context.hasActiveTask && context.currentTaskStatus === "halted") {
      return {
        intent: "resume",
        task_ref: "current",
        instruction: trimmed,
        confidence: 0.9,
        reason: "The active task is halted, so treating the request as recovery guidance to resume with.",
      };
    }

    return {
      intent: "start_task",
      task_ref: null,
      instruction: trimmed,
      confidence: 0.9,
      reason: "Defaulted non-control natural language to a task start request.",
    };
  }
}

export function resolveRuleBasedIntent(
  text: string,
  context: IntentResolverContext,
  commandMapping: IntentResolverPipelineOptions["commandMapping"],
): IntentEnvelope | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return clarify("Tell me what you want to do.");
  }

  const aliasMatch = parseAliasCommand(trimmed, commandMapping);
  if (aliasMatch) {
    const instruction = aliasMatch.args.join(" ").trim();
    if ((aliasMatch.command === "new" || aliasMatch.command === "followup") && instruction.length === 0) {
      return clarify(`Tell me what you want to ${aliasMatch.command === "new" ? "start" : "send as a follow-up"}.`);
    }

    if (aliasMatch.command === "new") {
      return {
        intent: "start_task",
        task_ref: null,
        instruction,
        confidence: 0.99,
        reason: "Matched a backward-compatible start-task alias.",
      };
    }

    if (aliasMatch.command === "followup") {
      if (context.currentTaskStatus === "halted") {
        return {
          intent: "resume",
          task_ref: "current",
          instruction,
          confidence: 0.99,
          reason: "Matched a follow-up alias while the task is halted, so resuming with the new guidance.",
        };
      }

      return {
        intent: "followup",
        task_ref: "current",
        instruction,
        confidence: 0.99,
        reason: "Matched a backward-compatible follow-up alias.",
      };
    }

    if (aliasMatch.command === "resume") {
      return {
        intent: "resume",
        task_ref: "current",
        instruction,
        confidence: 0.99,
        reason: "Matched a backward-compatible resume alias.",
      };
    }

    if (aliasMatch.command === "halt") {
      return {
        intent: "halt",
        task_ref: "current",
        instruction,
        confidence: 0.99,
        reason: "Matched a backward-compatible halt alias.",
      };
    }

    return {
      intent: "status",
      task_ref: context.currentTaskId ?? "current",
      instruction: "",
      confidence: 0.99,
      reason: "Matched a backward-compatible status alias.",
    };
  }

  const statusPatterns = [
    /^(status|show status|show me the status)\??$/i,
    /^(what(?:'s| is) the status)\??$/i,
    /^(where are we at)\??$/i,
  ];
  if (statusPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      intent: "status",
      task_ref: context.currentTaskId ?? "current",
      instruction: "",
      confidence: 0.96,
      reason: "Matched a status control phrase.",
    };
  }

  const resumeMatch = trimmed.match(/^(resume|continue|carry on|pick (?:it )?back up)(?:\s+(.*))?$/i);
  if (resumeMatch) {
    return {
      intent: "resume",
      task_ref: "current",
      instruction: (resumeMatch[2] ?? "").trim(),
      confidence: 0.95,
      reason: "Matched a resume control phrase.",
    };
  }

  const haltMatch = trimmed.match(/^(halt|stop|cancel|abort)(?:\s+(.*))?$/i);
  if (haltMatch) {
    return {
      intent: "halt",
      task_ref: "current",
      instruction: (haltMatch[2] ?? "").trim(),
      confidence: 0.95,
      reason: "Matched a halt control phrase.",
    };
  }

  return null;
}

function parseAliasCommand(
  text: string,
  commandMapping: IntentResolverPipelineOptions["commandMapping"],
): { command: RoutedCommand; args: string[] } | null {
  const [head, ...args] = text.split(/\s+/);
  const lowered = head.toLowerCase();
  const match = (Object.entries(commandMapping) as Array<[RoutedCommand, string[]]>)
    .find(([, aliases]) => aliases.some((alias) => alias.toLowerCase() === lowered));

  if (!match) {
    return null;
  }

  return {
    command: match[0],
    args,
  };
}

function isAmbiguousPrompt(text: string): boolean {
  return /^(help|what now|go|do it|again|more|ok|okay|sure|yes|no|maybe)\??$/i.test(text);
}

function clarify(reason: string): IntentEnvelope {
  return {
    intent: "clarify",
    task_ref: null,
    instruction: "",
    confidence: 0.2,
    reason,
  };
}
