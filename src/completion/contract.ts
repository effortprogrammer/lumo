import { type ToolExecutionRecord } from "../domain/task.js";
import {
  type ArtifactClaim,
  type ArtifactKind,
  type CompletionContract,
  type CompletionSignalKind,
  type CompletionState,
} from "./types.js";

export function inferCompletionContract(instruction: string): CompletionContract {
  const normalized = instruction.toLowerCase();
  const wantsDraft = /초안|draft|template|서식|양식/.test(normalized);
  const wantsSummaryResponse = /정리|summary|요약|explain|설명|알려줘|찾아줘/.test(normalized);
  const wantsSummaryArtifact = /가이드|guide|deliver|전달|문서|markdown|md 파일|txt 파일/.test(normalized);
  const wantsRecommendation = /추천|recommend|rank|비교|선택|판단|결론/.test(normalized);
  const wantsCodeChange = /fix|bug|implement|add|update|change|refactor|수정|구현|추가|리팩터/.test(normalized);
  const requiredArtifactKinds: ArtifactKind[] = [];
  const requiredSignals: CompletionSignalKind[] = [];
  if (wantsDraft) {
    requiredArtifactKinds.push("draft");
  }
  if (wantsSummaryArtifact || wantsDraft) {
    requiredArtifactKinds.push("summary");
  }
  if (wantsSummaryResponse && !wantsSummaryArtifact && !wantsDraft) {
    requiredSignals.push("summary_response");
  }
  if (wantsRecommendation) {
    requiredSignals.push("recommendation");
  }
  if (wantsCodeChange) {
    requiredSignals.push("code_change");
  }

  if (requiredArtifactKinds.length === 0 && requiredSignals.length === 0) {
    return {
      requiresArtifacts: false,
      minimumArtifacts: 0,
      requiredArtifactKinds: [],
      requiredSignals: [],
    };
  }

  return {
    requiresArtifacts: requiredArtifactKinds.length > 0,
    minimumArtifacts: requiredArtifactKinds.length,
    requiredArtifactKinds,
    requiredSignals: uniqueSignals(requiredSignals),
  };
}

export function createCompletionState(contract: CompletionContract): CompletionState {
  const missingArtifactKinds = [...contract.requiredArtifactKinds];
  const missingSignals = [...contract.requiredSignals];
  return {
    contract,
    artifacts: [],
    observedSignals: [],
    satisfied: false,
    missingArtifactKinds,
    missingSignals,
  };
}

export function applyArtifactClaim(
  state: CompletionState,
  claim: ArtifactClaim,
): CompletionState {
  const artifacts = dedupeArtifacts([...state.artifacts, claim]);
  const kindsPresent = new Set(artifacts.map((artifact) => artifact.kind));
  const missingArtifactKinds = state.contract.requiredArtifactKinds.filter((kind) => !kindsPresent.has(kind));
  const satisfied = computeSatisfied({
    contract: state.contract,
    artifacts,
    observedSignals: state.observedSignals,
    missingArtifactKinds,
    missingSignals: state.missingSignals,
  });
  return {
    ...state,
    artifacts,
    satisfied,
    missingArtifactKinds,
    missingSignals: [...state.missingSignals],
    lastSatisfiedAt: satisfied ? claim.createdAt : state.lastSatisfiedAt,
  };
}

export function applyCompletionSignal(
  state: CompletionState,
  signal: CompletionSignalKind,
  occurredAt: string,
): CompletionState {
  const observedSignals = uniqueSignals([...state.observedSignals, signal]);
  const missingSignals = state.contract.requiredSignals.filter((required) => !observedSignals.includes(required));
  const satisfied = computeSatisfied({
    contract: state.contract,
    artifacts: state.artifacts,
    observedSignals,
    missingArtifactKinds: state.missingArtifactKinds,
    missingSignals,
  });
  return {
    ...state,
    observedSignals,
    missingSignals,
    satisfied,
    lastSatisfiedAt: satisfied ? occurredAt : state.lastSatisfiedAt,
  };
}

export function extractArtifactClaim(record: ToolExecutionRecord): ArtifactClaim | undefined {
  if (record.tool !== "coding-agent" || record.status === "error") {
    return undefined;
  }
  const outputText = typeof record.output === "string" ? record.output : JSON.stringify(record.output);
  const path = readPathFromOutput(outputText) ?? readPathFromInput(record.input);
  if (!path) {
    return undefined;
  }
  return {
    path,
    kind: classifyArtifactKind(path),
    createdAt: record.timestamp,
    sourceTool: record.tool,
  };
}

export function summarizeCompletionState(state: CompletionState): string {
  if (state.satisfied) {
    return `Completion contract satisfied with ${state.artifacts.length} artifact(s) and ${state.observedSignals.length} signal(s).`;
  }
  if (!hasCompletionRequirements(state.contract)) {
    return "No explicit completion contract is inferred for this task yet.";
  }
  return `Artifacts collected: ${state.artifacts.length}. Missing kinds: ${state.missingArtifactKinds.join(", ") || "none"}. Missing signals: ${state.missingSignals.join(", ") || "none"}.`;
}

export function hasCompletionRequirements(contract: CompletionContract): boolean {
  return contract.requiredArtifactKinds.length > 0 || contract.requiredSignals.length > 0;
}

export function extractCompletionSignalsFromTool(record: ToolExecutionRecord): CompletionSignalKind[] {
  if (record.status === "error") {
    return [];
  }
  const outputText = typeof record.output === "string" ? record.output : JSON.stringify(record.output);
  if (record.tool === "coding-agent") {
    if (extractArtifactClaim(record)) {
      const path = readPathFromOutput(outputText) ?? readPathFromInput(record.input) ?? "";
      if (/\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|swift|kt|c|cpp|cs)$/i.test(path)) {
        return ["code_change"];
      }
    }
  }
  return [];
}

export function extractCompletionSignalsFromConversation(text: string): CompletionSignalKind[] {
  const normalized = text.toLowerCase();
  const signals: CompletionSignalKind[] = [];
  if (text.trim().length >= 120) {
    signals.push("summary_response");
  }
  if (/recommend|추천|결론|best option|therefore|따라서/.test(normalized)) {
    signals.push("recommendation");
  }
  return uniqueSignals(signals);
}

function readPathFromOutput(output: string): string | undefined {
  const match = output.match(/Successfully wrote \d+ bytes to (.+)$/m);
  return match?.[1]?.trim();
}

function readPathFromInput(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

function classifyArtifactKind(path: string): ArtifactKind {
  const normalized = path.toLowerCase();
  if (/초안|draft|template|form|양식/.test(normalized)) {
    return "draft";
  }
  if (/가이드|guide|summary|정리|요약/.test(normalized) || normalized.endsWith(".md")) {
    return "summary";
  }
  if (/report|보고서/.test(normalized)) {
    return "report";
  }
  if (/csv|json|xlsx|data/.test(normalized)) {
    return "data";
  }
  return "unknown";
}

function dedupeArtifacts(artifacts: ArtifactClaim[]): ArtifactClaim[] {
  const seen = new Set<string>();
  const result: ArtifactClaim[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.path}:${artifact.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(artifact);
  }
  return result;
}

function computeSatisfied(options: {
  contract: CompletionContract;
  artifacts: ArtifactClaim[];
  observedSignals: CompletionSignalKind[];
  missingArtifactKinds: ArtifactKind[];
  missingSignals: CompletionSignalKind[];
}): boolean {
  if (!hasCompletionRequirements(options.contract)) {
    return false;
  }
  const artifactSatisfied = !options.contract.requiresArtifacts
    || (options.artifacts.length >= options.contract.minimumArtifacts && options.missingArtifactKinds.length === 0);
  const signalSatisfied = options.missingSignals.length === 0;
  return artifactSatisfied && signalSatisfied;
}

function uniqueSignals(signals: CompletionSignalKind[]): CompletionSignalKind[] {
  return [...new Set(signals)];
}
