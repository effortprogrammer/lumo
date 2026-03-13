import { type ActorToolName } from "../domain/task.js";

export interface ParsedActorCommand {
  tool: ActorToolName;
  input: string;
}

const prefixes: Array<{ prefix: string; tool: ActorToolName }> = [
  { prefix: "/bash ", tool: "bash" },
  { prefix: "bash: ", tool: "bash" },
  { prefix: "/browser ", tool: "agent-browser" },
  { prefix: "browser: ", tool: "agent-browser" },
  { prefix: "/agent ", tool: "coding-agent" },
  { prefix: "agent: ", tool: "coding-agent" },
];

export function parseActorInstruction(text: string): ParsedActorCommand[] {
  const commands: ParsedActorCommand[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const prefixed = prefixes.find(({ prefix }) => line.startsWith(prefix));
    if (prefixed) {
      commands.push({
        tool: prefixed.tool,
        input: line.slice(prefixed.prefix.length).trim(),
      });
      continue;
    }

    commands.push({
      tool: "coding-agent",
      input: line,
    });
  }

  return commands;
}
