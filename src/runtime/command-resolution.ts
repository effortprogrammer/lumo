import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
