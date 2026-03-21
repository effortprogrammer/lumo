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

  it("pushes the actor toward an authoritative source when stuck on low-trust search results", async () => {
    const client = new HeuristicSupervisorClient();

    const decision = await client.decide({
      taskInstruction: "산업기능요원의 해외여행 허가 서류를 찾아서 정리해줘",
      conversationHistory: [],
      recentLogs: [],
      anomalies: [],
      browserState: {
        pageKind: "search_results",
        url: "https://www.google.com/search?q=산업기능요원+해외여행+허가+서류",
        title: "산업기능요원 해외여행 허가 서류 - Google Search",
        domainTrust: "low",
      },
      triggeredBy: "time",
      occurredAt: "2026-03-18T10:00:00Z",
    });

    assert.equal(decision.action, "feedback");
    assert.match(decision.suggestion ?? "", /authoritative|search engines/i);
  });

  it("pushes the actor into synthesis after reaching a trustworthy source", async () => {
    const client = new HeuristicSupervisorClient();

    const decision = await client.decide({
      taskInstruction: "산업기능요원의 해외여행 허가 서류를 찾아서 정리하고 초안 문서를 전달해줘",
      conversationHistory: [],
      recentLogs: [
        createBrowserLog("open https://www.mma.go.kr"),
        createBrowserLog("snapshot"),
        createBrowserLog("open https://www.mma.go.kr/contents.do?mc=mma0000789"),
        createBrowserLog("snapshot"),
      ],
      anomalies: [],
      browserState: {
        pageKind: "article",
        url: "https://www.mma.go.kr/contents.do?mc=mma0000789",
        title: "전문연구.산업기능요원 국외출장 등 - 병무청",
        domainTrust: "high",
      },
      triggeredBy: "time",
      occurredAt: "2026-03-18T10:00:00Z",
    });

    assert.equal(decision.action, "feedback");
    assert.match(decision.suggestion ?? "", /synthesis|drafting|trustworthy source/i);
  });
});

function createBrowserLog(input: string) {
  return {
    step: 1,
    timestamp: "2026-03-18T10:00:00Z",
    tool: "agent-browser" as const,
    input,
    output: "ok",
    durationMs: 1,
    status: "ok" as const,
  };
}
