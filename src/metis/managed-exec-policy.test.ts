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
    await fs.writeFile(
      managedConfigPath,
      JSON.stringify({ enterprise: { managedMode: true, orgId: "metis" } }),
      "utf8",
    );

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
    await fs.writeFile(
      managedConfigPath,
      JSON.stringify({ enterprise: { managedMode: false, orgId: "metis" } }),
      "utf8",
    );

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
});
