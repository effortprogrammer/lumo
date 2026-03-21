import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../src/runtime/pi-agent-browser-extension.js";

describe("pi-agent-browser-extension", () => {
  it("passes explicit CLI arguments and session name to agent-browser", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const tool = registerTestTool({
      async exec(executable, args) {
        calls.push({ executable, args });
        return {
          stdout: '{"title":"Smoke"}',
          stderr: "",
          code: 0,
          killed: false,
        };
      },
    });

    process.env.LUMO_AGENT_BROWSER_PATH = "/opt/lumo/node_modules/.bin/agent-browser";
    process.env.LUMO_AGENT_BROWSER_SESSION = "lumo-session-123";

    const result = await tool.execute("call-1", {
      command: 'open "https://example.com"',
    }, undefined, undefined, {});

    assert.deepEqual(calls, [{
      executable: "/opt/lumo/node_modules/.bin/agent-browser",
      args: ["--session", "lumo-session-123", "open", "https://example.com"],
    }]);
    assert.deepEqual(result.details, {
      command: 'open "https://example.com"',
      executable: "/opt/lumo/node_modules/.bin/agent-browser",
      sessionName: "lumo-session-123",
      args: ["--session", "lumo-session-123", "open", "https://example.com"],
      stdout: '{"title":"Smoke"}',
      stderr: "",
      exitCode: 0,
      action: "open",
      url: "https://example.com",
      title: "Smoke",
    });
  });

  it("throws when agent-browser exits with a non-zero status", async () => {
    const tool = registerTestTool({
      async exec() {
        return {
          stdout: "",
          stderr: "navigation failed",
          code: 1,
          killed: false,
        };
      },
    });

    await assert.rejects(
      () => tool.execute("call-2", { command: "get title" }, undefined, undefined, {}),
      /navigation failed/i,
    );
  });
});

function registerTestTool(pi: {
  exec: (executable: string, args: string[], options?: unknown) => Promise<{
    stdout?: string;
    stderr?: string;
    code: number;
    killed?: boolean;
  }>;
}) {
  let registeredTool: any;
  extension({
    ...pi,
    registerTool(tool: unknown) {
      registeredTool = tool;
    },
  } as any);

  return registeredTool;
}
