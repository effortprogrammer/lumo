import {
  type TaskPairing,
  type ToolExecutionRecord,
} from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";

export interface UiTaskSnapshot {
  pairing: TaskPairing;
  actorLogs: ToolExecutionRecord[];
  supervisorDecisions: SupervisorDecision[];
}

export function createSampleTaskSnapshot(): UiTaskSnapshot {
  const createdAt = "2026-03-12T14:00:00Z";

  return {
    pairing: {
      task: {
        taskId: "task-001",
        actor: {
          id: "actor-001",
          model: "claude-opus-4",
          systemPrompt: "default",
          tools: ["bash", "agent-browser", "coding-agent"],
        },
        supervisor: {
          id: "supervisor-001",
          model: "gpt-4.1-mini",
          systemPrompt: "watch-actor",
          maxBatchSteps: 5,
          maxBatchAgeMs: 120_000,
        },
        status: "running",
        createdAt,
        startedAt: createdAt,
        currentStep: 12,
        lastUpdatedAt: "2026-03-12T14:03:42Z",
      },
      context: {
        taskId: "task-001",
        instruction: {
          id: "instruction-001",
          text: "Search Naver for XX and summarize the results.",
          createdAt,
        },
        conversationHistory: [
          {
            id: "turn-001",
            role: "human",
            text: "Also save the result as markdown.",
            timestamp: "2026-03-12T14:01:10Z",
          },
        ],
      },
    },
    actorLogs: [
      {
        step: 9,
        timestamp: "2026-03-12T14:02:55Z",
        tool: "agent-browser",
        input: "open https://naver.com",
        output: "{\"success\":true}",
        durationMs: 1220,
      },
      {
        step: 10,
        timestamp: "2026-03-12T14:03:05Z",
        tool: "agent-browser",
        input: "search XX",
        output: "{\"success\":true,\"results\":10}",
        durationMs: 890,
        screenshotRef: {
          id: "shot-001",
          path: "./artifacts/shot-001.png",
          capturedAt: "2026-03-12T14:03:05Z",
        },
      },
      {
        step: 11,
        timestamp: "2026-03-12T14:03:12Z",
        tool: "bash",
        input: "cat notes.md",
        output: "# Notes",
        durationMs: 36,
      },
    ],
    supervisorDecisions: [
      {
        status: "ok",
        confidence: 0.94,
        reason: "Initial browser navigation matched the task.",
        action: "continue",
      },
      {
        status: "warning",
        confidence: 0.78,
        reason: "Repeated clicks detected near a popup flow.",
        suggestion: "Prefer dismissing the popup once and continue to results.",
        action: "feedback",
      },
    ],
  };
}
