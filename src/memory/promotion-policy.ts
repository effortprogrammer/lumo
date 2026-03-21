import {
  type MemoryLessonRecord,
  type MemoryScope,
  type MemorySkillRecord,
  type RetrievedMemoryContext,
} from "./types.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "into",
  "on",
  "or",
  "of",
  "the",
  "to",
  "with",
  "in",
  "at",
  "by",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "then",
  "than",
]);

export function deriveTaskPattern(instruction: string): string {
  const tokens = tokenize(instruction);
  return tokens.slice(0, 6).join(" ") || "general_task";
}

export function buildMemoryScope(instruction: string, cwd = process.cwd()): MemoryScope {
  return {
    projectKey: cwd,
    taskPattern: deriveTaskPattern(instruction),
    host: extractHost(instruction),
  };
}

export function selectRelevantMemory(options: {
  instruction: string;
  scope: MemoryScope;
  lessons: MemoryLessonRecord[];
  skills: MemorySkillRecord[];
  now: string;
}): RetrievedMemoryContext {
  const lessonMatches = options.lessons
    .map((lesson) => ({
      lesson,
      score: scoreLesson(options.instruction, options.scope, lesson, options.now),
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.lesson);

  const skillMatches = options.skills
    .map((skill) => ({
      skill,
      score: scoreSkill(options.instruction, options.scope, skill, options.now),
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((entry) => entry.skill);

  const guidanceLines = [
    ...skillMatches.flatMap((skill) =>
      skill.playbook.slice(0, 2).map((line) => `Skill ${skill.name}: ${line}`),
    ),
    ...lessonMatches.slice(0, 2).map((lesson) =>
      `Lesson ${lesson.kind}: ${lesson.recommendedAction}`),
  ].slice(0, 4);

  return {
    taskPattern: options.scope.taskPattern,
    lessons: lessonMatches,
    skills: skillMatches,
    guidanceLines,
  };
}

export function shouldPromoteLesson(options: {
  lesson: MemoryLessonRecord;
  matchingLessons: MemoryLessonRecord[];
}): boolean {
  const repeatCount = options.matchingLessons.length + 1;
  return options.lesson.promotionCandidate
    && options.lesson.confidence >= 0.85
    && repeatCount >= 3;
}

export function promoteLessonToSkill(options: {
  lesson: MemoryLessonRecord;
  relatedLessons: MemoryLessonRecord[];
  existingSkill?: MemorySkillRecord;
  now: string;
}): MemorySkillRecord {
  const totalLessons = [options.lesson, ...options.relatedLessons];
  const confidence = average(totalLessons.map((lesson) => lesson.confidence));
  const repeatCount = totalLessons.length;
  const successRate = Math.min(0.99, Math.max(0.7, confidence));
  const tags = unique(totalLessons.flatMap((lesson) => lesson.tags));
  const triggerConditions = unique(totalLessons.flatMap((lesson) => lesson.triggerSignals)).slice(0, 6);
  const playbook = unique(totalLessons.map((lesson) => lesson.recommendedAction)).slice(0, 4);
  return {
    skillId: options.existingSkill?.skillId ?? `skill-${options.lesson.lessonId}`,
    derivedFromLessonIds: unique(totalLessons.map((lesson) => lesson.lessonId)),
    name: options.existingSkill?.name ?? `${options.lesson.kind}:${options.lesson.taskPattern}`,
    scope: options.lesson.scope,
    triggerConditions,
    playbook,
    confidence,
    repeatCount,
    successRate,
    lastAppliedAt: options.now,
    expiresAt: new Date(Date.parse(options.now) + 1000 * 60 * 60 * 24 * 30).toISOString(),
    status: "active",
    tags,
  };
}

function scoreLesson(
  instruction: string,
  scope: MemoryScope,
  lesson: MemoryLessonRecord,
  now: string,
): number {
  const overlap = tokenOverlap(instruction, [lesson.taskPattern, lesson.recommendedAction, ...lesson.tags].join(" "));
  const scopeBonus = scope.projectKey === lesson.scope.projectKey ? 0.2 : 0;
  const hostBonus = scope.host && lesson.scope.host === scope.host ? 0.15 : 0;
  const freshness = freshnessScore(lesson.freshness, now);
  return overlap * 0.5 + lesson.confidence * 0.2 + freshness * 0.15 + scopeBonus + hostBonus;
}

function scoreSkill(
  instruction: string,
  scope: MemoryScope,
  skill: MemorySkillRecord,
  now: string,
): number {
  if (skill.status !== "active") {
    return 0;
  }
  const overlap = tokenOverlap(instruction, [skill.name, ...skill.playbook, ...skill.tags].join(" "));
  const scopeBonus = scope.projectKey === skill.scope.projectKey ? 0.2 : 0;
  const hostBonus = scope.host && skill.scope.host === scope.host ? 0.15 : 0;
  const freshness = freshnessScore(skill.lastAppliedAt, now);
  return overlap * 0.45 + skill.confidence * 0.2 + freshness * 0.1 + skill.successRate * 0.1 + scopeBonus + hostBonus;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function extractHost(value: string): string | undefined {
  const match = value.match(/https?:\/\/([^/\s]+)/i);
  return match?.[1]?.toLowerCase();
}

function freshnessScore(timestamp: string, now: string): number {
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(timestamp));
  const maxAgeMs = 1000 * 60 * 60 * 24 * 30;
  return 1 - Math.min(1, ageMs / maxAgeMs);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
