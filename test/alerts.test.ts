import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
import {
  AlertDispatcher,
  VoiceCallAlertChannel,
  type AlertChannel,
} from "../src/alerts/dispatcher.js";
import { type LogBatch } from "../src/logging/log-batcher.js";
import { MockSupervisorClient } from "../src/supervisor/model-client.js";
import { SupervisorPipeline } from "../src/supervisor/pipeline.js";

describe("AlertDispatcher", () => {
  it("dispatches warning decisions to configured channels", async () => {
    const sentEvents: string[] = [];
    const adapter = new StubA2AAdapter();
    adapter.registerMessageHandler("actor", async () => {});
    const dispatcher = new AlertDispatcher([
      createChannel("terminal", sentEvents),
      createChannel("discord-webhook", sentEvents),
    ]);
    const pipeline = new SupervisorPipeline({
      adapter,
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "warning",
        confidence: 0.8,
        reason: "command failed",
        suggestion: "inspect stderr",
        action: "feedback",
      }),
      alerts: dispatcher,
      now: () => "2026-03-12T00:00:00Z",
    });

    await pipeline.consume(createBatch());

    assert.deepEqual(sentEvents, [
      "terminal:warning:task-alert",
      "discord-webhook:warning:task-alert",
    ]);
  });

  it("does not dispatch alerts for ok decisions", async () => {
    const sentEvents: string[] = [];
    const dispatcher = new AlertDispatcher([createChannel("terminal", sentEvents)]);
    const pipeline = new SupervisorPipeline({
      adapter: new StubA2AAdapter(),
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "ok",
        confidence: 0.99,
        reason: "all good",
        action: "continue",
      }),
      alerts: dispatcher,
      now: () => "2026-03-12T00:00:00Z",
    });

    await pipeline.consume(createBatch());

    assert.deepEqual(sentEvents, []);
  });

  it("routes only critical alerts to the voice-call executor", async () => {
    const invocations: Array<{ command: string; args: string[] }> = [];
    const criticalChannel = new VoiceCallAlertChannel({
      recipient: "+15551234567",
      providerCommandTemplate: [
        "openclaw",
        "voice-call",
        "--to",
        "{recipient}",
        "--message",
        "{message}",
      ],
      executor: {
        async run(command, args) {
          invocations.push({ command, args });
          return {
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            durationMs: 5,
          };
        },
      },
      logger: {
        warn: () => {},
      },
    });

    const warningResult = await criticalChannel.send({
      ...createAlertEvent(),
      decision: {
        status: "warning",
        confidence: 0.8,
        reason: "needs eyes",
        action: "feedback",
      },
    });
    const criticalResult = await criticalChannel.send({
      ...createAlertEvent(),
      decision: {
        status: "critical",
        confidence: 0.95,
        reason: "runaway command",
        action: "halt",
        suggestion: "stop the actor",
      },
    });

    assert.equal(warningResult.status, "skipped");
    assert.equal(criticalResult.status, "sent");
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0], {
      command: "openclaw",
      args: [
        "voice-call",
        "--to",
        "+15551234567",
        "--message",
        "Lumo CRITICAL alert | task=task-alert | action=halt | reason=runaway command | suggestion=stop the actor",
      ],
    });
  });
});

function createChannel(name: string, sentEvents: string[]): AlertChannel {
  return {
    name,
    async send(event) {
      sentEvents.push(`${name}:${event.decision.status}:${event.taskId}`);
      return {
        channel: name,
        status: "sent",
        detail: "ok",
      };
    },
  };
}

function createBatch(): LogBatch {
  return {
    taskInstruction: "test alert",
    conversationHistory: [],
    triggeredBy: "manual",
    batch: [
      {
        step: 1,
        timestamp: "2026-03-12T00:00:00Z",
        tool: "bash",
        input: "echo hi",
        output: "hi",
        durationMs: 1,
        metadata: {
          taskId: "task-alert",
        },
      },
    ],
  };
}

function createAlertEvent() {
  return {
    decision: {
      status: "critical" as const,
      confidence: 0.9,
      reason: "critical issue",
      action: "halt" as const,
    },
    batch: createBatch(),
    taskId: "task-alert",
    actorAgentId: "actor",
    supervisorAgentId: "supervisor",
    occurredAt: "2026-03-12T00:00:00Z",
  };
}
