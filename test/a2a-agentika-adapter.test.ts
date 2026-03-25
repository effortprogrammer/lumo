import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { AgentikaA2AAdapter } from "../src/a2a/agentika-adapter.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("AgentikaA2AAdapter", () => {
  it("publishes messages to the correct topic with the envelope idempotency key", async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const adapter = new AgentikaA2AAdapter({
      baseUrl: "http://127.0.0.1:7200",
      token: "dev",
      taskId: "task-123",
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
        });
        if (url.endsWith("/api/topics")) {
          return jsonResponse({}, { status: 201 });
        }
        return jsonResponse({}, { status: 201 });
      },
    });

    await adapter.sendMessage({
      id: "message-envelope-1",
      from: "actor",
      to: "supervisor",
      payload: {
        id: "message-1",
        taskId: "task-123",
        role: "assistant",
        parts: [{ kind: "text", text: "progress update" }],
        sentAt: "2026-03-24T00:00:00Z",
      },
    });

    assert.equal(requests[0]?.url.endsWith("/api/topics"), true);
    assert.equal(
      requests[1]?.url,
      "http://127.0.0.1:7200/api/topics/task.task-123.actor-progress/events",
    );
    assert.equal(requests[1]?.body?.type, "a2a.message");
    assert.equal(requests[1]?.body?.idempotency_key, "message-envelope-1");
  });

  it("auto-creates topics on start, polls messages, and acks successful delivery", async () => {
    const calls: string[] = [];
    const adapter = new AgentikaA2AAdapter({
      baseUrl: "http://127.0.0.1:7200",
      token: "dev",
      taskId: "task-123",
      pollIntervalMs: 10,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/topics")) {
          return jsonResponse({}, { status: 201 });
        }
        if (url.endsWith("/api/consumers")) {
          return jsonResponse({ id: "consumer-supervisor" }, { status: 201 });
        }
        if (url.includes("/next?limit=5")) {
          return jsonResponse({
            events: [{
              offset: "41",
              payload: {
                envelope: {
                  id: "progress-envelope-1",
                  from: "actor",
                  to: "supervisor",
                  payload: {
                    id: "progress-message-1",
                    taskId: "task-123",
                    role: "assistant",
                    parts: [{
                      kind: "text",
                      text: "browser advanced",
                    }],
                    sentAt: "2026-03-24T00:00:00Z",
                  },
                },
              },
            }],
          });
        }
        if (url.endsWith("/ack")) {
          return jsonResponse({}, { status: 200 });
        }
        return jsonResponse({ events: [] });
      },
    });

    let delivered = "";
    adapter.registerMessageHandler("supervisor", (envelope) => {
      delivered = envelope.payload.parts[0]?.kind === "text"
        ? envelope.payload.parts[0].text
        : "";
    });

    await adapter.start();
    await sleep(30);
    adapter.stop();

    assert.equal(delivered, "browser advanced");
    assert.equal(calls.filter((url) => url.endsWith("/api/topics")).length >= 3, true);
    assert.equal(calls.some((url) => url.endsWith("/api/consumers/consumer-supervisor/ack")), true);
  });

  it("nacks when a handler throws", async () => {
    const calls: string[] = [];
    const adapter = new AgentikaA2AAdapter({
      baseUrl: "http://127.0.0.1:7200",
      token: "dev",
      taskId: "task-123",
      pollIntervalMs: 10,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/topics")) {
          return jsonResponse({}, { status: 201 });
        }
        if (url.endsWith("/api/consumers")) {
          return jsonResponse({ id: "consumer-actor" }, { status: 201 });
        }
        if (url.includes("/next?limit=5")) {
          return jsonResponse({
            events: [{
              offset: "7",
              payload: {
                envelope: {
                  from: "supervisor",
                  to: "actor",
                  payload: {
                    taskId: "task-123",
                    reason: "stop",
                    requestedAt: "2026-03-24T00:00:01Z",
                  },
                },
              },
            }],
          });
        }
        if (url.endsWith("/nack")) {
          return jsonResponse({}, { status: 200 });
        }
        return jsonResponse({});
      },
    });

    adapter.registerCancelHandler("actor", () => {
      throw new Error("boom");
    });

    await adapter.start();
    await sleep(30);
    adapter.stop();

    assert.equal(calls.some((url) => url.endsWith("/api/consumers/consumer-actor/nack")), true);
  });

  it("publishes cancel requests to the cancel topic", async () => {
    const requests: string[] = [];
    const adapter = new AgentikaA2AAdapter({
      baseUrl: "http://127.0.0.1:7200",
      token: "dev",
      taskId: "task-123",
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        return jsonResponse({}, { status: 201 });
      },
    });

    await adapter.cancelTask({
      id: "cancel-envelope-1",
      from: "supervisor",
      to: "actor",
      payload: {
        taskId: "task-123",
        reason: "unsafe",
        requestedAt: "2026-03-24T00:00:00Z",
      },
    });

    assert.equal(
      requests.at(-1),
      "http://127.0.0.1:7200/api/topics/task.task-123.cancel/events",
    );
  });
});
