# Merkl Autopilot Service

## What it does

- Runs a daily Merkl incentive strategy pipeline.
- Discovers opportunities, allocates capital, applies guardrails, and executes approved actions.
- Exposes remote control APIs and a browser dashboard.

## Architecture

- `src/agents.js`: Opportunity, Allocation, Guardrail, Execution agents
- `src/controller.js`: scheduling, retries, run lifecycle, alerts, pause/manual override
- `src/learning.js`: confidence adaptation, cooldown state, and learning persistence
- `src/server.js`: API + dashboard
- `src/config.js`: environment and strategy config loading

## Security model

- Role-based API keys (`admin`, `viewer`)
- Command-prefix allowlist before execution
- Structured command actions (`file` + `args`) for live execution
- Dry-run default
- Hot/cold signer separation checks
- Audit events written to `automation/state/audit.log`
- Bounded learning controls to prevent unsafe over-adjustment

## Run

```bash
yarn autopilot:start
```

## Test

```bash
yarn autopilot:test
```
