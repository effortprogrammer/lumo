export type ArtifactKind = "draft" | "summary" | "report" | "data" | "unknown";

export type CompletionSignalKind = "summary_response" | "recommendation" | "code_change";

export interface ArtifactClaim {
  path: string;
  kind: ArtifactKind;
  createdAt: string;
  sourceTool: "coding-agent" | "bash" | "agent-browser";
}

export interface CompletionContract {
  requiresArtifacts: boolean;
  minimumArtifacts: number;
  requiredArtifactKinds: ArtifactKind[];
  requiredSignals: CompletionSignalKind[];
}

export interface CompletionState {
  contract: CompletionContract;
  artifacts: ArtifactClaim[];
  observedSignals: CompletionSignalKind[];
  satisfied: boolean;
  missingArtifactKinds: ArtifactKind[];
  missingSignals: CompletionSignalKind[];
  lastSatisfiedAt?: string;
}
