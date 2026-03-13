import { type LumoConfig } from "../config/load-config.js";
import { SubprocessCommandRunner, type CommandRunner } from "../runtime/subprocess.js";
import {
  AlertDispatcher,
  DiscordWebhookAlertChannel,
  TelegramBotAlertChannel,
  TerminalAlertChannel,
  VoiceCallAlertChannel,
} from "./dispatcher.js";

export function createAlertDispatcher(
  config: LumoConfig,
  options: {
    fetchImpl?: typeof fetch;
    writer?: { write: (text: string) => void };
    commandRunner?: CommandRunner;
    logger?: {
      warn(message: string): void;
    };
  } = {},
): AlertDispatcher {
  const channels = [];

  if (config.alerts.channels.terminal.enabled) {
    channels.push(
      new TerminalAlertChannel({
        bell: config.alerts.enableTerminalBell,
        writer: options.writer,
      }),
    );
  }

  if (config.alerts.channels.discord.enabled) {
    channels.push(
      new DiscordWebhookAlertChannel(
        config.alerts.channels.discord.webhookUrl ?? config.alerts.webhookUrl ?? "",
        options.fetchImpl,
      ),
    );
  }

  if (config.alerts.channels.telegram.enabled) {
    channels.push(new TelegramBotAlertChannel());
  }

  if (config.alerts.channels.voiceCall.enabled) {
    channels.push(new VoiceCallAlertChannel({
      recipient: config.alerts.channels.voiceCall.recipient,
      providerCommandTemplate: config.alerts.channels.voiceCall.providerCommandTemplate,
      executor: options.commandRunner ?? new SubprocessCommandRunner(),
      logger: options.logger ?? console,
    }));
  }

  return new AlertDispatcher(channels);
}
