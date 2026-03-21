export {
  AgentikaEventBusAdapter as AgentikaShadowSink,
  createDefaultAgentikaEventBus as createDefaultAgentikaShadowSink,
} from "./agentika-adapter.js";
export type { LumoEventBus as AgentikaEventSink } from "./bus.js";
export type { LumoStoredEvent as AgentikaStoredEvent } from "./types.js";
