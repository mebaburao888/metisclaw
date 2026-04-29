# Metis Claw — Product Architecture

> **Status:** Living document · v0.1 · 2026-04-29  
> **Author:** Babu Rao (AI architect) + H  
> **Purpose:** Blueprint for transforming the current enforcement prototype into a full managed-client product.

---

## What Metis Is

Metis is a **managed distribution of OpenClaw** for teams and enterprises.

It gives one administrator centralized control over:

- which AI models are allowed
- whether exec commands require manual approval
- which tools agents can use
- which skills can be installed (official vs unofficial)
- what is visible vs locked in the end-user UI

End users install **Metis OpenClaw** the same way they'd install regular OpenClaw.  
The difference: certain settings are **locked by their organization** and cannot be overridden locally.

---

## Core Principles

| Principle | What it means |
|---|---|
| **Fail-closed** | If policy is missing, invalid, or unreachable → block, never open |
| **Dual enforcement** | UI lock + backend enforcement. Never one without the other. |
| **Transparent to users** | Users see what is locked and why. Not silent black boxes. |
| **Admin-owned, client-enforced** | Admin sets policy centrally. Client enforces it locally. |
| **Tenant-isolated** | One policy server can serve multiple orgs. Policies never bleed across tenants. |

---

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    METIS ADMIN PLANE                        │
│                                                             │
│   ┌──────────────────┐     ┌─────────────────────────┐     │
│   │  Admin Console   │────▶│  Metis Policy Server    │     │
│   │  (web UI)        │     │  (REST API + DB)        │     │
│   └──────────────────┘     └─────────────────────────┘     │
│                                     │                       │
│                          ┌──────────┴──────────┐           │
│                          │  Audit Event Store  │           │
│                          └─────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
                            │ policy distribution
                            │ audit event ingestion
          ┌─────────────────┼──────────────────────┐
          ▼                 ▼                       ▼
┌──────────────┐  ┌──────────────┐       ┌──────────────┐
│  PC 1        │  │  PC 2        │  ...  │  PC N        │
│  Metis       │  │  Metis       │       │  Metis       │
│  OpenClaw    │  │  OpenClaw    │       │  OpenClaw    │
│  client      │  │  client      │       │  client      │
└──────────────┘  └──────────────┘       └──────────────┘
```

### Component Descriptions

#### Metis Policy Server
- REST API hosted by the Metis team (or self-hosted by enterprise customers)
- Stores org config, policy per org, enrolled clients
- Issues enrollment tokens for new clients
- Serves current policy to authenticated clients
- Receives audit events from clients
- Admin Console connects to this

#### Admin Console
- Web UI (React) hosted alongside the policy server
- Metis-branded, not OpenClaw branded
- Only accessible to org admins (role-gated)
- Where the admin defines policy, sees audit events, manages enrolled devices

#### Metis OpenClaw Client
- The OpenClaw fork installed on user machines
- On startup: fetches and caches current policy from the policy server
- Enforces policy locally (fail-closed if unreachable)
- Periodically polls for policy updates
- Sends audit events back to the policy server
- Displays locked settings in UI with "Managed by your organization" state

---

## Policy Object Schema

This is the canonical policy document that flows from admin → clients.

```jsonc
{
  "schemaVersion": 1,
  "orgId": "acme-corp",
  "policyVersion": 42,
  "issuedAt": "2026-04-29T00:00:00Z",
  "expiresAt": "2026-05-29T00:00:00Z",

  "models": {
    "managed": true,                          // if false, user can use any model
    "allowed": [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o"
    ],
    "blocked": [
      "local/*"                               // glob patterns supported
    ],
    "default": "anthropic/claude-sonnet-4-6"
  },

  "tools": {
    "exec": {
      "enabled": true,
      "requireApproval": true,               // all exec requires manual approval
      "denyPatterns": ["rm -rf", "curl | sh"],
      "allowPatterns": []                    // if set, ONLY these patterns allowed
    },
    "webSearch": { "enabled": true },
    "webFetch": { "enabled": true },
    "fileSystem": {
      "enabled": true,
      "readOnly": false,
      "rootRestriction": null               // e.g. "~/workspace" to sandbox
    }
  },

  "skills": {
    "managed": true,
    "allowOfficialOnly": true,              // block unofficial/community skills
    "allowlist": [],                        // specific approved third-party skills
    "blocklist": []                         // specific blocked skills by name
  },

  "ui": {
    "lockModelSelector": true,             // user cannot switch models
    "lockExecApproval": true,              // user cannot disable approval requirement
    "lockSkillInstall": true,              // user cannot change skill permissions
    "showManagedBadge": true,              // show "managed by org" in settings
    "allowLocalConfig": false             // block local config overrides entirely
  },

  "audit": {
    "enabled": true,
    "endpoint": "https://metis.example.com/api/audit",
    "events": ["exec", "model_switch", "skill_install", "tool_call"]
  }
}
```

---

## Client Lifecycle

### 1. Enrollment (first run)
```
User installs Metis OpenClaw
       │
       ▼
Client reads enrollment token from:
  - ENV var: METIS_ENROLLMENT_TOKEN
  - or: metis-config.json in install dir
       │
       ▼
Client calls: POST /api/enroll
  { orgId, enrollmentToken, machineId, platform, version }
       │
       ▼
Server responds with:
  { clientId, clientSecret, policyUrl }
       │
       ▼
Client stores clientId + clientSecret locally (encrypted)
Client fetches initial policy from policyUrl
Client begins enforcement
```

### 2. Policy Refresh (ongoing)
```
Client startup
       │
       ▼
GET /api/policy?orgId=X&clientId=Y&version=Z
  (authenticated with clientSecret)
       │
       ├─ 200 with new policy → cache + enforce
       ├─ 304 not modified → use cached
       └─ 4xx/5xx/unreachable → use cached, log warning
              │
              └─ if no cache exists → FAIL CLOSED (block all restricted ops)
```

### 3. Audit Event Upload
```
Local event fires (exec blocked, model switched, skill installed)
       │
       ▼
Buffered locally in audit queue
       │
       ▼
POST /api/audit  (batched, max 50 events per call)
  [{ eventType, timestamp, clientId, orgId, result, metadata }]
       │
       ├─ 200 → clear queue
       └─ fail → retry with exponential backoff, max 7 days retention
```

---

## Enforcement Scope

### Phase 1 (current prototype)
- [x] exec command enforcement
- [x] deny patterns
- [x] require approval flow
- [x] audit events (requested + resolved)
- [x] org/policy mismatch rejection
- [x] fail-closed on invalid policy

### Phase 2 (next)
- [ ] model allow/block list enforcement
- [ ] central policy server (REST API + DB)
- [ ] client enrollment + policy pull
- [ ] skill install governance
- [ ] tool allow/deny beyond exec

### Phase 3
- [ ] UI lock layer (locked controls with managed badge)
- [ ] admin console (React web UI)
- [ ] policy versioning + rollback
- [ ] per-client or per-group policy overrides
- [ ] emergency policy push (force refresh without polling interval)

### Phase 4
- [ ] multi-tenant org support
- [ ] role-based admin access (admin vs viewer vs per-dept policy editor)
- [ ] compliance export (SOC2-ready audit trail)
- [ ] SSO / SAML for admin console
- [ ] desktop notification on admin policy change

---

## UI Lock Behavior

When a setting is governed by admin policy, the end-user UI should:

1. **Render the control as disabled** (greyed out, not interactive)
2. **Show a lock icon** next to it
3. **Show a tooltip on hover:**  
   `"This setting is managed by your Metis administrator"`
4. **Not allow local config file to override it** (backend also enforces)

### Examples

**Model selector — managed:**
```
Model:  [Claude Sonnet 4.6 ▾]  🔒 Managed by your organization
```

**Exec approval — managed:**
```
Require approval for shell commands:  [ON]  🔒  (cannot be disabled)
```

**Skill install — managed:**
```
Install Skill...   [Install from ClawHub ▾]
                   ⚠️  Only verified official skills are allowed by your organization.
                   [Community skills are blocked]
```

**Settings page banner (when any settings are managed):**
```
┌──────────────────────────────────────────────────────┐
│  🛡  Some settings are managed by Metis Enterprise   │
│     Contact your administrator to request changes.   │
└──────────────────────────────────────────────────────┘
```

---

## Admin Console — Screen Map

```
Login (Metis Admin)
│
├── Dashboard
│     Org status, enrolled client count, recent audit summary
│
├── Policy Editor
│     ├── Models tab
│     │     Toggle managed, pick allowed models, set default
│     ├── Tools tab
│     │     Exec: on/off, approval, deny patterns
│     │     Web search / fetch: on/off
│     │     File system: on/off, read-only toggle
│     ├── Skills tab
│     │     Official only toggle, allowlist, blocklist
│     └── UI Locks tab
│           Which controls are locked in end-user UI
│
├── Clients / Devices
│     List of enrolled machines, last-seen, policy version, platform
│     Option: revoke a client
│
├── Audit Log
│     Filterable by: client, event type, result, date range
│     Exportable to CSV
│
└── Settings
      Org settings, admin user management, enrollment token generation
```

---

## Technology Recommendations

### Policy Server
- **Runtime:** Node.js (TypeScript) — same stack as OpenClaw fork
- **DB:** SQLite for self-hosted / Postgres for hosted SaaS
- **Auth:** JWT for client auth, session cookies for admin console
- **Deployment:** Docker container or standalone Node process

### Admin Console
- **Framework:** React + Vite (same as OpenClaw control UI)
- **Styling:** Tailwind or the current CSS custom properties approach
- **State:** React Query for API fetching

### Client Changes (Metis OpenClaw fork)
- New module: `src/metis/policy-client.ts` — enrollment + fetch + cache
- New module: `src/metis/audit-uploader.ts` — batched event upload
- Existing: `src/metis/managed-exec-policy.ts` — already built
- UI changes: lock layer in existing settings components

---

## Build Sequence (Recommended)

```
Week 1-2: Policy Server MVP
  - POST /api/enroll
  - GET /api/policy
  - POST /api/audit
  - SQLite schema
  - Admin auth (single admin user, token-based to start)

Week 3-4: Client Enrollment + Pull
  - policy-client.ts in fork
  - reads enrollment token on first run
  - fetches and caches policy
  - hooks into existing enforcement chain
  - fail-closed when policy missing

Week 5-6: Expand Enforcement + Audit Upload
  - model allow/block list enforcement
  - skill install governance
  - audit-uploader.ts (batched, retry)

Week 7-8: UI Lock Layer
  - locked settings component wrapper
  - managed badge in UI
  - settings banner

Week 9-10: Admin Console
  - policy editor
  - client/device list
  - audit log viewer
  - enrollment token generator

Week 11-12: Polish + Pilot
  - internal team installs Metis OpenClaw
  - one real org running centrally managed policy
  - collect feedback, fix gaps
```

---

## What Makes Metis Defensible

Three things make this hard to replicate quickly:

1. **Deep fork** — the enforcement is in the gateway layer, not a surface wrapper. Bypassing it requires modifying the binary.

2. **Dual enforcement** — UI lock + backend enforcement at the same time. Cosmetic-only or backend-only approaches are both weaker.

3. **Audit trail** — enterprise buyers care about compliance. A policy that silently enforces with no record is less valuable than one that produces a tamper-evident log.

These three together = something enterprise buyers will pay for.

---

*Next: build the policy server MVP (Week 1-2 scope above)*
