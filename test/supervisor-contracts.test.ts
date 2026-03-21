import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSupervisorInputEnvelope,
  buildSupervisorOutputEnvelope,
} from "../src/supervisor/contracts.js";
import { type LogBatch } from "../src/logging/log-batcher.js";

describe("buildSupervisorInputEnvelope", () => {
  it("normalizes a log batch into a single supervisor input contract", () => {
    const batch: LogBatch = {
      taskInstruction: "inspect the browser workflow",
      conversationHistory: ["continue with the current task"],
      batch: [
        {
          step: 3,
          timestamp: "2026-03-15T11:00:00Z",
          tool: "agent-browser",
          input: "snapshot",
          output: "ok",
          durationMs: 10,
          status: "ok",
        },
      ],
      recentLogs: [
        {
          step: 2,
          timestamp: "2026-03-15T10:59:58Z",
          tool: "agent-browser",
          input: "get title",
          output: "Google",
          durationMs: 10,
          status: "ok",
        },
      ],
      anomalies: [],
      triggeredBy: "time",
    };

    const input = buildSupervisorInputEnvelope(batch, {
      occurredAt: "2026-03-15T11:00:01Z",
      currentStatus: "running",
      currentStep: 3,
    });

    assert.equal(input.taskInstruction, "inspect the browser workflow");
    assert.equal(input.conversationHistory[0], "continue with the current task");
    assert.equal(input.recentLogs[0]?.step, 2);
    assert.equal(input.triggeredBy, "time");
    assert.equal(input.currentStatus, "running");
    assert.equal(input.currentStep, 3);
    assert.equal(input.occurredAt, "2026-03-15T11:00:01Z");
  });
});


describe("buildSupervisorOutputEnvelope", () => {
  it("normalizes a supervisor decision into a structured output contract", () => {
    const output = buildSupervisorOutputEnvelope({
      decision: {
        status: "warning",
        confidence: 0.84,
        reason: "Actor is stuck in repeated browsing without synthesizing.",
        suggestion: "Stop browsing and draft the resume now.",
        action: "feedback",
      },
      report: {
        taskId: "task-1",
        sessionId: "session-1",
        severity: "warning",
        status: "running",
        title: "Actor may be blocked by research without synthesis",
        summary: "The actor has enough browsing context and should move on to drafting.",
        anomalyKinds: [],
        reasons: ["Too much browsing, no synthesis"],
        recommendedAction: "resume-with-guidance",
        supervisorDecision: {
          confidence: 0.84,
          reason: "Actor is stuck in repeated browsing without synthesizing.",
          suggestion: "Stop browsing and draft the resume now.",
          action: "feedback",
        },
        evidence: {},
        occurredAt: "2026-03-15T12:00:00Z",
        bottleneck: {
          kind: "research_without_synthesis",
          severity: "warning",
          confidence: 0.9,
          summary: "The actor should switch from browsing to synthesis.",
          diagnosis: "The actor already reached relevant sources but continues browsing.",
          evidence: ["Relevant source reached"],
          recoverable: true,
          recoveryPlan: {
            action: "switch_to_synthesis",
            summary: "Switch to synthesis now.",
            instructions: ["Draft the resume now."],
            humanEscalationNeeded: false,
            targetPhase: "synthesis",
          },
        },
      },
    });

    assert.equal(output.decision.status, "warning");
    assert.equal(output.bottleneck?.kind, "research_without_synthesis");
    assert.equal(output.recoveryPlan?.action, "switch_to_synthesis");
    assert.equal(output.shouldEscalateHuman, false);
    assert.equal(output.shouldInterveneActor, true);
  });
});
