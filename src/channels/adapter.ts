import {
  type ChannelMessageHandler,
  type ChannelOutboundEvent,
  type ChannelSendResult,
} from "./model.js";

export interface ChannelAdapter {
  readonly name: string;
  send(event: ChannelOutboundEvent): Promise<ChannelSendResult>;
  onMessage(handler: ChannelMessageHandler): void;
  pollOnce(): Promise<number>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
