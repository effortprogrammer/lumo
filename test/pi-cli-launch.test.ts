import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDefaultConfig } from "../src/config/load-config.js";
import {
  createPiCliLaunchSpec,
  launchPiCli,
  preparePiLaunchEnvironment,
} from "../src/runtime/pi-cli-launch.js";

describe("createPiCliLaunchSpec", () => {
  it("resolves the pi CLI without overriding pi-managed model state", () => {
    const config = createDefaultConfig();

    const spec = createPiCliLaunchSpec(config, {
      PATH: "/usr/local/bin",
    }, "/tmp", () => ({ candidate: "pi", path: "/usr/local/bin/pi" }), false);

    assert.match(spec.command, /pi$/);
    assert.deepEqual(spec.args, []);
    assert.equal(spec.env.LUMO_LAUNCH_MODE, "pi-cli");
  });

  it("throws when the pi CLI cannot be resolved", () => {
    const config = createDefaultConfig();

    assert.throws(
      () => createPiCliLaunchSpec(config, { PATH: "" }, "/tmp/no-pi-here", () => undefined, false),
      /pi CLI is unavailable/i,
    );
  });

  it("falls back to the installed pi package CLI when .bin resolution is unavailable", () => {
    const config = createDefaultConfig();

    const spec = createPiCliLaunchSpec(
      config,
      { PATH: "" },
      "/tmp/no-direct-bin",
      () => undefined,
      false,
      () => "/opt/lumo/node_modules/@mariozechner/pi-coding-agent/dist/index.js",
      () => true,
    );

    assert.equal(spec.command, "/opt/lumo/node_modules/@mariozechner/pi-coding-agent/dist/cli.js");
  });

  it("prepares a fallback writable home and accepts env-based provider config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-pi-home-"));

    try {
      const env = {
        HOME: join(tempDir, "home"),
        OPENAI_API_KEY: "sk-test",
      };

      const result = await preparePiLaunchEnvironment(env, tempDir);

      assert.equal(result.providerConfigured, true);
      assert.equal(result.providerHint, "OPENAI_API_KEY");
      assert.equal(env.HOME, result.homeDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts pi settings/models file based configuration when env vars are missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-pi-home-files-"));
    const home = join(tempDir, "home");

    try {
      await mkdir(join(home, ".pi", "agent"), { recursive: true });
      await writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
        defaultProvider: "openai",
      }), "utf8");
      await writeFile(join(home, ".pi", "agent", "models.json"), JSON.stringify({
        openai: {
          models: ["gpt-4.1"],
        },
      }), "utf8");

      const env = { HOME: home };
      const result = await preparePiLaunchEnvironment(env, tempDir);

      assert.equal(result.providerConfigured, true);
      assert.equal(result.homeDir, home);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a friendly provider onboarding error when no provider is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-pi-home-missing-provider-"));

    try {
      const result = await preparePiLaunchEnvironment({ HOME: join(tempDir, "home") }, tempDir);
      assert.equal(result.providerConfigured, false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a friendly failure after onboarding launch when provider setup is still missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-pi-launch-missing-provider-"));

    try {
      const config = createDefaultConfig();
      const exitCode = await launchPiCli(config, {
        env: { HOME: join(tempDir, "home") },
        cwd: tempDir,
        spawnImpl: (() => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          queueMicrotask(() => child.emit("close", 0));
          return child as never;
        }) as typeof import("node:child_process").spawn,
      });

      assert.equal(exitCode, 1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-launches automatically after provider setup is detected", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-pi-launch-provider-success-"));
    const home = join(tempDir, "home");
    const spawns: number[] = [];

    try {
      const config = createDefaultConfig();
      const exitCode = await launchPiCli(config, {
        env: { HOME: home },
        cwd: tempDir,
        spawnImpl: (() => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          spawns.push(1);
          queueMicrotask(async () => {
            if (spawns.length === 1) {
              await mkdir(join(home, ".pi", "agent"), { recursive: true });
              await writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
                defaultProvider: "openai",
              }), "utf8");
            }
            child.emit("close", 0);
          });
          return child as never;
        }) as typeof import("node:child_process").spawn,
      });

      assert.equal(exitCode, 0);
      assert.equal(spawns.length, 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
