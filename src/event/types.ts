export interface LumoPublishedEvent {
  topic: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface LumoStoredEvent {
  id: string;
  offset: string;
  source: string;
  type: string;
  timestamp?: number;
  payload: Record<string, unknown>;
}

export interface LumoEventFetchQuery {
  topic: string;
  limit?: number;
}

export interface LumoEventBusCapabilities {
  publish: boolean;
  fetchRecent: boolean;
  durable: boolean;
}

export interface LumoEventBusHealth {
  ok: boolean;
  provider: string;
  detail?: string;
}
