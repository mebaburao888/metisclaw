import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type MetisPolicySnapshotStatus =
  | "disabled"
  | "bypassed"
  | "loaded"
  | "missing"
  | "invalid_json"
  | "invalid_policy"
  | "invalid_managed_config"
  | "org_mismatch"
  | "read_error";

export type MetisPolicyIssue = {
  path: string;
  message: string;
};

export type MetisExecPolicy = {
  enabled?: boolean;
  requireApproval?: boolean;
  denyPatterns?: string[];
};

export type MetisPolicy = {
  orgId: string;
  policyVersion: number;
  managedMode: boolean;
  tools?: {
    exec?: MetisExecPolicy;
  };
};

export type ManagedConfig = {
  enterprise?: {
    managedMode?: boolean;
    orgId?: string;
    policyUrl?: string;
    updateManifestUrl?: string;
    channel?: string;
  };
};

function validateManagedConfigShape(config: unknown, managedConfigPath: string): MetisPolicyIssue[] {
  const issues: MetisPolicyIssue[] = [];
  if (!isRecord(config)) {
    return [{ path: managedConfigPath, message: "managed config must be an object" }];
  }
  if (!isRecord(config.enterprise)) {
    issues.push({ path: managedConfigPath, message: "managed config.enterprise must be an object" });
    return issues;
  }
  if (typeof config.enterprise.managedMode !== "boolean") {
    issues.push({ path: managedConfigPath, message: "managed config.enterprise.managedMode must be a boolean" });
  }
  if (
    "orgId" in config.enterprise &&
    config.enterprise.orgId !== undefined &&
    (typeof config.enterprise.orgId !== "string" || !config.enterprise.orgId.trim())
  ) {
    issues.push({ path: managedConfigPath, message: "managed config.enterprise.orgId must be a non-empty string when provided" });
  }
  return issues;
}

export type MetisPolicySnapshot = {
  status: MetisPolicySnapshotStatus;
  loadedAt: string;
  managedConfigPath?: string;
  schemaPath?: string;
  policyPath?: string;
  policy?: MetisPolicy | null;
  issues: MetisPolicyIssue[];
};

export type MetisManagedRuntimeContext = {
  managedMode: boolean;
  enterprise: ManagedConfig["enterprise"];
  policy: MetisPolicy | null;
  policySnapshot: MetisPolicySnapshot;
  policyIssues: MetisPolicyIssue[];
  source: "disabled" | "bypassed" | "local-file" | "policy-unavailable";
};

export type MetisExecDecisionReason =
  | "managed_mode_disabled"
  | "policy_unavailable"
  | "tool_disabled"
  | "deny_pattern_match"
  | "approval_required"
  | "allowed";

export type MetisExecDecision = {
  action: "allow" | "deny" | "requireApproval";
  reason: MetisExecDecisionReason;
  matchedPattern?: string;
  audit: {
    eventType: "tool.exec.preflight";
    result: "allowed" | "blocked" | "pending";
    decision: "allow" | "deny" | "requireApproval";
    reason: MetisExecDecisionReason;
    matchedPattern?: string;
  };
};

let runtimeContextPromise: Promise<MetisManagedRuntimeContext> | undefined;

function parseJsonSafe(raw: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: `${label} is invalid JSON: ${String(error)}` };
  }
}

async function readJsonFile(filePath: string, label: string) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseJsonSafe(raw, label);
    if (!parsed.ok) {
      return {
        ok: false as const,
        status: "invalid_json" as const,
        issues: [{ path: filePath, message: parsed.error }],
      };
    }
    return { ok: true as const, value: parsed.value };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        ok: false as const,
        status: "missing" as const,
        issues: [{ path: filePath, message: `${label} file not found` }],
      };
    }
    return {
      ok: false as const,
      status: "read_error" as const,
      issues: [{ path: filePath, message: `${label} read failure: ${String(error)}` }],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePolicyShape(policy: unknown, policyPath: string): MetisPolicyIssue[] {
  const issues: MetisPolicyIssue[] = [];
  if (!isRecord(policy)) {
    return [{ path: policyPath, message: "policy must be an object" }];
  }
  if (typeof policy.orgId !== "string" || !policy.orgId.trim()) {
    issues.push({ path: policyPath, message: "policy.orgId must be a non-empty string" });
  }
  if (typeof policy.policyVersion !== "number" || !Number.isInteger(policy.policyVersion)) {
    issues.push({ path: policyPath, message: "policy.policyVersion must be an integer" });
  }
  if (typeof policy.managedMode !== "boolean") {
    issues.push({ path: policyPath, message: "policy.managedMode must be a boolean" });
  }
  const execPolicy = isRecord(policy.tools) && isRecord(policy.tools.exec) ? policy.tools.exec : undefined;
  if (execPolicy) {
    if ("enabled" in execPolicy && typeof execPolicy.enabled !== "boolean") {
      issues.push({ path: policyPath, message: "policy.tools.exec.enabled must be a boolean" });
    }
    if ("requireApproval" in execPolicy && typeof execPolicy.requireApproval !== "boolean") {
      issues.push({ path: policyPath, message: "policy.tools.exec.requireApproval must be a boolean" });
    }
    if (
      "denyPatterns" in execPolicy &&
      (!Array.isArray(execPolicy.denyPatterns) ||
        execPolicy.denyPatterns.some((item) => typeof item !== "string"))
    ) {
      issues.push({ path: policyPath, message: "policy.tools.exec.denyPatterns must be a string array" });
    }
  }
  return issues;
}

export function resolveMetisPaths(env: NodeJS.ProcessEnv = process.env): {
  managedConfigPath: string;
  policyPath: string;
  auditLogPath: string;
} {
  const stateDir = resolveStateDir(env);
  const baseDir = path.join(stateDir, "metis-claw");
  return {
    managedConfigPath:
      env.OPENCLAW_METIS_MANAGED_CONFIG_PATH?.trim() || path.join(baseDir, "managed-config.json"),
    policyPath: env.OPENCLAW_METIS_POLICY_PATH?.trim() || path.join(baseDir, "policy.json"),
    auditLogPath:
      env.OPENCLAW_METIS_AUDIT_LOG_PATH?.trim() || path.join(stateDir, "logs", "metis-claw-audit.jsonl"),
  };
}

export function invalidateMetisManagedRuntimeCache(): void {
  runtimeContextPromise = undefined;
}

export async function loadManagedRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MetisManagedRuntimeContext> {
  const { managedConfigPath, policyPath } = resolveMetisPaths(env);
  const managedRead = await readJsonFile(managedConfigPath, "managed config");
  if (!managedRead.ok) {
    const managementIntent = managedRead.status !== "missing";
    return {
      managedMode: managementIntent,
      enterprise: {},
      policy: null,
      policySnapshot: {
        status: managedRead.status === "missing" ? "disabled" : "invalid_managed_config",
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues: managedRead.issues,
      },
      policyIssues: managedRead.issues,
      source: managedRead.status === "missing" ? "disabled" : "policy-unavailable",
    };
  }

  const managedConfigIssues = validateManagedConfigShape(managedRead.value, managedConfigPath);
  if (managedConfigIssues.length > 0) {
    return {
      managedMode: true,
      enterprise: {},
      policy: null,
      policySnapshot: {
        status: "invalid_managed_config",
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues: managedConfigIssues,
      },
      policyIssues: managedConfigIssues,
      source: "policy-unavailable",
    };
  }

  const managedConfig = managedRead.value as ManagedConfig;
  const managedMode = managedConfig.enterprise?.managedMode === true;
  if (!managedMode) {
    return {
      managedMode: false,
      enterprise: managedConfig.enterprise ?? {},
      policy: null,
      policySnapshot: {
        status: "bypassed",
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues: [],
      },
      policyIssues: [],
      source: "bypassed",
    };
  }

  const policyRead = await readJsonFile(policyPath, "policy");
  if (!policyRead.ok) {
    return {
      managedMode: true,
      enterprise: managedConfig.enterprise ?? {},
      policy: null,
      policySnapshot: {
        status: policyRead.status,
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues: policyRead.issues,
      },
      policyIssues: policyRead.issues,
      source: "policy-unavailable",
    };
  }

  const issues = validatePolicyShape(policyRead.value, policyPath);
  if (issues.length > 0) {
    return {
      managedMode: true,
      enterprise: managedConfig.enterprise ?? {},
      policy: null,
      policySnapshot: {
        status: "invalid_policy",
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues,
      },
      policyIssues: issues,
      source: "policy-unavailable",
    };
  }

  const policy = policyRead.value as MetisPolicy;
  const configuredOrgId = managedConfig.enterprise?.orgId?.trim();
  if (configuredOrgId && configuredOrgId !== policy.orgId) {
    const issues = [
      {
        path: policyPath,
        message: `policy.orgId (${policy.orgId}) does not match managed config enterprise.orgId (${configuredOrgId})`,
      },
    ];
    return {
      managedMode: true,
      enterprise: managedConfig.enterprise ?? {},
      policy: null,
      policySnapshot: {
        status: "org_mismatch",
        loadedAt: new Date().toISOString(),
        managedConfigPath,
        policyPath,
        issues,
      },
      policyIssues: issues,
      source: "policy-unavailable",
    };
  }

  return {
    managedMode: true,
    enterprise: managedConfig.enterprise ?? {},
    policy,
    policySnapshot: {
      status: "loaded",
      loadedAt: new Date().toISOString(),
      managedConfigPath,
      policyPath,
      policy,
      issues: [],
    },
    policyIssues: [],
    source: "local-file",
  };
}

export async function getMetisManagedRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MetisManagedRuntimeContext> {
  runtimeContextPromise ??= loadManagedRuntimeContext(env);
  return await runtimeContextPromise;
}

export function normalizeExecDecision(params: {
  managedMode: boolean;
  command: string;
  policySnapshot: Pick<MetisPolicySnapshot, "status" | "policy">;
}): MetisExecDecision {
  if (!params.managedMode) {
    return {
      action: "allow",
      reason: "managed_mode_disabled",
      audit: {
        eventType: "tool.exec.preflight",
        result: "allowed",
        decision: "allow",
        reason: "managed_mode_disabled",
      },
    };
  }

  if (params.policySnapshot.status !== "loaded" || !params.policySnapshot.policy) {
    return {
      action: "deny",
      reason: "policy_unavailable",
      audit: {
        eventType: "tool.exec.preflight",
        result: "blocked",
        decision: "deny",
        reason: "policy_unavailable",
      },
    };
  }

  const execPolicy = params.policySnapshot.policy.tools?.exec;
  if (execPolicy?.enabled === false) {
    return {
      action: "deny",
      reason: "tool_disabled",
      audit: {
        eventType: "tool.exec.preflight",
        result: "blocked",
        decision: "deny",
        reason: "tool_disabled",
      },
    };
  }

  const matchedPattern = execPolicy?.denyPatterns?.find((pattern) =>
    pattern.trim() ? params.command.toLowerCase().includes(pattern.toLowerCase()) : false,
  );
  if (matchedPattern) {
    return {
      action: "deny",
      reason: "deny_pattern_match",
      matchedPattern,
      audit: {
        eventType: "tool.exec.preflight",
        result: "blocked",
        decision: "deny",
        reason: "deny_pattern_match",
        matchedPattern,
      },
    };
  }

  if (execPolicy?.requireApproval) {
    return {
      action: "requireApproval",
      reason: "approval_required",
      audit: {
        eventType: "tool.exec.preflight",
        result: "pending",
        decision: "requireApproval",
        reason: "approval_required",
      },
    };
  }

  return {
    action: "allow",
    reason: "allowed",
    audit: {
      eventType: "tool.exec.preflight",
      result: "allowed",
      decision: "allow",
      reason: "allowed",
    },
  };
}

export function readExecCommand(params: unknown): string {
  if (!isRecord(params)) {
    return "";
  }
  const command = params.command;
  return typeof command === "string" ? command : "";
}
