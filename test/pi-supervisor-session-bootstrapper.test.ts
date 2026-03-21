import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PiSupervisorSessionBootstrapper } from "../src/runtime/pi-supervisor-session-bootstrapper.js";

describe("PiSupervisorSessionBootstrapper", () => {
  it("boots a separate-session supervisor when a pi client is available", async () => {
    let capturedInstruction = "";
    const sentInputs: Array<{ sessionId: string; text: string; options?: Record<string, unknown> }> = [];
    const bootstrapper = new PiSupervisorSessionBootstrapper({
      client: {
        isAvailable: () => true,
        createSession: ({ sessionId, instruction }) => {
          capturedInstruction = instruction;
          return {
            externalSessionId: `external-${sessionId}`,
          };
        },
        async sendInput(sessionId, text, options) {
          sentInputs.push({ sessionId, text, options });
        },
        subscribe() {
          return () => {};
        },
      },
      now: () => "2026-03-16T12:00:05Z",
    });

    const result = await bootstrapper.bootstrap({
      pairId: "pair-1",
      taskId: "task-1",
      actorAgentId: "actor-1",
      supervisorAgentId: "supervisor-1",
      instruction: "inspect the paired actor session",
      occurredAt: "2026-03-16T12:00:00Z",
    });

    assert.equal(result.mode, "separate_session");
    assert.equal(result.status, "ready");
    assert.equal(result.sessionId, "external-supervisor-task-1");
    assert.equal(result.metadata?.bootstrap, "pi-supervisor-session");
    assert.ok(capturedInstruction.includes("\"type\":\"supervisor-feedback\""));
    assert.ok(capturedInstruction.includes("\"type\":\"supervisor-halt\""));
    assert.ok(capturedInstruction.includes("exactly one JSON object and nothing else"));
    assert.equal(sentInputs[0]?.sessionId, "external-supervisor-task-1");
    assert.ok(sentInputs[0]?.text.includes("dedicated supervisor"));
  });

  it("returns a failed bootstrap result when the pi client is unavailable", async () => {
    const bootstrapper = new PiSupervisorSessionBootstrapper({
      client: {
        isAvailable: () => false,
        createSession: () => {
          throw new Error("should not be called");
        },
        async sendInput() {},
        subscribe() {
          return () => {};
        },
      },
      now: () => "2026-03-16T12:00:05Z",
    });

    const result = await bootstrapper.bootstrap({
      pairId: "pair-1",
      taskId: "task-1",
      actorAgentId: "actor-1",
      supervisorAgentId: "supervisor-1",
      instruction: "inspect the paired actor session",
      occurredAt: "2026-03-16T12:00:00Z",
    });

    assert.equal(result.mode, "separate_session");
    assert.equal(result.status, "failed");
    assert.equal(result.metadata?.error, "pi supervisor runtime is unavailable");
  });

  it("delivers actor progress updates into the separate supervisor session", async () => {
    const sendCalls: Array<{ sessionId: string; text: string; options?: Record<string, unknown> }> = [];
    const bootstrapper = new PiSupervisorSessionBootstrapper({
      client: {
        isAvailable: () => true,
        createSession: ({ sessionId }) => ({
          externalSessionId: `external-${sessionId}`,
        }),
        async sendInput(sessionId, text, options) {
          sendCalls.push({ sessionId, text, options });
        },
        subscribe() {
          return () => {};
        },
      },
      now: () => "2026-03-16T12:00:05Z",
    });

    await bootstrapper.deliverProgress({
      pairId: "pair-1",
      taskId: "task-1",
      supervisorSessionId: "external-supervisor-task-1",
      occurredAt: "2026-03-16T12:01:00Z",
      input: {
        taskInstruction: "inspect task workflow",
        conversationHistory: [
          "Start working on the task.",
        ],
        recentLogs: [],
        anomalies: [],
        recentLifecycleEvents: [
          {
            id: "evt-1",
            offset: "0",
            source: "lumo.supervisor",
            type: "supervisor.intervention.issued",
            timestamp: 1773821655319,
            payload: {
              interventionId: "intervention-1",
            },
          },
        ],
        recentActorProgressEvents: [
          {
            progressId: "progress-1",
            actorSessionId: "actor-session-1",
            sequence: 7,
            summary: "collected three prices from the listing page",
            currentStatus: "running",
            currentStep: 7,
          },
        ],
        triggeredBy: "manual",
        currentStatus: "running",
        currentStep: 3,
        occurredAt: "2026-03-16T12:01:00Z",
      },
    });

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.sessionId, "external-supervisor-task-1");
    assert.ok(sendCalls[0]?.text.includes("\"taskInstruction\":\"inspect task workflow\""));
    assert.ok(sendCalls[0]?.text.includes("Evaluate this update now"));
    assert.ok(sendCalls[0]?.text.includes("respond immediately with exactly one JSON object"));
    assert.ok(sendCalls[0]?.text.includes("Recent lifecycle events"));
    assert.ok(sendCalls[0]?.text.includes("intervention-1"));
    assert.ok(sendCalls[0]?.text.includes("Recent actor progress events"));
    assert.ok(sendCalls[0]?.text.includes("collected three prices"));
  });

  it("subscribes to supervisor conversation output and parses feedback/halt directives", async () => {
    let listener: ((event: {
      type: "conversation.turn";
      taskId: string;
      turn: { text: string };
    }) => void) | undefined;
    const feedbacks: string[] = [];
    const halts: string[] = [];
    const bootstrapper = new PiSupervisorSessionBootstrapper({
      client: {
        isAvailable: () => true,
        createSession: ({ sessionId }) => ({
          externalSessionId: `external-${sessionId}`,
        }),
        async sendInput() {},
        subscribe(_sessionId, cb) {
          listener = cb as typeof listener;
          return () => {
            listener = undefined;
          };
        },
      },
    });

    const unsubscribe = bootstrapper.attachInterventionListener({
      pairId: "pair-1",
      taskId: "task-1",
      supervisorSessionId: "external-supervisor-task-1",
      onFeedback(message) {
        feedbacks.push(message.instructions?.[0] ?? message.decision.reason);
      },
      onHalt(message) {
        halts.push(message.decision.reason);
      },
    });

    listener?.({
      type: "conversation.turn",
      taskId: "task-1",
      turn: {
        text: JSON.stringify({
          type: "supervisor-feedback",
          decision: {
            status: "warning",
            confidence: 0.9,
            reason: "switch to synthesis now",
            action: "feedback",
          },
          instructions: ["extract requirements now"],
        }),
      },
    });
    listener?.({
      type: "conversation.turn",
      taskId: "task-1",
      turn: {
        text: JSON.stringify({
          type: "supervisor-halt",
          decision: {
            status: "critical",
            confidence: 0.95,
            reason: "wait for human review",
            action: "halt",
          },
          humanActionNeeded: true,
        }),
      },
    });
    unsubscribe();

    assert.deepEqual(feedbacks, ["extract requirements now"]);
    assert.deepEqual(halts, ["wait for human review"]);
  });
});
