import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSupervisorEscalationReport } from "../src/supervisor/escalation-report.js";
import { type LogBatch } from "../src/logging/log-batcher.js";
import { type SupervisorDecision } from "../src/supervisor/decision.js";

describe("buildSupervisorEscalationReport", () => {
  it("builds a human-facing escalation summary from anomalies and recent tool evidence", () => {
    const report = buildSupervisorEscalationReport(createBatch(), createDecision(), {
      taskId: "task-alert",
      occurredAt: "2026-03-12T00:00:00Z",
    });

    assert.equal(report.taskId, "task-alert");
    assert.equal(report.sessionId, "session-alert");
    assert.equal(report.severity, "critical");
    assert.equal(report.status, "halted");
    assert.match(report.title, /retry loop/i);
    assert.match(report.summary, /same failure pattern without recovering/i);
    assert.deepEqual(report.anomalyKinds, ["retry_loop"]);
    assert.equal(report.recommendedAction, "halted-awaiting-human");
    assert.equal(report.evidence.retryCount, 3);
    assert.equal(report.evidence.latestTool, "bash");
    assert.equal(report.bottleneck?.kind, "retry_loop");
  });
});

function createDecision(): SupervisorDecision {
  return {
    status: "critical",
    confidence: 0.95,
    reason: "The actor is unlikely to recover automatically.",
    suggestion: "Review the failure before resuming.",
    action: "halt",
  };
}

function createBatch(): LogBatch {
  return {
    taskInstruction: "test alert",
    conversationHistory: [],
    triggeredBy: "anomaly",
    anomalies: [
      {
        id: "anomaly-retry-loop",
        kind: "retry_loop",
        severity: "critical",
        message: "The actor is retrying the same failing operation repeatedly.",
        taskId: "task-alert",
        sessionId: "session-alert",
        occurredAt: "2026-03-12T00:00:00Z",
        relatedStep: 3,
        relatedTool: "bash",
        evidence: {
          retryCount: 3,
          repeatedInput: "curl https://api.example.com",
        },
      },
    ],
    batch: [
      {
        step: 3,
        timestamp: "2026-03-12T00:00:00Z",
        tool: "bash",
        input: "curl https://api.example.com",
        output: "timeout",
        durationMs: 1_000,
        status: "error",
        exitCode: 1,
        metadata: {
          taskId: "task-alert",
          runtimeSessionId: "session-alert",
        },
      },
    ],
  };
}
