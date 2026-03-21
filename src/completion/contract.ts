import { type ToolExecutionRecord } from "../domain/task.js";
import {
  type ArtifactClaim,
  type ArtifactKind,
  type CompletionContract,
  type CompletionState,
} from "./types.js";

export function inferCompletionContract(instruction: string): CompletionContract {
  const normalized = instruction.toLowerCase();
  const wantsDraft = /초안|draft|template|서식|양식/.test(normalized);
  const wantsSummary = /정리|summary|가이드|guide|전달|deliver|문서/.test(normalized);
  const requiredArtifactKinds: ArtifactKind[] = [];
  if (wantsDraft) {
    requiredArtifactKinds.push("draft");
  }
  if (wantsSummary) {
    requiredArtifactKinds.push("summary");
  }

  if (requiredArtifactKinds.length === 0) {
    return {
      requiresArtifacts: false,
      minimumArtifacts: 0,
      requiredArtifactKinds: [],
    };
  }

  return {
    requiresArtifacts: true,
    minimumArtifacts: requiredArtifactKinds.length,
    requiredArtifactKinds,
  };
}

export function createCompletionState(contract: CompletionContract): CompletionState {
  return {
    contract,
    artifacts: [],
    satisfied: !contract.requiresArtifacts,
    missingArtifactKinds: [...contract.requiredArtifactKinds],
  };
}

export function applyArtifactClaim(
  state: CompletionState,
  claim: ArtifactClaim,
): CompletionState {
  const artifacts = dedupeArtifacts([...state.artifacts, claim]);
  const kindsPresent = new Set(artifacts.map((artifact) => artifact.kind));
  const missingArtifactKinds = state.contract.requiredArtifactKinds.filter((kind) => !kindsPresent.has(kind));
  const satisfied = !state.contract.requiresArtifacts
    || (artifacts.length >= state.contract.minimumArtifacts && missingArtifactKinds.length === 0);
  return {
    ...state,
    artifacts,
    satisfied,
    missingArtifactKinds,
    lastSatisfiedAt: satisfied ? claim.createdAt : state.lastSatisfiedAt,
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
    return `Completion contract satisfied with ${state.artifacts.length} artifact(s).`;
  }
  if (!state.contract.requiresArtifacts) {
    return "No artifact contract is required for this task.";
  }
  return `Artifacts collected: ${state.artifacts.length}. Missing kinds: ${state.missingArtifactKinds.join(", ") || "none"}.`;
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
