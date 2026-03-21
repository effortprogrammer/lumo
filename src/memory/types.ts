import { type TaskStatus } from "../domain/task.js";

export type MemoryOutcomeVerdict =
  | "success"
  | "assisted_success"
  | "safe_stop"
  | "blocked"
  | "failed"
  | "inconclusive";

export type MemoryLessonKind =
  | "task_pattern"
  | "recovery_pattern"
  | "anti_pattern";

export type MemorySkillStatus = "active" | "cooling" | "expired" | "demoted";

export interface MemoryScope {
  projectKey: string;
  taskPattern: string;
  host?: string;
}

export interface MemoryOutcomeRecord {
  outcomeId: string;
  sessionId: string;
  taskId: string;
  finalStatus: TaskStatus;
  verdict: MemoryOutcomeVerdict;
  confidence: number;
  reason: string;
  evidenceRefs: string[];
  judgedAt: string;
  judgedBy: "supervisor";
  taskPattern: string;
  scope: MemoryScope;
}

export interface MemoryLessonRecord {
  lessonId: string;
  sourceSessionId: string;
  taskId: string;
  kind: MemoryLessonKind;
  taskPattern: string;
  scope: MemoryScope;
  triggerSignals: string[];
  whatWorked?: string;
  whatFailed?: string;
  recommendedAction: string;
  avoidWhen: string[];
  confidence: number;
  freshness: string;
  tags: string[];
  evidenceRefs: string[];
  promotionCandidate: boolean;
}

export interface MemorySkillRecord {
  skillId: string;
  derivedFromLessonIds: string[];
  name: string;
  scope: MemoryScope;
  triggerConditions: string[];
  playbook: string[];
  confidence: number;
  repeatCount: number;
  successRate: number;
  lastAppliedAt: string;
  expiresAt: string;
  status: MemorySkillStatus;
  tags: string[];
}

export interface MemoryRetrievalRecord {
  retrievalId: string;
  taskId: string;
  sessionId?: string;
  taskPattern: string;
  retrievedLessonIds: string[];
  retrievedSkillIds: string[];
  reason: string;
  appliedAt: string;
  appliedTo: "task_start" | "supervisor_observation" | "bottleneck_recovery";
}

export interface RetrievedMemoryContext {
  taskPattern: string;
  lessons: MemoryLessonRecord[];
  skills: MemorySkillRecord[];
  guidanceLines: string[];
}
