import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitMetisExecApprovalRequestedAudit,
  emitMetisExecApprovalResolvedAudit,
  emitMetisExecPreflightAudit,
} from "./audit.js";
import { invalidateMetisManagedRuntimeCache, normalizeExecDecision } from "./managed-exec-policy.js";

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-metis-audit-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

afterEach(() => {
  invalidateMetisManagedRuntimeCache();
  vi.unstubAllEnvs();
});

describe("metis audit semantics", () => {
  it("marks requireApproval preflight as pending instead of approved", async () => {
    const decision = normalizeExecDecision({
      managedMode: true,
      command: "echo hi",
      policySnapshot: {
        status: "loaded",
        policy: {
          orgId: "metis",
          policyVersion: 1,
          managedMode: true,
          tools: { exec: { requireApproval: true } },
        },
      },
    });

    expect(decision.action).toBe("requireApproval");
    expect(decision.audit.result).toBe("pending");
  });

  it("writes approval requested and resolved audit events with distinct states", async () => {
    const root = await makeTempDir();
    const managedConfigPath = path.join(root, "managed-config.json");
    const policyPath = path.join(root, "policy.json");
    const auditLogPath = path.join(root, "metis-audit.jsonl");

    await writeJson(managedConfigPath, { enterprise: { managedMode: true, orgId: "metis" } });
    await writeJson(policyPath, {
      orgId: "metis",
      policyVersion: 1,
      managedMode: true,
      tools: { exec: { requireApproval: true } },
    });

    vi.stubEnv("OPENCLAW_METIS_MANAGED_CONFIG_PATH", managedConfigPath);
    vi.stubEnv("OPENCLAW_METIS_POLICY_PATH", policyPath);
    vi.stubEnv("OPENCLAW_METIS_AUDIT_LOG_PATH", auditLogPath);
    invalidateMetisManagedRuntimeCache();

    const decision = normalizeExecDecision({
      managedMode: true,
      command: "echo hi",
      policySnapshot: {
        status: "loaded",
        policy: {
          orgId: "metis",
          policyVersion: 1,
          managedMode: true,
          tools: { exec: { requireApproval: true } },
        },
      },
    });

    await emitMetisExecPreflightAudit({
      decision,
      toolCallId: "tool-1",
      command: "echo hi",
      sessionKey: "session-1",
    });
    await emitMetisExecApprovalRequestedAudit({
      toolCallId: "tool-1",
      command: "echo hi",
      sessionKey: "session-1",
    });
    await emitMetisExecApprovalResolvedAudit({
      resolution: "allow-once",
      toolCallId: "tool-1",
      command: "echo hi",
      sessionKey: "session-1",
    });

    const raw = await fs.readFile(auditLogPath, "utf8");
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      eventType: "tool.exec.preflight",
      result: "pending",
      decision: "requireApproval",
      reason: "approval_required",
    });
    expect(events[1]).toMatchObject({
      eventType: "tool.exec.approval_requested",
      result: "pending",
      decision: "requireApproval",
      reason: "approval_required",
    });
    expect(events[2]).toMatchObject({
      eventType: "tool.exec.approval_resolved",
      result: "approved",
      decision: "requireApproval",
      reason: "allow-once",
    });
  });
});
