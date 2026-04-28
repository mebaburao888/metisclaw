import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBeforeToolCallHook } from "../agents/pi-tools.before-tool-call.js";
import {
  getMetisManagedRuntimeContext,
  invalidateMetisManagedRuntimeCache,
  normalizeExecDecision,
} from "./managed-exec-policy.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-metis-"));
}

afterEach(() => {
  invalidateMetisManagedRuntimeCache();
  vi.unstubAllEnvs();
});

describe("metis managed exec policy", () => {
  it("fails closed for exec when managed mode is enabled but policy is missing", async () => {
    const root = await makeTempDir();
    const managedConfigPath = path.join(root, "managed-config.json");
    await writeJson(managedConfigPath, { enterprise: { managedMode: true, orgId: "metis" } });

    vi.stubEnv("OPENCLAW_METIS_MANAGED_CONFIG_PATH", managedConfigPath);
    vi.stubEnv("OPENCLAW_METIS_POLICY_PATH", path.join(root, "missing-policy.json"));
    invalidateMetisManagedRuntimeCache();

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hello" },
    });

    expect(outcome).toEqual({
      blocked: true,
      reason: "Metis Claw blocked exec because managed policy is unavailable",
    });
  });

  it("allows exec when managed mode is disabled", async () => {
    const root = await makeTempDir();
    const managedConfigPath = path.join(root, "managed-config.json");
    await writeJson(managedConfigPath, { enterprise: { managedMode: false, orgId: "metis" } });

    vi.stubEnv("OPENCLAW_METIS_MANAGED_CONFIG_PATH", managedConfigPath);
    invalidateMetisManagedRuntimeCache();

    const ctx = await getMetisManagedRuntimeContext(process.env);
    const decision = normalizeExecDecision({
      managedMode: ctx.managedMode,
      command: "echo hello",
      policySnapshot: { status: ctx.policySnapshot.status, policy: ctx.policy },
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("managed_mode_disabled");
  });

  it("fails closed when managed config is malformed", async () => {
    const root = await makeTempDir();
    const managedConfigPath = path.join(root, "managed-config.json");
    await fs.writeFile(managedConfigPath, "{ not-json", "utf8");

    vi.stubEnv("OPENCLAW_METIS_MANAGED_CONFIG_PATH", managedConfigPath);
    invalidateMetisManagedRuntimeCache();

    const ctx = await getMetisManagedRuntimeContext(process.env);
    expect(ctx.managedMode).toBe(true);
    expect(ctx.policySnapshot.status).toBe("invalid_managed_config");
    expect(ctx.policyIssues[0]?.message).toMatch(/invalid JSON/i);

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hello" },
    });
    expect(outcome).toEqual({
      blocked: true,
      reason: "Metis Claw blocked exec because managed policy is unavailable",
    });
  });

  it("fails closed when managed config orgId does not match policy orgId", async () => {
    const root = await makeTempDir();
    const managedConfigPath = path.join(root, "managed-config.json");
    const policyPath = path.join(root, "policy.json");
    await writeJson(managedConfigPath, { enterprise: { managedMode: true, orgId: "metis-a" } });
    await writeJson(policyPath, {
      orgId: "metis-b",
      policyVersion: 1,
      managedMode: true,
      tools: { exec: { enabled: true } },
    });

    vi.stubEnv("OPENCLAW_METIS_MANAGED_CONFIG_PATH", managedConfigPath);
    vi.stubEnv("OPENCLAW_METIS_POLICY_PATH", policyPath);
    invalidateMetisManagedRuntimeCache();

    const ctx = await getMetisManagedRuntimeContext(process.env);
    expect(ctx.managedMode).toBe(true);
    expect(ctx.policySnapshot.status).toBe("org_mismatch");
    expect(ctx.policy).toBeNull();
    expect(ctx.policyIssues[0]?.message).toMatch(/does not match/i);

    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "echo hello" },
    });
    expect(outcome).toEqual({
      blocked: true,
      reason: "Metis Claw blocked exec because managed policy is unavailable",
    });
  });
});
