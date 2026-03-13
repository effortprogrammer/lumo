import { type LumoConfig } from "../config/load-config.js";
import { type ChannelAdapter } from "./adapter.js";
import {
  DiscordChannelAdapter,
  DiscordGatewayInboundBridge,
  FileDiscordInboundBridge,
} from "./discord-adapter.js";
import { TelegramChannelAdapter } from "./telegram-adapter.js";

export function createChannelAdapters(
  config: LumoConfig,
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [];

  if (config.channels.adapters.discord.enabled) {
    const inbound = config.channels.adapters.discord.inbound;
    const inboundBridge =
      inbound.mode === "gateway"
        ? new DiscordGatewayInboundBridge({
          token: process.env[inbound.tokenEnvVar] ?? "",
          tokenEnvVar: inbound.tokenEnvVar,
          allowedChannels: inbound.allowedChannels,
          allowedUsers: inbound.allowedUsers,
          mentionPrefix: inbound.mentionPrefix,
        })
        : inbound.filePath
          ? new FileDiscordInboundBridge({
            filePath: inbound.filePath,
          })
          : undefined;
    adapters.push(
      new DiscordChannelAdapter({
        webhookUrl:
          config.channels.adapters.discord.webhookUrl ??
          config.alerts.channels.discord.webhookUrl ??
          config.alerts.webhookUrl,
        inboundBridge,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  if (config.channels.adapters.telegram.enabled) {
    adapters.push(
      new TelegramChannelAdapter({
        botToken: config.channels.adapters.telegram.botToken,
        chatId: config.channels.adapters.telegram.chatId,
        pollIntervalMs: config.channels.adapters.telegram.inbound.pollIntervalMs,
        timeoutSeconds: config.channels.adapters.telegram.inbound.timeoutSeconds,
        allowedChatIds: config.channels.adapters.telegram.inbound.allowedChatIds,
        allowedUserIds: config.channels.adapters.telegram.inbound.allowedUserIds,
        mentionPrefix: config.channels.adapters.telegram.inbound.mentionPrefix,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  return adapters;
}
