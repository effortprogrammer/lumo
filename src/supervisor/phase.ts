import {
  type BrowserProgressAssessment,
  type BrowserStateSnapshot,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type CompletionState } from "../completion/types.js";

export type TaskPhase =
  | "searching"
  | "source_selection"
  | "requirement_extraction"
  | "synthesis"
  | "artifact_drafting"
  | "verifying"
  | "completed"
  | "blocked";

export interface PhaseTransitionRecommendation {
  targetPhase: Exclude<TaskPhase, "blocked">;
  reason: string;
  instructions: string[];
}

export interface TaskPhaseAssessment {
  currentPhase: TaskPhase;
  confidence: number;
  summary: string;
  evidence: string[];
  recommendation?: PhaseTransitionRecommendation;
}

export interface TaskPhaseAssessmentContext {
  taskInstruction: string;
  browserState?: BrowserStateSnapshot;
  browserProgress?: BrowserProgressAssessment;
  recentLogs: ToolExecutionRecord[];
  collectionState?: {
    itemsCollected: number;
    distinctItems: number;
    fieldsSeen: string[];
    comparisonReady?: boolean;
    recommendationReady?: boolean;
  };
  completionState?: CompletionState;
}

export function assessTaskPhase(
  context: TaskPhaseAssessmentContext,
): TaskPhaseAssessment {
  const latestLog = context.recentLogs.at(-1);
  const normalizedTask = context.taskInstruction.toLowerCase();
  const wantsArtifact = /resume|cv|이력서|draft|초안|정리|deliver|전달/.test(normalizedTask);
  const wantsCollection = isCollectionTask(normalizedTask);
  const browserLogs = context.recentLogs.filter((record) => record.tool === "agent-browser");
  const codingLogs = context.recentLogs.filter((record) => record.tool === "coding-agent");
  const latestBrowser = browserLogs.at(-1);
  const hasEnoughResearchSignals = browserLogs.length >= 4;
  const distinctCollectionItems = countDistinctCollectionItems(context.recentLogs);

  if (context.completionState?.contract.requiresArtifacts && context.completionState.satisfied) {
    return {
      currentPhase: "completed",
      confidence: 0.96,
      summary: "The requested deliverables were produced and the completion contract is satisfied.",
      evidence: [
        `Artifacts produced: ${context.completionState.artifacts.length}.`,
        ...context.completionState.artifacts.map((artifact) => `Artifact: ${artifact.path}`),
      ].slice(0, 4),
    };
  }

  if (latestLog?.status === "error" || context.browserProgress?.state === "stalled") {
    return {
      currentPhase: "blocked",
      confidence: 0.88,
      summary: "The task is currently blocked on a failed or stalled step.",
      evidence: [
        latestLog?.input ? `Latest failing step: ${latestLog.input}` : "A recent step failed or stalled.",
        context.browserProgress?.reason ?? "The current page flow is not advancing.",
      ].filter(Boolean),
    };
  }

  if (codingLogs.length > 0 && wantsArtifact) {
    if (context.completionState?.contract.requiresArtifacts && (context.completionState.artifacts.length ?? 0) > 0) {
      return {
        currentPhase: "verifying",
        confidence: 0.84,
        summary: "The actor has already produced artifacts and should verify deliverable completeness instead of continuing broad research.",
        evidence: context.completionState?.artifacts.map((artifact) => `Artifact: ${artifact.path}`) ?? [],
        recommendation: {
          targetPhase: "synthesis",
          reason: "The task has deliverables on disk and should now verify completion criteria before stopping.",
          instructions: [
            "Stop broad browsing and verify the requested deliverables against the original task.",
            `Confirm whether the completion contract is satisfied. Missing kinds: ${context.completionState?.missingArtifactKinds.join(", ") || "none"}.`,
            "If the contract is satisfied, finalize the task instead of continuing research.",
          ],
        },
      };
    }
    return {
      currentPhase: "artifact_drafting",
      confidence: 0.86,
      summary: "The actor has moved into drafting the requested deliverable.",
      evidence: [
        `Recent coding-agent step: ${codingLogs.at(-1)?.input ?? "drafting output"}`,
      ],
    };
  }

  if (
    wantsCollection
    && (context.collectionState?.distinctItems ?? distinctCollectionItems) < 3
    && isRelevantResearchPage(context.browserState)
  ) {
    return {
      currentPhase: "source_selection",
      confidence: 0.83,
      summary: "The actor is still collecting enough distinct items before ranking or recommending.",
      evidence: [
        `Distinct collection signals seen so far: ${context.collectionState?.distinctItems ?? distinctCollectionItems}.`,
        context.browserState?.title ? `Current page: ${context.browserState.title}` : "Relevant listing page detected.",
      ],
    };
  }

  if (isRelevantResearchPage(context.browserState) && wantsArtifact && (isObservationHeavy(browserLogs) || hasEnoughResearchSignals)) {
    return {
      currentPhase: "requirement_extraction",
      confidence: hasEnoughResearchSignals ? 0.87 : 0.82,
      summary: hasEnoughResearchSignals
        ? "The actor has already gathered enough browsing context and should move into extraction and synthesis."
        : "The actor is repeatedly inspecting a relevant source page instead of moving into synthesis.",
      evidence: [
        context.browserState?.title ? `Current page: ${context.browserState.title}` : "Relevant source page detected.",
        hasEnoughResearchSignals
          ? `Recent browser steps (${browserLogs.length}) indicate the actor has already explored the relevant sources.`
          : "Recent browser steps are dominated by get url / get title / snapshot checks.",
      ],
      recommendation: {
        targetPhase: "synthesis",
        reason: "The task already reached a relevant source page and should now extract role requirements before drafting.",
        instructions: [
          "Stop broad navigation and use the current page as the primary source.",
          "Extract the required skills, responsibilities, and qualifications from the current page.",
          "Switch to synthesis and prepare the requested resume draft.",
        ],
      },
    };
  }

  if (context.browserState?.pageKind === "job_detail") {
    return {
      currentPhase: "requirement_extraction",
      confidence: 0.84,
      summary: "The actor is on a detailed job page and should extract requirements from it.",
      evidence: [
        context.browserState.title ? `Job detail page: ${context.browserState.title}` : "Job detail page detected.",
      ],
      recommendation: wantsArtifact
        ? {
          targetPhase: "synthesis",
          reason: "Once the role requirements are extracted, the task should transition into resume synthesis.",
          instructions: [
            "Extract the requirements from the current page.",
            "Summarize the capabilities needed for the role.",
            "Draft the requested resume once the requirements are captured.",
          ],
        }
        : undefined,
    };
  }

  if (context.browserState?.pageKind === "job_listing" || context.browserState?.pageKind === "search_results") {
    return {
      currentPhase: "source_selection",
      confidence: 0.82,
      summary: "The actor is still choosing the most relevant source page.",
      evidence: [
        latestBrowser?.input ? `Recent browser step: ${latestBrowser.input}` : "The actor is browsing search or listing pages.",
      ],
    };
  }

  return {
    currentPhase: browserLogs.length > 0 ? "searching" : "synthesis",
    confidence: 0.7,
    summary: browserLogs.length > 0
      ? "The actor is still searching for the right source material."
      : "The actor appears to be reasoning without an active browser flow.",
    evidence: [
      latestLog?.input ? `Latest step: ${latestLog.input}` : "No recent step details available.",
    ],
  };
}

function isRelevantResearchPage(browserState: BrowserStateSnapshot | undefined): boolean {
  if (!browserState) {
    return false;
  }
  return browserState.pageKind === "job_listing"
    || browserState.pageKind === "job_detail"
    || browserState.pageKind === "search_results";
}

function isObservationHeavy(browserLogs: ToolExecutionRecord[]): boolean {
  const recent = browserLogs.slice(-4);
  if (recent.length < 3) {
    return false;
  }
  return recent.every((record) => /^(get url|get title|snapshot)$/i.test(record.input.trim()));
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
  const distinct = new Set(
    productMatches.map((match) => `${match[1]?.trim()}|${match[2]}`),
  );

  return distinct.size;
}
