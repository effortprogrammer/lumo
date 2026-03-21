import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCompletionSignal,
  createCompletionState,
  extractCompletionSignalsFromConversation,
  extractCompletionSignalsFromTool,
  inferCompletionContract,
} from "../src/completion/contract.js";

describe("completion contract inference", () => {
  it("infers summary-response requirements for summary-only tasks", () => {
    const contract = inferCompletionContract("산업기능요원 출국 절차를 조사해서 정리해줘");

    assert.equal(contract.requiresArtifacts, false);
    assert.deepEqual(contract.requiredSignals, ["summary_response"]);
  });

  it("infers recommendation requirements for decision tasks", () => {
    const contract = inferCompletionContract("지금 어떤 방식으로 출시하는 게 좋을지 추천해줘");

    assert.ok(contract.requiredSignals.includes("recommendation"));
  });

  it("infers code-change requirements for implementation tasks", () => {
    const contract = inferCompletionContract("로그인 버그를 수정해줘");

    assert.ok(contract.requiredSignals.includes("code_change"));
  });

  it("marks summary completion when the actor emits a substantive final response", () => {
    const contract = inferCompletionContract("출장 준비 절차를 정리해줘");
    const state = createCompletionState(contract);
    const signals = extractCompletionSignalsFromConversation(
      "산업기능요원이 해외 출국 전에 준비해야 할 절차를 정리하면 다음과 같습니다. 먼저 허가 신청 시점을 확인하고, 다음으로 필요한 제출 서류를 회사와 병무청 기준으로 나눠 준비해야 합니다. 마지막으로 허가 승인 후 출력물과 여권을 함께 챙기는 것이 안전합니다.",
    );

    const next = signals.reduce(
      (current, signal) => applyCompletionSignal(current, signal, "2026-03-21T00:00:00Z"),
      state,
    );

    assert.equal(next.satisfied, true);
    assert.deepEqual(next.missingSignals, []);
  });

  it("extracts code-change completion signals from successful coding-agent writes", () => {
    const signals = extractCompletionSignalsFromTool({
      step: 1,
      timestamp: "2026-03-21T00:00:00Z",
      tool: "coding-agent",
      input: '{"path":"/tmp/app.ts","content":"fix"}',
      output: "Successfully wrote 120 bytes to /tmp/app.ts",
      durationMs: 1,
      status: "ok",
    });

    assert.deepEqual(signals, ["code_change"]);
  });
});
