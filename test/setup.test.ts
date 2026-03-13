import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildSetupConfig,
  parseSetupCliArgs,
  resolveSetupAnswers,
  runSetupCli,
  shouldRunDiscordGatewayHealthcheck,
  type SetupCliOptions,
  writeSetupConfig,
} from "../src/setup/wizard.js";

describe("setup wizard", () => {
  it("generates config JSON from non-interactive flags", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      const exitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        configPath,
        "--actor-model",
        " actor-x ",
        "--supervisor-model",
        " supervisor-y ",
        "--supervisor-client",
        "heuristic",
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-webhook-url",
        " https://discord.example/webhook ",
        "--discord-token-env-var",
        " BOT_TOKEN ",
        "--discord-allowed-channels",
        " guild:1/channel:2 , thread:3 ",
        "--discord-allowed-users",
        " user-1 , user-2 ",
        "--discord-mention-prefix",
        " @lumo ",
        "--terminal-alerts",
        "true",
      ], {
        output: createWriter(),
        error: createWriter(),
      });

      assert.equal(exitCode, 0);

      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      assert.deepEqual(parsed, {
        actor: {
          model: "actor-x",
        },
        supervisor: {
          model: "supervisor-y",
          client: "heuristic",
          openaiCompatible: {
            enabled: false,
          },
        },
        alerts: {
          enableTerminalBell: true,
          channels: {
            terminal: {
              enabled: true,
            },
            discord: {
              enabled: true,
              webhookUrl: "https://discord.example/webhook",
            },
          },
          webhookUrl: "https://discord.example/webhook",
        },
        channels: {
          adapters: {
            discord: {
              enabled: true,
              webhookUrl: "https://discord.example/webhook",
              inbound: {
                mode: "gateway",
                filePath: "./.lumo/discord-inbound.jsonl",
                tokenEnvVar: "BOT_TOKEN",
                allowedChannels: ["guild:1/channel:2", "thread:3"],
                allowedUsers: ["user-1", "user-2"],
                mentionPrefix: "@lumo",
              },
            },
          },
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("guards overwrites unless force is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-overwrite-"));
    const configPath = join(tempDir, "lumo.config.json");

    try {
      await writeFile(configPath, "{\n  \"existing\": true\n}\n");

      await assert.rejects(
        () =>
          writeSetupConfig(
            configPath,
            buildSetupConfig(
              resolveSetupAnswers(createOptions({
                force: false,
                help: false,
                nonInteractive: true,
                configPath,
                actorModel: "actor",
                supervisorModel: "supervisor",
                supervisorClient: "mock",
                discordEnabled: "false",
                discordInboundMode: "file",
              })),
            ),
            {
              force: false,
            },
          ),
        /already exists/i,
      );

      const overwritten = await writeSetupConfig(
        configPath,
        buildSetupConfig(
          resolveSetupAnswers(createOptions({
            force: true,
            help: false,
            nonInteractive: true,
            configPath,
            actorModel: "actor-2",
            supervisorModel: "supervisor-2",
            supervisorClient: "mock",
            discordEnabled: "false",
            discordInboundMode: "file",
            enableTerminalAlerts: "false",
          })),
        ),
        {
          force: true,
        },
      );

      assert.equal(overwritten.overwritten, true);
      const raw = await readFile(configPath, "utf8");
      assert.match(raw, /actor-2/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses setup inputs and validates gateway requirements", () => {
    const options = parseSetupCliArgs([
      "--non-interactive",
      "--config",
      " ./custom.json ",
      "--actor-model",
      " local-actor ",
      "--supervisor-model",
      " supervisor ",
      "--supervisor-client",
      "openai-compatible",
      "--discord-enabled",
      "yes",
      "--discord-inbound-mode",
      "gateway",
      "--discord-token-env-var",
      " DISCORD_TOKEN ",
      "--discord-allowed-channels",
      " guild:1/channel:2 , thread:3 ",
      "--discord-allowed-users",
      " user-1 , user-2 ",
      "--discord-mention-prefix",
      " @lumo ",
      "--terminal-alerts",
      "no",
    ]);

    const answers = resolveSetupAnswers(options);
    assert.equal(answers.configPath, "./custom.json");
    assert.equal(answers.actorModel, "local-actor");
    assert.equal(answers.supervisorClient, "openai-compatible");
    assert.deepEqual(answers.allowedChannels, ["guild:1/channel:2", "thread:3"]);
    assert.deepEqual(answers.allowedUsers, ["user-1", "user-2"]);
    assert.equal(answers.mentionPrefix, "@lumo");
    assert.equal(answers.enableTerminalAlerts, false);

    assert.throws(
      () =>
        resolveSetupAnswers(createOptions({
          force: false,
          help: false,
          nonInteractive: true,
          configPath: "./lumo.config.json",
          actorModel: "actor",
          supervisorModel: "supervisor",
          supervisorClient: "mock",
          discordEnabled: "true",
          discordInboundMode: "gateway",
          tokenEnvVar: "   ",
          allowedChannels: "   ",
          enableTerminalAlerts: "false",
        })),
      /required when gateway mode is selected/i,
    );
  });

  it("defaults Discord gateway healthcheck on for interactive setup and off for non-interactive", () => {
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: false,
      }),
      true,
    );
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: true,
      }),
      false,
    );
    assert.equal(
      shouldRunDiscordGatewayHealthcheck({
        nonInteractive: true,
        discordGatewayHealthcheck: "true",
      }),
      true,
    );
  });

  it("reports Discord gateway healthcheck pass and fail without failing setup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-setup-healthcheck-"));
    const passPath = join(tempDir, "pass.config.json");
    const failPath = join(tempDir, "fail.config.json");

    try {
      const passWriter = createBufferingWriter();
      const passExitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        passPath,
        "--actor-model",
        "actor",
        "--supervisor-model",
        "supervisor",
        "--supervisor-client",
        "mock",
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-token-env-var",
        "BOT_TOKEN",
        "--discord-allowed-channels",
        "channel:1",
        "--discord-gateway-healthcheck",
        "true",
        "--terminal-alerts",
        "false",
      ], {
        env: {
          BOT_TOKEN: "secret",
        },
        output: passWriter,
        error: passWriter,
        discordGatewayHealthcheck: async (tokenEnvVar, token) => ({
          ok: true,
          detail: `${tokenEnvVar}:${token.length}`,
        }),
      });

      const failWriter = createBufferingWriter();
      const failExitCode = await runSetupCli([
        "--non-interactive",
        "--config",
        failPath,
        "--actor-model",
        "actor",
        "--supervisor-model",
        "supervisor",
        "--supervisor-client",
        "mock",
        "--discord-enabled",
        "true",
        "--discord-inbound-mode",
        "gateway",
        "--discord-token-env-var",
        "BOT_TOKEN",
        "--discord-allowed-channels",
        "channel:1",
        "--discord-gateway-healthcheck",
        "true",
        "--terminal-alerts",
        "false",
      ], {
        env: {
          BOT_TOKEN: "secret",
        },
        output: failWriter,
        error: failWriter,
        discordGatewayHealthcheck: async () => ({
          ok: false,
          detail: "HTTP 401 invalid token",
        }),
      });

      assert.equal(passExitCode, 0);
      assert.equal(failExitCode, 0);
      assert.match(passWriter.buffer, /PASS: BOT_TOKEN:6/);
      assert.match(failWriter.buffer, /FAIL: HTTP 401 invalid token/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createOptions(overrides: Partial<SetupCliOptions>): SetupCliOptions {
  return {
    force: false,
    help: false,
    nonInteractive: false,
    ...overrides,
  };
}

function createWriter(): { write: (_text: string) => void } {
  return {
    write(): void {},
  };
}

function createBufferingWriter(): { buffer: string; write: (text: string) => void } {
  return {
    buffer: "",
    write(text: string): void {
      this.buffer += text;
    },
  };
}
