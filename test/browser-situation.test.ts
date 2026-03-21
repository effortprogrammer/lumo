import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichBrowserSituation } from "../src/runtime/browser-situation.js";
import { type LogBatch } from "../src/logging/log-batcher.js";

describe("enrichBrowserSituation", () => {
  it("captures browser state and marks meaningful browser progress as advancing", () => {
    const enriched = enrichBrowserSituation(createBatch(), "2026-03-15T11:00:03Z");

    assert.equal(enriched.browserState?.url, "https://openai.com/careers");
    assert.equal(enriched.browserState?.title, "Careers at OpenAI");
    assert.equal(enriched.browserState?.pageKind, "job_listing");
    assert.equal(enriched.browserProgress?.state, "advancing");
    assert.equal(enriched.browserProgress?.goalRelevance, "high");
    assert.match(enriched.browserProgress?.summary ?? "", /currently on/i);
  });

  it("explains browser command failures using the current page context", () => {
    const enriched = enrichBrowserSituation(createFailureBatch(), "2026-03-15T11:00:03Z");

    assert.equal(enriched.browserProgress?.state, "stalled");
    assert.match(enriched.browserProgress?.reason ?? "", /matched multiple elements/i);
    assert.match(enriched.browserProgress?.summary ?? "", /selector ambiguity/i);
    assert.match(enriched.browserProgress?.recommendedNext ?? "", /snapshot/i);
  });

  it("marks weak search-result pages as low-trust stalled browsing", () => {
    const enriched = enrichBrowserSituation(createWeakSearchBatch(), "2026-03-15T11:00:03Z");

    assert.equal(enriched.browserState?.domainTrust, "low");
    assert.equal(enriched.browserProgress?.sourceTrust, "low");
    assert.equal(enriched.browserProgress?.state, "stalled");
    assert.match(enriched.browserProgress?.recommendedNext ?? "", /official|authoritative/i);
  });

  it("classifies government pages as high-trust article-like sources", () => {
    const enriched = enrichBrowserSituation({
      taskInstruction: "산업기능요원의 해외여행 허가 서류를 정리해줘",
      conversationHistory: [],
      triggeredBy: "manual",
      anomalies: [],
      batch: [{
        step: 1,
        timestamp: "2026-03-15T11:00:01Z",
        tool: "agent-browser",
        input: "open https://www.mma.go.kr/contents.do?mc=mma0000789",
        output: { title: "전문연구.산업기능요원 국외출장 등 - 병무청" },
        durationMs: 200,
        status: "ok",
        metadata: {
          url: "https://www.mma.go.kr/contents.do?mc=mma0000789",
          title: "전문연구.산업기능요원 국외출장 등 - 병무청",
        },
      }],
    }, "2026-03-15T11:00:03Z");

    assert.equal(enriched.browserState?.pageKind, "article");
    assert.equal(enriched.browserState?.domainTrust, "high");
    assert.equal(enriched.browserProgress?.goalRelevance, "high");
  });
});

function createBatch(): LogBatch {
  return {
    taskInstruction: "google 들어가서 openai 공고를 확인하고 이력서 초안을 만들어줘",
    conversationHistory: [],
    triggeredBy: "manual",
    anomalies: [],
    batch: [
      {
        step: 1,
        timestamp: "2026-03-15T11:00:01Z",
        tool: "agent-browser",
        input: "open https://openai.com/careers",
        output: {
          title: "Careers at OpenAI",
        },
        durationMs: 200,
        status: "ok",
        metadata: {
          url: "https://openai.com/careers",
          title: "Careers at OpenAI",
          browserAction: "open",
        },
      },
      {
        step: 2,
        timestamp: "2026-03-15T11:00:02Z",
        tool: "agent-browser",
        input: "snapshot",
        output: {
          title: "Careers at OpenAI",
        },
        durationMs: 220,
        status: "ok",
        metadata: {
          url: "https://openai.com/careers",
          title: "Careers at OpenAI",
          browserAction: "snapshot",
        },
      },
    ],
  };
}

function createFailureBatch(): LogBatch {
  return {
    taskInstruction: "google 들어가서 openai 공고를 확인하고 이력서 초안을 만들어줘",
    conversationHistory: [],
    triggeredBy: "manual",
    anomalies: [],
    batch: [
      {
        step: 1,
        timestamp: "2026-03-15T11:00:01Z",
        tool: "agent-browser",
        input: "open https://openai.com/careers",
        output: {
          title: "Careers at OpenAI",
        },
        durationMs: 200,
        status: "ok",
        metadata: {
          url: "https://openai.com/careers",
          title: "Careers at OpenAI",
          browserAction: "open",
        },
      },
      {
        step: 2,
        timestamp: "2026-03-15T11:00:02Z",
        tool: "agent-browser",
        input: "click e11",
        output: '✗ Selector "e11" matched 2 elements. Run \'snapshot\' to get updated refs, or use a more specific CSS selector.',
        durationMs: 220,
        status: "error",
        metadata: {
          url: "https://openai.com/careers",
          title: "Careers at OpenAI",
          browserAction: "click",
        },
      },
    ],
  };
}

function createWeakSearchBatch(): LogBatch {
  return {
    taskInstruction: "산업기능요원의 해외여행 허가 서류를 찾아서 정리해줘",
    conversationHistory: [],
    triggeredBy: "manual",
    anomalies: [],
    batch: [
      {
        step: 1,
        timestamp: "2026-03-15T11:00:01Z",
        tool: "agent-browser",
        input: "open https://www.google.com/search?q=산업기능요원+해외여행+허가+서류",
        output: {
          title: "산업기능요원 해외여행 허가 서류 - Google Search",
        },
        durationMs: 200,
        status: "ok",
        metadata: {
          url: "https://www.google.com/search?q=산업기능요원+해외여행+허가+서류",
          title: "산업기능요원 해외여행 허가 서류 - Google Search",
        },
      },
    ],
  };
}
