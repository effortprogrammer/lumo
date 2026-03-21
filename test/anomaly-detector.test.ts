import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeuristicRuntimeAnomalyDetector } from "../src/runtime/anomaly-detector.js";
import { type RuntimeAnomalyDetectorContext } from "../src/runtime/anomaly-detector.js";

describe("HeuristicRuntimeAnomalyDetector", () => {
  it("detects repeated browser actions as browser_stuck", () => {
    const detector = new HeuristicRuntimeAnomalyDetector();
    const anomalies = detector.detect(createContext({
      now: "2026-03-14T11:00:10Z",
      recentLogs: [
        createLog(1, "agent-browser", "click #login", "2026-03-14T11:00:01Z"),
        createLog(2, "agent-browser", "click #login", "2026-03-14T11:00:02Z"),
        createLog(3, "agent-browser", "click #login", "2026-03-14T11:00:03Z"),
        createLog(4, "agent-browser", "click #login", "2026-03-14T11:00:04Z"),
      ],
      lastToolProgressAt: "2026-03-14T11:00:04Z",
    }));

    assert.equal(anomalies[0]?.kind, "browser_stuck");
    assert.equal(anomalies[0]?.severity, "critical");
  });

  it("detects retry loops from repeated failing logs", () => {
    const detector = new HeuristicRuntimeAnomalyDetector();
    const anomalies = detector.detect(createContext({
      now: "2026-03-14T11:00:10Z",
      recentLogs: [
        createLog(1, "bash", "curl https://api.example.com", "2026-03-14T11:00:01Z", "error"),
        createLog(2, "bash", "curl https://api.example.com", "2026-03-14T11:00:02Z", "error"),
        createLog(3, "bash", "curl https://api.example.com", "2026-03-14T11:00:03Z", "error"),
      ],
      lastToolProgressAt: "2026-03-14T11:00:03Z",
    }));

    assert.ok(anomalies.some((anomaly) => anomaly.kind === "retry_loop"));
  });

  it("detects no_progress when the runtime stalls while still running", () => {
    const detector = new HeuristicRuntimeAnomalyDetector({ noProgressMs: 5_000 });
    const anomalies = detector.detect(createContext({
      now: "2026-03-14T11:00:10Z",
      recentLogs: [
        createLog(1, "coding-agent", "summarize repo", "2026-03-14T11:00:01Z"),
      ],
      lastToolProgressAt: "2026-03-14T11:00:01Z",
    }));

    assert.ok(anomalies.some((anomaly) => anomaly.kind === "no_progress"));
  });
});

function createContext(overrides: {
  now: string;
  recentLogs: Array<ReturnType<typeof createLog>>;
  lastToolProgressAt?: string;
}): RuntimeAnomalyDetectorContext {
  return {
    now: overrides.now,
    snapshot: {
      taskId: "task-1",
      sessionId: "session-1",
      currentStep: overrides.recentLogs.at(-1)?.step ?? 0,
      status: "running",
      lastUpdatedAt: overrides.lastToolProgressAt ?? overrides.now,
      lastToolProgressAt: overrides.lastToolProgressAt,
      latestTool: overrides.recentLogs.at(-1)?.tool,
      latestInput: overrides.recentLogs.at(-1)?.input,
    },
    recentLogs: overrides.recentLogs,
    recentConversation: [],
  };
}

function createLog(
  step: number,
  tool: "bash" | "agent-browser" | "coding-agent",
  input: string,
  timestamp: string,
  status: "ok" | "error" = "ok",
) {
  return {
    step,
    timestamp,
    tool,
    input,
    output: status === "error" ? "failure" : "ok",
    durationMs: 10,
    exitCode: status === "error" ? 1 : 0,
    status,
  };
}
