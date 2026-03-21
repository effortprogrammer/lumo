import {
  type LumoEventBusCapabilities,
  type LumoEventBusHealth,
  type LumoEventFetchQuery,
  type LumoPublishedEvent,
  type LumoStoredEvent,
} from "./types.js";

export interface LumoEventStore {
  fetchRecent?(query: LumoEventFetchQuery): Promise<LumoStoredEvent[]>;
}

export interface LumoEventBus extends LumoEventStore {
  publish(event: LumoPublishedEvent): Promise<void>;
  capabilities?(): Promise<LumoEventBusCapabilities>;
  health?(): Promise<LumoEventBusHealth>;
}

export class NoopLumoEventBus implements LumoEventBus {
  async publish(_event: LumoPublishedEvent): Promise<void> {
    return;
  }

  async fetchRecent(_query: LumoEventFetchQuery): Promise<LumoStoredEvent[]> {
    return [];
  }

  async capabilities(): Promise<LumoEventBusCapabilities> {
    return {
      publish: false,
      fetchRecent: false,
      durable: false,
    };
  }

  async health(): Promise<LumoEventBusHealth> {
    return {
      ok: true,
      provider: "noop",
    };
  }
}
