import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryHarness } from "../src/memory/harness.js";
import { type LumoEventBus } from "../src/event/bus.js";
import { type LumoPublishedEvent, type LumoStoredEvent } from "../src/event/types.js";
import { createTaskPairRuntimeState } from "../src/runtime/task-pair-state.js";
import { type TaskSession } from "../src/runtime/session-manager.js";

class InMemoryEventBus implements LumoEventBus {
  readonly published: LumoPublishedEvent[] = [];
  private readonly events = new Map<string, LumoStoredEvent[]>();

  async publish(event: LumoPublishedEvent): Promise<void> {
    this.published.push(event);
    const stored: LumoStoredEvent = {
      id: event.idempotencyKey ?? `${event.topic}:${this.published.length}`,
      offset: String(this.published.length),
      source: event.source,
      type: event.type,
      timestamp: Date.now(),
      payload: event.payload,
    };
    const bucket = this.events.get(event.topic) ?? [];
    bucket.unshift(stored);
    this.events.set(event.topic, bucket);
  }

  async fetchRecent(query: { topic: string; limit?: number }): Promise<LumoStoredEvent[]> {
    return (this.events.get(query.topic) ?? []).slice(0, query.limit ?? 50);
  }

  seed(topic: string, type: string, payload: Record<string, unknown>): void {
    const bucket = this.events.get(topic) ?? [];
    bucket.unshift({
      id: `${topic}:${bucket.length + 1}`,
      offset: String(bucket.length + 1),
      source: "test",
      type,
      timestamp: Date.now(),
      payload,
    });
    this.events.set(topic, bucket);
  }
}

describe("MemoryHarness", () => {
  it("records outcomes, retrospectives, and promotes repeated lessons into skills", async () => {
    const bus = new InMemoryEventBus();
    const now = () => "2026-03-21T12:00:00Z";
    const harness = new MemoryHarness(bus, now);

    const seedLesson = {
      sourceSessionId: "seed-session",
      taskId: "seed-task",
      kind: "task_pattern",
      taskPattern: "inspect browser workflow summarize page",
      scope: {
        projectKey: process.cwd(),
        taskPattern: "inspect browser workflow summarize page",
      },
      triggerSignals: ["completed"],
      whatWorked: "Inspect the browser first.",
      recommendedAction: "Inspect the browser first and synthesize the result immediately.",
      avoidWhen: [],
      confidence: 0.9,
      freshness: "2026-03-20T12:00:00Z",
      tags: ["inspect", "browser"],
      evidenceRefs: ["seed"],
      promotionCandidate: true,
    };

    bus.seed("memory.lessons", "memory.retrospective_recorded", {
      lessonId: "lesson-seed-1",
      ...seedLesson,
    });
    bus.seed("memory.lessons", "memory.retrospective_recorded", {
      lessonId: "lesson-seed-2",
      ...seedLesson,
    });

    await harness.reviewCompletedSession({
      session: createReviewedSession(),
      finalStatus: "completed",
    });

    assert.ok(bus.published.some((event) => event.type === "memory.outcome_recorded"));
    assert.ok(bus.published.some((event) => event.type === "memory.retrospective_recorded"));
    assert.ok(bus.published.some((event) => event.type === "memory.skill_promoted"));
  });

  it("retrieves relevant lessons and skills for similar instructions", async () => {
    const bus = new InMemoryEventBus();
    const harness = new MemoryHarness(bus, () => "2026-03-21T12:00:00Z");

    bus.seed("memory.lessons", "memory.retrospective_recorded", {
      lessonId: "lesson-1",
      sourceSessionId: "session-1",
      taskId: "task-1",
      kind: "recovery_pattern",
      taskPattern: "inspect browser workflow",
      scope: {
        projectKey: process.cwd(),
        taskPattern: "inspect browser workflow",
      },
      triggerSignals: ["browser_stuck"],
      recommendedAction: "Inspect the browser before repeating the same command.",
      avoidWhen: [],
      confidence: 0.92,
      freshness: "2026-03-20T12:00:00Z",
      tags: ["inspect", "browser", "workflow"],
      evidenceRefs: ["lesson"],
      promotionCandidate: true,
    });
    bus.seed("memory.skills", "memory.skill_promoted", {
      skillId: "skill-1",
      derivedFromLessonIds: ["lesson-1"],
      name: "recovery_pattern:inspect browser workflow",
      scope: {
        projectKey: process.cwd(),
        taskPattern: "inspect browser workflow",
      },
      triggerConditions: ["browser_stuck"],
      playbook: ["Inspect the browser before repeating the same command."],
      confidence: 0.93,
      repeatCount: 3,
      successRate: 0.84,
      lastAppliedAt: "2026-03-20T12:00:00Z",
      expiresAt: "2026-04-20T12:00:00Z",
      status: "active",
      tags: ["inspect", "browser", "workflow"],
    });

    const context = await harness.retrieveForInstruction({
      taskId: "task-live",
      sessionId: "session-live",
      instruction: "Inspect the browser workflow and summarize the current page.",
      appliedTo: "task_start",
    });

    assert.equal(context.lessons.length, 1);
    assert.equal(context.skills.length, 1);
    assert.match(context.guidanceLines[0] ?? "", /Inspect the browser/i);
    assert.ok(bus.published.some((event) => event.type === "memory.retrieval"));
  });
});

function createReviewedSession(): TaskSession {
  return {
    runtime: {
      sessionId: "session-reviewed",
      provider: "pi",
      task: {
        task: {
          taskId: "task-reviewed",
          actor: {
            id: "actor",
            systemPrompt: "run tasks",
            tools: ["bash", "agent-browser", "coding-agent"],
          },
          supervisor: {
            id: "supervisor",
            model: "heuristic",
            systemPrompt: "watch the actor",
            maxBatchSteps: 5,
            maxBatchAgeMs: 1000,
          },
          status: "completed",
          createdAt: "2026-03-21T11:55:00Z",
          startedAt: "2026-03-21T11:55:05Z",
          completedAt: "2026-03-21T11:59:59Z",
          currentStep: 4,
          lastUpdatedAt: "2026-03-21T11:59:59Z",
        },
        context: {
          taskId: "task-reviewed",
          instruction: {
            id: "instruction-1",
            text: "Inspect the browser workflow and summarize the page.",
            createdAt: "2026-03-21T11:55:00Z",
          },
          conversationHistory: [],
        },
      },
      pairState: createTaskPairRuntimeState({
        sessionId: "session-reviewed",
        taskId: "task-reviewed",
        actorAgentId: "actor",
        supervisorAgentId: "supervisor",
        status: "completed",
        currentStep: 4,
      }),
      actorLogs: [],
    },
    pairState: {
      ...createTaskPairRuntimeState({
        sessionId: "session-reviewed",
        taskId: "task-reviewed",
        actorAgentId: "actor",
        supervisorAgentId: "supervisor",
        status: "completed",
        currentStep: 4,
      }),
      supervisor: {
        ...createTaskPairRuntimeState({
          sessionId: "session-reviewed",
          taskId: "task-reviewed",
          actorAgentId: "actor",
          supervisorAgentId: "supervisor",
          status: "completed",
          currentStep: 4,
        }).supervisor,
        lastInterventionEffect: {
          interventionId: "int-1",
          status: "resolved",
          evaluatedAt: "2026-03-21T11:59:50Z",
          reason: "The actor resumed and reached synthesis.",
        },
      },
    },
    decisions: [
      {
        status: "warning",
        confidence: 0.9,
        reason: "The actor should switch to synthesis.",
        suggestion: "Inspect the browser first and synthesize the result immediately.",
        action: "feedback",
      },
    ],
    supervisorOutputs: [
      {
        decision: {
          status: "warning",
          confidence: 0.9,
          reason: "The actor should switch to synthesis.",
          suggestion: "Inspect the browser first and synthesize the result immediately.",
          action: "feedback",
        },
        bottleneck: {
          kind: "research_without_synthesis",
          severity: "warning",
          confidence: 0.9,
          summary: "The actor should switch to synthesis.",
          diagnosis: "The actor gathered enough context but kept browsing.",
          evidence: ["Relevant source reached"],
          recoverable: true,
          recoveryPlan: {
            action: "switch_to_synthesis",
            summary: "Switch to synthesis now.",
            instructions: ["Inspect the browser first and synthesize the result immediately."],
            humanEscalationNeeded: false,
            targetPhase: "synthesis",
          },
        },
        recoveryPlan: {
          action: "switch_to_synthesis",
          summary: "Switch to synthesis now.",
          instructions: ["Inspect the browser first and synthesize the result immediately."],
          humanEscalationNeeded: false,
          targetPhase: "synthesis",
        },
        escalationReport: {
          taskId: "task-reviewed",
          sessionId: "session-reviewed",
          severity: "warning",
          status: "running",
          title: "Actor may be blocked by research without synthesis",
          summary: "The actor has enough browsing context and should move on to synthesis.",
          anomalyKinds: [],
          reasons: ["Too much browsing without synthesis"],
          recommendedAction: "resume-with-guidance",
          supervisorDecision: {
            confidence: 0.9,
            reason: "The actor should switch to synthesis.",
            suggestion: "Inspect the browser first and synthesize the result immediately.",
            action: "feedback",
          },
          evidence: {},
          taskPhase: {
            currentPhase: "source_selection",
            confidence: 0.88,
            summary: "The task is still in research mode.",
            evidence: ["Browsing continues"],
          },
          bottleneck: {
            kind: "research_without_synthesis",
            severity: "warning",
            confidence: 0.9,
            summary: "The actor should switch to synthesis.",
            diagnosis: "The actor gathered enough context but kept browsing.",
            evidence: ["Relevant source reached"],
            recoverable: true,
            recoveryPlan: {
              action: "switch_to_synthesis",
              summary: "Switch to synthesis now.",
              instructions: ["Inspect the browser first and synthesize the result immediately."],
              humanEscalationNeeded: false,
              targetPhase: "synthesis",
            },
          },
          occurredAt: "2026-03-21T11:59:40Z",
        },
        shouldEscalateHuman: false,
        shouldInterveneActor: true,
      },
    ],
    supervisorProgress: [],
  };
}
