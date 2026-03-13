export * from "./a2a/in-process-adapter.js";
export * from "./a2a/protocol.js";
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
export * from "./logging/log-batcher.js";
export * from "./setup/wizard.js";
export * from "./supervisor/decision.js";
export * from "./supervisor/model-client.js";
export * from "./supervisor/pipeline.js";
export * from "./runtime/actor-runtime.js";
export * from "./runtime/command-parser.js";
export * from "./runtime/command-resolution.js";
export * from "./runtime/runtime-session-adapter.js";
export * from "./runtime/session-manager.js";
export * from "./runtime/subprocess.js";

import { loadConfig } from "./config/load-config.js";
import { runTerminalLoop } from "./runtime/terminal-loop.js";
import { runSetupCli } from "./setup/wizard.js";

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "setup") {
      process.exitCode = await runSetupCli(args.slice(1));
      return;
    }

    const config = await loadConfig(args[0] ?? "lumo.config.json");
    await runTerminalLoop(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Lumo startup failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  void main();
}
