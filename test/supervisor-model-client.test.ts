import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeuristicSupervisorClient } from "../src/supervisor/model-client.js";

describe("HeuristicSupervisorClient", () => {
  it("waits for a recently issued intervention to settle before issuing more feedback", async () => {
    const client = new HeuristicSupervisorClient();

    const decision = await client.decide({
      taskInstruction: "inspect the browser workflow",
      conversationHistory: [],
      recentLogs: [],
      anomalies: [],
      recentLifecycleEvents: [
        {
          id: "evt-1",
          offset: "0",
          source: "lumo.supervisor",
          type: "supervisor.intervention.issued",
          timestamp: Date.now(),
          payload: {
            interventionId: "intervention-1",
            decision: {
              status: "warning",
              action: "feedback",
            },
          },
        },
      ],
      triggeredBy: "time",
      occurredAt: "2026-03-18T10:00:00Z",
    });

    assert.equal(decision.action, "continue");
    assert.match(decision.reason, /Waiting for the actor to finish applying recent supervisor intervention/);
  });
});
