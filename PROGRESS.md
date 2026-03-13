# Lumo Phase 10 Progress

Completed on 2026-03-13.

## Completed Items

- Added binary detection helper and switched default browser runner selection to `agent-browser` when available, otherwise a mock fallback with explicit metadata.
- Added coding-agent default detection for `codex`, `claude`, and `opencode`, with real command specs when binaries are present and clear mock metadata when absent.
- Added `OpenAICompatibleSupervisorClient` for OpenAI-compatible `/chat/completions` endpoints, wired behind config and env fields, with heuristic fallback when selected but not configured.
- Added alert channel abstractions plus implementations for terminal, Discord webhook, and critical-only voice-call delivery; the Telegram alert channel remains an explicit placeholder.
- Wired warning and critical supervisor decisions into alert dispatch before feedback or halt routing.
- Expanded terminal loop commands with `config`, `supervisor <mode>`, and `smoke`.
- Updated tests for resolver fallback logic, config merging, runtime metadata, and alert dispatch routing.
- Added an OpenClaw-style `ChannelAdapter` layer with normalized inbound/outbound message models.
- Implemented a Discord adapter that posts outbound updates via webhook and can poll a local JSONL file bridge for inbound messages in development without a bot token.
- Replaced the Telegram adapter skeleton with a real Bot API adapter that supports outbound `sendMessage`, inbound long polling via `getUpdates`, normalization into `ChannelInboundMessage`, allowlist filters, prefix filtering, and graceful start/stop behavior.
- Added a unified `IntentEnvelope` schema with `intent`, `task_ref`, `instruction`, `confidence`, and `reason` for all inbound task-control routing.
- Added an intent resolver pipeline with a lightweight rule-based control-phrase pass and a model-resolver interface with a mock default fallback.
- Updated `ConversationRouter` so all inbound human messages route through `IntentEnvelope`; old aliases remain supported but are no longer required.
- Updated the terminal loop help and examples to use natural conversation as the primary UX instead of command-first task entry.
- Extended config defaults and example config with `channels.intentRouting` settings alongside optional alias mapping.
- Added tests for natural-language task starts, unprefixed resume/halt/status controls, ambiguous clarify responses, and backward-compatible alias routing.
- Added `ConversationRouter` and `ChannelBridge` so inbound channel messages can drive `SessionManager` actions and emit task lifecycle plus supervisor warning/critical updates.
- Added `bridge` to the terminal loop to poll enabled adapters on demand.
- Added tests for router command mapping, intent resolution, and channel adapter contract behavior.
- Added Discord gateway inbound mode with real-time bot login, scoped `messageCreate` handling, self-loop prevention, optional sender allowlists, and mention-prefix filtering.
- Preserved the JSONL file bridge as a fallback inbound mode and kept Discord outbound delivery on the webhook path.
- Extended normalized channel message and reply-target models to preserve guild, channel, thread, and message ids for future reply-aware outbound handling.
- Added adapter lifecycle startup and shutdown so the Discord gateway client connects on launch and destroys cleanly on exit, with reconnect and error logs.
- Updated config defaults, example config, and README for gateway mode setup including bot token env vars, intents, permissions, and scope filters.
- Added deterministic tests for Discord gateway config parsing, message normalization, and mock-client event delivery.
- Added a dedicated `lumo setup` CLI mode so first-run configuration generation is separate from the runtime terminal loop.
- Implemented an interactive setup wizard that collects actor, supervisor, Discord, and terminal-alert settings and writes config JSON safely.
- Added non-interactive setup support with flags and `LUMO_SETUP_*` environment variables for CI/bootstrap usage.
- Added validation and sanitization for setup input, including trimmed fields, comma-list parsing, and gateway-mode required-field checks.
- Added overwrite guards for generated config files with confirmation prompts unless `--force` is supplied.
- Added an optional setup-time Discord gateway healthcheck with interactive-on/non-interactive-off defaults, explicit pass/fail/skip diagnostics, and non-fatal behavior.
- Added configurable voice-call alert dispatch through a pluggable command executor with recipient and provider command template interpolation for critical alerts only.
- Extended config defaults, example config, and README with Telegram inbound settings, Discord setup healthcheck controls, and voice-call alert configuration.
- Updated README with setup walkthroughs and non-interactive examples.
- Added deterministic tests for setup healthcheck result handling, Telegram normalization/filtering and Bot API polling/send behavior, voice-call dispatch routing, and the new config surfaces.
- Introduced a `RuntimeSessionAdapter` abstraction with explicit session event types and lifecycle methods for create/send/pause/resume/halt/subscribe.
- Refactored `SessionManager` to drive runtimes through the adapter boundary while preserving terminal and conversation behavior.
- Kept the `RuntimeSessionAdapter` abstraction but removed runtime-provider fallback from the production path.
- Kept `LegacyRuntimeAdapter` only as a non-production compatibility scaffold; `SessionManager` now initializes pi-mono only.
- Added strict pi-mono startup validation and health-check enforcement with explicit launch/config errors instead of silent fallback.
- Narrowed config defaults and validation so `runtime.provider` must be `pi-mono`; legacy provider values now fail fast from env or config.
- Updated terminal banner/help, README, and example config to document pi-mono-only runtime behavior.
- Updated adapter-focused tests to remove legacy fallback assumptions, add fail-fast coverage, and preserve deterministic pi-mono event mapping checks.

## Verification

- `npm run build`
- `npm run test`

Results:

- `npm run build` passed.
- `npm run test` passed with 42 tests across 16 suites.

Real vs placeholder:

- Real: Discord gateway inbound, Telegram adapter inbound/outbound, Discord setup healthcheck, terminal alerts, Discord webhook alerts, and critical voice-call alert dispatch.
- Real: pi-mono is the only supported runtime in the startup and session-management path; legacy runtime execution has been removed/disabled from production selection.
- Placeholder: `LegacyRuntimeAdapter` remains in-tree only as a compatibility scaffold and contract reference, not as an active production runtime path.
- Placeholder: `PiMonoSessionAdapter` remains a local scaffold until a real pi-mono client/runtime is connected.
- Placeholder: Telegram alert-channel dispatch still returns an explicit skipped result until a dedicated alert delivery path is added.
