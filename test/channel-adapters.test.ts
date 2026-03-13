import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DiscordChannelAdapter,
  DiscordGatewayInboundBridge,
  FileDiscordInboundBridge,
  normalizeDiscordGatewayMessage,
} from "../src/channels/discord-adapter.js";
import {
  TelegramChannelAdapter,
  normalizeTelegramUpdate,
} from "../src/channels/telegram-adapter.js";

describe("channel adapters", () => {
  it("delivers file-backed Discord inbound messages through the adapter contract", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lumo-discord-"));
    const inboundPath = join(tempDir, "discord.jsonl");
    const seen: string[] = [];

    try {
      await writeFile(
        inboundPath,
        [
          JSON.stringify({
            messageId: "msg-1",
            conversationId: "conv-1",
            text: "status",
            userId: "user-1",
            displayName: "Tester",
          }),
        ].join("\n"),
      );

      const adapter = new DiscordChannelAdapter({
        webhookUrl: "https://discord.example/webhook",
        inboundBridge: new FileDiscordInboundBridge({
          filePath: inboundPath,
          now: () => "2026-03-12T00:00:00Z",
        }),
        fetchImpl: async () =>
          new Response("", {
            status: 200,
          }),
      });

      adapter.onMessage((message) => {
        seen.push(`${message.adapter}:${message.text}:${message.sender.displayName}`);
      });

      const handled = await adapter.pollOnce();
      const sendResult = await adapter.send({
        type: "router.reply",
        target: {
          adapter: "discord",
          conversationId: "conv-1",
        },
        occurredAt: "2026-03-12T00:00:00Z",
        text: "pong",
      });

      assert.equal(handled, 1);
      assert.deepEqual(seen, ["discord:status:Tester"]);
      assert.equal(sendResult.status, "sent");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes and filters Telegram updates deterministically", () => {
    const normalized = normalizeTelegramUpdate(
      {
        update_id: 101,
        message: {
          message_id: 202,
          date: 1_773_273_600,
          text: "@lumo status",
          chat: {
            id: 777,
            type: "private",
          },
          from: {
            id: 42,
            first_name: "Test",
            last_name: "User",
          },
        },
      },
      {
        allowedChatIds: ["777"],
        allowedUserIds: ["42"],
        mentionPrefix: "@lumo",
      },
    );

    const filtered = normalizeTelegramUpdate(
      {
        update_id: 102,
        message: {
          message_id: 203,
          text: "status",
          chat: {
            id: 888,
          },
          from: {
            id: 99,
            first_name: "Blocked",
          },
        },
      },
      {
        allowedChatIds: ["777"],
        allowedUserIds: ["42"],
        mentionPrefix: "@lumo",
      },
    );

    assert.deepEqual(normalized, {
      adapter: "telegram",
      messageId: "202",
      conversationId: "777",
      channelId: "777",
      text: "status",
      sender: {
        userId: "42",
        displayName: "Test User",
        isHuman: true,
      },
      receivedAt: "2026-03-12T00:00:00.000Z",
      raw: {
        updateId: 101,
        chatId: "777",
        chatType: "private",
        username: undefined,
      },
    });
    assert.equal(filtered, null);
  });

  it("polls Telegram inbound updates and sends outbound messages through Bot API", async () => {
    const seen: string[] = [];
    const requests: Array<{ url: string; body: string }> = [];
    const adapter = new TelegramChannelAdapter({
      botToken: "telegram-token",
      chatId: "777",
      allowedChatIds: ["777"],
      allowedUserIds: ["42"],
      mentionPrefix: "@lumo",
      timeoutSeconds: 0,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push({ url, body });

        if (url.endsWith("/getUpdates")) {
          return new Response(JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 3001,
                message: {
                  message_id: 4001,
                  date: 1_773_340_800,
                  text: "@lumo status",
                  chat: {
                    id: 777,
                    type: "private",
                  },
                  from: {
                    id: 42,
                    username: "tester",
                    first_name: "Test",
                  },
                },
              },
              {
                update_id: 3002,
                message: {
                  message_id: 4002,
                  text: "@lumo ignore-me",
                  chat: {
                    id: 999,
                  },
                  from: {
                    id: 42,
                    first_name: "Test",
                  },
                },
              },
            ],
          }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_id: 5001,
          },
        }), {
          status: 200,
        });
      },
      logger: createTestLogger([]),
    });

    adapter.onMessage((message) => {
      seen.push(`${message.messageId}:${message.text}:${message.conversationId}`);
    });

    const handled = await adapter.pollOnce();
    const result = await adapter.send({
      type: "router.reply",
      target: {
        adapter: "telegram",
        conversationId: "777",
        replyToMessageId: "4001",
      },
      occurredAt: "2026-03-12T00:00:00Z",
      text: "hello",
    });

    assert.equal(handled, 1);
    assert.deepEqual(seen, ["4001:status:777"]);
    assert.equal(result.status, "sent");
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.url ?? "", /getUpdates$/);
    assert.match(requests[1]?.url ?? "", /sendMessage$/);
    assert.match(requests[1]?.body ?? "", /"chat_id":"777"/);
    assert.match(requests[1]?.body ?? "", /"text":"hello"/);
    assert.match(requests[1]?.body ?? "", /"message_id":4001/);
  });

  it("normalizes scoped Discord gateway messages deterministically", () => {
    const normalized = normalizeDiscordGatewayMessage(
      {
        id: "msg-1",
        content: "@lumo status",
        createdTimestamp: Date.parse("2026-03-12T00:00:00Z"),
        guildId: "guild-1",
        channelId: "thread-9",
        author: {
          id: "user-1",
          username: "tester",
        },
        member: {
          displayName: "Tester",
        },
        channel: {
          id: "thread-9",
          parentId: "channel-1",
          isThread: () => true,
        },
      },
      {
        ownUserId: "bot-1",
        allowedChannels: ["guild:guild-1/channel:channel-1/thread:thread-9"],
        allowedUsers: ["user-1"],
        mentionPrefix: "@lumo",
      },
    );

    assert.deepEqual(normalized, {
      adapter: "discord",
      messageId: "msg-1",
      conversationId: "thread-9",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-9",
      text: "status",
      sender: {
        userId: "user-1",
        displayName: "Tester",
        isHuman: true,
      },
      receivedAt: "2026-03-12T00:00:00.000Z",
      raw: {
        id: "msg-1",
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-9",
        authorId: "user-1",
      },
    });
  });

  it("starts Discord gateway inbound, ignores self messages, and forwards allowed messages", async () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const client = new FakeDiscordGatewayClient("bot-1");
    const adapter = new DiscordChannelAdapter({
      inboundBridge: new DiscordGatewayInboundBridge({
        token: "secret-token",
        tokenEnvVar: "LUMO_CHANNELS_DISCORD_BOT_TOKEN",
        allowedChannels: ["channel:channel-1"],
        allowedUsers: ["user-1"],
        mentionPrefix: "@lumo",
        logger: createTestLogger(logs),
        createClient: async () => client,
        now: () => "2026-03-12T00:00:00Z",
      }),
      fetchImpl: async () => new Response("", { status: 200 }),
    });

    adapter.onMessage((message) => {
      seen.push(`${message.messageId}:${message.text}:${message.channelId}`);
    });

    await adapter.start();
    client.emit("ready");
    client.emit("messageCreate", {
      id: "msg-self",
      content: "@lumo should-ignore",
      author: {
        id: "bot-1",
        username: "lumo",
      },
      channelId: "channel-1",
      channel: {
        id: "channel-1",
        isThread: () => false,
      },
    });
    client.emit("messageCreate", {
      id: "msg-user",
      content: "@lumo status",
      author: {
        id: "user-1",
        username: "tester",
      },
      member: {
        displayName: "Tester",
      },
      guildId: "guild-1",
      channelId: "channel-1",
      channel: {
        id: "channel-1",
        isThread: () => false,
      },
    });
    await Promise.resolve();
    await adapter.stop();

    assert.equal(client.loginCalls, 1);
    assert.equal(client.destroyCalls, 1);
    assert.deepEqual(seen, ["msg-user:status:channel-1"]);
    assert.match(logs.join("\n"), /logging in with bot token/);
    assert.match(logs.join("\n"), /connected as bot-1/);
  });
});

class FakeDiscordGatewayClient extends EventEmitter {
  user: { id: string };
  loginCalls = 0;
  destroyCalls = 0;

  constructor(userId: string) {
    super();
    this.user = { id: userId };
  }

  async login(_token: string): Promise<string> {
    this.loginCalls += 1;
    return "ok";
  }

  destroy(): void {
    this.destroyCalls += 1;
  }
}

function createTestLogger(messages: string[]) {
  return {
    info: (message: string) => {
      messages.push(`info:${message}`);
    },
    warn: (message: string) => {
      messages.push(`warn:${message}`);
    },
    error: (message: string) => {
      messages.push(`error:${message}`);
    },
  };
}
