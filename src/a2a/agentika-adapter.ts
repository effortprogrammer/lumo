import { type A2AAgentAdapter, type A2AEnvelope, type A2AMessage, type CancelTaskRequest } from "./protocol.js";

export interface AgentikaA2AAdapterOptions {
  baseUrl: string;
  token: string;
  taskId: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

type MessageHandler = (message: A2AEnvelope<A2AMessage>) => Promise<void> | void;
type CancelHandler = (request: A2AEnvelope<CancelTaskRequest>) => Promise<void> | void;
type AgentRole = "actor" | "supervisor";
type ConsumerKind = "message" | "cancel";

interface AgentikaConsumerEvent<TEnvelope> {
  offset: string;
  payload?: {
    envelope?: TEnvelope;
  };
}

interface ConsumerRegistration {
  agentId: string;
  kind: ConsumerKind;
  topic: string;
  consumerId: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

export class AgentikaA2AAdapter implements A2AAgentAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly taskId: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly ensuredTopics = new Set<string>();
  private readonly messageHandlers = new Map<string, MessageHandler>();
  private readonly cancelHandlers = new Map<string, CancelHandler>();
  private readonly consumers = new Map<string, ConsumerRegistration>();
  private readonly pollers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlightPolls = new Set<string>();
  private started = false;

  constructor(options: AgentikaA2AAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.taskId = options.taskId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {
    await Promise.all([
      this.ensureTopic(this.actorProgressTopic),
      this.ensureTopic(this.supervisorCommandsTopic),
      this.ensureTopic(this.cancelTopic),
    ]);
    this.started = true;
    await this.ensureRegisteredConsumers();
  }

  stop(): void {
    for (const poller of this.pollers.values()) {
      clearInterval(poller);
    }
    this.pollers.clear();
    this.inFlightPolls.clear();
  }

  registerMessageHandler(agentId: string, handler: MessageHandler): void {
    this.messageHandlers.set(agentId, handler);
    if (this.started) {
      void this.ensureConsumer({
        agentId,
        kind: "message",
        topic: this.topicForMessageAgent(agentId),
      });
    }
  }

  registerCancelHandler(agentId: string, handler: CancelHandler): void {
    this.cancelHandlers.set(agentId, handler);
    if (this.started) {
      void this.ensureConsumer({
        agentId,
        kind: "cancel",
        topic: this.cancelTopic,
      });
    }
  }

  async sendMessage(envelope: A2AEnvelope<A2AMessage>): Promise<void> {
    await this.publishEnvelope(this.topicForMessageRecipient(envelope.to), envelope, "a2a.message");
  }

  async cancelTask(envelope: A2AEnvelope<CancelTaskRequest>): Promise<void> {
    await this.publishEnvelope(this.cancelTopic, envelope, "a2a.cancel");
  }

  private get actorProgressTopic(): string {
    return `task.${this.taskId}.actor-progress`;
  }

  private get supervisorCommandsTopic(): string {
    return `task.${this.taskId}.supervisor-cmds`;
  }

  private get cancelTopic(): string {
    return `task.${this.taskId}.cancel`;
  }

  private async ensureRegisteredConsumers(): Promise<void> {
    await Promise.all([
      ...Array.from(this.messageHandlers.keys(), (agentId) =>
        this.ensureConsumer({
          agentId,
          kind: "message",
          topic: this.topicForMessageAgent(agentId),
        })),
      ...Array.from(this.cancelHandlers.keys(), (agentId) =>
        this.ensureConsumer({
          agentId,
          kind: "cancel",
          topic: this.cancelTopic,
        })),
    ]);
  }

  private async ensureConsumer(options: {
    agentId: string;
    kind: ConsumerKind;
    topic: string;
  }): Promise<void> {
    const registrationKey = this.consumerKey(options.kind, options.agentId);
    if (this.consumers.has(registrationKey)) {
      return;
    }

    await this.ensureTopic(options.topic);
    const role = resolveAgentRole(options.agentId);
    const response = await this.request("/api/consumers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        topic: options.topic,
        group_id: `lumo-${role}-${this.taskId}`,
        consumer_id: `lumo-${role}-${options.kind}-${this.taskId}`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to register Agentika consumer for ${options.topic}: HTTP ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as { id?: string; consumer_id?: string };
    const consumerId = payload.id ?? payload.consumer_id;
    if (typeof consumerId !== "string" || consumerId.length === 0) {
      throw new Error(`Agentika consumer registration for ${options.topic} did not return an id`);
    }

    const registration: ConsumerRegistration = {
      agentId: options.agentId,
      kind: options.kind,
      topic: options.topic,
      consumerId,
    };
    this.consumers.set(registrationKey, registration);
    this.startPolling(registrationKey, registration);
  }

  private startPolling(registrationKey: string, registration: ConsumerRegistration): void {
    if (this.pollers.has(registrationKey)) {
      return;
    }

    const poller = setInterval(() => {
      void this.pollConsumer(registrationKey, registration);
    }, this.pollIntervalMs);
    poller.unref?.();
    this.pollers.set(registrationKey, poller);
    void this.pollConsumer(registrationKey, registration);
  }

  private async pollConsumer(registrationKey: string, registration: ConsumerRegistration): Promise<void> {
    if (this.inFlightPolls.has(registrationKey)) {
      return;
    }

    this.inFlightPolls.add(registrationKey);
    try {
      const response = await this.request(`/api/consumers/${encodeURIComponent(registration.consumerId)}/next?limit=5`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to poll Agentika consumer ${registration.consumerId}: HTTP ${response.status} ${await response.text()}`);
      }

      const payload = await response.json() as {
        events?: Array<AgentikaConsumerEvent<A2AEnvelope<A2AMessage> | A2AEnvelope<CancelTaskRequest>>>;
      };
      for (const event of payload.events ?? []) {
        if (registration.kind === "message") {
          await this.handleMessageEvent(registration, event as AgentikaConsumerEvent<A2AEnvelope<A2AMessage>>);
        } else {
          await this.handleCancelEvent(registration, event as AgentikaConsumerEvent<A2AEnvelope<CancelTaskRequest>>);
        }
      }
    } finally {
      this.inFlightPolls.delete(registrationKey);
    }
  }

  private async handleMessageEvent(
    registration: ConsumerRegistration,
    event: AgentikaConsumerEvent<A2AEnvelope<A2AMessage>>,
  ): Promise<void> {
    const envelope = event.payload?.envelope;
    if (!envelope) {
      await this.ackConsumerOffset(registration.consumerId, event.offset);
      return;
    }

    const handler = this.messageHandlers.get(registration.agentId);
    if (!handler) {
      await this.ackConsumerOffset(registration.consumerId, event.offset);
      return;
    }

    try {
      await handler(envelope);
      await this.ackConsumerOffset(registration.consumerId, event.offset);
    } catch {
      await this.nackConsumer(registration.consumerId, true);
    }
  }

  private async handleCancelEvent(
    registration: ConsumerRegistration,
    event: AgentikaConsumerEvent<A2AEnvelope<CancelTaskRequest>>,
  ): Promise<void> {
    const envelope = event.payload?.envelope;
    if (!envelope) {
      await this.ackConsumerOffset(registration.consumerId, event.offset);
      return;
    }

    const handler = this.cancelHandlers.get(registration.agentId);
    if (!handler) {
      await this.ackConsumerOffset(registration.consumerId, event.offset);
      return;
    }

    try {
      await handler(envelope);
      await this.ackConsumerOffset(registration.consumerId, event.offset);
    } catch {
      await this.nackConsumer(registration.consumerId, true);
    }
  }

  private async publishEnvelope<TPayload>(
    topic: string,
    envelope: A2AEnvelope<TPayload>,
    type: "a2a.message" | "a2a.cancel",
  ): Promise<void> {
    await this.ensureTopic(topic);
    const response = await this.request(`/api/topics/${encodeURIComponent(topic)}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: envelope.from,
        type,
        payload: {
          envelope,
        },
        idempotency_key: envelope.id,
      }),
    });
    if (response.ok || response.status === 409) {
      return;
    }
    throw new Error(`Failed to publish Agentika ${type} event to ${topic}: HTTP ${response.status} ${await response.text()}`);
  }

  private async ackConsumerOffset(consumerId: string, offset: string): Promise<void> {
    const response = await this.request(`/api/consumers/${encodeURIComponent(consumerId)}/ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ offset }),
    });
    if (!response.ok) {
      throw new Error(`Failed to ack Agentika consumer ${consumerId}: HTTP ${response.status} ${await response.text()}`);
    }
  }

  private async nackConsumer(consumerId: string, retryable: boolean): Promise<void> {
    const response = await this.request(`/api/consumers/${encodeURIComponent(consumerId)}/nack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ retryable }),
    });
    if (!response.ok) {
      throw new Error(`Failed to nack Agentika consumer ${consumerId}: HTTP ${response.status} ${await response.text()}`);
    }
  }

  private async ensureTopic(topic: string): Promise<void> {
    if (this.ensuredTopics.has(topic)) {
      return;
    }

    const response = await this.request("/api/topics", {
      method: "POST",
      headers: {
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
    throw new Error(`Failed to ensure Agentika topic ${topic}: HTTP ${response.status} ${await response.text()}`);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private topicForMessageRecipient(agentId: string): string {
    return resolveAgentRole(agentId) === "actor"
      ? this.supervisorCommandsTopic
      : this.actorProgressTopic;
  }

  private topicForMessageAgent(agentId: string): string {
    return resolveAgentRole(agentId) === "actor"
      ? this.supervisorCommandsTopic
      : this.actorProgressTopic;
  }

  private consumerKey(kind: ConsumerKind, agentId: string): string {
    return `${kind}:${agentId}`;
  }
}

function resolveAgentRole(agentId: string): AgentRole {
  if (agentId === "actor" || agentId.includes("actor")) {
    return "actor";
  }
  if (agentId === "supervisor" || agentId.includes("supervisor")) {
    return "supervisor";
  }
  throw new Error(`Unable to resolve Agentika A2A role for agent "${agentId}"`);
}
