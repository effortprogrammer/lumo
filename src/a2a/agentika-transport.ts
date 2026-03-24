import { type AgentikaA2AAdapter } from "./agentika-adapter.js";
import { createActorTransport, createSupervisorTransport, type ActorTransport, type SupervisorTransport } from "./transport.js";

export function createAgentikaActorTransport(adapter: AgentikaA2AAdapter): ActorTransport {
  return createActorTransport(adapter);
}

export function createAgentikaSupervisorTransport(adapter: AgentikaA2AAdapter): SupervisorTransport {
  return createSupervisorTransport(adapter);
}
