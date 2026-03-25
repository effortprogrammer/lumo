export interface CliAuthConfig {
  type: "none" | "cookie" | "api-key" | "oauth";
  refresh_strategy: "none" | "manual" | "automatic";
}

export interface CliHealthStatus {
  last_success: string | null;
  last_failure: string | null;
  consecutive_failures: number;
  failure_threshold: number;
}

export interface CliInterfaceCommand {
  args: string[];
  flags: string[];
  description: string;
}

export type CliInterfaceMap = Record<string, CliInterfaceCommand>;

export interface CliManifest {
  name: string;
  version: string;
  description: string;
  language: "python";
  entrypoint: string;
  capabilities: string[];
  auth: CliAuthConfig;
  health: CliHealthStatus;
  interface: CliInterfaceMap;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  parsed: unknown;
}

export interface CliSummary {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  health: CliHealthStatus;
  path: string;
}
