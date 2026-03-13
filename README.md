# Lumo Phase 10

Local TypeScript harness for an actor/supervisor loop with in-process A2A routing and unified intent-based terminal/channel routing.

## What Works Now

- Real actor runtime that parses instruction lines and executes:
  - `/bash <command>` through `sh -lc`
  - `/browser <command>` through `agent-browser` when detected, otherwise a configurable mock subprocess runner
  - `/agent <prompt>` through a selectable coding-agent subprocess profile (`codex`, `claude`, or `opencode`) when detected, otherwise a mock subprocess
- Runtime session adapter layer with a stable `RuntimeSessionAdapter` contract:
  - `PiMonoSessionAdapter` is the only supported production runtime provider
  - startup performs an explicit pi-mono health-check and exits with a configuration/runtime error if the provider is unavailable
  - deterministic pi-mono event mapping remains covered by tests
- Structured actor log records with step number, tool, output, exit code, error state, metadata, and optional screenshot reference for browser capture commands
- Supervisor pipeline that consumes `LogBatch`, uses a pluggable model client, and returns validated `SupervisorDecision`
- Three supervisor clients:
  - `mock` for local/offline default behavior
  - `heuristic` for simple risk/failure/repetition checks
  - `openai-compatible` for remote `/chat/completions` endpoints via `fetch`, enabled only when configured
- In-process A2A message flow:
  - `feedback` sends a supervisor message to the actor and pauses the task
  - `halt` sends a cancel request to the actor and halts the task
- Alert dispatcher with channel abstractions for terminal, Discord webhook, Telegram bot, and voice-call hooks
  - terminal and Discord webhook alert delivery are implemented
  - voice-call alert dispatch is implemented for critical alerts through a configurable command template executor
  - Telegram bot alert dispatch still returns an explicit placeholder result
- OpenClaw-style channel adapter layer with normalized inbound/outbound models and a `ChannelAdapter` contract
  - Discord adapter sends outbound events over webhook
  - Discord inbound supports either a real-time Discord gateway bot client or the existing polled JSONL file bridge fallback
  - Telegram adapter supports Bot API outbound delivery plus long-poll inbound with allowlist and prefix filters
- Unified `IntentEnvelope` routing schema for inbound UX:
  - `intent`: `start_task`, `followup`, `resume`, `halt`, `status`, or `clarify`
  - `task_ref`: `current`, a task id, or `null`
  - `instruction`, `confidence`, and `reason`
- Intent resolver pipeline with:
  - a rule-based pass for control phrases and backward-compatible aliases
  - a model-resolver interface with a mock default fallback
  - default `start_task` routing for non-control natural language when confidence is high enough, otherwise `clarify`
- Conversation router that maps any inbound human message through `IntentEnvelope` resolution, then emits task lifecycle plus supervisor warning/critical updates back through the originating adapter
- Terminal interaction loop that accepts natural conversation such as starting work, asking for status, resuming, or halting without command prefixes, while still supporting operational CLI commands like `config`, `logs`, `bridge`, and `smoke`
- JSON config loader with defaults for actor, supervisor, batch, alert channels, channel adapters, and command mapping
- Interactive `lumo setup` wizard for first-run config generation, plus a non-interactive mode for CI/bootstrap flows
- Automated tests for actor log emission, supervisor routing, config parsing, setup generation, overwrite guards, batching, A2A delivery, decision validation, command resolution, alert dispatch routing, router command mapping, and Discord adapter normalization/contract behavior

## Terminal Usage

Install dependencies:

```bash
npm install
```

Run the CLI:

```bash
npm run dev
```

Run the setup wizard:

```bash
npm run dev -- setup
```

Optional config file at runtime:

```bash
npm run dev -- ./lumo.config.json
```

Non-interactive bootstrap example:

```bash
npm run dev -- setup --non-interactive --force \
  --config ./lumo.config.json \
  --actor-model local-actor \
  --supervisor-model mock-supervisor \
  --supervisor-client heuristic \
  --discord-enabled true \
  --discord-inbound-mode gateway \
  --discord-token-env-var LUMO_CHANNELS_DISCORD_BOT_TOKEN \
  --discord-allowed-channels guild:123/channel:456 \
  --discord-allowed-users 111111111111111111,222222222222222222 \
  --discord-mention-prefix @lumo \
  --discord-gateway-healthcheck true \
  --terminal-alerts true
```

Conversation examples:

- `Investigate why the checkout tests are flaky`
- `what's the status?`
- `continue with the last plan`
- `stop this run`
- `followup collect the latest stack trace`
- `new compare the failing branch against main`

Operational CLI commands:

- `config`
- `logs`
- `bridge`
- `provider <codex|claude|opencode>`
- `supervisor <mock|heuristic|openai-compatible>`
- `smoke`
- `help`
- `exit`

At startup, Lumo now requires a healthy pi-mono runtime. There is no silent legacy fallback.

Task instruction syntax inside a started task:

- `/bash pwd`
- `/browser capture current page`
- `/agent summarize the repo state`
- Plain text without a prefix defaults to the configured coding agent

## Config

`lumo.config.json` is optional. Missing values fall back to in-code defaults.

### Setup Wizard

`lumo setup` prompts for:

- config path
- actor model default
- supervisor model and client
- Discord enablement
- Discord inbound mode (`gateway` or `file`)
- optional Discord webhook URL
- Discord token env var name
- allowed Discord channels and users
- optional mention prefix
- optional setup-time Discord gateway healthcheck
- terminal alerts

If the target file already exists, Lumo asks before overwriting it unless `--force` is set.

For CI or bootstrap automation, `lumo setup --non-interactive` accepts flags and `LUMO_SETUP_*` environment variables:

- `LUMO_SETUP_CONFIG_PATH`
- `LUMO_SETUP_ACTOR_MODEL`
- `LUMO_SETUP_SUPERVISOR_MODEL`
- `LUMO_SETUP_SUPERVISOR_CLIENT`
- `LUMO_SETUP_DISCORD_ENABLED`
- `LUMO_SETUP_DISCORD_INBOUND_MODE`
- `LUMO_SETUP_DISCORD_WEBHOOK_URL`
- `LUMO_SETUP_DISCORD_TOKEN_ENV_VAR`
- `LUMO_SETUP_DISCORD_ALLOWED_CHANNELS`
- `LUMO_SETUP_DISCORD_ALLOWED_USERS`
- `LUMO_SETUP_DISCORD_MENTION_PREFIX`
- `LUMO_SETUP_DISCORD_GATEWAY_HEALTHCHECK`
- `LUMO_SETUP_TERMINAL_ALERTS`
- `LUMO_SETUP_FORCE`
- `LUMO_SETUP_NON_INTERACTIVE`

Example:

```json
{
  "runtime": {
    "provider": "pi-mono"
  },
  "actor": {
    "model": "local-actor",
    "codingAgent": {
      "provider": "claude"
    }
  },
  "supervisor": {
    "client": "openai-compatible",
    "openaiCompatible": {
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini",
      "timeoutMs": 15000
    }
  },
  "batch": {
    "maxSteps": 2,
    "immediateKeywords": ["sudo", "rm -rf"]
  },
  "alerts": {
    "enableTerminalBell": true,
    "channels": {
      "terminal": {
        "enabled": true
      },
      "discord": {
        "enabled": true,
        "webhookUrl": "https://discord.com/api/webhooks/..."
      },
      "voiceCall": {
        "enabled": true,
        "recipient": "+15551234567",
        "providerCommandTemplate": ["openclaw", "voice-call", "--to", "{recipient}", "--message", "{message}"]
      }
    }
  },
  "channels": {
    "commandMapping": {
      "new": ["new"],
      "followup": ["followup"],
      "resume": ["resume"],
      "halt": ["halt"],
      "status": ["status"]
    },
    "intentRouting": {
      "modelResolver": "mock",
      "startTaskConfidenceThreshold": 0.7
    },
    "adapters": {
      "discord": {
        "enabled": true,
        "webhookUrl": "https://discord.com/api/webhooks/...",
        "inbound": {
          "mode": "gateway",
          "tokenEnvVar": "LUMO_CHANNELS_DISCORD_BOT_TOKEN",
          "allowedChannels": ["guild:123/channel:456"],
          "allowedUsers": ["111111111111111111"],
          "mentionPrefix": "@lumo"
        }
      },
      "telegram": {
        "enabled": true,
        "botToken": "123456:telegram-bot-token",
        "chatId": "777777777",
        "inbound": {
          "allowedChatIds": ["777777777"],
          "allowedUserIds": ["123456789"],
          "mentionPrefix": "@lumo",
          "pollIntervalMs": 1000,
          "timeoutSeconds": 30
        }
      }
    }
  }
}
```

OpenAI-compatible supervisor mode reads the API key from config or `LUMO_SUPERVISOR_OPENAI_API_KEY`. The default config also reads:

- `LUMO_RUNTIME_PROVIDER`
- `LUMO_SUPERVISOR_OPENAI_BASE_URL`
- `LUMO_SUPERVISOR_OPENAI_MODEL`
- `LUMO_SUPERVISOR_OPENAI_TIMEOUT_MS`
- `LUMO_ALERTS_DISCORD_WEBHOOK_URL`
- `LUMO_CHANNELS_DISCORD_WEBHOOK_URL`
- `LUMO_CHANNELS_DISCORD_INBOUND_MODE`
- `LUMO_CHANNELS_DISCORD_INBOUND_FILE`
- `LUMO_CHANNELS_DISCORD_BOT_TOKEN_ENV_VAR`
- `LUMO_CHANNELS_DISCORD_BOT_TOKEN`
- `LUMO_CHANNELS_DISCORD_ALLOWED_CHANNELS`
- `LUMO_CHANNELS_DISCORD_ALLOWED_USERS`
- `LUMO_CHANNELS_DISCORD_MENTION_PREFIX`
- `LUMO_CHANNELS_TELEGRAM_BOT_TOKEN`
- `LUMO_CHANNELS_TELEGRAM_CHAT_ID`
- `LUMO_CHANNELS_TELEGRAM_ALLOWED_CHAT_IDS`
- `LUMO_CHANNELS_TELEGRAM_ALLOWED_USER_IDS`
- `LUMO_CHANNELS_TELEGRAM_MENTION_PREFIX`
- `LUMO_CHANNELS_TELEGRAM_POLL_INTERVAL_MS`
- `LUMO_CHANNELS_TELEGRAM_TIMEOUT_SECONDS`
- `LUMO_ALERTS_VOICE_CALL_RECIPIENT`
- `LUMO_ALERTS_VOICE_CALL_COMMAND_TEMPLATE`

Real binary detection runs automatically for `agent-browser`, `codex`, `claude`, and `opencode`. If a binary is not found, Lumo falls back to a local mock subprocess and includes that fallback in command metadata. If your installed CLI expects different flags, override the command spec in `lumo.config.json`.

## Runtime Migration

Lumo now routes session lifecycle calls through `RuntimeSessionAdapter` instead of letting `SessionManager` own runtime execution directly. The current state of the migration is:

- Implemented: adapter contract, strict pi-mono initialization in `SessionManager`, startup health-check enforcement, unchanged terminal and conversation flows through the adapter boundary, and deterministic mapping utilities for pi-mono events.
- Disabled in production: the legacy runtime execution path no longer participates in runtime selection or fallback.
- Scaffolded: `PiMonoSessionAdapter` client integration, pause/resume/halt wiring into a real pi-mono backend, and production session brokerage.

### Discord Gateway Setup

1. Create a Discord bot in the Discord Developer Portal.
2. Under `Bot`, copy the bot token and store it in the env var named by `channels.adapters.discord.inbound.tokenEnvVar` (default: `LUMO_CHANNELS_DISCORD_BOT_TOKEN`).
3. Under `Bot`, enable these intents:
   - `Server Members Intent` is not required
   - `Presence Intent` is not required
   - `Message Content Intent` is required so the gateway client can read message text
4. Invite the bot with permissions sufficient to read and write in the target channels:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
   - `Create Public Threads` or `Send Messages in Threads` if you want thread-scoped use
5. Set `channels.adapters.discord.inbound.mode` to `gateway`.
6. Set `allowedChannels` to the scopes you want to accept. Supported forms are:
   - raw ids like `456789012345678901`
   - `guild:<guildId>`
   - `channel:<channelId>`
   - `thread:<threadId>`
   - `guild:<guildId>/channel:<channelId>`
   - `channel:<channelId>/thread:<threadId>`
   - `guild:<guildId>/channel:<channelId>/thread:<threadId>`
7. Optionally set `allowedUsers` to a sender allowlist and `mentionPrefix` to require a prefix like `@lumo`.

Gateway inbound starts automatically when Lumo starts. The `bridge` CLI command is still useful for file mode, but gateway mode receives messages in real time and logs connect, reconnect, resume, disconnect, and shutdown events.

When `lumo setup` writes a config with Discord gateway inbound enabled, it can also run a non-fatal connectivity check against the bot token env var. Interactive setup defaults this check on. Non-interactive setup defaults it off unless `--discord-gateway-healthcheck true` or `LUMO_SETUP_DISCORD_GATEWAY_HEALTHCHECK=true` is set.

### Telegram Bot API Setup

Set `channels.adapters.telegram.enabled` to `true`, then provide:

1. `botToken` or `LUMO_CHANNELS_TELEGRAM_BOT_TOKEN`
2. `chatId` for the default outbound destination
3. Optional inbound filters under `channels.adapters.telegram.inbound`:
   - `allowedChatIds`
   - `allowedUserIds`
   - `mentionPrefix`
   - `pollIntervalMs`
   - `timeoutSeconds`

Telegram inbound uses Bot API `getUpdates` long polling and normalizes accepted user messages into `ChannelInboundMessage`. Outbound replies use the inbound conversation id when available and fall back to the configured `chatId`.

### Voice-Call Alerts

Critical supervisor alerts can trigger a voice-call provider command through `alerts.channels.voiceCall`. Configure:

1. `enabled: true`
2. `recipient`
3. `providerCommandTemplate`, for example `["openclaw", "voice-call", "--to", "{recipient}", "--message", "{message}"]`

Supported template tokens are `{recipient}`, `{message}`, `{taskId}`, `{severity}`, `{action}`, `{reason}`, `{suggestion}`, `{actorAgentId}`, and `{supervisorAgentId}`. Warning alerts are skipped, and missing voice-call config degrades to a logged skip instead of a hard failure.

### Discord File Fallback

For local Discord bridge input, append JSON lines to the configured inbound file. Example:

```json
{"messageId":"msg-1","conversationId":"discord-local","userId":"operator-1","displayName":"Operator","text":"what's the status?"}
```

Then run `bridge` in the terminal loop to poll adapters once.

Explicit aliases remain supported for backward compatibility, but they are optional. The router now treats natural-language control phrases and natural-language task requests as the primary UX.

See [`lumo.config.example.json`](/Users/howard/.openclaw/workspace-orchestrator/shared-workspace/projects/harness/lumo/lumo.config.example.json) for a full example.

## Scripts

```bash
npm run build
npm run test
npm run lint
```
