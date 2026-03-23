# Lumo

Lumo is a supervised runtime for autonomous tasks.

It runs an actor, monitors it with a supervisor, and escalates when the task needs human attention.

## What Lumo does

- Runs monitored tasks through an actor-supervisor loop
- Injects feedback on warnings and halts on critical states
- Sends escalation alerts to operators through Discord webhooks or the terminal
- Accepts task input from local CLI and supported chat adapters
- Supports browser-oriented and coding-agent execution paths through its built-in runtime integration

## Requirements

- Node.js 22+
- npm
- A configured model provider for the runtime you want to use

## Install

For a local checkout:

```bash
git clone https://github.com/effortprogrammer/lumo.git
cd lumo
npm install
npm run build
npm link
```

After linking:

```bash
lumo
```

If you prefer to run without linking globally:

```bash
npm run cli
```

## First run

On first run, Lumo looks for `./lumo.config.json`.

- If the file exists, Lumo starts with that config
- If the file is missing, Lumo launches guided setup automatically

You can also start setup directly:

```bash
lumo init
lumo setup
```

## Setup modes

The setup wizard has two paths:

- `Quickstart` creates a minimal local config
- `Custom` lets you configure Discord integration, alerting, the pi runtime provider, and an optional supervisor model

The guided setup currently focuses on Lumo-owned integrations such as:

- Discord inbound configuration
- Discord webhook alerts
- terminal alerts
- pi runtime model provider setup
- optional supervisor model wiring for `lumo.config.json`

Quickstart now also includes a pi model provider step so first-time installs do not stop at the runtime's "No model provider is configured yet" prompt. API-key based providers are written to `~/.pi/agent/auth.json`, while OAuth-based providers such as GitHub Copilot will prompt you to finish setup later with `/login` inside `pi`.

Custom setup adds an optional supervisor section for either `anthropic-compatible` or `openai-compatible` clients and writes those settings into `lumo.config.json`.

## Discord setup

There are two separate Discord surfaces:

- `Discord inbound`: lets you send tasks and control messages to Lumo from Discord
- `Discord webhook alerts`: lets Lumo send escalation alerts to a Discord channel

If you only want escalation alerts, a webhook URL is enough.

If you want Discord as a control surface, you also need:

- a Discord bot token
- allowed channel scopes
- optional allowed user filters
- an optional mention prefix

The example config shows both surfaces in one place: `lumo.config.example.json`.

## Run

Default config path:

```bash
lumo
```

Explicit config path:

```bash
lumo ./lumo.config.json
```

CLI help:

```bash
lumo --help
```

## How task control works

Lumo supports natural-language task control through its intent router.

Common flows:

- start a new task
- send a follow-up to the current task
- ask for task status
- halt the current task
- resume a halted task with extra guidance

When the supervisor detects a warning or critical condition, it can:

- continue normally
- inject feedback into the running task
- halt the task and emit an escalation alert

## Alerts

Supported alert channels today:

- terminal
- Discord webhook
- voice-call command integration for critical alerts

Current limitation:

- Telegram alert dispatch is not implemented yet

## Example config

See `lumo.config.example.json` for a full configuration example covering runtime, supervisor, Discord, alerts, and channel adapters.
