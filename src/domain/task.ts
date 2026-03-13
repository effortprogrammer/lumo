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
  model: string;
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
