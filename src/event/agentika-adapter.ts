import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type LumoEventBus } from "./bus.js";
import {
  type LumoEventBusCapabilities,
  type LumoEventBusHealth,
  type LumoEventFetchQuery,
  type LumoPublishedEvent,
  type LumoStoredEvent,
} from "./types.js";

interface AgentikaAdapterOptions {
  binaryPath?: string;
  baseUrl?: string;
  dataDir?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
}

export class AgentikaEventBusAdapter implements LumoEventBus {
  private readonly binaryPath: string;
  private readonly baseUrl: string;
  private readonly dataDir: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly port: string;
  private serverProcess?: ChildProcess;
  private started = false;
  private readonly ensuredTopics = new Set<string>();

  constructor(options: AgentikaAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? "/tmp/agentika/target/release/agentika";
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:7200";
    this.dataDir = options.dataDir ?? resolve(process.cwd(), ".lumo-agentika");
    this.token = options.token ?? "dev";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.port = new URL(this.baseUrl).port || "7200";
  }

  async publish(event: LumoPublishedEvent): Promise<void> {
    await this.ensureServer();
    await this.ensureTopic(event.topic);
    const response = await this.fetchImpl(`${this.baseUrl}/api/topics/${encodeURIComponent(event.topic)}/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: event.source,
        type: event.type,
        payload: event.payload,
        idempotency_key: event.idempotencyKey ? `${event.type}:${event.idempotencyKey}` : undefined,
        ...(event.correlationId
          ? {
              payload: {
                ...event.payload,
                _eventMeta: {
                  correlationId: event.correlationId,
                },
              },
            }
          : {}),
      }),
    });
    if (response.ok || response.status === 409) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Failed to publish Agentika event ${event.type} to ${event.topic}: HTTP ${response.status} ${await response.text()}`);
    }
  }

  async fetchRecent(query: LumoEventFetchQuery): Promise<LumoStoredEvent[]> {
    await this.ensureServer();
    const limit = query.limit ?? 12;
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/topics/${encodeURIComponent(query.topic)}/events?offset=0&limit=${limit}`,
      {
        headers: {
          authorization: `Bearer ${this.token}`,
        },
      },
    );
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch Agentika events for ${query.topic}: HTTP ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as {
      events?: Array<{
        id?: string;
        offset?: string;
        source?: string;
        type?: string;
        timestamp?: number;
        payload?: Record<string, unknown>;
      }>;
    };
    return (payload.events ?? [])
      .filter((event): event is Required<Pick<LumoStoredEvent, "id" | "offset" | "source" | "type" | "payload">> & Partial<Pick<LumoStoredEvent, "timestamp">> =>
        typeof event.id === "string"
        && typeof event.offset === "string"
        && typeof event.source === "string"
        && typeof event.type === "string"
        && typeof event.payload === "object"
        && event.payload !== null)
      .slice(-limit)
      .map((event) => ({
        id: event.id,
        offset: event.offset,
        source: event.source,
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      }));
  }

  async capabilities(): Promise<LumoEventBusCapabilities> {
    return {
      publish: true,
      fetchRecent: true,
      durable: true,
    };
  }

  async health(): Promise<LumoEventBusHealth> {
    try {
      await this.ensureServer();
      const response = await this.fetchImpl(`${this.baseUrl}/readyz`);
      return {
        ok: response.ok,
        provider: "agentika",
        detail: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        provider: "agentika",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.started) {
      return;
    }

    if (!existsSync(this.binaryPath)) {
      throw new Error(`Agentika binary not found at ${this.binaryPath}`);
    }

    await mkdir(this.dataDir, { recursive: true });
    this.serverProcess = this.spawnImpl(this.binaryPath, [
      "serve",
      "--port",
      this.port,
      "--data-dir",
      this.dataDir,
    ], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    } as any) as ChildProcess;
    this.serverProcess?.unref?.();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/readyz`);
        if (response.ok) {
          this.started = true;
          return;
        }
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }

    throw new Error("Agentika server did not become ready in time.");
  }

  private async ensureTopic(topic: string): Promise<void> {
    if (this.ensuredTopics.has(topic)) {
      return;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/topics`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: topic,
        visibility: "public",
        ephemeral: false,
      }),
    });
    if (response.ok || response.status === 409) {
      this.ensuredTopics.add(topic);
      return;
    }
    throw new Error(`Failed to ensure Agentika topic ${topic}: HTTP ${response.status}`);
  }
}

export function createDefaultAgentikaEventBus(): LumoEventBus | undefined {
  if (process.env.LUMO_AGENTIKA_SHADOW !== "1") {
    return undefined;
  }
  return new AgentikaEventBusAdapter();
}
