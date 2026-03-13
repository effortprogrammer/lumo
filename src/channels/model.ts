import { type TaskStatus } from "../domain/task.js";
import { type SupervisorDecision } from "../supervisor/decision.js";

export interface ChannelParticipant {
  userId: string;
  displayName?: string;
  isHuman: boolean;
}

export interface ChannelInboundMessage {
  adapter: string;
  messageId: string;
  conversationId: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  text: string;
  sender: ChannelParticipant;
  receivedAt: string;
  raw?: unknown;
}

export interface ChannelReplyTarget {
  adapter: string;
  conversationId: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  replyToMessageId?: string;
}

export interface BaseChannelOutboundEvent {
  target: ChannelReplyTarget;
  occurredAt: string;
}

export interface ChannelReplyEvent extends BaseChannelOutboundEvent {
  type: "router.reply";
  text: string;
}

export interface ChannelTaskLifecycleEvent extends BaseChannelOutboundEvent {
  type: "task.lifecycle";
  taskId: string;
  status: TaskStatus;
  step: number;
  summary: string;
}

export interface ChannelSupervisorAlertEvent extends BaseChannelOutboundEvent {
  type: "supervisor.alert";
  taskId: string;
  severity: "warning" | "critical";
  decision: SupervisorDecision;
}

export type ChannelOutboundEvent =
  | ChannelReplyEvent
  | ChannelTaskLifecycleEvent
  | ChannelSupervisorAlertEvent;

export interface ChannelSendResult {
  channel: string;
  status: "sent" | "skipped" | "failed";
  detail: string;
}

export type ChannelMessageHandler = (
  message: ChannelInboundMessage,
) => Promise<void> | void;
