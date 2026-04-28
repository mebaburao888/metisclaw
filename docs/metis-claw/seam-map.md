# Metis Claw Seam Map

This document describes exactly where Metis enforcement hooks into the OpenClaw runtime.
It exists so packaging the fork into a distributable `metis-claw` product is an explicit,
traceable decision instead of tribal knowledge.

---

## Seam 1 — exec preflight (before_tool_call)

**File:** `src/agents/pi-tools.before-tool-call.ts`

**Hook:** `runBeforeToolCallHook`

This is the single intercept point for all `exec` tool calls in the agent runtime.
When `toolName === "exec"`:

1. `getMetisManagedRuntimeContext(process.env)` is called (cached, process-lifetime).
2. `readExecCommand(params)` extracts the command string.
3. `normalizeExecDecision({ managedMode, command, policySnapshot })` produces a decision.
4. Decision outcomes:
   - `allow` → continue normally
   - `deny` → return blocked result immediately
   - `requireApproval` → enter the existing OpenClaw approval flow

Metis emits audit events at each stage via `emitMetisExecPreflightAudit`.

---

## Seam 2 — policy load + validation

**File:** `src/metis/managed-exec-policy.ts`

Two entry points:

### `getMetisManagedRuntimeContext(env)`
Public, cached. Returns the process-lifetime `MetisManagedRuntimeContext`.
**Cache note:** cached for process lifetime. Restart required for config/policy changes.
Call `invalidateMetisManagedRuntimeCache()` to force a reload (testing / future hot-reload).

### `loadManagedRuntimeContext(env)`
Actual I/O. Called once by the cache.

Load order:
1. Read `managed-config.json` (path via `OPENCLAW_METIS_MANAGED_CONFIG_PATH` or default).
2. Validate shape via `validateManagedConfigShape`.
3. If `enterprise.managedMode !== true` → return `bypassed`.
4. Read `policy.json` (path via `OPENCLAW_METIS_POLICY_PATH` or default).
5. Validate shape via `validatePolicyShape`.
6. If `enterprise.orgId` is set and does not match `policy.orgId` → return `org_mismatch`.
7. Return `loaded` with the `MetisPolicy`.

All failure paths return `managedMode: true` + a non-`loaded` status so exec fails closed.

---

## Seam 3 — approval flow

**File:** `src/agents/pi-tools.before-tool-call.ts`

When decision is `requireApproval`:
1. `emitMetisExecApprovalRequestedAudit(...)` is called.
2. The existing `resolveApprovalRequest(...)` OpenClaw approval path is entered.
3. An `onResolution` callback is attached:
   - On resolution (allow-once / allow-always / deny / timeout / cancelled):
     `emitMetisExecApprovalResolvedAudit({ resolution, ... })` is called.

No new approval UI is introduced. Approval stays with the **end user** via the existing
OpenClaw approval card/button surface.

---

## Seam 4 — audit log

**File:** `src/metis/audit.ts`

All audit events are appended to a JSONL file via `appendMetisAuditEvent`.

Path resolution:
- `OPENCLAW_METIS_AUDIT_LOG_PATH` env override
- Default: `<stateDir>/logs/metis-claw-audit.jsonl`

Event types emitted today:

| eventType                        | when                                  | result values                         |
|----------------------------------|---------------------------------------|---------------------------------------|
| `tool.exec.preflight`            | every exec in managed mode            | `allowed`, `blocked`, `pending`       |
| `tool.exec.approval_requested`   | when requireApproval fires            | `pending`                             |
| `tool.exec.approval_resolved`    | when user approves / denies / timeout | `approved`, `denied`, `timeout`, `cancelled` |
| `tool.exec.result`               | after exec completes                  | `allowed`, `error`                    |

---

## Seam 5 — path resolution

**File:** `src/metis/managed-exec-policy.ts`

`resolveMetisPaths(env)` is the single function that resolves all Metis file paths.

| Path               | Env override                          | Default                                          |
|--------------------|---------------------------------------|--------------------------------------------------|
| managed-config     | `OPENCLAW_METIS_MANAGED_CONFIG_PATH`  | `<stateDir>/metis-claw/managed-config.json`      |
| policy             | `OPENCLAW_METIS_POLICY_PATH`          | `<stateDir>/metis-claw/policy.json`              |
| audit log          | `OPENCLAW_METIS_AUDIT_LOG_PATH`       | `<stateDir>/logs/metis-claw-audit.jsonl`         |

---

## What is NOT yet wired

The following are described in the plan but not yet implemented in this fork:

- **Bootstrap/config precedence override** — Metis config does not yet take precedence over
  the normal `openclaw.json` config at startup.
- **Admin-side policy distribution / sync** — no remote policy fetch; file-local only.
- **Hot-reload** — config/policy changes require a restart.
- **Operator approvals** — all approvals are end-user today; no separate admin approval path.
- **Plugin-level approval scopes** — Metis does not yet intercept plugin tool approvals.
- **Binary packaging** — no `metis-claw` npm package entry point yet.

---

## Adding a new Metis enforcement point (future)

1. Add a new `eventType` to `audit.ts` and document it in this file.
2. Hook via `runBeforeToolCallHook` for tool-level checks, or add a new gateway middleware
   hook for request-level checks.
3. Wire path resolution through `resolveMetisPaths` so the new path is env-overridable.
4. Add focused tests for the new decision path.
5. Update this seam map.
