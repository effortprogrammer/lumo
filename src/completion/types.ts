export type ArtifactKind = "draft" | "summary" | "report" | "data" | "unknown";

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
}

export interface CompletionState {
  contract: CompletionContract;
  artifacts: ArtifactClaim[];
  satisfied: boolean;
  missingArtifactKinds: ArtifactKind[];
  lastSatisfiedAt?: string;
}
