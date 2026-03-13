import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string }): Promise<CommandResult>;
}

export class SubprocessCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options?: { cwd?: string },
  ): Promise<CommandResult> {
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: unknown) => {
        stdout += String(chunk);
      });

      child.stderr.on("data", (chunk: unknown) => {
        stderr += String(chunk);
      });

      child.on("error", (error: unknown) => {
        reject(error);
      });

      child.on("close", (exitCode: unknown) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: typeof exitCode === "number" ? exitCode : null,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
