import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnthropicCompatibleSupervisorClient } from "../src/supervisor/model-client.js";

describe("AnthropicCompatibleSupervisorClient", () => {
  it("calls the anthropic-compatible messages endpoint and parses JSON text", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const client = new AnthropicCompatibleSupervisorClient({
      baseUrl: "https://ccapi.labs.mengmota.com/anthropic/v1",
      apiKey: "test-token",
      model: "claude-opus-4-6",
      systemPrompt: "Watch tool logs and stop unsafe or stuck behavior.",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body ?? ""),
        });
        return new Response(JSON.stringify({
          content: [
            {
              type: "text",
              text: `\`\`\`json\n${JSON.stringify({
                status: "warning",
                confidence: 0.91,
                reason: "Actor is looping.",
                suggestion: "Switch to synthesis.",
                action: "feedback",
              })}\n\`\`\``,
            },
          ],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const decision = await client.decide({
      taskInstruction: "inspect the browser workflow",
      conversationHistory: [],
      recentLogs: [],
      anomalies: [],
      triggeredBy: "manual",
      occurredAt: "2026-03-18T10:00:00Z",
    });

    assert.equal(calls[0]?.url, "https://ccapi.labs.mengmota.com/anthropic/v1/messages");
    assert.equal(calls[0]?.headers["x-api-key"], "test-token");
    assert.match(calls[0]?.body ?? "", /claude-opus-4-6/);
    assert.equal(decision.action, "feedback");
    assert.equal(decision.status, "warning");
  });
});
