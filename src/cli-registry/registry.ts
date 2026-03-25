import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SubprocessCommandRunner, type CommandRunner } from "../runtime/subprocess.js";
import type {
  CliHealthStatus,
  CliManifest,
  CliResult,
  CliSummary,
} from "./manifest.js";

interface RegistryRecord {
  manifest: CliManifest;
  directoryPath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertManifest(value: unknown, source: string): CliManifest {
  if (!isObject(value)) {
    throw new Error(`Invalid manifest in ${source}: expected object`);
  }

  const requiredStringFields = ["name", "version", "description", "language", "entrypoint"] as const;
  for (const field of requiredStringFields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new Error(`Invalid manifest in ${source}: field '${field}' must be a non-empty string`);
    }
  }

  if (value.language !== "python") {
    throw new Error(`Invalid manifest in ${source}: only python CLIs are supported`);
  }

  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid manifest in ${source}: 'capabilities' must be a string array`);
  }

  if (!isObject(value.auth) || typeof value.auth.type !== "string" || typeof value.auth.refresh_strategy !== "string") {
    throw new Error(`Invalid manifest in ${source}: 'auth' is malformed`);
  }

  if (
    !isObject(value.health)
    || typeof value.health.consecutive_failures !== "number"
    || typeof value.health.failure_threshold !== "number"
  ) {
    throw new Error(`Invalid manifest in ${source}: 'health' is malformed`);
  }

  if (!isObject(value.interface)) {
    throw new Error(`Invalid manifest in ${source}: 'interface' must be an object`);
  }

  for (const [command, definition] of Object.entries(value.interface)) {
    if (
      !isObject(definition)
      || !Array.isArray(definition.args)
      || !Array.isArray(definition.flags)
      || typeof definition.description !== "string"
    ) {
      throw new Error(`Invalid manifest in ${source}: interface command '${command}' is malformed`);
    }
  }

  return value as unknown as CliManifest;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export class CliRegistry {
  private readonly registryPath: string;
  private readonly runner: CommandRunner;
  private readonly now: () => string;
  private readonly records = new Map<string, RegistryRecord>();

  constructor(
    registryPath: string,
    options?: { runner?: CommandRunner; now?: () => string },
  ) {
    this.registryPath = resolve(registryPath);
    this.runner = options?.runner ?? new SubprocessCommandRunner();
    this.now = options?.now ?? (() => new Date().toISOString());
  }

  async discover(): Promise<CliManifest[]> {
    this.records.clear();

    if (!existsSync(this.registryPath)) {
      return [];
    }

    const entries = await readdir(this.registryPath);
    const manifests: CliManifest[] = [];

    for (const entry of entries) {
      if (entry.startsWith("_")) {
        continue;
      }

      const directoryPath = join(this.registryPath, entry);
      const manifestPath = join(directoryPath, "manifest.json");
      if (!existsSync(manifestPath)) {
        continue;
      }

      const rawManifest = await readFile(manifestPath, "utf8");
      const manifest = assertManifest(JSON.parse(rawManifest), manifestPath);
      this.records.set(manifest.name, { manifest, directoryPath });
      manifests.push(manifest);
    }

    manifests.sort((left, right) => left.name.localeCompare(right.name));
    return manifests;
  }

  get(name: string): CliManifest | undefined {
    return this.records.get(name)?.manifest;
  }

  list(): CliSummary[] {
    return [...this.records.values()]
      .map(({ manifest, directoryPath }) => ({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        capabilities: [...manifest.capabilities],
        health: { ...manifest.health },
        path: directoryPath,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async invoke(name: string, command: string, args: string[]): Promise<CliResult> {
    const record = this.records.get(name);
    if (!record) {
      throw new Error(`CLI '${name}' is not registered`);
    }

    const entrypointPath = join(record.directoryPath, record.manifest.entrypoint);
    if (!existsSync(entrypointPath)) {
      throw new Error(`CLI '${name}' entrypoint does not exist: ${entrypointPath}`);
    }

    const result = await this.runner.run("python3", [entrypointPath, command, ...args], {
      cwd: record.directoryPath,
    });

    return {
      ...result,
      parsed: parseJsonOutput(result.stdout),
    };
  }

  async healthCheck(name: string): Promise<CliHealthStatus> {
    const result = await this.invoke(name, "health", ["--json"]);
    const ok = result.exitCode === 0;
    await this.updateHealth(name, ok);
    return this.records.get(name)?.manifest.health ?? {
      last_success: null,
      last_failure: null,
      consecutive_failures: 0,
      failure_threshold: 3,
    };
  }

  async updateHealth(name: string, success: boolean): Promise<void> {
    const record = this.records.get(name);
    if (!record) {
      throw new Error(`CLI '${name}' is not registered`);
    }

    const nextHealth: CliHealthStatus = {
      ...record.manifest.health,
      last_success: success ? this.now() : record.manifest.health.last_success,
      last_failure: success ? record.manifest.health.last_failure : this.now(),
      consecutive_failures: success ? 0 : record.manifest.health.consecutive_failures + 1,
    };

    record.manifest = {
      ...record.manifest,
      health: nextHealth,
    };
    this.records.set(name, record);

    const manifestPath = join(record.directoryPath, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(record.manifest, null, 2)}\n`, "utf8");
  }
}
