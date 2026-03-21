import {
  type BrowserProgressAssessment,
  type BrowserStateSnapshot,
  type RuntimeAnomaly,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { assessTaskPhase, type TaskPhase, type TaskPhaseAssessment } from "./phase.js";

export type BottleneckKind =
  | "selector_ambiguity"
  | "missing_target"
  | "navigation_drift"
  | "research_without_synthesis"
  | "weak_source_churn"
  | "tool_failure_without_fallback"
  | "retry_loop"
  | "no_progress"
  | "browser_state_unclear"
  | "human_decision_required";

export type RecoveryAction =
  | "retry_with_refined_selector"
  | "refresh_browser_state"
  | "reconfirm_current_page"
  | "prefer_official_source"
  | "switch_to_extraction"
  | "switch_to_synthesis"
  | "switch_tool_or_strategy"
  | "pause_and_wait"
  | "halt_and_escalate"
  | "resume_with_guidance";

export interface RecoveryPlan {
  action: RecoveryAction;
  summary: string;
  instructions: string[];
  humanEscalationNeeded: boolean;
  maxAttempts?: number;
  targetPhase?: Exclude<TaskPhase, "blocked">;
}

export interface BottleneckAssessment {
  kind: BottleneckKind;
  severity: "warning" | "critical";
  confidence: number;
  summary: string;
  diagnosis: string;
  evidence: string[];
  recoverable: boolean;
  recoveryPlan: RecoveryPlan;
}

export interface BottleneckAssessmentContext {
  anomalies: RuntimeAnomaly[];
  browserProgress?: BrowserProgressAssessment;
  browserState?: BrowserStateSnapshot;
  recentLogs: ToolExecutionRecord[];
  taskInstruction: string;
  taskPhase?: TaskPhaseAssessment;
  collectionState?: {
    itemsCollected: number;
    distinctItems: number;
    fieldsSeen: string[];
    comparisonReady?: boolean;
    recommendationReady?: boolean;
  };
}

export function assessBottleneck(
  context: BottleneckAssessmentContext,
): BottleneckAssessment | undefined {
  const phase = context.taskPhase ?? assessTaskPhase({
    taskInstruction: context.taskInstruction,
    browserState: context.browserState,
    browserProgress: context.browserProgress,
    recentLogs: context.recentLogs,
  });
  const latestAnomaly = [...context.anomalies]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .at(-1);
  const browserReason = context.browserProgress?.reason?.toLowerCase() ?? "";
  const observationLoop = detectObservationLoop(context.recentLogs);
  const searchEngineSwitches = countWeakSearchEngineVisits(context.recentLogs);
  const collectionTask = isCollectionTask(context.taskInstruction.toLowerCase());
  const distinctCollectionItems = context.collectionState?.distinctItems ?? countDistinctCollectionItems(context.recentLogs);

  if (
    context.browserState?.pageKind === "search_results"
    && context.browserState.domainTrust === "low"
    && searchEngineSwitches >= 3
  ) {
    return {
      kind: "weak_source_churn",
      severity: "warning",
      confidence: 0.9,
      summary: "The actor is bouncing across weak search pages instead of converging on an authoritative source.",
      diagnosis: "Repeated visits to low-trust search domains suggest the task is stuck in search-engine churn.",
      evidence: [
        `Weak search visits detected: ${searchEngineSwitches}.`,
        context.browserState.url ? `Current URL: ${context.browserState.url}` : "Current page is a low-trust search result.",
      ],
      recoverable: true,
      recoveryPlan: {
        action: "prefer_official_source",
        summary: "Stop broad searching and navigate directly to the most authoritative likely source.",
        instructions: [
          "Stop rotating between search engines and generic aggregators.",
          "Identify the primary organization or institution behind the task.",
          "Navigate directly to the official domain or a government/documentation source before continuing.",
        ],
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "source_selection",
      },
    };
  }

  if (browserReason.includes("matched multiple elements")) {
    return {
      kind: "selector_ambiguity",
      severity: "warning",
      confidence: 0.91,
      summary: "Browser progress is blocked by an ambiguous selector.",
      diagnosis: context.browserProgress?.reason ?? "A browser selector matched multiple possible targets.",
      evidence: [
        context.browserProgress?.summary ?? "Browser execution stalled during a selector-based action.",
      ],
      recoverable: true,
      recoveryPlan: {
        action: "retry_with_refined_selector",
        summary: "Refresh the page map and retry with a unique selector or element ref.",
        instructions: [
          "Run snapshot to get updated refs for the current page.",
          "Choose a more specific selector or a unique element ref.",
          "Retry the browser action only after confirming the target is unique.",
        ],
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "source_selection",
      },
    };
  }

  if (browserReason.includes("could not be found") || browserReason.includes("not present")) {
    return {
      kind: "missing_target",
      severity: "warning",
      confidence: 0.88,
      summary: "Browser progress is blocked because the target element is missing.",
      diagnosis: context.browserProgress?.reason ?? "The expected browser target could not be found on the current page.",
      evidence: [
        context.browserProgress?.summary ?? "Browser execution stalled because the page target is missing.",
      ],
      recoverable: true,
      recoveryPlan: {
        action: "refresh_browser_state",
        summary: "Reconfirm the current page before selecting a new target.",
        instructions: [
          "Run get url and get title to confirm the current page.",
          "Run snapshot to refresh visible refs.",
          "Choose a selector that exists on the confirmed page.",
        ],
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "source_selection",
      },
    };
  }

  if (latestAnomaly?.kind === "retry_loop") {
    return {
      kind: "retry_loop",
      severity: "critical",
      confidence: 0.96,
      summary: "The actor is retrying the same failure pattern without recovering.",
      diagnosis: latestAnomaly.message,
      evidence: [
        `Retry count: ${latestAnomaly.evidence?.retryCount ?? "unknown"}`,
        latestAnomaly.evidence?.repeatedInput ? `Repeated input: ${latestAnomaly.evidence.repeatedInput}` : "Repeated failing action detected.",
      ],
      recoverable: false,
      recoveryPlan: {
        action: "halt_and_escalate",
        summary: "Stop the actor and request human guidance before resuming.",
        instructions: [
          "Stop the current execution path.",
          "Summarize the repeated failure to the operator.",
          "Resume only after receiving corrected guidance.",
        ],
        humanEscalationNeeded: true,
        maxAttempts: 1,
      },
    };
  }

  if (latestAnomaly?.kind === "unsupported_browser_path") {
    return {
      kind: "tool_failure_without_fallback",
      severity: "critical",
      confidence: 0.94,
      summary: "The actor attempted an unsupported browser execution path.",
      diagnosis: latestAnomaly.message,
      evidence: [
        "Internal browser/web tooling was used instead of the external agent-browser path.",
      ],
      recoverable: false,
      recoveryPlan: {
        action: "halt_and_escalate",
        summary: "Stop and re-run the browser work through the supported external browser tool.",
        instructions: [
          "Stop the current execution path.",
          "Reissue the browser work through the external agent-browser tool.",
          "Resume only after the supported browser path is confirmed.",
        ],
        humanEscalationNeeded: true,
        maxAttempts: 1,
      },
    };
  }

  if (
    phase.currentPhase === "requirement_extraction"
    && phase.recommendation?.targetPhase === "synthesis"
    && !(collectionTask && distinctCollectionItems < 3)
  ) {
    return {
      kind: "research_without_synthesis",
      severity: "warning",
      confidence: Math.max(phase.confidence, observationLoop ? 0.9 : 0.86),
      summary: "The actor reached relevant research pages but has not transitioned into extraction or writing.",
      diagnosis: phase.recommendation.reason,
      evidence: [
        ...phase.evidence,
        observationLoop ? "The actor is repeatedly checking page state (get url/get title/snapshot) instead of extracting content." : "No measurable progress was detected after reaching a relevant page.",
        context.browserProgress?.summary ?? "Recent browser work remained on relevant pages without producing the final artifact.",
      ],
      recoverable: true,
      recoveryPlan: {
        action: "switch_to_synthesis",
        summary: "Transition from browsing into extraction and writing.",
        instructions: phase.recommendation.instructions,
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "synthesis",
      },
    };
  }

  if (latestAnomaly?.kind === "no_progress") {
    return {
      kind: "no_progress",
      severity: "warning",
      confidence: 0.82,
      summary: "The actor is active but no meaningful progress is being observed.",
      diagnosis: latestAnomaly.message,
      evidence: [
        context.browserProgress?.summary ?? "Recent actions did not produce new meaningful state changes.",
      ],
      recoverable: true,
      recoveryPlan: {
        action: "refresh_browser_state",
        summary: "Reconfirm the current state before choosing the next action.",
        instructions: [
          "Check the current URL and title.",
          "Capture a fresh snapshot to confirm the visible state.",
          "Pick the next action only after the current state is clear.",
        ],
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "source_selection",
      },
    };
  }

  if (context.browserProgress?.state === "unclear") {
    if (
      phase.currentPhase === "requirement_extraction"
      && phase.recommendation?.targetPhase === "synthesis"
      && observationLoop
      && !(collectionTask && distinctCollectionItems < 3)
    ) {
      return {
        kind: "research_without_synthesis",
        severity: "warning",
        confidence: 0.84,
        summary: "The actor is staying in page-inspection mode on a relevant research page instead of switching to extraction or drafting.",
        diagnosis: phase.recommendation.reason,
        evidence: [
          ...phase.evidence,
          context.browserProgress.summary,
          "Recent browser commands were limited to state checks such as get url/get title/snapshot.",
        ],
        recoverable: true,
        recoveryPlan: {
          action: "switch_to_synthesis",
          summary: "Stop state-checking loops and begin extracting or drafting from the current page.",
          instructions: phase.recommendation.instructions,
          humanEscalationNeeded: false,
          maxAttempts: 1,
          targetPhase: "synthesis",
        },
      };
    }

    return {
      kind: "browser_state_unclear",
      severity: "warning",
      confidence: 0.78,
      summary: "The current browser state is too ambiguous to choose the next action safely.",
      diagnosis: context.browserProgress.reason,
      evidence: [
        context.browserProgress.summary,
      ],
      recoverable: true,
      recoveryPlan: {
        action: "reconfirm_current_page",
        summary: "Reconfirm the current page before continuing.",
        instructions: [
          "Run get url and get title.",
          "Capture a snapshot to inspect visible elements.",
          "Only continue after the page state is explicitly confirmed.",
        ],
        humanEscalationNeeded: false,
        maxAttempts: 1,
        targetPhase: "source_selection",
      },
    };
  }

  return undefined;
}
function isRelevantResearchPage(browserState: BrowserStateSnapshot | undefined): boolean {
  if (!browserState) {
    return false;
  }
  return browserState.pageKind === "job_listing"
    || browserState.pageKind === "job_detail"
    || browserState.pageKind === "search_results";
}

function detectObservationLoop(recentLogs: ToolExecutionRecord[]): boolean {
  const recentBrowserLogs = recentLogs
    .filter((record) => record.tool === "agent-browser")
    .slice(-4);
  if (recentBrowserLogs.length < 3) {
    return false;
  }

  return recentBrowserLogs.every((record) =>
    /^(get url|get title|snapshot)$/i.test(record.input.trim()),
  );
}

function countWeakSearchEngineVisits(recentLogs: ToolExecutionRecord[]): number {
  const urls = recentLogs
    .filter((record) => record.tool === "agent-browser")
    .map((record) => {
      const value = record.metadata?.url;
      return typeof value === "string" ? value.toLowerCase() : "";
    })
    .filter((url) => /(google|bing|naver|duckduckgo)\./.test(url));
  return new Set(urls).size;
}

function isCollectionTask(taskInstruction: string): boolean {
  return /가격|비교|정렬|추천|상품들|여러|목록|공고 몇|몇 개|collect|compare|rank|recommend/.test(taskInstruction);
}

function countDistinctCollectionItems(recentLogs: ToolExecutionRecord[]): number {
  const text = recentLogs
    .map((record) => `${record.input}\n${typeof record.output === "string" ? record.output : JSON.stringify(record.output)}`)
    .join("\n");

  const productMatches = [
    ...text.matchAll(/([가-힣A-Za-z0-9()\/\-\s]{4,80})\s*\n?\s*(?:상품금액\s*)?(\d{1,3}(?:,\d{3})+)\s*원/g),
  ];
  return new Set(productMatches.map((match) => `${match[1]?.trim()}|${match[2]}`)).size;
}
