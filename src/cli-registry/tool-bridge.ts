import type { CliManifest } from "./manifest.js";
import { CliRegistry } from "./registry.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: false;
  };
  metadata: {
    registryCli: string;
    command: string;
    capabilities: string[];
    language: "python";
    entrypoint: string;
  };
}

function interfaceToProperties(manifest: CliManifest, command: string): ToolDefinition["inputSchema"] {
  const definition = manifest.interface[command];
  const properties: ToolDefinition["inputSchema"]["properties"] = {};

  for (const argument of definition.args) {
    properties[argument] = {
      type: "string",
      description: `CLI argument for ${manifest.name} ${command}: ${argument}`,
    };
  }

  if (definition.flags.some((flag) => flag.includes("--limit"))) {
    properties.limit = {
      type: "number",
      description: "Maximum number of results to return",
    };
  }

  if (definition.flags.some((flag) => flag.includes("--type"))) {
    properties.type = {
      type: "string",
      description: "Search subtype accepted by the CLI",
    };
  }

  if (definition.flags.some((flag) => flag.includes("--json"))) {
    properties.json = {
      type: "boolean",
      description: "Force JSON output from the CLI",
    };
  }

  return {
    type: "object",
    properties,
    required: [...definition.args],
    additionalProperties: false,
  };
}

export function registryToTools(registry: CliRegistry): ToolDefinition[] {
  return registry.list().flatMap((summary) => {
    const manifest = registry.get(summary.name);
    if (!manifest) {
      return [];
    }

    return Object.keys(manifest.interface)
      .sort()
      .map((command) => ({
        name: `${manifest.name}.${command}`,
        description: manifest.interface[command].description,
        inputSchema: interfaceToProperties(manifest, command),
        metadata: {
          registryCli: manifest.name,
          command,
          capabilities: [...manifest.capabilities],
          language: manifest.language,
          entrypoint: manifest.entrypoint,
        },
      }));
  });
}
