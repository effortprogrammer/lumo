export type TaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "halted"
  | "completed"
  | "failed";

export type ActorToolName = "bash" | "agent-browser" | "coding-agent";
export type CodingAgentProvider = "codex" | "claude" | "opencode";

export interface ActorProfile {
  id: string;
  systemPrompt: string;
  tools: ActorToolName[];
}

export interface SupervisorProfile {
  id: string;
  model: string;
  systemPrompt: string;
  maxBatchSteps: number;
  maxBatchAgeMs: number;
}

export interface ConversationTurn {
  id: string;
  role: "human" | "actor" | "supervisor" | "system";
  text: string;
  timestamp: string;
}

export interface ScreenshotRef {
  id: string;
  mimeType?: string;
  path?: string;
  url?: string;
  capturedAt: string;
}

export type BrowserPageKind =
  | "homepage"
  | "search_results"
  | "job_listing"
  | "job_detail"
  | "login_wall"
  | "modal"
  | "article"
  | "unknown";

export interface BrowserStateSnapshot {
  url?: string;
  title?: string;
  pageKind: BrowserPageKind;
  domainTrust?: "high" | "medium" | "low";
  lastAction?: string;
  lastActionAt?: string;
  lastMeaningfulChangeAt?: string;
  extractedTextHints?: string[];
  screenshotRef?: ScreenshotRef;
  metadata?: Record<string, unknown>;
}

export interface BrowserProgressAssessment {
  state: "advancing" | "stalled" | "unclear";
  goalRelevance: "high" | "medium" | "low" | "unknown";
  sourceTrust?: "high" | "medium" | "low";
  reason: string;
  summary: string;
  recommendedNext?: string;
  observedAt: string;
}

export type RuntimeChildKind =
  | "coding-agent"
  | "browser"
  | "subprocess"
  | "sub-agent";

export interface RuntimeChildRef {
  kind: RuntimeChildKind;
  id?: string;
  name?: string;
}

export type RuntimeAnomalyKind =
  | "browser_stuck"
  | "unsupported_browser_path"
  | "repeated_action_loop"
  | "no_progress"
  | "retry_loop"
  | "hanging"
  | "timeout_escalated"
  | "objective_drift"
  | "child_unresponsive"
  | "child_exit_unexpected";

export type RuntimeAnomalySeverity = "warning" | "critical";

export interface RuntimeAnomalyEvidence {
  repeatedInput?: string;
  repeatedCount?: number;
  lastProgressAt?: string;
  stalledForMs?: number;
  retryCount?: number;
  childProcessName?: string;
  exitCode?: number | null;
  url?: string;
  screenshotRef?: ScreenshotRef;
  metadata?: Record<string, unknown>;
  child?: RuntimeChildRef;
}

export interface RuntimeAnomaly {
  id: string;
  kind: RuntimeAnomalyKind;
  severity: RuntimeAnomalySeverity;
  message: string;
  taskId: string;
  sessionId?: string;
  occurredAt: string;
  relatedStep?: number;
  relatedTool?: ActorToolName;
  evidence?: RuntimeAnomalyEvidence;
}

export interface TaskInstruction {
  id: string;
  text: string;
  createdAt: string;
}

export interface TaskContext {
  taskId: string;
  instruction: TaskInstruction;
  conversationHistory: ConversationTurn[];
}

export interface TaskLifecycle {
  taskId: string;
  actor: ActorProfile;
  supervisor: SupervisorProfile;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  haltedAt?: string;
  currentStep: number;
  lastUpdatedAt: string;
}

export interface ToolExecutionRecord {
  step: number;
  timestamp: string;
  tool: ActorToolName;
  input: string;
  output: string | Record<string, unknown>;
  durationMs: number;
  exitCode?: number | null;
  status?: "ok" | "error";
  error?: string;
  metadata?: Record<string, unknown>;
  screenshotRef?: ScreenshotRef;
  riskKeywords?: string[];
}

export interface TaskPairing {
  task: TaskLifecycle;
  context: TaskContext;
}
