import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createDefaultConfig,
  loadConfig,
} from "../src/config/load-config.js";

describe("loadConfig", () => {
  it("returns defaults when the config file is missing", async () => {
    const config = await loadConfig("./missing-config.json");
    assert.equal(config.runtime.provider, "pi");
    assert.equal(config.actor.codingAgent.provider, "codex");
    assert.equal(config.supervisor.client, "mock");
    assert.equal(config.runtime.bootstrap.enabled, true);
  });

  it("merges json overrides onto defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: {
            provider: "pi",
            bootstrap: {
              enabled: false,
              commands: ["custom-bootstrap --start"],
              retryBackoffMs: 50,
            },
          },
          actor: {
            codingAgent: {
              provider: "claude",
            },
          },
          supervisor: {
            client: "openai-compatible",
            openaiCompatible: {
              enabled: true,
              baseUrl: "https://example.invalid/v1",
              model: "gpt-4.1-mini",
            },
          },
          batch: {
            maxSteps: 9,
          },
          alerts: {
            enableTerminalBell: true,
            channels: {
              terminal: {
                enabled: true,
              },
              voiceCall: {
                enabled: true,
                recipient: "+15551234567",
                providerCommandTemplate: ["openclaw", "voice-call", "--to", "{recipient}"],
              },
            },
          },
          channels: {
            adapters: {
              discord: {
                inbound: {
                  mode: "gateway",
                  tokenEnvVar: "CUSTOM_DISCORD_TOKEN",
                  allowedChannels: ["guild:g-1/channel:c-1"],
                  allowedUsers: ["user-9"],
                  mentionPrefix: "@lumo",
                },
              },
              telegram: {
                inbound: {
                  allowedChatIds: ["777"],
                  allowedUserIds: ["42"],
                  mentionPrefix: "@lumo",
                  timeoutSeconds: 5,
                },
              },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      const defaults = createDefaultConfig();

      assert.equal(config.runtime.provider, "pi");
      assert.equal(config.runtime.bootstrap.enabled, false);
      assert.deepEqual(config.runtime.bootstrap.commands, ["custom-bootstrap --start"]);
      assert.equal(config.runtime.bootstrap.retryBackoffMs, 50);
      assert.equal(config.actor.codingAgent.provider, "claude");
      assert.equal(config.supervisor.client, "openai-compatible");
      assert.equal(config.supervisor.openaiCompatible.enabled, true);
      assert.equal(config.batch.maxSteps, 9);
      assert.equal(config.batch.maxAgeMs, defaults.batch.maxAgeMs);
      assert.equal(config.alerts.enableTerminalBell, true);
      assert.equal(config.alerts.channels.terminal.enabled, true);
      assert.equal(config.alerts.channels.voiceCall.enabled, true);
      assert.equal(config.alerts.channels.voiceCall.recipient, "+15551234567");
      assert.deepEqual(config.alerts.channels.voiceCall.providerCommandTemplate, [
        "openclaw",
        "voice-call",
        "--to",
        "{recipient}",
      ]);
      assert.equal(config.channels.adapters.discord.inbound.mode, "gateway");
      assert.equal(config.channels.adapters.discord.inbound.tokenEnvVar, "CUSTOM_DISCORD_TOKEN");
      assert.deepEqual(config.channels.adapters.discord.inbound.allowedChannels, ["guild:g-1/channel:c-1"]);
      assert.deepEqual(config.channels.adapters.discord.inbound.allowedUsers, ["user-9"]);
      assert.equal(config.channels.adapters.discord.inbound.mentionPrefix, "@lumo");
      assert.deepEqual(config.channels.adapters.telegram.inbound.allowedChatIds, ["777"]);
      assert.deepEqual(config.channels.adapters.telegram.inbound.allowedUserIds, ["42"]);
      assert.equal(config.channels.adapters.telegram.inbound.mentionPrefix, "@lumo");
      assert.equal(config.channels.adapters.telegram.inbound.timeoutSeconds, 5);
      assert.equal(config.channels.intentRouting.modelResolver, "mock");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives default command metadata from resolver fallback logic", () => {
    const config = createDefaultConfig({
      resolveBinary: (candidates) => candidates[0] === "pi"
        ? { candidate: "pi", path: "/usr/local/bin/pi" }
        : undefined,
    });

    assert.equal(config.actor.browserRunner.metadata?.mode, "mock");
    assert.equal(config.actor.codingAgent.commands.codex.metadata?.mode, "mock");
    assert.equal(config.runtime.provider, "pi");
    assert.equal(config.runtime.bootstrap.enabled, true);
    assert.deepEqual(config.runtime.bootstrap.commands, ["pi --version", "pi doctor"]);
    assert.equal(config.supervisor.openaiCompatible.enabled, false);
    assert.deepEqual(config.channels.commandMapping.resume, ["resume"]);
    assert.equal(config.channels.intentRouting.startTaskConfidenceThreshold, 0.7);
  });

  it("parses discord gateway inbound defaults from env", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_RUNTIME_PROVIDER: "pi",
        LUMO_RUNTIME_AUTO_BOOTSTRAP: "false",
        LUMO_RUNTIME_BOOTSTRAP_COMMANDS: "pi --version ;; pi doctor",
        LUMO_RUNTIME_BOOTSTRAP_RETRY_BACKOFF_MS: "25",
        LUMO_CHANNELS_DISCORD_INBOUND_MODE: "gateway",
        LUMO_CHANNELS_DISCORD_BOT_TOKEN_ENV_VAR: "DISCORD_TOKEN",
        LUMO_CHANNELS_DISCORD_ALLOWED_CHANNELS: "guild:g-1/channel:c-1,thread:t-1",
        LUMO_CHANNELS_DISCORD_ALLOWED_USERS: "user-1,user-2",
        LUMO_CHANNELS_DISCORD_MENTION_PREFIX: "@lumo",
        LUMO_CHANNELS_TELEGRAM_ALLOWED_CHAT_IDS: "777,888",
        LUMO_CHANNELS_TELEGRAM_ALLOWED_USER_IDS: "42,43",
        LUMO_CHANNELS_TELEGRAM_MENTION_PREFIX: "/lumo",
        LUMO_CHANNELS_TELEGRAM_TIMEOUT_SECONDS: "5",
        LUMO_ALERTS_VOICE_CALL_RECIPIENT: "+15551234567",
        LUMO_ALERTS_VOICE_CALL_COMMAND_TEMPLATE: "openclaw,voice-call,--to,{recipient}",
      },
      resolveBinary: () => undefined,
    });

    assert.equal(config.runtime.provider, "pi");
    assert.equal(config.runtime.bootstrap.enabled, false);
    assert.deepEqual(config.runtime.bootstrap.commands, ["pi --version", "pi doctor"]);
    assert.equal(config.runtime.bootstrap.retryBackoffMs, 25);
    assert.equal(config.channels.adapters.discord.inbound.mode, "gateway");
    assert.equal(config.channels.adapters.discord.inbound.tokenEnvVar, "DISCORD_TOKEN");
    assert.deepEqual(config.channels.adapters.discord.inbound.allowedChannels, [
      "guild:g-1/channel:c-1",
      "thread:t-1",
    ]);
    assert.deepEqual(config.channels.adapters.discord.inbound.allowedUsers, ["user-1", "user-2"]);
    assert.equal(config.channels.adapters.discord.inbound.mentionPrefix, "@lumo");
    assert.deepEqual(config.channels.adapters.telegram.inbound.allowedChatIds, ["777", "888"]);
    assert.deepEqual(config.channels.adapters.telegram.inbound.allowedUserIds, ["42", "43"]);
    assert.equal(config.channels.adapters.telegram.inbound.mentionPrefix, "/lumo");
    assert.equal(config.channels.adapters.telegram.inbound.timeoutSeconds, 5);
    assert.equal(config.alerts.channels.voiceCall.recipient, "+15551234567");
    assert.deepEqual(config.alerts.channels.voiceCall.providerCommandTemplate, [
      "openclaw",
      "voice-call",
      "--to",
      "{recipient}",
    ]);
  });

  it("supports anthropic-compatible supervisor defaults and overrides", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-anthropic-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          supervisor: {
            client: "anthropic-compatible",
            anthropicCompatible: {
              enabled: true,
              baseUrl: "https://ccapi.labs.mengmota.com/anthropic/v1",
              model: "claude-opus-4-6",
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      assert.equal(config.supervisor.client, "anthropic-compatible");
      assert.equal(config.supervisor.anthropicCompatible.enabled, true);
      assert.equal(config.supervisor.anthropicCompatible.baseUrl, "https://ccapi.labs.mengmota.com/anthropic/v1");
      assert.equal(config.supervisor.anthropicCompatible.model, "claude-opus-4-6");
      assert.equal(config.supervisor.anthropicCompatible.timeoutMs, 30_000);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to standard anthropic env vars for anthropic-compatible supervisor auth", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_SUPERVISOR_ANTHROPIC_ENABLED: "true",
        ANTHROPIC_API_KEY: "anthropic-test-token",
      },
      resolveBinary: () => undefined,
    });

    assert.equal(config.supervisor.anthropicCompatible.enabled, true);
    assert.equal(config.supervisor.anthropicCompatible.apiKey, "anthropic-test-token");
  });

  it("falls back to ccapi env vars for anthropic-compatible supervisor auth", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_SUPERVISOR_ANTHROPIC_ENABLED: "true",
        CCAPI_API_KEY: "ccapi-test-token",
      },
      resolveBinary: () => undefined,
    });

    assert.equal(config.supervisor.anthropicCompatible.enabled, true);
    assert.equal(config.supervisor.anthropicCompatible.apiKey, "ccapi-test-token");
  });

  it("supports agentika A2A defaults and env overrides", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_AGENTIKA_A2A: "1",
        LUMO_AGENTIKA_EVENT_BUS: "0",
        LUMO_AGENTIKA_URL: "http://127.0.0.1:7201",
        LUMO_AGENTIKA_TOKEN: "secret",
        LUMO_AGENTIKA_POLL_INTERVAL_MS: "250",
        LUMO_AGENTIKA_BINARY: " /tmp/agentika ",
        LUMO_AGENTIKA_DATA_DIR: " .custom-agentika ",
      },
      resolveBinary: () => undefined,
    });

    assert.equal(config.agentika.enabled, true);
    assert.equal(config.agentika.eventBus, false);
    assert.equal(config.agentika.baseUrl, "http://127.0.0.1:7201");
    assert.equal(config.agentika.token, "secret");
    assert.equal(config.agentika.pollIntervalMs, 250);
    assert.equal(config.agentika.binaryPath, "/tmp/agentika");
    assert.equal(config.agentika.dataDir, ".custom-agentika");
  });

  it("defaults agentika event bus to the A2A enabled value", () => {
    const enabledConfig = createDefaultConfig({
      env: {
        LUMO_AGENTIKA_A2A: "1",
      },
      resolveBinary: () => undefined,
    });
    const disabledConfig = createDefaultConfig({
      env: {},
      resolveBinary: () => undefined,
    });

    assert.equal(enabledConfig.agentika.eventBus, true);
    assert.equal(disabledConfig.agentika.eventBus, false);
  });

  it("supports legacy agentika shadow env var as an event bus alias", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_AGENTIKA_SHADOW: "1",
      },
      resolveBinary: () => undefined,
    });

    assert.equal(config.agentika.enabled, false);
    assert.equal(config.agentika.eventBus, true);
  });

  it("merges agentika config file overrides", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-agentika-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          agentika: {
            enabled: true,
            eventBus: true,
            baseUrl: "http://127.0.0.1:7300",
            token: "file-token",
            pollIntervalMs: 333,
            binaryPath: "/opt/agentika",
            dataDir: ".agentika-store",
          },
        }),
      );

      const config = await loadConfig(configPath);
      assert.equal(config.agentika.enabled, true);
      assert.equal(config.agentika.eventBus, true);
      assert.equal(config.agentika.baseUrl, "http://127.0.0.1:7300");
      assert.equal(config.agentika.token, "file-token");
      assert.equal(config.agentika.pollIntervalMs, 333);
      assert.equal(config.agentika.binaryPath, "/opt/agentika");
      assert.equal(config.agentika.dataDir, ".agentika-store");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tolerates legacy actor.model-only overrides", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-model-migration-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          actor: {
            model: "gpt-4.1",
          },
        }),
      );

      const config = await loadConfig(configPath);
      assert.equal(config.actor.codingAgent.provider, "codex");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported runtime provider values from env", () => {
    assert.throws(
      () => createDefaultConfig({
        env: {
          LUMO_RUNTIME_PROVIDER: "legacy",
        },
        resolveBinary: () => undefined,
      }),
      /Lumo now requires runtime\.provider to be "pi"/i,
    );
  });

  it("rejects unsupported runtime provider values from config files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: {
            provider: "legacy",
          },
        }),
      );

      await assert.rejects(
        () => loadConfig(configPath),
        /Unsupported runtime\.provider "legacy" in config/i,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
