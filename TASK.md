# Task: Add Model Provider Setup to Lumo Wizard

## Goal
Enhance `lumo init` / `lumo setup` so users can configure a model provider (for pi runtime) and optionally a supervisor model during the setup wizard — eliminating the "No models available" dead-end after first install.

## Current State
- `src/setup/wizard.ts` handles setup but only covers Discord/alerts
- `src/runtime/pi-cli-launch.ts` checks for providers via env vars or `~/.pi/agent/auth.json`
- pi supports many providers: Anthropic, OpenAI, Google, OpenRouter, etc.
- pi auth.json format: `{"anthropic": "sk-ant-...", "openai": "sk-..."}` (key = provider name from env-api-keys.ts)
- Supervisor config is in `lumo.config.json` under `supervisor.anthropicCompatible` / `supervisor.openaiCompatible`

## Requirements

### 1. Quickstart Flow — Add Model Provider Step
After the existing Quickstart confirmation, add ONE more step:

```
Model provider for pi runtime (use arrow keys)
> Anthropic (API key)
  OpenAI (API key)
  Google Gemini (API key)
  GitHub Copilot (free, OAuth in pi)
  OpenRouter (API key)
  Skip (configure later in pi)
```

- If user picks an API key provider → prompt for the key → write to `~/.pi/agent/auth.json`
- If user picks OAuth provider (GitHub Copilot etc.) → print message: "After setup, run /login in pi to complete OAuth."
- If user picks Skip → current behavior (no change)

### 2. Custom Flow — Full Provider + Supervisor Setup
In the Custom flow, add TWO new sections after existing Discord/alerts steps:

**a) Model Provider (same as Quickstart)**

**b) Supervisor Model**
```
Configure supervisor model? (use arrow keys)
> Yes
  No (use defaults)

Supervisor provider:
> Anthropic-compatible
  OpenAI-compatible

[If Anthropic-compatible]
Base URL [https://api.anthropic.com/v1]: 
API key (or env var name) [ANTHROPIC_API_KEY]: 
Model [claude-sonnet-4-20250514]:

[If OpenAI-compatible]  
Base URL [https://api.openai.com/v1]:
API key (or env var name) [OPENAI_API_KEY]:
Model [gpt-4o]:
```

- Write supervisor settings into the generated `lumo.config.json`
- Set `supervisor.client` to the chosen type
- Set `enabled: true` on the chosen compatible block

### 3. Auth File Writing
- Create `~/.pi/agent/auth.json` if it doesn't exist
- Merge with existing auth.json if it already exists (don't overwrite other providers)
- Provider key names must match pi's expected format:
  - `anthropic` for Anthropic
  - `openai` for OpenAI
  - `google` for Google Gemini
  - `openrouter` for OpenRouter

### 4. Non-Interactive Support
Extend CLI flags for non-interactive mode:
- `--model-provider <name>` (anthropic, openai, google, openrouter, copilot, skip)
- `--model-api-key <key>`
- `--supervisor-provider <type>` (anthropic-compatible, openai-compatible, none)
- `--supervisor-base-url <url>`
- `--supervisor-api-key <key>`
- `--supervisor-model <model>`

With corresponding `LUMO_SETUP_*` env var fallbacks.

### 5. Summary Display
Update `formatQuickstartPreview()` and `formatSetupSummary()` to show:
```
Model provider: Anthropic (API key configured)
Supervisor: anthropic-compatible (claude-sonnet-4-20250514)
```

### 6. Tests
Update existing tests in `test/setup.test.ts` to cover:
- Quickstart with provider selection
- Custom with supervisor configuration  
- Non-interactive with new flags
- Auth.json creation/merge
- Skip behavior (no auth.json changes)

## Constraints
- Don't modify `pi-cli-launch.ts` — it already checks auth.json and env vars
- Don't modify `load-config.ts` types — supervisor config structure is already there
- Keep the wizard UX consistent (same arrow-key select pattern)
- API keys should NEVER be logged or echoed back in full (mask all but last 4 chars in summary)
- Respect existing `--force` and `--non-interactive` semantics

## Files to Modify
- `src/setup/wizard.ts` — main changes
- `test/setup.test.ts` — test updates
- `README.md` — document new setup options in First Run section

## Build & Test
```bash
npm run build   # must pass clean
npm test         # all tests must pass
```
