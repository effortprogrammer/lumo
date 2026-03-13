declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  execPath: string;
  exitCode?: number;
  stdin: unknown;
  stdout?: {
    isTTY?: boolean;
    write: (text: string) => void;
  };
};

declare module "node:process" {
  export const stdin: unknown;
  export const stdout: {
    isTTY?: boolean;
    write: (text: string) => void;
  };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function spawn(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdio?: [string, string, string];
    },
  ): {
    stdout: {
      on: (event: string, listener: (chunk: unknown) => void) => void;
    };
    stderr: {
      on: (event: string, listener: (chunk: unknown) => void) => void;
    };
    on: (event: string, listener: (value: unknown) => void) => void;
  };
}

declare module "node:readline/promises" {
  export function createInterface(options: {
    input: unknown;
    output: unknown;
  }): {
    question(prompt: string): Promise<string>;
    close(): void;
  };
}

declare module "react" {
  const React: {
    createElement: (...args: unknown[]) => unknown;
  };

  export default React;
}

declare module "ink" {
  export const Box: unknown;
  export const Text: unknown;
  export const Newline: unknown;
  export function render(tree: unknown): void;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal: (actual: unknown, expected: unknown, message?: string) => void;
    deepEqual: (actual: unknown, expected: unknown, message?: string) => void;
    ok: (value: unknown, message?: string) => void;
    match: (actual: string, expected: RegExp, message?: string) => void;
    throws: (fn: () => void, expected?: RegExp | object, message?: string) => void;
    rejects: (
      fn: () => Promise<unknown>,
      expected?: RegExp | object,
      message?: string,
    ) => Promise<void>;
  };

  export default assert;
}
