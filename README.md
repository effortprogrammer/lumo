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

- Node.js 20+
- npm
- pi-mono runtime available/reachable

## Install

```bash
git clone https://github.com/effortprogrammer/lumo.git
cd lumo
npm install
```

## Setup

Interactive setup:

```bash
npm run dev -- setup
```

This creates `lumo.config.json`.

## Run

```bash
npm run dev
```

Or with an explicit config path:

```bash
npm run dev -- ./lumo.config.json
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
