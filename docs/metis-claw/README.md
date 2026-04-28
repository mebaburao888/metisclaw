# Metis Claw Managed Files (Pilot)

This fork currently expects Metis-managed files in the OpenClaw state directory.

## Default paths
- Managed config: `<stateDir>/metis-claw/managed-config.json`
- Policy: `<stateDir>/metis-claw/policy.json`
- Audit log: `<stateDir>/logs/metis-claw-audit.jsonl`

## Environment overrides
- `OPENCLAW_METIS_MANAGED_CONFIG_PATH`
- `OPENCLAW_METIS_POLICY_PATH`
- `OPENCLAW_METIS_AUDIT_LOG_PATH`

## Current pilot behavior
- `enterprise.managedMode: true` enables Metis-managed exec policy checks.
- If managed config is malformed, exec fails closed instead of silently acting unmanaged.
- If `enterprise.orgId` and `policy.orgId` do not match, policy is rejected and exec fails closed.
- If `tools.exec.requireApproval` is true, approval is requested from the end user through the existing OpenClaw approval flow.
- Approval audit semantics are distinct:
  - `tool.exec.preflight` may be `pending`
  - `tool.exec.approval_requested` records request/pending
  - `tool.exec.approval_resolved` records approved/denied/timeout/cancelled outcome

## Important pilot limitation
Policy/config are cached for process lifetime right now. Restart is required for changes to take effect.
