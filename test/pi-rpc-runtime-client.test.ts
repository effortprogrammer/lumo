import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiRpcCliArgs, buildPiRuntimeEnv } from "../src/runtime/pi-rpc-runtime-client.js";

describe("buildPiRpcCliArgs", () => {
  it("includes the restricted built-in tool set and appended browser policy prompt", () => {
    const args = buildPiRpcCliArgs({
      model: "zai/glm-5",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      appendSystemPrompt: "Use agent-browser via bash only.",
      extensions: ["/tmp/pi-agent-browser-extension.js"],
    });

    assert.deepEqual(args, [
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      "zai/glm-5",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--append-system-prompt",
      "Use agent-browser via bash only.",
      "--extension",
      "/tmp/pi-agent-browser-extension.js",
    ]);
  });
});

describe("buildPiRuntimeEnv", () => {
  it("injects the resolved agent-browser binary path for the pi browser extension", () => {
    const env = buildPiRuntimeEnv(
      { PATH: "/usr/bin" },
      "/opt/lumo/node_modules/.bin/agent-browser",
      "lumo-session-1",
      "/work/lumo",
    );

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.LUMO_AGENT_BROWSER_PATH, "/opt/lumo/node_modules/.bin/agent-browser");
    assert.equal(env.LUMO_AGENT_BROWSER_SESSION, "lumo-session-1");
    assert.equal(env.AGENT_BROWSER_PROFILE, "/work/lumo/.lumo/agent-browser-profile");
  });

  it("preserves explicit auto-connect env only when the caller opts in", () => {
    const env = buildPiRuntimeEnv(
      {
        PATH: "/usr/bin",
        AGENT_BROWSER_AUTO_CONNECT: "1",
      },
      "/opt/lumo/node_modules/.bin/agent-browser",
      "lumo-session-2",
      "/work/lumo",
    );

    assert.equal(env.AGENT_BROWSER_AUTO_CONNECT, "1");
  });
});
