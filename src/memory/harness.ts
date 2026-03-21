import { type LumoEventBus } from "../event/bus.js";
import { type LumoStoredEvent } from "../event/types.js";
import { type TaskSession } from "../runtime/session-manager.js";
import { reviewTaskSession } from "../supervisor/session-review.js";
import {
  buildMemoryScope,
  promoteLessonToSkill,
  selectRelevantMemory,
  shouldPromoteLesson,
} from "./promotion-policy.js";
import {
  type MemoryLessonRecord,
  type MemoryOutcomeRecord,
  type MemoryRetrievalRecord,
  type MemorySkillRecord,
  type RetrievedMemoryContext,
} from "./types.js";

const OUTCOME_TOPIC = "memory.outcomes";
const LESSON_TOPIC = "memory.lessons";
const SKILL_TOPIC = "memory.skills";
const RETRIEVAL_TOPIC = "memory.retrievals";

export class MemoryHarness {
  constructor(
    private readonly eventBus: LumoEventBus,
    private readonly now: () => string,
  ) {}

  async retrieveForInstruction(options: {
    taskId: string;
    sessionId?: string;
    instruction: string;
    appliedTo: MemoryRetrievalRecord["appliedTo"];
  }): Promise<RetrievedMemoryContext> {
    const now = this.now();
    const scope = buildMemoryScope(options.instruction);
    const [lessonEvents, skillEvents] = await Promise.all([
      this.eventBus.fetchRecent?.({ topic: LESSON_TOPIC, limit: 100 }) ?? Promise.resolve([]),
      this.eventBus.fetchRecent?.({ topic: SKILL_TOPIC, limit: 100 }) ?? Promise.resolve([]),
    ]);

    const lessons = lessonEvents
      .map((event) => parseLessonRecord(event))
      .filter((value): value is MemoryLessonRecord => value !== null);
    const skills = skillEvents
      .map((event) => parseSkillRecord(event))
      .filter((value): value is MemorySkillRecord => value !== null);
    const context = selectRelevantMemory({
      instruction: options.instruction,
      scope,
      lessons,
      skills,
      now,
    });

    if (context.lessons.length > 0 || context.skills.length > 0) {
      const retrievalRecord: MemoryRetrievalRecord = {
        retrievalId: `retrieval-${options.taskId}-${sanitizeTimestamp(now)}`,
        taskId: options.taskId,
        sessionId: options.sessionId,
        taskPattern: context.taskPattern,
        retrievedLessonIds: context.lessons.map((lesson) => lesson.lessonId),
        retrievedSkillIds: context.skills.map((skill) => skill.skillId),
        reason: `Auto-retrieved ${context.lessons.length} lesson(s) and ${context.skills.length} skill(s) for a similar task pattern.`,
        appliedAt: now,
        appliedTo: options.appliedTo,
      };
      await this.eventBus.publish({
        topic: RETRIEVAL_TOPIC,
        type: "memory.retrieval",
        source: "lumo.memory",
        idempotencyKey: retrievalRecord.retrievalId,
        payload: retrievalRecord as unknown as Record<string, unknown>,
      });
    }

    return context;
  }

  async reviewCompletedSession(options: {
    session: TaskSession;
    finalStatus: TaskSession["runtime"]["task"]["task"]["status"];
  }): Promise<void> {
    const reviewedAt = this.now();
    const { outcome, lessons } = reviewTaskSession({
      session: options.session,
      finalStatus: options.finalStatus,
      occurredAt: reviewedAt,
    });
    await this.publishOutcome(outcome);
    for (const lesson of lessons) {
      await this.publishLesson(lesson);
      await this.maybePromoteLesson(lesson, reviewedAt);
    }
  }

  private async publishOutcome(outcome: MemoryOutcomeRecord): Promise<void> {
    await this.eventBus.publish({
      topic: OUTCOME_TOPIC,
      type: "memory.outcome_recorded",
      source: "lumo.memory",
      idempotencyKey: outcome.outcomeId,
      payload: outcome as unknown as Record<string, unknown>,
    });
  }

  private async publishLesson(lesson: MemoryLessonRecord): Promise<void> {
    await this.eventBus.publish({
      topic: LESSON_TOPIC,
      type: "memory.retrospective_recorded",
      source: "lumo.memory",
      idempotencyKey: lesson.lessonId,
      payload: lesson as unknown as Record<string, unknown>,
    });
  }

  private async maybePromoteLesson(lesson: MemoryLessonRecord, now: string): Promise<void> {
    const [lessonEvents, skillEvents] = await Promise.all([
      this.eventBus.fetchRecent?.({ topic: LESSON_TOPIC, limit: 100 }) ?? Promise.resolve([]),
      this.eventBus.fetchRecent?.({ topic: SKILL_TOPIC, limit: 100 }) ?? Promise.resolve([]),
    ]);
    const relatedLessons = lessonEvents
      .map((event) => parseLessonRecord(event))
      .filter((value): value is MemoryLessonRecord => value !== null)
      .filter((candidate) =>
        candidate.lessonId !== lesson.lessonId
        && candidate.taskPattern === lesson.taskPattern
        && candidate.kind === lesson.kind
        && candidate.recommendedAction === lesson.recommendedAction,
      );
    if (!shouldPromoteLesson({ lesson, matchingLessons: relatedLessons })) {
      return;
    }
    const existingSkill = skillEvents
      .map((event) => parseSkillRecord(event))
      .find((candidate) =>
        candidate !== null
        && candidate.scope.taskPattern === lesson.scope.taskPattern
        && candidate.name === `${lesson.kind}:${lesson.taskPattern}`,
      ) ?? undefined;
    const skill = promoteLessonToSkill({
      lesson,
      relatedLessons,
      existingSkill,
      now,
    });
    await this.eventBus.publish({
      topic: SKILL_TOPIC,
      type: existingSkill ? "memory.skill_refreshed" : "memory.skill_promoted",
      source: "lumo.memory",
      idempotencyKey: `${skill.skillId}:${sanitizeTimestamp(now)}`,
      payload: skill as unknown as Record<string, unknown>,
    });
  }
}

function parseLessonRecord(event: LumoStoredEvent): MemoryLessonRecord | null {
  const payload = event.payload;
  if (typeof payload.lessonId !== "string" || typeof payload.recommendedAction !== "string") {
    return null;
  }
  return payload as unknown as MemoryLessonRecord;
}

function parseSkillRecord(event: LumoStoredEvent): MemorySkillRecord | null {
  const payload = event.payload;
  if (typeof payload.skillId !== "string" || !Array.isArray(payload.playbook)) {
    return null;
  }
  return payload as unknown as MemorySkillRecord;
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[^0-9]/g, "");
}
