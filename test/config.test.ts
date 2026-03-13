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
    assert.equal(config.runtime.provider, "pi-mono");
    assert.equal(config.actor.codingAgent.provider, "codex");
    assert.equal(config.supervisor.client, "mock");
  });

  it("merges json overrides onto defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-config-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          runtime: {
            provider: "pi-mono",
          },
          actor: {
            model: "custom-actor",
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

      assert.equal(config.runtime.provider, "pi-mono");
      assert.equal(config.actor.model, "custom-actor");
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
      resolveBinary: () => undefined,
    });

    assert.equal(config.actor.browserRunner.metadata?.mode, "mock");
    assert.equal(config.actor.codingAgent.commands.codex.metadata?.mode, "mock");
    assert.equal(config.runtime.provider, "pi-mono");
    assert.equal(config.supervisor.openaiCompatible.enabled, false);
    assert.deepEqual(config.channels.commandMapping.resume, ["resume"]);
    assert.equal(config.channels.intentRouting.startTaskConfidenceThreshold, 0.7);
  });

  it("parses discord gateway inbound defaults from env", () => {
    const config = createDefaultConfig({
      env: {
        LUMO_RUNTIME_PROVIDER: "pi-mono",
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

    assert.equal(config.runtime.provider, "pi-mono");
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

  it("rejects legacy runtime provider values from env", () => {
    assert.throws(
      () => createDefaultConfig({
        env: {
          LUMO_RUNTIME_PROVIDER: "legacy",
        },
        resolveBinary: () => undefined,
      }),
      /Lumo now requires runtime\.provider to be "pi-mono"/i,
    );
  });

  it("rejects legacy runtime provider values from config files", async () => {
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
