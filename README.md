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
- Runtime is **pi-mono only** (startup first attempts auto-bootstrap, then fails if the pi-mono health-check still fails)

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

Wizard UX notes:

- Yes/No and enum choices use an interactive selector. Use the arrow keys to move and `Enter` to confirm.
- Free-form text is still used for values like config path, model names, token env vars, and allowlists.
- The wizard shows a final summary of all selected values and requires one last Yes/No confirmation before writing the file.

## Run

```bash
lumo
```

On startup, Lumo checks whether the `pi-mono` runtime is reachable. If the first health-check fails and auto-bootstrap is enabled, Lumo runs the configured bootstrap command list, waits briefly, and retries the health-check once before giving up.

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
- If `runtime.bootstrap.enabled` is `false` or `LUMO_RUNTIME_AUTO_BOOTSTRAP=0`, Lumo keeps the existing fail-fast startup behavior with no bootstrap attempt.
- Default bootstrap behavior is to detect the locally installed `pi-mono` dependency and run `npm --prefix './node_modules/pi-mono' run build`.
- Override bootstrap commands in config with `runtime.bootstrap.commands` or via `LUMO_RUNTIME_BOOTSTRAP_COMMANDS`, using `;;` between commands, for example `export LUMO_RUNTIME_BOOTSTRAP_COMMANDS="pi-mono bootstrap ;; pi-mono doctor"`.
- Tune the retry delay with `runtime.bootstrap.retryBackoffMs` or `LUMO_RUNTIME_BOOTSTRAP_RETRY_BACKOFF_MS`.
- When bootstrap still fails, startup prints the attempted commands so you can run or replace them directly.
