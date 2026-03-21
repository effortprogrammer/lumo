import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedBinary {
  candidate: string;
  path: string;
}

export interface BinaryResolverOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isExecutable?: (path: string) => boolean;
}

export type BinaryResolver = (
  candidates: readonly string[],
  options?: BinaryResolverOptions,
) => ResolvedBinary | undefined;

export const resolveBinaryCommand: BinaryResolver = (
  candidates,
  options = {},
) => {
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const env = options.env ?? process.env;
  const searchPath = env.PATH ?? "";
  const pathEntries = searchPath.split(":").filter(Boolean);
  const pathExts = [""];

  for (const candidate of candidates) {
    if (candidate.trim().length === 0) {
      continue;
    }

    if (candidate.includes("/") || candidate.includes("\\")) {
      const directPath = options.cwd ? resolve(options.cwd, candidate) : resolve(candidate);
      const executablePath = findExecutablePath(directPath, pathExts, isExecutable);
      if (executablePath) {
        return { candidate, path: executablePath };
      }
      continue;
    }

    for (const pathEntry of pathEntries) {
      const executablePath = findExecutablePath(
        join(pathEntry, candidate),
        pathExts,
        isExecutable,
      );
      if (executablePath) {
        return { candidate, path: executablePath };
      }
    }
  }

  return undefined;
};

function findExecutablePath(
  basePath: string,
  extensions: readonly string[],
  isExecutable: (path: string) => boolean,
): string | undefined {
  for (const extension of extensions) {
    const candidatePath = basePath.endsWith(extension) ? basePath : `${basePath}${extension}`;
    if (isExecutable(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

function defaultIsExecutable(path: string): boolean {
  return existsSync(path);
}


export function resolveBinaryCommandFromModule(
  candidates: readonly string[],
  moduleUrl: string,
  options: BinaryResolverOptions & { maxDepth?: number } = {},
): ResolvedBinary | undefined {
  const scopedCandidates = buildModuleBinaryCandidates(candidates, moduleUrl, options.maxDepth ?? 6);
  return resolveBinaryCommand(scopedCandidates, {
    ...options,
    cwd: undefined,
  });
}

export function buildModuleBinaryCandidates(
  candidates: readonly string[],
  moduleUrl: string,
  maxDepth = 6,
): string[] {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const searchRoots = collectAncestorDirectories(moduleDir, maxDepth);
  const scopedCandidates: string[] = [];

  for (const root of searchRoots) {
    for (const candidate of candidates) {
      if (candidate.trim().length === 0) {
        continue;
      }
      scopedCandidates.push(join(root, "node_modules", ".bin", candidate));
    }
  }

  return scopedCandidates;
}

function collectAncestorDirectories(start: string, maxDepth: number): string[] {
  const directories: string[] = [];
  let current = start;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}
