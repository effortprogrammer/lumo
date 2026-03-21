import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessBottleneck } from "../src/supervisor/bottleneck.js";

describe("assessBottleneck", () => {
  it("classifies selector ambiguity as a recoverable selector_ambiguity bottleneck", () => {
    const bottleneck = assessBottleneck({
      anomalies: [],
      browserProgress: {
        state: "stalled",
        goalRelevance: "high",
        reason: 'The browser command `click e11` failed because the selector matched multiple elements on Careers at OpenAI.',
        summary: 'Browser execution is stalled because selector ambiguity prevented `click e11` from choosing a single target on Careers at OpenAI.',
        recommendedNext: "Capture a fresh snapshot and switch to a more specific selector or element ref before retrying.",
        observedAt: "2026-03-15T11:00:03Z",
      },
      browserState: {
        pageKind: "job_listing",
        title: "Careers at OpenAI",
      },
      recentLogs: [],
      taskInstruction: "google 들어가서 openai 공고를 보고 이력서를 작성해줘",
    });

    assert.equal(bottleneck?.kind, "selector_ambiguity");
    assert.equal(bottleneck?.recoverable, true);
    assert.equal(bottleneck?.recoveryPlan.action, "retry_with_refined_selector");
  });

  it("classifies no progress on a relevant job page as research_without_synthesis", () => {
    const bottleneck = assessBottleneck({
      anomalies: [
        {
          id: "anomaly-no-progress",
          kind: "no_progress",
          severity: "warning",
          message: "The task has not made measurable progress within the expected interval.",
          taskId: "task-1",
          occurredAt: "2026-03-15T11:05:00Z",
        },
      ],
      browserProgress: {
        state: "advancing",
        goalRelevance: "high",
        reason: "The browser state changed and produced new page context.",
        summary: "The browser is currently on OpenAI Job Detail (job_detail).",
        recommendedNext: "Continue extracting the needed information from the current page.",
        observedAt: "2026-03-15T11:05:00Z",
      },
      browserState: {
        pageKind: "job_detail",
        title: "OpenAI Job Detail",
      },
      recentLogs: [],
      taskInstruction: "OpenAI 공고를 보고 필요한 역량을 정리하고 가상의 이력서를 작성해줘",
    });

    assert.equal(bottleneck?.kind, "research_without_synthesis");
    assert.equal(bottleneck?.recoveryPlan.action, "switch_to_synthesis");
  });

  it("classifies repeated page-state checks on a relevant page as research_without_synthesis", () => {
    const bottleneck = assessBottleneck({
      anomalies: [],
      browserProgress: {
        state: "unclear",
        goalRelevance: "high",
        reason: "The browser action completed, but no stable page context was extracted yet.",
        summary: "Browser progress is ambiguous because URL/title evidence is missing.",
        recommendedNext: "Capture a snapshot or query the current title/URL before proceeding.",
        observedAt: "2026-03-15T11:05:00Z",
      },
      browserState: {
        pageKind: "job_detail",
        title: "OpenAI Job Detail",
      },
      recentLogs: [
        createBrowserLog("get url"),
        createBrowserLog("get title"),
        createBrowserLog("snapshot"),
      ],
      taskInstruction: "OpenAI 공고를 보고 필요한 역량을 정리하고 가상의 이력서를 작성해줘",
    });

    assert.equal(bottleneck?.kind, "research_without_synthesis");
    assert.equal(bottleneck?.recoveryPlan.action, "switch_to_synthesis");
  });

  it("does not force synthesis early for collection tasks that have too few distinct items", () => {
    const bottleneck = assessBottleneck({
      anomalies: [
        {
          id: "anomaly-no-progress",
          kind: "no_progress",
          severity: "warning",
          message: "The task has not made measurable progress within the expected interval.",
          taskId: "task-1",
          occurredAt: "2026-03-15T11:05:00Z",
        },
      ],
      browserProgress: {
        state: "advancing",
        goalRelevance: "high",
        reason: "The browser state changed and produced new page context.",
        summary: "The browser is currently on a product listing page.",
        recommendedNext: "Continue collecting item data.",
        observedAt: "2026-03-15T11:05:00Z",
      },
      browserState: {
        pageKind: "search_results",
        title: "생수 검색 결과",
      },
      collectionState: {
        itemsCollected: 2,
        distinctItems: 1,
        fieldsSeen: ["name", "price"],
      },
      recentLogs: [
        createBrowserLog("get text body", "제주삼다수 18,000원"),
        createBrowserLog("snapshot"),
      ],
      taskInstruction: "쿠팡에서 생수 상품 여러 개 가격을 비교하고 정렬해서 추천해줘",
    });

    assert.notEqual(bottleneck?.kind, "research_without_synthesis");
  });

  it("classifies repeated weak-search visits as weak_source_churn", () => {
    const bottleneck = assessBottleneck({
      anomalies: [],
      browserProgress: {
        state: "stalled",
        goalRelevance: "low",
        sourceTrust: "low",
        reason: "The actor is still on a weak search-results page instead of a trustworthy source.",
        summary: "The browser is currently on Google Search (search_results, trust=low).",
        recommendedNext: "Prefer an official or directly relevant source instead of continuing to bounce across search engines.",
        observedAt: "2026-03-15T11:05:00Z",
      },
      browserState: {
        pageKind: "search_results",
        title: "산업기능요원 해외여행 허가 서류 - Google Search",
        url: "https://www.google.com/search?q=산업기능요원+해외여행+허가+서류",
        domainTrust: "low",
      },
      recentLogs: [
        createSearchLog("https://www.google.com/search?q=산업기능요원+해외여행+허가+서류"),
        createSearchLog("https://www.bing.com/search?q=산업기능요원+해외여행+허가+서류"),
        createSearchLog("https://search.naver.com/search.naver?query=산업기능요원+해외여행+허가+서류"),
      ],
      taskInstruction: "산업기능요원의 해외여행 허가 서류를 찾아서 정리해줘",
    });

    assert.equal(bottleneck?.kind, "weak_source_churn");
    assert.equal(bottleneck?.recoveryPlan.action, "prefer_official_source");
  });
});

function createBrowserLog(input: string, output = "") {
  return {
    step: 1,
    timestamp: "2026-03-15T11:00:00Z",
    tool: "agent-browser" as const,
    input,
    output,
    durationMs: 1,
    status: "ok" as const,
  };
}

function createSearchLog(url: string) {
  return {
    step: 1,
    timestamp: "2026-03-15T11:00:00Z",
    tool: "agent-browser" as const,
    input: `open ${url}`,
    output: "ok",
    durationMs: 1,
    status: "ok" as const,
    metadata: { url },
  };
}
