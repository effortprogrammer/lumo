import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CliManifest } from "../cli-registry/manifest.js";

export interface PiAgentRegistryExtensionSourceOptions {
  registryPath: string;
  manifests: CliManifest[];
  registryModuleSpecifier?: string;
}

export interface PiAgentRegistryExtensionFile {
  directoryPath: string;
  extensionPath: string;
  source: string;
}

export function buildPiAgentRegistryExtensionSource(
  options: PiAgentRegistryExtensionSourceOptions,
): string {
  const registryModuleSpecifier = options.registryModuleSpecifier
    ?? pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../cli-registry/registry.js")).href;
  const serializedManifests = JSON.stringify(options.manifests, null, 2);
  const serializedRegistryPath = JSON.stringify(resolve(options.registryPath));

  return `import { Type } from "@mariozechner/pi-ai";
import { CliRegistry } from ${JSON.stringify(registryModuleSpecifier)};

const embeddedManifests = ${serializedManifests};
const registryPath = ${serializedRegistryPath};

function interfaceToProperties(manifest, command) {
  const definition = manifest.interface[command];
  const properties = {};

  for (const argument of definition.args) {
    properties[argument] = {
      type: "string",
      description: \`CLI argument for \${manifest.name} \${command}: \${argument}\`,
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

function manifestsToTools(manifests) {
  return [...manifests]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((manifest) =>
      Object.keys(manifest.interface)
        .sort()
        .map((command) => ({
          name: \`\${manifest.name}_\${command}\`,
          description: manifest.interface[command].description,
          inputSchema: interfaceToProperties(manifest, command),
          metadata: {
            registryCli: manifest.name,
            command,
            positionalArgs: manifest.interface[command].args,
          },
        })),
    );
}

function schemaPropertyToTypeBox(key, property) {
  if (property.type === "number") {
    return Type.Number({ description: property.description || \`\${key} parameter\` });
  }
  if (property.type === "boolean") {
    return Type.Boolean({ description: property.description || \`\${key} parameter\` });
  }
  return Type.String({ description: property.description || \`\${key} parameter\` });
}

function paramsToCliArgs(params, positionalArgNames) {
  const result = [];
  const entries = Object.entries(params || {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== false,
  );
  for (const [key, value] of entries) {
    if (positionalArgNames.includes(key)) {
      result.push(String(value));
    } else if (value === true) {
      result.push(\`--\${key}\`);
    } else {
      result.push(\`--\${key}\`, String(value));
    }
  }
  return result;
}

export default async function (pi) {
  const registry = new CliRegistry(registryPath);
  await registry.discover();

  for (const toolDef of manifestsToTools(embeddedManifests)) {
    pi.registerTool({
      name: toolDef.name,
      label: toolDef.name,
      description: toolDef.description,
      parameters: Type.Object(
        Object.fromEntries(
          Object.entries(toolDef.inputSchema.properties).map(([key, property]) => [
            key,
            schemaPropertyToTypeBox(key, property),
          ]),
        ),
      ),
      async execute(toolCallId, params, signal, onUpdate) {
        const cliArgs = paramsToCliArgs(params, toolDef.metadata.positionalArgs);
        onUpdate?.({
          content: [{ type: "text", text: \`Running \${toolDef.metadata.registryCli} \${toolDef.metadata.command} \${cliArgs.join(" ")}\` }],
        });

        const result = await registry.invoke(toolDef.metadata.registryCli, toolDef.metadata.command, cliArgs);
        const stdout = result.stdout?.trim() ?? "";
        const stderr = result.stderr?.trim() ?? "";
        const text = stdout || stderr || \`CLI exited with code \${result.exitCode}\`;
        if (result.exitCode !== 0) {
          throw new Error(stderr || stdout || text);
        }

        return {
          content: [{ type: "text", text }],
          details: {
            toolCallId,
            registryCli: toolDef.metadata.registryCli,
            command: toolDef.metadata.command,
            args: cliArgs,
            stdout,
            stderr,
            exitCode: result.exitCode,
            parsed: result.parsed,
          },
        };
      },
    });
  }
}
`;
}

export function createPiAgentRegistryExtensionFile(
  registryPath: string,
  options?: { baseDir?: string; registryModuleSpecifier?: string },
): PiAgentRegistryExtensionFile {
  const manifests = discoverRegistryManifests(resolve(registryPath));
  return createPiAgentRegistryExtensionFileFromManifests({
    registryPath,
    manifests,
    baseDir: options?.baseDir,
    registryModuleSpecifier: options?.registryModuleSpecifier,
  });
}

export function createPiAgentRegistryExtensionFileFromManifests(options: {
  registryPath: string;
  manifests: CliManifest[];
  baseDir?: string;
  registryModuleSpecifier?: string;
}): PiAgentRegistryExtensionFile {
  const baseDir = options.baseDir ?? tmpdir();
  mkdirSync(baseDir, { recursive: true });
  const directoryPath = mkdtempSync(join(baseDir, "lumo-registry-ext-"));
  const extensionPath = join(directoryPath, "pi-agent-registry-extension.js");
  const source = buildPiAgentRegistryExtensionSource({
    registryPath: options.registryPath,
    manifests: options.manifests,
    registryModuleSpecifier: options.registryModuleSpecifier,
  });
  writeFileSync(extensionPath, source, "utf8");
  return {
    directoryPath,
    extensionPath,
    source,
  };
}

export function resolvePiAgentRegistryExtensionBaseDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../.lumo/tmp");
}

function discoverRegistryManifests(registryPath: string): CliManifest[] {
  if (!existsSync(registryPath)) {
    return [];
  }

  const manifests: CliManifest[] = [];
  for (const entry of readdirSync(registryPath)) {
    if (entry.startsWith("_")) {
      continue;
    }
    const manifestPath = join(registryPath, entry, "manifest.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    manifests.push(JSON.parse(readFileSync(manifestPath, "utf8")) as CliManifest);
  }

  manifests.sort((left, right) => left.name.localeCompare(right.name));
  return manifests;
}
