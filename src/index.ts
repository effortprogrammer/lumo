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
import { runSetupCli } from "./setup/wizard.js";

export function getCliUsage(): string {
  return [
    "Usage: lumo [config-path]",
    "       lumo <command>",
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

    const configPath = args[0] ?? "lumo.config.json";
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
    process.exitCode = await launchPiCli(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lumo startup failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  void main();
}
