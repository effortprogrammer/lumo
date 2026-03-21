import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent-browser",
    label: "Agent Browser",
    description: "Run browser automation through the external agent-browser CLI using explicit command syntax such as `open <url>`, `get title`, `click <selector>`, `snapshot`, or `get text <selector>`.",
    parameters: Type.Object({
      command: Type.String({ description: "Exact agent-browser CLI command, for example `open https://example.com`, `get title`, or `click button.submit`." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const executable = process.env.LUMO_AGENT_BROWSER_PATH?.trim() || "agent-browser";
      const sessionName = process.env.LUMO_AGENT_BROWSER_SESSION?.trim();
      const command = typeof (params as { command?: unknown }).command === "string"
        ? (params as { command: string }).command.trim()
        : "";
      if (command.length === 0) {
        throw new Error("agent-browser command is required and must use CLI syntax such as `open <url>` or `get title`.");
      }

      const commandArgs = parseAgentBrowserCommand(command);
      const args = [
        ...(sessionName ? ["--session", sessionName] : []),
        ...commandArgs,
      ];
      onUpdate?.({
        content: [{ type: "text", text: `Running ${executable}: ${args.join(" ")}` }],
        details: { command, executable, sessionName, args },
      });

      const result = await pi.exec(executable, args, { signal });
      const stdout = result.stdout?.trim() ?? "";
      const stderr = result.stderr?.trim() ?? "";
      if (result.code !== 0) {
        throw new Error(
          stderr
            || stdout
            || `agent-browser exited with code ${result.code}`,
        );
      }
      const text = stdout || stderr || `agent-browser exited with code ${result.code}`;
      const parsed = parseAgentBrowserOutput(stdout);
      const normalizedDetails = normalizeAgentBrowserDetails(commandArgs, stdout);

      return {
        content: [{ type: "text", text }],
        details: {
          command,
          executable,
          sessionName,
          args,
          stdout,
          stderr,
          exitCode: result.code,
          ...normalizedDetails,
          ...parsed,
        },
      };
    },
  });
}

function parseAgentBrowserOutput(stdout: string): Record<string, unknown> {
  if (stdout.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

function parseAgentBrowserCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === "\"" || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function normalizeAgentBrowserDetails(
  commandArgs: string[],
  stdout: string,
): Record<string, unknown> {
  const [command, ...args] = commandArgs;
  if (!command) {
    return {};
  }

  if (command === "open" && args[0]) {
    return {
      action: "open",
      url: args[0],
    };
  }

  if (command === "get" && args[0] === "title") {
    return {
      action: "get title",
      title: stdout.trim() || undefined,
    };
  }

  if (command === "get" && args[0] === "url") {
    return {
      action: "get url",
      url: stdout.trim() || undefined,
    };
  }

  if (command === "snapshot") {
    return {
      action: "snapshot",
    };
  }

  if (command === "click") {
    return {
      action: "click",
      target: args[0],
    };
  }

  if (command === "fill" || command === "type") {
    return {
      action: command,
      target: args[0],
    };
  }

  return {
    action: command,
  };
}
