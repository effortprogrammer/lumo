import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ChannelBridge } from "../channels/bridge.js";
import { ConversationRouter } from "../channels/conversation-router.js";
import { createChannelAdapters } from "../channels/factory.js";
import { executeIntentEnvelope } from "../channels/intent-executor.js";
import { IntentResolverPipeline } from "../channels/intent-resolver.js";
import { type LumoConfig } from "../config/load-config.js";
import { type SupervisorDecision } from "../supervisor/decision.js";
import { SessionManager } from "./session-manager.js";


function writeOut(text: string): void {
  stdout?.write?.(text);
}
export async function runTerminalLoop(config: LumoConfig): Promise<void> {
  const sessionManager = await SessionManager.create(config);
  const adapters = createChannelAdapters(config);
  let router: ConversationRouter;
  router = new ConversationRouter({
    sessionManager,
    adapters,
    commandMapping: config.channels.commandMapping,
    startTaskConfidenceThreshold: config.channels.intentRouting.startTaskConfidenceThreshold,
    createSessionCallbacks: (): ReturnType<typeof createRuntimeCallbacks> =>
      createRuntimeCallbacks(router),
  });
  const intentResolver = new IntentResolverPipeline({
    commandMapping: config.channels.commandMapping,
    startTaskConfidenceThreshold: config.channels.intentRouting.startTaskConfidenceThreshold,
  });
  const bridge = new ChannelBridge(adapters, router);
  const rl = createInterface({ input: stdin, output: stdout as never });

  printBanner(config);

  try {
    await bridge.start();

    while (true) {
      const line = (await rl.question("lumo> ")).trim();
      if (line.length === 0) {
        continue;
      }

      if (line === "exit" || line === "quit") {
        break;
      }

      if (line === "help") {
        printHelp();
        continue;
      }

      if (line === "config") {
        printConfig(config);
        continue;
      }

      if (line === "logs") {
        printLogs(sessionManager);
        continue;
      }

      if (line === "bridge") {
        const handled = await bridge.pollOnce();
        writeOut(`bridge processed ${handled} inbound message(s)\n`);
        continue;
      }

      if (line.startsWith("provider ")) {
        const provider = line.slice("provider ".length).trim();
        if (provider === "codex" || provider === "claude" || provider === "opencode") {
          config.actor.codingAgent.provider = provider;
          writeOut(`coding agent provider set to ${provider}\n`);
        } else {
          writeOut("provider must be one of: codex, claude, opencode\n");
        }
        continue;
      }

      if (line.startsWith("supervisor ")) {
        const client = line.slice("supervisor ".length).trim();
        if (
          client === "mock" ||
          client === "heuristic" ||
          client === "openai-compatible"
        ) {
          config.supervisor.client = client;
          writeOut(`supervisor client set to ${client}\n`);
        } else {
          writeOut("supervisor must be one of: mock, heuristic, openai-compatible\n");
        }
        continue;
      }

      if (line === "smoke") {
        sessionManager.createTask(createSmokeDemoInstruction(), createRuntimeCallbacks(router));
        continue;
      }

      const envelope = await intentResolver.resolve(line, {
        hasActiveTask: Boolean(sessionManager.current),
        currentTaskId: sessionManager.current?.runtime.task.task.taskId ?? null,
      });
      try {
        const reply = await executeIntentEnvelope(envelope, {
          sessionManager,
          createSessionCallbacks: () => createRuntimeCallbacks(router),
        });
        writeOut(`${reply}\n`);
      } catch (error) {
        writeOut(`intent routing failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } finally {
    rl.close();
    await bridge.stop();
  }
}

function printBanner(config: LumoConfig): void {
  writeOut("Lumo Phase 10 CLI\n");
  writeOut(
    `runtime=pi-mono-only supervisor=${config.supervisor.client} actor-provider=${config.actor.codingAgent.provider}\n`,
  );
  printHelp();
}

function printHelp(): void {
  writeOut("conversation: type what you want done, or say things like \"what's the status?\", \"continue\", or \"stop this run\"\n");
  writeOut("cli commands: config | logs | bridge | provider <name> | supervisor <mode> | smoke | help | exit\n");
  writeOut("runtime: pi-mono is mandatory; startup fails if the pi-mono runtime health-check does not pass\n");
  writeOut("tool syntax inside a task: /bash <cmd>, /browser <cmd>, /agent <prompt>, or plain text for the coding agent\n");
}

function printLogs(sessionManager: SessionManager): void {
  const current = sessionManager.current;
  if (!current) {
    writeOut("no active task\n");
    return;
  }

  for (const record of current.runtime.actorLogs) {
    writeOut(formatLog(record));
  }

  for (const decision of current.decisions) {
    writeOut(formatDecision(decision));
  }
}

function printConfig(config: LumoConfig): void {
  const currentProvider = config.actor.codingAgent.provider;
  const currentAgentCommand = config.actor.codingAgent.commands[currentProvider];
  writeOut(`${JSON.stringify({
    actor: {
      provider: currentProvider,
      browserRunner: redactConfigMetadata(config.actor.browserRunner),
      codingAgentCommand: redactConfigMetadata(currentAgentCommand),
    },
    runtime: config.runtime,
    supervisor: {
      client: config.supervisor.client,
      openaiCompatible: {
        enabled: config.supervisor.openaiCompatible.enabled,
        configured: Boolean(
          config.supervisor.openaiCompatible.baseUrl &&
          config.supervisor.openaiCompatible.apiKey &&
          config.supervisor.openaiCompatible.model,
        ),
        baseUrl: config.supervisor.openaiCompatible.baseUrl,
        model: config.supervisor.openaiCompatible.model,
        timeoutMs: config.supervisor.openaiCompatible.timeoutMs,
      },
    },
    alerts: {
      enableTerminalBell: config.alerts.enableTerminalBell,
      channels: config.alerts.channels,
    },
    channels: config.channels,
  }, null, 2)}\n`);
}

function createRuntimeCallbacks(router: ConversationRouter) {
  return {
    onLog: (record: {
      step: number;
      tool: string;
      input: string;
      status?: string;
      durationMs: number;
    }) => {
      writeOut(formatLog(record));
    },
    onDecision: (decision: SupervisorDecision) => {
      writeOut(formatDecision(decision));
      void router.emitSupervisorAlert(decision);
    },
    onStatusChange: (status: "pending" | "running" | "paused" | "halted" | "completed" | "failed") => {
      writeOut(`status -> ${status}\n`);
      void router.emitTaskLifecycle(status);
    },
  };
}

function redactConfigMetadata(spec: { command: string; args: string[]; metadata?: Record<string, unknown> }) {
  return {
    command: spec.command,
    args: spec.args,
    metadata: spec.metadata,
  };
}

function formatLog(record: {
  step: number;
  tool: string;
  input: string;
  status?: string;
  durationMs: number;
}): string {
  return `log step=${record.step} tool=${record.tool} status=${record.status ?? "ok"} durationMs=${record.durationMs} input=${record.input}\n`;
}

function formatDecision(decision: SupervisorDecision): string {
  return `decision action=${decision.action} status=${decision.status} confidence=${decision.confidence.toFixed(2)} reason=${decision.reason}\n`;
}

function createSmokeDemoInstruction(): string {
  return [
    "/bash pwd",
    "/browser capture current page",
    "/agent summarize the repository status and next steps",
  ].join("\n");
}
