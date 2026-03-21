import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StubA2AAdapter } from "../src/a2a/in-process-adapter.js";
import {
  AlertDispatcher,
  DiscordWebhookAlertChannel,
  VoiceCallAlertChannel,
  type AlertChannel,
} from "../src/alerts/dispatcher.js";
import { type LogBatch } from "../src/logging/log-batcher.js";
import { buildSupervisorEscalationReport } from "../src/supervisor/escalation-report.js";
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

  it("returns a structured supervisor output envelope", async () => {
    const adapter = new StubA2AAdapter();
    adapter.registerMessageHandler("actor", async () => {});
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
      now: () => "2026-03-12T00:00:00Z",
    });

    const output = await pipeline.consume(createBatch());

    assert.equal(output.decision.status, "warning");
    assert.equal(output.shouldInterveneActor, true);
    assert.equal(output.escalationReport?.taskId, "task-alert");
    const feedbackPart = adapter.sentMessages[0]?.payload.parts.find((part) => part.kind === "json");
    assert.equal(feedbackPart?.kind, "json");
    if (feedbackPart?.kind === "json" && feedbackPart.data.type === "supervisor-feedback") {
      assert.equal(feedbackPart.data.type, "supervisor-feedback");
      assert.equal(feedbackPart.data.decision, output.decision);
      assert.equal(feedbackPart.data.shouldEscalateHuman, false);
      assert.ok(typeof feedbackPart.data.interventionId === "string");
    } else {
      assert.fail("expected supervisor-feedback JSON payload");
    }
  });

  it("wraps halt interventions in a structured cancel payload", async () => {
    const adapter = new StubA2AAdapter();
    adapter.registerCancelHandler("actor", async () => {});
    const pipeline = new SupervisorPipeline({
      adapter,
      actorAgentId: "actor",
      supervisorAgentId: "supervisor",
      client: new MockSupervisorClient({
        status: "critical",
        confidence: 0.96,
        reason: "manual intervention required",
        suggestion: "wait for the operator",
        action: "halt",
      }),
      now: () => "2026-03-12T00:00:00Z",
    });

    const output = await pipeline.consume(createBatch());

    assert.equal(output.shouldEscalateHuman, true);
    assert.equal(adapter.cancelRequests[0]?.payload.details?.type, "supervisor-halt");
    assert.equal(adapter.cancelRequests[0]?.payload.details?.decision, output.decision);
    assert.equal(adapter.cancelRequests[0]?.payload.details?.humanActionNeeded, true);
    assert.ok(typeof adapter.cancelRequests[0]?.payload.details?.interventionId === "string");
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
        "Lumo CRITICAL alert | task=task-alert | title=Actor was halted after supervisor intervention | action=halt | reason=critical issue Current activity: bash echo hi Last progress: Step 1 via bash | suggestion=stop the actor",
      ],
    });
  });

  it("posts rich Discord webhook alerts for human escalation", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const channel = new DiscordWebhookAlertChannel(
      "https://discord.example/webhook",
      async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
        });
        return new Response("", { status: 200 });
      },
    );

    const result = await channel.send(createAlertEvent({
      decision: {
        status: "critical",
        confidence: 0.95,
        reason: "manual intervention required",
        action: "halt",
        suggestion: "review the checkout page before resuming",
      },
      report: {
        browserState: {
          url: "https://example.com/checkout",
          title: "Checkout",
          pageKind: "modal",
          screenshotRef: {
            id: "shot-1",
            url: "https://cdn.example.com/shot-1.png",
            capturedAt: "2026-03-12T00:00:00Z",
          },
        },
        bottleneck: {
          kind: "browser_state_unclear",
          severity: "critical",
          confidence: 0.93,
          summary: "The browser is on an unexpected modal page.",
          diagnosis: "The actor needs a human to confirm whether to continue checkout.",
          evidence: ["Modal overlay obscures the underlying page."],
          recoverable: false,
          recoveryPlan: {
            action: "halt_and_escalate",
            summary: "Wait for operator guidance.",
            instructions: ["Confirm the correct checkout path before resuming."],
            humanEscalationNeeded: true,
          },
        },
      },
    }));

    assert.equal(result.status, "sent");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://discord.example/webhook");
    assert.match(String(requests[0]?.body.content), /Lumo CRITICAL alert/);
    const embeds = requests[0]?.body.embeds;
    assert.ok(Array.isArray(embeds));
    const embed = embeds?.[0] as Record<string, unknown> | undefined;
    assert.equal(embed?.url, "https://example.com/checkout");
    assert.deepEqual(embed?.image, { url: "https://cdn.example.com/shot-1.png" });
    const fields = Array.isArray(embed?.fields) ? embed.fields as Array<Record<string, unknown>> : [];
    assert.ok(fields.some((field) => field.name === "Bottleneck" && String(field.value).includes("browser_state_unclear")));
    assert.ok(fields.some((field) => field.name === "Browser" && String(field.value).includes("https://example.com/checkout")));
    assert.ok(fields.some((field) => field.name === "Screenshot" && String(field.value).includes("https://cdn.example.com/shot-1.png")));
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
    anomalies: [],
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

function createAlertEvent(
  overrides: {
    decision?: {
      status: "warning" | "critical";
      confidence: number;
      reason: string;
      action: "continue" | "feedback" | "halt";
      suggestion?: string;
    };
    report?: Partial<ReturnType<typeof buildSupervisorEscalationReport>>;
  } = {},
) {
  const decision = overrides.decision ?? {
    status: "critical" as const,
    confidence: 0.9,
    reason: "critical issue",
    action: "halt" as const,
  };
  const batch = createBatch();
  const baseReport = buildSupervisorEscalationReport(batch, decision, {
    taskId: "task-alert",
    occurredAt: "2026-03-12T00:00:00Z",
  });
  return {
    decision,
    batch,
    taskId: "task-alert",
    actorAgentId: "actor",
    supervisorAgentId: "supervisor",
    occurredAt: "2026-03-12T00:00:00Z",
    report: {
      ...baseReport,
      ...overrides.report,
    },
  };
}
