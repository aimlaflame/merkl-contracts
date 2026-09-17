# Autopilot Recovery Playbook

## Immediate safety actions

1. Switch to manual mode: `POST /mode {"mode":"manual"}`.
2. Stop execution: `POST /stop`.
3. Rotate `AUTOPILOT_ADMIN_API_KEYS` if access is suspected compromised.

## Guardrail or repeated-failure auto pause

1. Review `GET /status` and `GET /runs`.
2. Inspect `automation/state/audit.log` for `run.error` and `alert.created` events.
3. Adjust policy limits or strategy actions.
4. Trigger dry-run preflight with `AUTOPILOT_EXECUTION_MODE=dry-run` and `POST /run-now`.
5. Return to `AUTOPILOT_MODE=auto`, then `POST /start`.

## Signer policy failure

1. Confirm `HOT_SIGNER_PRIVATE_KEY` and `COLD_SIGNER_ADDRESS` are set.
2. Verify hot signer has minimal required permissions only.
3. Keep cold signer as custody/rotation account and avoid daily automation use.

## Suspicious execution

1. Stop service immediately.
2. Revoke strategy command authorization by tightening `AUTOPILOT_ALLOWED_COMMAND_PREFIXES`.
3. Rotate hot signer key and API keys.
4. Resume only in dry-run until audit log review is complete.

## Daily operational checklist

1. Confirm scheduler next run in `/status`.
2. Acknowledge and clear active alerts.
3. Verify estimated APR and realized PnL trend.
4. Keep command allowlist and strategy files under source control review.
