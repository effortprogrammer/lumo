import { existsSync } from "node:fs";
export * from "./a2a/in-process-adapter.js";
export * from "./a2a/agentika-bridge.js";
export * from "./a2a/protocol.js";
export * from "./a2a/transport.js";
export * from "./alerts/dispatcher.js";
export * from "./alerts/create-dispatcher.js";
export * from "./channels/adapter.js";
export * from "./channels/bridge.js";
export * from "./channels/conversation-router.js";
export * from "./channels/discord-adapter.js";
export * from "./channels/factory.js";
export * from "./channels/intent-executor.js";
export * from "./channels/intent-resolver.js";
export * from "./channels/intent.js";
export * from "./channels/model.js";
export * from "./channels/telegram-adapter.js";
export * from "./config/load-config.js";
export * from "./domain/task.js";
export * from "./event/bus.js";
export * from "./event/types.js";
export * from "./event/agentika-adapter.js";
export * from "./logging/log-batcher.js";
export * from "./setup/wizard.js";
export * from "./supervisor/decision.js";
export * from "./supervisor/bottleneck.js";
export * from "./supervisor/contracts.js";
export * from "./supervisor/escalation-report.js";
export * from "./supervisor/engine.js";
export * from "./supervisor/phase.js";
export * from "./supervisor/model-client.js";
export * from "./supervisor/pipeline.js";
export * from "./runtime/anomaly-detector.js";
export * from "./runtime/browser-situation.js";
export * from "./runtime/pi-cli-launch.js";
export * from "./runtime/command-parser.js";
export * from "./runtime/command-resolution.js";
export * from "./runtime/runtime-session-adapter.js";
export * from "./runtime/session-manager.js";
export * from "./runtime/subprocess.js";
export * from "./runtime/task-pair-manager.js";
export * from "./runtime/task-pair-state.js";
export * from "./runtime/supervisor-session-bootstrap.js";
export * from "./runtime/pi-supervisor-session-bootstrapper.js";

import { loadConfig } from "./config/load-config.js";
import { launchPiCli } from "./runtime/pi-cli-launch.js";
import { SessionManager, type SessionRuntimeCallbacks } from "./runtime/session-manager.js";
import { runSetupCli } from "./setup/wizard.js";

interface ReadableStdin {
  isTTY?: boolean;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

interface WritableStreamLike {
  write: (text: string) => void;
}

export function getCliUsage(): string {
  return [
    "Usage: lumo <task-instruction>",
    "       lumo [config.json] <task-instruction>",
    "       lumo --config my-config.json <task-instruction>",
    "       echo 'task' | lumo",
    "",
    "Commands:",
    "  init                       Run guided first-time setup",
    "  setup                      Run setup explicitly",
    "  --help, -h                 Show this help",
    "",
    "Behavior:",
    "  - Running `lumo` starts the app with ./lumo.config.json by default.",
    "  - If the config file is missing, Lumo launches guided setup automatically.",
    "  - After setup, Lumo launches the pi CLI.",
  ].join("\n");
}

async function readInstructionFromStdin(): Promise<string> {
  const stdin = process.stdin as ReadableStdin;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "halted";
}

function writeStdout(text: string): void {
  const stdout = process.stdout as WritableStreamLike | undefined;
  stdout?.write(text);
}

function writeStderr(text: string): void {
  console.error(text.trimEnd());
}

export async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
      console.log(getCliUsage());
      process.exitCode = 0;
      return;
    }

    if (args[0] === "setup" || args[0] === "init") {
      process.exitCode = await runSetupCli(args.slice(1));
      return;
    }

    const defaultConfigPath = "lumo.config.json";
    let configPath: string;
    let instructionArgs: string[];

    // If first arg is a --config flag or an existing .json file, treat as config path
    if (args.length > 0 && args[0] === "--config") {
      configPath = args[1] ?? defaultConfigPath;
      instructionArgs = args.slice(2);
    } else if (args.length > 0 && args[0].endsWith(".json") && existsSync(args[0])) {
      configPath = args[0];
      instructionArgs = args.slice(1);
    } else {
      configPath = defaultConfigPath;
      instructionArgs = args;
    }

    if (!existsSync(configPath)) {
      console.log(`No config found at ${configPath}. Launching setup...`);
      const setupExitCode = await runSetupCli(["--config", configPath]);
      if (setupExitCode !== 0) {
        console.error("Setup cancelled. Run `lumo setup` to configure and try again.");
        process.exitCode = setupExitCode || 1;
        return;
      }
    }

    const config = await loadConfig(configPath);
    let instruction = instructionArgs.join(" ").trim();
    const stdin = process.stdin as ReadableStdin;
    if (!instruction && !stdin.isTTY) {
      instruction = await readInstructionFromStdin();
    }

    if (!instruction) {
      writeStderr("Usage: lumo <task-instruction>");
      writeStderr("       echo 'task' | lumo");
      process.exitCode = 1;
      return;
    }

    let sessionManager: SessionManager;
    try {
      sessionManager = await SessionManager.create(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(`Lumo runtime unavailable: ${message}`);
      process.exitCode = 1;
      return;
    }

    const callbacks: SessionRuntimeCallbacks = {
      onConversation: (turn) => {
        if (turn.role !== "actor" || !turn.text.trim()) {
          return;
        }
        writeStdout(`${turn.text}\n`);
      },
      onDecision: (decision) => {
        writeStderr(
          `supervisor: ${decision.status} | ${decision.action} | ${decision.reason}\n`,
        );
      },
      onSupervisorOutput: (output) => {
        if (!output.recoveryPlan?.instructions.length) {
          return;
        }
        writeStderr(
          `supervisor intervention: ${output.recoveryPlan.instructions.join("; ")}\n`,
        );
      },
      onLog: (record) => {
        if (process.env.LUMO_DEBUG !== "1") {
          return;
        }
        writeStderr(
          `[tool:${record.tool}] step=${record.step} status=${record.status} input=${(record.input ?? "").slice(0, 80)}\n`,
        );
      },
      onStatusChange: (status) => {
        writeStderr(`status: ${status}\n`);
      },
    };

    const session = sessionManager.createTask(instruction, callbacks);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const taskStatus = session.runtime.task.task.status;
        const actorStatus = session.pairState.actor.status;
        if (!isTerminalStatus(taskStatus) && !isTerminalStatus(actorStatus)) {
          return;
        }
        clearInterval(check);
        const terminalStatus = isTerminalStatus(taskStatus) ? taskStatus : actorStatus;
        process.exitCode = terminalStatus === "completed" ? 0 : 1;
        resolve();
      }, 2000);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lumo startup failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  void main();
}
