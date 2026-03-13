# Lumo

Actor-Supervisor harness for monitored autonomous tasks.

## What it does

- Runs tasks through an **Actor** runtime (bash / browser / coding-agent paths)
- Monitors execution with a **Supervisor**
- Supports intervention outcomes:
  - `ok` → continue
  - `warning` → feedback injection
  - `critical` → halt + alert
- Uses unified natural-language intent routing (`start_task`, `followup`, `resume`, `halt`, `status`)
- Supports channel integration (Discord gateway/webhook, Telegram inbound/outbound)
- Runtime is **pi-mono only** (startup fails if pi-mono health-check fails)

## Requirements

- Node.js 22+
- npm
- pi-mono runtime available/reachable

## Install

```bash
git clone https://github.com/effortprogrammer/lumo.git
cd lumo
npm install
npm run build
npm link
```

`npm install` now auto-installs the `pi-mono` dependency from GitHub (`badlogic/pi-mono`) as part of a fresh clone setup.

If you prefer a one-shot global install instead of a link:

```bash
npm i -g .
```

After either `npm link` or `npm i -g .`, run the installed CLI directly:

```bash
lumo
```

You can also run setup first:

```bash
lumo setup
```

Convenience scripts:

```bash
npm run build
npm run link:global
npm run install:global
```

## Setup

Interactive setup:

```bash
lumo setup
```

This creates `lumo.config.json`.

## Run

```bash
lumo
```

Or with an explicit config path:

```bash
lumo ./lumo.config.json
```

If you have not linked or globally installed the package yet, you can still run the built CLI locally:

```bash
npm run cli
npm run setup
```

For a future published package, the equivalent no-install flow would be:

```bash
npx lumo
```

## Basic usage (natural language)

After startup, type naturally:

- `네이버에서 오픈클로 검색해서 요약해`
- `지금 상태 어때?`
- `이전 작업 이어서 진행해`
- `이 작업 멈춰`

## Notes

- Legacy runtime fallback is removed.
- If `runtime.provider` is not `pi-mono`, startup fails fast.
