import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { mkdir, readFile, unlink, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type DaemonRequest = {
  command: string;
  args: string[];
  cwd: string;
  session: string;
};

type DaemonResponse = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
};

const DEFAULT_SESSION = "default";
const DAEMON_FLAG = "--lumo-daemon";
const SOCKET_FLAG = "--socket";
const PROFILE_FLAG = "--profile";
const READY_TIMEOUT_MS = 60_000;
const nodeProcess = process as unknown as {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  execPath: string;
  exit: (code?: number) => never;
  exitCode?: number;
  on: (event: string, listener: () => void) => void;
  stdout?: { write: (text: string) => void };
  stderr?: { write: (text: string) => void };
};
type SpawnedChild = ReturnType<typeof spawn> & { unref: () => void };
type BrowserPageLike = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  title: () => Promise<string>;
  url: () => string;
  evaluate: <T, A = undefined>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  locator: (selector: string) => {
    click: () => Promise<unknown>;
    fill: (value: string) => Promise<unknown>;
    pressSequentially: (value: string) => Promise<unknown>;
    innerText: () => Promise<string>;
  };
  screenshot: (options: Record<string, unknown>) => Promise<unknown>;
  waitForLoadState: (state: string, options?: Record<string, unknown>) => Promise<unknown>;
};
type BrowserContextLike = {
  pages: () => BrowserPageLike[];
  newPage: () => Promise<BrowserPageLike>;
  close: () => Promise<unknown>;
};

async function main(): Promise<void> {
  const argv = nodeProcess.argv.slice(2);
  if (argv[0] === DAEMON_FLAG) {
    await runDaemon(argv.slice(1));
    return;
  }

  const { session, command, args } = parseCliArgs(argv);
  if (!command) {
    throw new Error("A browser command is required.");
  }

  const cwd = nodeProcess.env.LUMO_AGENT_BROWSER_WORKDIR?.trim() || nodeProcess.cwd();
  const socketPath = buildSocketPath(cwd, session);
  const profileRoot = nodeProcess.env.AGENT_BROWSER_PROFILE?.trim() || join(cwd, ".lumo", "agent-browser-profile");
  const profilePath = join(profileRoot, sanitizeSessionName(session));

  if (command === "close" && !(await canConnect(socketPath))) {
    return;
  }

  if (!(await canConnect(socketPath))) {
    await startDaemon({ session, socketPath, profilePath, cwd });
  }

  const response = await sendRequest(socketPath, {
    command,
    args,
    cwd,
    session,
  });
  if (!response.ok) {
    throw new Error(response.stderr?.trim() || "Browser command failed.");
  }
  if (response.stdout && nodeProcess.stdout) {
    nodeProcess.stdout.write(response.stdout);
  }
}

function parseCliArgs(argv: string[]): { session: string; command?: string; args: string[] } {
  let session = DEFAULT_SESSION;
  const args = [...argv];
  if (args[0] === "--session") {
    session = args[1]?.trim() || DEFAULT_SESSION;
    args.splice(0, 2);
  }

  const [command, ...rest] = args;
  return {
    session: sanitizeSessionName(session),
    command,
    args: rest,
  };
}

async function startDaemon(options: {
  session: string;
  socketPath: string;
  profilePath: string;
  cwd: string;
}): Promise<void> {
  await mkdir(dirname(options.socketPath), { recursive: true });
  await mkdir(options.profilePath, { recursive: true });
  const logPath = `${options.socketPath}.log`;
  try {
    await unlink(options.socketPath);
  } catch {}
  try {
    await unlink(logPath);
  } catch {}

  const logHandle = await open(logPath, "a");

  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(nodeProcess.execPath, [
    scriptPath,
    DAEMON_FLAG,
    options.session,
    SOCKET_FLAG,
    options.socketPath,
    PROFILE_FLAG,
    options.profilePath,
  ], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd] as any,
    env: nodeProcess.env,
  } as any);
  await logHandle.close();
  (child as SpawnedChild).unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (await canConnect(options.socketPath)) {
      return;
    }
    await delay(100);
  }
  let logTail = "";
  try {
    logTail = (await readFile(logPath, "utf8")).trim();
  } catch {}
  throw new Error(logTail
    ? `Timed out waiting for Camoufox browser daemon to start. Daemon log: ${logTail}`
    : "Timed out waiting for Camoufox browser daemon to start.");
}

async function runDaemon(argv: string[]): Promise<void> {
  const session = sanitizeSessionName(argv[0] || DEFAULT_SESSION);
  const socketIndex = argv.indexOf(SOCKET_FLAG);
  const profileIndex = argv.indexOf(PROFILE_FLAG);
  const socketPath = socketIndex >= 0 ? argv[socketIndex + 1] : undefined;
  const profilePath = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  if (!socketPath || !profilePath) {
    throw new Error("Daemon mode requires socket and profile paths.");
  }

  await mkdir(dirname(socketPath), { recursive: true });
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, ".lumo-session"), session, "utf8");

  const { Camoufox } = await loadCamoufoxModule(nodeProcess.cwd());
  const context = await Camoufox({
    user_data_dir: profilePath,
    headless: parseHeadless(nodeProcess.env.LUMO_CAMOUFOX_HEADLESS),
  }) as BrowserContextLike;

  let shuttingDown = false;
  const closeEverything = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close();
    try {
      await context.close();
    } finally {
      try {
        await unlink(socketPath);
      } catch {}
      nodeProcess.exit(0);
    }
  };

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const payload = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      let response: DaemonResponse;
      try {
        const request = JSON.parse(payload) as DaemonRequest;
        response = await executeCommand(context, request);
        if (request.command === "close" && response.ok) {
          socket.write(`${JSON.stringify(response)}\n`, () => {
            void closeEverything();
          });
          return;
        }
      } catch (error) {
        response = {
          ok: false,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });

  nodeProcess.on("SIGINT", () => {
    void closeEverything();
  });
  nodeProcess.on("SIGTERM", () => {
    void closeEverything();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function executeCommand(context: BrowserContextLike, request: DaemonRequest): Promise<DaemonResponse> {
  const page = await getPage(context);
  const selector = request.args[0];
  const value = request.args.slice(1).join(" ");

  switch (request.command) {
    case "open": {
      const target = normalizeUrl(selector);
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await waitForPage(page);
      return jsonResponse({
        action: "open",
        url: page.url(),
        title: await page.title(),
      });
    }
    case "get": {
      return runGet(page, request.args);
    }
    case "click": {
      ensureArgument(selector, "click requires a selector");
      await page.locator(selector).click();
      await waitForPage(page);
      return jsonResponse({
        action: "click",
        target: selector,
        url: page.url(),
        title: await page.title(),
      });
    }
    case "fill": {
      ensureArgument(selector, "fill requires a selector");
      ensureArgument(value, "fill requires a value");
      await page.locator(selector).fill(value);
      return jsonResponse({
        action: "fill",
        target: selector,
        url: page.url(),
        title: await page.title(),
      });
    }
    case "type": {
      ensureArgument(selector, "type requires a selector");
      ensureArgument(value, "type requires a value");
      const locator = page.locator(selector);
      await locator.click();
      await locator.fill("");
      await locator.pressSequentially(value);
      return jsonResponse({
        action: "type",
        target: selector,
        url: page.url(),
        title: await page.title(),
      });
    }
    case "snapshot": {
      return jsonResponse({
        action: "snapshot",
        url: page.url(),
        title: await page.title(),
        text: await snapshotText(page),
      });
    }
    case "screenshot": {
      const path = await writeScreenshot(page, request.cwd, request.session, selector);
      return jsonResponse({
        action: "screenshot",
        url: page.url(),
        title: await page.title(),
        path,
        screenshotRef: {
          id: `shot-${Date.now()}`,
          path,
          mimeType: "image/png",
          capturedAt: new Date().toISOString(),
        },
      });
    }
    case "scroll": {
      const direction = (selector ?? "down").toLowerCase();
      const amount = parseScrollAmount(request.args[1]);
      if (direction !== "down" && direction !== "up") {
        throw new Error(`Unsupported scroll direction: ${direction}`);
      }
      const delta = direction === "up" ? -amount : amount;
      await page.evaluate((value) => {
        window.scrollBy(0, value);
      }, delta);
      await delay(400);
      return jsonResponse({
        action: "scroll",
        direction,
        amount,
        url: page.url(),
        title: await page.title(),
      });
    }
    case "close": {
      return jsonResponse({
        action: "close",
        closed: true,
      });
    }
    default:
      throw new Error(`Unsupported browser command: ${request.command}`);
  }
}

async function runGet(
  page: BrowserPageLike,
  args: string[],
): Promise<DaemonResponse> {
  const subject = args[0];
  if (subject === "title") {
    return textResponse(await page.title());
  }
  if (subject === "url") {
    return textResponse(page.url());
  }
  if (subject === "text") {
    const selector = args[1];
    ensureArgument(selector, "get text requires a selector");
    const text = (await page.locator(selector).innerText()).trim();
    return textResponse(text);
  }
  throw new Error(`Unsupported get command: ${args.join(" ")}`);
}

async function getPage(context: BrowserContextLike): Promise<BrowserPageLike> {
  return context.pages()[0] ?? context.newPage();
}

async function snapshotText(page: BrowserPageLike): Promise<string> {
  const text = (await page.locator("body").innerText().catch(() => "")).trim();
  return text.slice(0, 4000);
}

async function writeScreenshot(page: BrowserPageLike, cwd: string, session: string, requestedPath?: string): Promise<string> {
  const outputPath = requestedPath
    ? resolve(cwd, requestedPath)
    : join(cwd, ".lumo", "screenshots", `${sanitizeSessionName(session)}-${Date.now()}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, type: "png" });
  return outputPath;
}

function normalizeUrl(value: string | undefined): string {
  ensureArgument(value, "open requires a URL");
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith("file://")) {
    return value;
  }
  return `https://${value}`;
}

function ensureArgument(value: string | undefined, message: string): asserts value is string {
  if (!value || value.trim().length === 0) {
    throw new Error(message);
  }
}

function jsonResponse(payload: Record<string, unknown>): DaemonResponse {
  return {
    ok: true,
    stdout: `${JSON.stringify(payload)}\n`,
  };
}

function textResponse(text: string): DaemonResponse {
  return {
    ok: true,
    stdout: `${text}\n`,
  };
}

async function sendRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise<DaemonResponse>((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const payload = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        resolvePromise(JSON.parse(payload) as DaemonResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

async function canConnect(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return false;
  }

  try {
    const result = await sendRequest(socketPath, {
      command: "get",
      args: ["url"],
      cwd: nodeProcess.cwd(),
      session: DEFAULT_SESSION,
    });
    return result.ok;
  } catch {
    try {
      await unlink(socketPath);
    } catch {}
    return false;
  }
}

function buildSocketPath(cwd: string, session: string): string {
  const key = createHash("sha1").update(`${resolve(cwd)}::${session}`).digest("hex").slice(0, 16);
  return join(os.tmpdir(), `lumo-camoufox-${key}.sock`);
}

function sanitizeSessionName(session: string): string {
  return session.replace(/[^a-z0-9_-]+/gi, "-") || DEFAULT_SESSION;
}

function parseHeadless(value: string | undefined): boolean | "virtual" {
  if (!value) {
    return true;
  }
  if (value === "virtual") {
    return "virtual";
  }
  return !["0", "false", "no"].includes(value.toLowerCase());
}

function parseScrollAmount(value: string | undefined): number {
  if (!value) {
    return 900;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 900;
  }
  return parsed;
}

async function waitForPage(page: BrowserPageLike): Promise<void> {
  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined),
    delay(500),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function loadCamoufoxModule(cwd: string): Promise<{
  Camoufox: (options: Record<string, unknown>) => Promise<BrowserContextLike>;
}> {
  const modulePath = join(cwd, "tools", "camoufox-adapter", "node_modules", "camoufox-js", "index.js");
  const fallbackModulePath = join(cwd, "tools", "camoufox-adapter", "node_modules", "camoufox-js", "dist", "index.js");
  const resolvedModulePath = existsSync(modulePath) ? modulePath : fallbackModulePath;
  if (!existsSync(resolvedModulePath)) {
    throw new Error("Camoufox adapter dependencies are missing. Run `npm install --prefix ./tools/camoufox-adapter`."
    );
  }
  return import(pathToFileURL(resolvedModulePath).href) as Promise<{
    Camoufox: (options: Record<string, unknown>) => Promise<BrowserContextLike>;
  }>;
}

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (nodeProcess.stderr) {
    nodeProcess.stderr.write(`${message}\n`);
  }
  const socketIndex = nodeProcess.argv.indexOf(SOCKET_FLAG);
  if (nodeProcess.argv.includes(DAEMON_FLAG) && socketIndex >= 0) {
    const socketPath = nodeProcess.argv[socketIndex + 1];
    if (socketPath) {
      try {
        await unlink(socketPath);
      } catch {}
    }
  }
  nodeProcess.exitCode = 1;
});
