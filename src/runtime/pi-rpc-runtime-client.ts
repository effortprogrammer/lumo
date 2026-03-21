import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinaryCommand, resolveBinaryCommandFromModule } from "./command-resolution.js";
import { type RuntimeAnomaly } from "../domain/task.js";
import { type PiMonoRuntimeClient, type PiMonoRuntimeEvent } from "./runtime-session-adapter.js";

interface PiRpcRuntimeClientOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: () => string;
  model?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  extensions?: string[];
}

type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_last_assistant_text" };

type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PiRpcEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start" }
  | { type: "message_end" }
  | {
    type: "tool_execution_start";
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }
  | {
    type: "message_update";
    assistantMessageEvent?: {
      type?: string;
      delta?: string;
    };
  }
  | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    result?: {
      content?: Array<{ type?: string; text?: string }>;
      details?: Record<string, unknown>;
    };
    isError: boolean;
  }
  | {
    type: "auto_retry_start";
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
  }
  | {
    type: "auto_retry_end";
    success: boolean;
    attempt: number;
    finalError?: string;
  };

interface PendingRequest {
  commandType: PiRpcCommand["type"];
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
}

interface SessionProcessRecord {
  externalSessionId: string;
  child: ReturnType<typeof spawn>;
  stdoutBuffer: string;
  stderrBuffer: string;
  pendingRequests: Map<string, PendingRequest>;
  listeners: Set<(event: PiMonoRuntimeEvent) => void>;
  toolArgsById: Map<string, Record<string, unknown>>;
  status: "pending" | "running" | "paused" | "halted" | "completed" | "failed";
  started: boolean;
  closed: boolean;
  assistantTextBuffer: string;
  pendingFinishTimer?: ReturnType<typeof setTimeout>;
  lastAgentEndMessages?: unknown[];
}

const DEFAULT_CLI_CANDIDATES = [
  "pi",
  "./node_modules/.bin/pi",
] as const;

const DEFAULT_AGENT_BROWSER_CANDIDATES = [
  "./bin/lumo-agent-browser.js",
  "agent-browser",
  "./node_modules/.bin/agent-browser",
] as const;

export class PiRpcRuntimeClient implements PiMonoRuntimeClient {
  private readonly now: () => string;
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly appendSystemPrompt?: string;
  private readonly tools?: string[];
  private readonly extensions?: string[];
  private readonly agentBrowserBinary?: string;
  private readonly sessions = new Map<string, SessionProcessRecord>();
  private readonly resolvedCli;
  private nextRequestId = 0;

  constructor(options: PiRpcRuntimeClientOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.model = options.model?.trim() || undefined;
    this.appendSystemPrompt = options.appendSystemPrompt?.trim() || undefined;
    this.tools = options.tools && options.tools.length > 0 ? [...options.tools] : undefined;
    this.extensions = options.extensions && options.extensions.length > 0
      ? [...options.extensions]
      : [fileURLToPath(new URL("./pi-agent-browser-extension.js", import.meta.url))];
    this.agentBrowserBinary = resolveBinaryCommand(DEFAULT_AGENT_BROWSER_CANDIDATES, {
      cwd: this.cwd,
      env: this.env,
    })?.path ?? resolveBinaryCommandFromModule(["agent-browser"], import.meta.url, {
      env: this.env,
    })?.path;
    this.resolvedCli = resolveBinaryCommand(DEFAULT_CLI_CANDIDATES, {
      cwd: this.cwd,
      env: this.env,
    }) ?? resolveBinaryCommandFromModule(["pi"], import.meta.url, {
      env: this.env,
    });
  }

  isAvailable(): boolean {
    return Boolean(this.resolvedCli?.path);
  }

  createSession(options: { sessionId: string; instruction: string }): { externalSessionId: string } {
    const cliPath = this.resolvedCli?.path;
    if (!cliPath) {
      throw new Error("pi runtime client is unavailable");
    }

    const args = buildPiRpcCliArgs({
      model: this.model,
      appendSystemPrompt: this.appendSystemPrompt,
      tools: this.tools,
      extensions: this.extensions,
    });

    const child = spawn(cliPath, args, {
      cwd: this.cwd,
      env: buildPiRuntimeEnv(
        this.env,
        this.agentBrowserBinary,
        `lumo-${options.sessionId}`,
        this.cwd,
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const record: SessionProcessRecord = {
      externalSessionId: options.sessionId,
      child,
      stdoutBuffer: "",
      stderrBuffer: "",
      pendingRequests: new Map(),
      listeners: new Set(),
      toolArgsById: new Map(),
      status: "pending",
      started: false,
      closed: false,
      assistantTextBuffer: "",
      lastAgentEndMessages: undefined,
    };

    child.stdout.on("data", (chunk: unknown) => {
      this.handleStdout(record, String(chunk));
    });
    child.stderr.on("data", (chunk: unknown) => {
      record.stderrBuffer += String(chunk);
    });
    child.on("error", (error: unknown) => {
      this.failRecord(record, error instanceof Error ? error.message : String(error));
    });
    child.on("close", (exitCode: unknown) => {
      record.closed = true;
      for (const pending of record.pendingRequests.values()) {
        pending.reject(new Error(this.buildExitMessage(record, exitCode)));
      }
      record.pendingRequests.clear();
      if (record.status !== "halted" && record.status !== "completed" && record.status !== "failed") {
        this.emitStatus(record, "failed");
      }
    });

    this.sessions.set(options.sessionId, record);
    return { externalSessionId: options.sessionId };
  }

  async sendInput(
    externalSessionId: string,
    text: string,
    options?: {
      role?: "human" | "actor" | "supervisor" | "system";
      deliverAs?: "auto" | "prompt" | "steer" | "follow_up";
      echoConversation?: boolean;
    },
  ): Promise<void> {
    const record = this.getRecord(externalSessionId);
    if (record.closed || record.status === "halted") {
      throw new Error("Task is halted and cannot accept more instructions");
    }

    if (options?.echoConversation !== false) {
      this.emitConversation(record, options?.role ?? "human", text);
    }
    this.clearPendingFinish(record);
    record.assistantTextBuffer = "";
    await this.sendCommand(record, {
      type: resolveDeliveryMode(record, options?.deliverAs),
      message: text,
    });
    this.markRunning(record);
  }

  async pause(externalSessionId: string, reason?: string): Promise<void> {
    const record = this.getRecord(externalSessionId);
    if (record.closed || record.status === "halted" || record.status === "completed") {
      return;
    }

    this.emitConversation(record, "system", reason ?? "Manual pause");
    this.emitStatus(record, "paused");
    await this.sendCommand(record, { type: "abort" });
  }

  async resume(
    externalSessionId: string,
    text?: string,
    options?: {
      role?: "human" | "actor" | "supervisor" | "system";
      echoConversation?: boolean;
    },
  ): Promise<void> {
    const record = this.getRecord(externalSessionId);
    if (record.closed || record.status === "halted") {
      throw new Error("Task is halted and cannot be resumed");
    }

    const message = text?.trim() || "Continue.";
    return this.sendInput(externalSessionId, message, {
      role: options?.role ?? "human",
      deliverAs: record.started ? "follow_up" : "prompt",
      echoConversation: options?.echoConversation,
    });
  }

  async halt(
    externalSessionId: string,
    reason: string,
    options?: {
      role?: "human" | "actor" | "supervisor" | "system";
      echoConversation?: boolean;
    },
  ): Promise<void> {
    const record = this.getRecord(externalSessionId);
    if (record.status === "halted") {
      return;
    }

    if (options?.echoConversation !== false) {
      const prefix = options?.role === "supervisor" ? "Supervisor halt" : "Manual halt";
      this.emitConversation(record, options?.role ?? "system", `${prefix}: ${reason}`);
    }
    this.emitStatus(record, "halted");
    this.disposeRecord(record);
  }

  subscribe(
    externalSessionId: string,
    listener: (event: PiMonoRuntimeEvent) => void,
  ): () => void {
    const record = this.getRecord(externalSessionId);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private handleStdout(record: SessionProcessRecord, chunk: string): void {
    record.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = record.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = record.stdoutBuffer.slice(0, newlineIndex).trim();
      record.stdoutBuffer = record.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (this.isResponse(parsed)) {
        const requestId = parsed.id ?? "";
        const pending = record.pendingRequests.get(requestId);
        if (!pending) {
          continue;
        }
        record.pendingRequests.delete(requestId);
        if (parsed.success) {
          pending.resolve(parsed);
        } else {
          const error = new Error(parsed.error ?? `${parsed.command} failed`);
          if (pending.commandType === "prompt" || pending.commandType === "steer" || pending.commandType === "follow_up") {
            this.failRecord(record, error.message);
          }
          pending.reject(error);
        }
        continue;
      }

      this.handleEvent(record, parsed as PiRpcEvent);
    }
  }

  private handleEvent(record: SessionProcessRecord, event: PiRpcEvent): void {
    if (event.type === "agent_start") {
      this.markRunning(record);
      return;
    }

    if (event.type === "message_update") {
      if (event.assistantMessageEvent?.type === "text_delta") {
        record.assistantTextBuffer += event.assistantMessageEvent.delta ?? "";
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      if (event.args) {
        record.toolArgsById.set(event.toolCallId, event.args);
      }
      return;
    }

    if (event.type === "agent_end") {
      record.lastAgentEndMessages = event.messages;
      this.scheduleAgentFinish(record);
      return;
    }

    if (event.type === "auto_retry_start") {
      this.clearPendingFinish(record);
      return;
    }

    if (event.type === "auto_retry_end") {
      if (!event.success) {
        this.failRecord(record, event.finalError ?? "Pi auto-retry failed.");
      }
      return;
    }

    if (event.type === "turn_start" || event.type === "turn_end" || event.type === "message_start" || event.type === "message_end") {
      return;
    }

    if (event.type === "tool_execution_end") {
      if (isPiInternalBrowserToolName(event.toolName)) {
        this.emit(record, {
          type: "runtime.anomaly",
          taskId: record.externalSessionId,
          occurredAt: this.now(),
          anomaly: buildUnsupportedBrowserPathAnomaly(record, event.toolName, this.now()),
        });
        return;
      }

      const toolArgs = event.args ?? record.toolArgsById.get(event.toolCallId);
      const normalizedResult = normalizeToolResult(event.toolName, event.result, this.now());
      this.emit(record, {
        type: "task.output",
        taskId: record.externalSessionId,
        occurredAt: this.now(),
        tool: mapPiToolName(event.toolName),
        input: normalizedResult.input ?? formatToolInput(toolArgs),
        output: normalizedResult.output,
        durationMs: 0,
        exitCode: event.isError ? 1 : 0,
        metadata: normalizedResult.metadata,
        screenshotRef: normalizedResult.screenshotRef,
      });
      record.toolArgsById.delete(event.toolCallId);
      return;
    }

    if (record.status === "halted" || record.status === "paused") {
      return;
    }
  }

  private scheduleAgentFinish(record: SessionProcessRecord): void {
    this.clearPendingFinish(record);
    record.pendingFinishTimer = setTimeout(() => {
      record.pendingFinishTimer = undefined;
      void this.finishAgentRun(record);
    }, 50);
  }

  private async finishAgentRun(record: SessionProcessRecord): Promise<void> {
    if (record.status === "halted" || record.status === "paused" || record.status === "completed" || record.status === "failed" || record.closed) {
      return;
    }

    const outcome = await this.resolveAgentOutcome(record);
    if (outcome.errorMessage) {
      this.failRecord(record, outcome.errorMessage);
      return;
    }
    if (outcome.assistantText) {
      this.emit(record, {
        type: "conversation.turn",
        taskId: record.externalSessionId,
        turn: {
          id: `turn-${Date.now()}`,
          role: "actor",
          text: outcome.assistantText,
          timestamp: this.now(),
        },
      });
    }
    this.emitStatus(record, "completed");
  }

  private async getLastAssistantText(record: SessionProcessRecord): Promise<string> {
    try {
      const response = await this.sendCommand(record, { type: "get_last_assistant_text" });
      const data = response.data as { text?: unknown } | undefined;
      return typeof data?.text === "string" ? data.text : "";
    } catch {
      return "";
    }
  }

  private markRunning(record: SessionProcessRecord): void {
    if (!record.started) {
      record.started = true;
      this.emit(record, {
        type: "session.started",
        taskId: record.externalSessionId,
        startedAt: this.now(),
      });
    }
    this.emitStatus(record, "running");
  }

  private emitStatus(
    record: SessionProcessRecord,
    status: Exclude<SessionProcessRecord["status"], "pending">,
  ): void {
    if (record.status === status) {
      return;
    }
    record.status = status;
    this.emit(record, {
      type: "session.status",
      taskId: record.externalSessionId,
      status,
      occurredAt: this.now(),
    });
  }

  private emitConversation(
    record: SessionProcessRecord,
    role: "human" | "actor" | "supervisor" | "system",
    text: string,
  ): void {
    this.emit(record, {
      type: "conversation.turn",
      taskId: record.externalSessionId,
      turn: {
        id: `turn-${Date.now()}`,
        role,
        text,
        timestamp: this.now(),
      },
    });
  }

  private emit(record: SessionProcessRecord, event: PiMonoRuntimeEvent): void {
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private async sendCommand(
    record: SessionProcessRecord,
    command: PiRpcCommand,
  ): Promise<PiRpcResponse> {
    if (record.closed) {
      throw new Error("pi session is closed");
    }

    const requestId = `req-${++this.nextRequestId}`;
    const payload = JSON.stringify({
      ...command,
      id: requestId,
    });

    return await new Promise<PiRpcResponse>((resolve, reject) => {
      record.pendingRequests.set(requestId, {
        commandType: command.type,
        resolve,
        reject,
      });
      record.child.stdin.write(`${payload}\n`);
    });
  }

  private failRecord(record: SessionProcessRecord, message: string): void {
    if (record.status === "failed") {
      return;
    }
    this.clearPendingFinish(record);
    if (message.trim().length > 0) {
      this.emitConversation(record, "system", `Pi runtime failure: ${message}`);
    }
    this.emitStatus(record, "failed");
  }

  private async resolveAgentOutcome(record: SessionProcessRecord): Promise<{ assistantText: string; errorMessage?: string }> {
    const lastAssistant = getLastAssistantMessage(record.lastAgentEndMessages);
    if (lastAssistant) {
      const errorMessage = getAssistantErrorMessage(lastAssistant);
      if (errorMessage) {
        return {
          assistantText: extractAssistantText(lastAssistant),
          errorMessage,
        };
      }
      const assistantText = extractAssistantText(lastAssistant);
      if (assistantText) {
        return { assistantText };
      }
    }

    const assistantText = record.assistantTextBuffer.trim().length > 0
      ? record.assistantTextBuffer.trim()
      : await this.getLastAssistantText(record);
    return { assistantText };
  }

  private clearPendingFinish(record: SessionProcessRecord): void {
    if (record.pendingFinishTimer) {
      clearTimeout(record.pendingFinishTimer);
      record.pendingFinishTimer = undefined;
    }
  }

  private buildExitMessage(record: SessionProcessRecord, exitCode: unknown): string {
    const normalizedExitCode = typeof exitCode === "number" ? String(exitCode) : "unknown";
    const stderr = record.stderrBuffer.trim();
    return stderr.length > 0
      ? `pi process exited with code ${normalizedExitCode}: ${stderr}`
      : `pi process exited with code ${normalizedExitCode}`;
  }

  private disposeRecord(record: SessionProcessRecord): void {
    if (record.closed) {
      return;
    }
    record.closed = true;
    for (const pending of record.pendingRequests.values()) {
    pending.reject(new Error("pi session was terminated"));
    }
    record.pendingRequests.clear();
    this.clearPendingFinish(record);
    record.child.kill("SIGTERM");
  }

  private getRecord(externalSessionId: string): SessionProcessRecord {
    const record = this.sessions.get(externalSessionId);
    if (!record) {
      throw new Error(`Unknown runtime session ${externalSessionId}`);
    }
    return record;
  }

  private isResponse(value: unknown): value is PiRpcResponse {
    return typeof value === "object"
      && value !== null
      && "type" in value
      && (value as { type?: unknown }).type === "response";
  }
}

export function createDefaultPiMonoRuntimeClient(options: PiRpcRuntimeClientOptions = {}): PiMonoRuntimeClient {
  return new PiRpcRuntimeClient(options);
}

export function buildPiRpcCliArgs(options: {
  model?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  extensions?: string[];
}): string[] {
  const args = ["--mode", "rpc", "--no-session"];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.tools && options.tools.length > 0) {
    args.push("--tools", options.tools.join(","));
  }
  if (options.appendSystemPrompt && options.appendSystemPrompt.trim().length > 0) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.extensions) {
    for (const extension of options.extensions) {
      if (extension.trim().length > 0) {
        args.push("--extension", extension);
      }
    }
  }

  return args;
}

export function buildPiRuntimeEnv(
  baseEnv: Record<string, string | undefined>,
  agentBrowserBinary?: string,
  agentBrowserSession?: string,
  cwd = process.cwd(),
): Record<string, string | undefined> {
  const detectedChrome = detectSystemChromeExecutable();
  return {
    ...baseEnv,
    LUMO_AGENT_BROWSER_WORKDIR: cwd,
    ...(agentBrowserBinary ? { LUMO_AGENT_BROWSER_PATH: agentBrowserBinary } : {}),
    ...(agentBrowserSession ? { LUMO_AGENT_BROWSER_SESSION: agentBrowserSession } : {}),
    AGENT_BROWSER_PROFILE: baseEnv.AGENT_BROWSER_PROFILE ?? join(cwd, ".lumo", "agent-browser-profile"),
    ...(baseEnv.AGENT_BROWSER_AUTO_CONNECT ? { AGENT_BROWSER_AUTO_CONNECT: baseEnv.AGENT_BROWSER_AUTO_CONNECT } : {}),
    ...(baseEnv.AGENT_BROWSER_EXECUTABLE_PATH
      ? {}
      : detectedChrome
        ? { AGENT_BROWSER_EXECUTABLE_PATH: detectedChrome }
        : {}),
  };
}

function detectSystemChromeExecutable(): string | undefined {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function mapPiToolName(toolName: string): "bash" | "agent-browser" | "coding-agent" {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash") {
    return "bash";
  }
  if (normalized.includes("browser") || normalized.includes("web")) {
    return "agent-browser";
  }
  return "coding-agent";
}

function isPiInternalBrowserToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized !== "agent-browser" && (normalized.includes("browser") || normalized.includes("web"));
}

function buildUnsupportedBrowserPathAnomaly(
  record: SessionProcessRecord,
  toolName: string,
  occurredAt: string,
): RuntimeAnomaly {
  return {
    id: `anomaly-unsupported-browser-path-${Date.now()}`,
    kind: "unsupported_browser_path",
    severity: "critical",
    message: `Pi attempted to use its internal browser tool "${toolName}", but Lumo requires browser work to go through the external agent-browser CLI.`,
    taskId: record.externalSessionId,
    sessionId: record.externalSessionId,
    occurredAt,
    evidence: {
      childProcessName: toolName,
      child: {
        kind: "browser",
        name: toolName,
      },
      metadata: {
        browserExecutionBoundary: "external-agent-browser-cli",
      },
    },
  };
}

function resolveDeliveryMode(
  record: SessionProcessRecord,
  requestedMode: "auto" | "prompt" | "steer" | "follow_up" | undefined,
): "prompt" | "steer" | "follow_up" {
  if (requestedMode && requestedMode !== "auto") {
    return requestedMode;
  }

  if (!record.started) {
    return "prompt";
  }

  return record.status === "running" ? "steer" : "follow_up";
}

function formatToolInput(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  if (typeof args.command === "string") {
    return args.command;
  }
  return JSON.stringify(args);
}

function formatToolOutput(
  result: {
    content?: Array<{ type?: string; text?: string }>;
    details?: Record<string, unknown>;
  } | undefined,
): string | Record<string, unknown> {
  const text = result?.content
    ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text ?? "")
    .join("\n")
    .trim();
  if (text && text.length > 0) {
    return text;
  }
  return result?.details ?? {};
}

function normalizeToolResult(
  toolName: string,
  result: {
    content?: Array<{ type?: string; text?: string }>;
    details?: Record<string, unknown>;
  } | undefined,
  occurredAt: string,
): {
  input?: string;
  output: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
  screenshotRef?: {
    id: string;
    mimeType?: string;
    path?: string;
    url?: string;
    capturedAt: string;
  };
} {
  const output = formatToolOutput(result);
  const details = result?.details;
  if (mapPiToolName(toolName) !== "agent-browser" || !details) {
    return { output };
  }

  const metadata: Record<string, unknown> = {};
  const input = pickString(details, ["command"]);
  const url = pickString(details, ["url", "currentUrl", "pageUrl"]);
  if (url) {
    metadata.url = url;
  }
  const title = pickString(details, ["title"]);
  if (title) {
    metadata.title = title;
  }
  const action = pickString(details, ["action", "browserAction"]);
  if (action) {
    metadata.browserAction = action;
  }
  const screenshotRef = normalizeScreenshotRef(details, occurredAt);
  if (screenshotRef) {
    metadata.screenshotCapturedAt = screenshotRef.capturedAt;
  }

  return {
    input,
    output,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    screenshotRef,
  };
}

function normalizeScreenshotRef(
  details: Record<string, unknown>,
  occurredAt: string,
): {
  id: string;
  mimeType?: string;
  path?: string;
  url?: string;
  capturedAt: string;
} | undefined {
  const nested = isRecord(details.screenshotRef) ? details.screenshotRef : undefined;
  const path = pickString(nested ?? details, ["path", "screenshotPath", "filePath"]);
  const url = pickString(nested ?? details, ["url", "screenshotUrl"]);
  if (!path && !url) {
    return undefined;
  }

  return {
    id: pickString(nested ?? details, ["id"]) ?? `shot-${Date.now()}`,
    mimeType: pickString(nested ?? details, ["mimeType"]),
    path,
    url,
    capturedAt: pickString(nested ?? details, ["capturedAt"]) ?? occurredAt,
  };
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


function getLastAssistantMessage(messages: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant") {
      return message as Record<string, unknown>;
    }
  }
  return undefined;
}

function getAssistantErrorMessage(message: Record<string, unknown>): string | undefined {
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  if (stopReason === "error" || stopReason === "aborted") {
    return errorMessage ?? `Pi assistant stopped with ${stopReason}.`;
  }
  return undefined;
}

function extractAssistantText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((entry): entry is { type?: unknown; text?: unknown } => typeof entry === "object" && entry !== null)
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text))
    .join("\n")
    .trim();
}
