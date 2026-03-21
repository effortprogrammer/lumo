import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import {
  resolveBinaryCommand,
  resolveBinaryCommandFromModule,
  type BinaryResolver,
} from "./command-resolution.js";
import { type LumoConfig } from "../config/load-config.js";

const DEFAULT_CLI_CANDIDATES = [
  "pi",
  "./node_modules/.bin/pi",
] as const;

export interface PiCliLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface PiLaunchPreflight {
  homeDir: string;
  usedFallbackHome: boolean;
  providerConfigured: boolean;
  providerHint?: string;
}

export function createPiCliLaunchSpec(
  config: LumoConfig,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  resolveBinary: BinaryResolver = resolveBinaryCommand,
  allowModuleFallback = true,
  resolvePackageEntry: (packageName: string) => string | undefined = defaultResolvePackageEntry,
  pathExists: (path: string) => boolean = existsSync,
): PiCliLaunchSpec {
  const resolved = resolveBinary(DEFAULT_CLI_CANDIDATES, {
    cwd,
    env,
  }) ?? (allowModuleFallback
    ? resolveBinaryCommandFromModule(["pi"], import.meta.url, {
      env,
    })
    : undefined);
  const packageCliPath = resolved?.path
    ? undefined
    : resolvePiCliFromInstalledPackage(resolvePackageEntry("@mariozechner/pi-coding-agent"), pathExists);

  if (!resolved?.path && !packageCliPath) {
    throw new Error("pi CLI is unavailable");
  }

  return {
    command: resolved?.path ?? packageCliPath!,
    args: [],
    env: {
      ...env,
      LUMO_LAUNCH_MODE: "pi-cli",
    },
  };
}

function defaultResolvePackageEntry(packageName: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(packageName);
  } catch {
    return undefined;
  }
}

function resolvePiCliFromInstalledPackage(
  packageEntry: string | undefined,
  pathExists: (path: string) => boolean,
): string | undefined {
  if (!packageEntry) {
    return undefined;
  }
  const candidate = join(dirname(packageEntry), "cli.js");
  return pathExists(candidate) ? candidate : undefined;
}

export async function launchPiCli(
  config: LumoConfig,
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    spawnImpl?: typeof spawn;
  } = {},
): Promise<number> {
  const launchEnv = { ...(options.env ?? process.env) };
  const preflight = await preparePiLaunchEnvironment(
    launchEnv,
    options.cwd ?? process.cwd(),
  );
  const spec = createPiCliLaunchSpec(config, launchEnv, options.cwd ?? process.cwd());
  const spawnImpl = options.spawnImpl ?? spawn;

  if (!preflight.providerConfigured) {
    console.log("No model provider is configured yet.");
    console.log("Lumo will open the runtime so you can complete provider setup first.");
  }

  const runPiProcess = async (): Promise<number> => await new Promise<number>((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      cwd: options.cwd ?? process.cwd(),
      env: spec.env,
      stdio: ["inherit", "inherit", "inherit"],
    });

    child.on("error", (error: unknown) => {
      reject(error);
    });

    child.on("close", (exitCode: unknown) => {
      resolve(typeof exitCode === "number" ? exitCode : 1);
    });
  });
  const exitCode = await runPiProcess();

  if (!preflight.providerConfigured) {
    const configuredAfterLaunch = await isProviderConfigured(launchEnv, preflight.homeDir);
    if (!configuredAfterLaunch) {
      console.error("Provider setup was not completed. Re-run `lumo` after connecting a model provider.");
      return exitCode === 0 ? 1 : exitCode;
    }

    console.log("Provider setup detected. Re-launching Lumo now.");
    return await runPiProcess();
  }

  return exitCode;
}

export async function preparePiLaunchEnvironment(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<PiLaunchPreflight> {
  const homeResolution = await resolveWritablePiHome(env, cwd);
  env.HOME = homeResolution.homeDir;
  const piAgentDir = join(homeResolution.homeDir, ".pi", "agent");
  await mkdir(piAgentDir, { recursive: true });

  const providerConfigured = await isProviderConfigured(env, homeResolution.homeDir);

  return {
    homeDir: homeResolution.homeDir,
    usedFallbackHome: homeResolution.usedFallbackHome,
    providerConfigured,
    providerHint: configuredProviderHint(env),
  };
}

async function resolveWritablePiHome(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ homeDir: string; usedFallbackHome: boolean }> {
  const requestedHome = env.HOME?.trim();
  if (requestedHome) {
    const ok = await ensureWritableDirectory(requestedHome);
    if (ok) {
      return {
        homeDir: requestedHome,
        usedFallbackHome: false,
      };
    }
  }

  const fallbackHome = resolve(cwd, ".lumo-runtime-home");
  const ok = await ensureWritableDirectory(fallbackHome);
  if (!ok) {
    throw new Error("Lumo could not prepare a writable runtime home directory.");
  }

  return {
    homeDir: fallbackHome,
    usedFallbackHome: true,
  };
}

async function ensureWritableDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isProviderConfigured(
  env: Record<string, string | undefined>,
  homeDir: string,
): Promise<boolean> {
  if (configuredProviderHint(env)) {
    return true;
  }

  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const modelsPath = join(homeDir, ".pi", "agent", "models.json");
  const [settings, models] = await Promise.all([
    readJsonIfPresent(settingsPath),
    readJsonIfPresent(modelsPath),
  ]);

  const hasDefaultProvider = isRecord(settings) && typeof settings.defaultProvider === "string";
  const hasModels = isRecord(models) && Object.keys(models).length > 0;
  return hasDefaultProvider || hasModels;
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function configuredProviderHint(env: Record<string, string | undefined>): string | undefined {
  if (env.OPENAI_API_KEY) return "OPENAI_API_KEY";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.GOOGLE_API_KEY || env.GEMINI_API_KEY) return env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "GEMINI_API_KEY";
  if (env.OPENROUTER_API_KEY) return "OPENROUTER_API_KEY";
  if (env.OLLAMA_HOST) return "OLLAMA_HOST";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
