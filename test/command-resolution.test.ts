import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/config/load-config.js";
import { resolveBinaryCommand } from "../src/runtime/command-resolution.js";

describe("command resolution", () => {
  it("resolves the first available binary from PATH order", () => {
    const resolved = resolveBinaryCommand(["agent-browser", "fallback-browser"], {
      env: {
        PATH: "/usr/local/bin:/opt/bin",
      },
      isExecutable: (path) => path === "/opt/bin/fallback-browser",
    });

    assert.deepEqual(resolved, {
      candidate: "fallback-browser",
      path: "/opt/bin/fallback-browser",
    });
  });

  it("falls back to mock command specs when binaries are unavailable", () => {
    const config = createDefaultConfig({
      resolveBinary: () => undefined,
    });

    assert.equal(config.actor.browserRunner.command, process.execPath);
    assert.equal(config.actor.browserRunner.metadata?.mode, "mock");
    assert.equal(config.actor.codingAgent.commands.codex.metadata?.mode, "mock");
  });

  it("uses detected binaries for browser and coding agent defaults", () => {
    const config = createDefaultConfig({
      resolveBinary: (candidates) => {
        if (candidates.includes("agent-browser")) {
          return {
            candidate: "agent-browser",
            path: "/usr/local/bin/agent-browser",
          };
        }

        if (candidates.includes("codex")) {
          return {
            candidate: "codex",
            path: "/usr/local/bin/codex",
          };
        }

        return undefined;
      },
    });

    assert.equal(config.actor.browserRunner.command, "/usr/local/bin/agent-browser");
    assert.equal(config.actor.browserRunner.metadata?.mode, "binary");
    assert.equal(config.actor.codingAgent.commands.codex.command, "/usr/local/bin/codex");
    assert.equal(config.actor.codingAgent.commands.codex.metadata?.mode, "binary");
    assert.equal(config.actor.codingAgent.commands.claude.metadata?.mode, "mock");
  });
});
