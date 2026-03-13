import { type ChannelAdapter } from "./adapter.js";
import { type ConversationRouter } from "./conversation-router.js";

export class ChannelBridge {
  constructor(
    private readonly adapters: readonly ChannelAdapter[],
    private readonly router: ConversationRouter,
  ) {
    const handler = this.router.createHandler();
    for (const adapter of adapters) {
      adapter.onMessage(handler);
    }
  }

  async pollOnce(): Promise<number> {
    let handled = 0;
    for (const adapter of this.adapters) {
      handled += await adapter.pollOnce();
    }
    return handled;
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.start?.();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop?.();
    }
  }
}
