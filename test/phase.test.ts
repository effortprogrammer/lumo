import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessTaskPhase } from "../src/supervisor/phase.js";

describe("assessTaskPhase", () => {
  it("marks observation-heavy relevant pages as requirement_extraction with a synthesis recommendation", () => {
    const phase = assessTaskPhase({
      taskInstruction: "OpenAI 공고를 보고 필요한 역량을 정리하고 가상의 이력서를 작성해줘",
      browserState: {
        pageKind: "job_detail",
        title: "OpenAI Research Engineer",
      },
      browserProgress: {
        state: "unclear",
        goalRelevance: "high",
        reason: "The browser action completed, but no stable page context was extracted yet.",
        summary: "Browser progress is ambiguous because URL/title evidence is missing.",
        recommendedNext: "Capture a snapshot or query the current title/URL before proceeding.",
        observedAt: "2026-03-15T11:00:00Z",
      },
      recentLogs: [
        createBrowserLog("get url"),
        createBrowserLog("get title"),
        createBrowserLog("snapshot"),
      ],
    });

    assert.equal(phase.currentPhase, "requirement_extraction");
    assert.equal(phase.recommendation?.targetPhase, "synthesis");
  });

  it("promotes long relevant browsing sessions into requirement_extraction even without a pure observation loop", () => {
    const phase = assessTaskPhase({
      taskInstruction: "OpenAI 공고를 보고 필요한 역량을 정리하고 가상의 이력서를 작성해줘",
      browserState: {
        pageKind: "job_listing",
        title: "OpenAI Careers",
      },
      browserProgress: {
        state: "advancing",
        goalRelevance: "high",
        reason: "The browser state changed and produced new page context.",
        summary: "The browser is currently on OpenAI Careers (job_listing).",
        recommendedNext: "Continue extracting the needed information from the current page.",
        observedAt: "2026-03-15T11:00:00Z",
      },
      recentLogs: [
        createBrowserLog("open https://google.com"),
        createBrowserLog("fill q OpenAI careers"),
        createBrowserLog("click e16"),
        createBrowserLog("open https://openai.com/careers"),
        createBrowserLog("snapshot"),
        createBrowserLog("get title"),
      ],
    });

    assert.equal(phase.currentPhase, "requirement_extraction");
    assert.equal(phase.recommendation?.targetPhase, "synthesis");
  });

  it("keeps collection tasks in source_selection until enough distinct items are gathered", () => {
    const phase = assessTaskPhase({
      taskInstruction: "쿠팡에서 생수 상품 여러 개 가격을 비교하고 정렬해서 추천해줘",
      collectionState: {
        itemsCollected: 2,
        distinctItems: 1,
        fieldsSeen: ["name", "price"],
      },
      browserState: {
        pageKind: "search_results",
        title: "생수 검색 결과",
      },
      browserProgress: {
        state: "advancing",
        goalRelevance: "high",
        reason: "The browser state changed and produced new page context.",
        summary: "The browser is currently on a product listing page.",
        recommendedNext: "Continue collecting item data.",
        observedAt: "2026-03-15T11:00:00Z",
      },
      recentLogs: [
        createBrowserLog("open https://www.coupang.com"),
        createBrowserLog("get text body", "제주삼다수 18,000원"),
        createBrowserLog("snapshot"),
      ],
    });

    assert.equal(phase.currentPhase, "source_selection");
    assert.equal(phase.recommendation, undefined);
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
