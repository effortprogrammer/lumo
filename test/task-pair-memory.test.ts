import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskPairManager } from "../src/runtime/task-pair-manager.js";
import { createDefaultConfig } from "../src/config/load-config.js";
import { type PiMonoRuntimeClient } from "../src/runtime/runtime-session-adapter.js";
import { type AgentikaEventSink } from "../src/event/agentika-sink.js";

type RuntimeSessionEventLike = Parameters<PiMonoRuntimeClient["subscribe"]>[1] extends (event: infer T) => void
  ? T
  : never;

class AvailablePiClient implements PiMonoRuntimeClient {
  private readonly listeners = new Map<string, (event: RuntimeSessionEventLike) => void>();

  isAvailable(): boolean {
    return true;
  }

  createSession(options: { sessionId: string }): { externalSessionId: string } {
    return { externalSessionId: `external-${options.sessionId}` };
  }

  async sendInput(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async halt(): Promise<void> {}

  subscribe(externalSessionId: string, listener: (event: RuntimeSessionEventLike) => void): () => void {
    this.listeners.set(externalSessionId, listener);
    return () => {
      this.listeners.delete(externalSessionId);
    };
  }

  emit(externalSessionId: string, event: RuntimeSessionEventLike): void {
    this.listeners.get(externalSessionId)?.(event);
  }
}

class MemoryEventSink implements AgentikaEventSink {
  readonly published: Array<{ topic: string; type: string; payload: Record<string, unknown> }> = [];

  async publish(event: { topic: string; type: string; payload: Record<string, unknown> }): Promise<void> {
    this.published.push({
      topic: event.topic,
      type: event.type,
      payload: event.payload,
    });
  }

  async fetchRecent(query: { topic: string }): Promise<Array<{ id: string; offset: string; source: string; type: string; payload: Record<string, unknown> }>> {
    if (query.topic === "memory.lessons") {
      return [
        {
          id: "lesson-1",
          offset: "1",
          source: "lumo.memory",
          type: "memory.retrospective_recorded",
          payload: {
            lessonId: "lesson-1",
            sourceSessionId: "session-old",
            taskId: "task-old",
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
          },
        },
      ];
    }
    if (query.topic === "memory.skills") {
      return [
        {
          id: "skill-1",
          offset: "1",
          source: "lumo.memory",
          type: "memory.skill_promoted",
          payload: {
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
            successRate: 0.83,
            lastAppliedAt: "2026-03-20T12:00:00Z",
            expiresAt: "2026-04-20T12:00:00Z",
            status: "active",
            tags: ["inspect", "browser", "workflow"],
          },
        },
      ];
    }
    return [];
  }
}

describe("TaskPairManager memory harness", () => {
  it("injects retrieved lessons and skills into supervisor observations", async () => {
    const client = new AvailablePiClient();
    const eventSink = new MemoryEventSink();
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        eventSink,
      },
    );

    const pair = manager.createPair("Inspect the browser workflow and summarize the page.");
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-21T12:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "task.output",
      taskId: pair.taskId,
      occurredAt: "2026-03-21T12:00:01Z",
      tool: "agent-browser",
      input: "snapshot",
      output: "OpenAI Careers",
      durationMs: 5,
      exitCode: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const cycle = await manager.observeCurrentPair();

    assert.equal(cycle?.input.priorLessons?.[0]?.lessonId, "lesson-1");
    assert.equal(cycle?.input.priorSkills?.[0]?.skillId, "skill-1");
  });

  it("records outcome and retrospective memory automatically when a task finishes", async () => {
    const client = new AvailablePiClient();
    const eventSink = new MemoryEventSink();
    const manager = await TaskPairManager.create(
      createDefaultConfig(),
      undefined,
      undefined,
      {
        healthCheck: () => true,
        piMonoClient: client,
      },
      {
        eventSink,
      },
    );

    const pair = manager.createPair("Inspect the browser workflow and summarize the page.");
    const externalSessionId = `external-${pair.session.runtime.sessionId}`;
    client.emit(externalSessionId, {
      type: "session.started",
      taskId: pair.taskId,
      startedAt: "2026-03-21T12:00:00Z",
    });
    client.emit(externalSessionId, {
      type: "session.status",
      taskId: pair.taskId,
      status: "completed",
      occurredAt: "2026-03-21T12:00:05Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.ok(eventSink.published.some((event) => event.type === "memory.outcome_recorded"));
    assert.ok(eventSink.published.some((event) => event.type === "memory.retrospective_recorded"));
  });
});
