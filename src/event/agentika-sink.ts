export {
  AgentikaEventBusAdapter as AgentikaShadowSink,
  createAgentikaEventBus as createAgentikaShadowSink,
} from "./agentika-adapter.js";
export type { LumoEventBus as AgentikaEventSink } from "./bus.js";
export type { LumoStoredEvent as AgentikaStoredEvent } from "./types.js";
