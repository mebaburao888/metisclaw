import fs from "node:fs/promises";
import path from "node:path";
import {
  getMetisManagedRuntimeContext,
  readExecCommand,
  resolveMetisPaths,
  type MetisExecDecision,
} from "./managed-exec-policy.js";

const REDACT_KEY_RE = /(password|token|api[_-]?key|secret|authorization)/i;
const REDACT_VALUE_PATTERNS = [
  /(api[_-]?key\s*[=:]\s*)\S+/gi,
  /(token\s*[=:]\s*)\S+/gi,
  /(password\s*[=:]\s*)\S+/gi,
  /(authorization:\s*bearer\s+)\S+/gi,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of REDACT_VALUE_PATTERNS) {
    out = out.replace(pattern, "$1<REDACTED>");
  }
  return out;
}

export function redactForAudit(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map((item) => redactForAudit(item));
  if (typeof input === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      next[key] = REDACT_KEY_RE.test(key) ? "<REDACTED>" : redactForAudit(value);
    }
    return next;
  }
  return input;
}

export async function appendMetisAuditEvent(event: Record<string, unknown>): Promise<string | null> {
  try {
    const { auditLogPath } = resolveMetisPaths(process.env);
    const fullPath = path.resolve(auditLogPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, `${JSON.stringify(redactForAudit(event))}\n`, "utf8");
    return fullPath;
  } catch {
    return null;
  }
}

export async function emitMetisExecPreflightAudit(params: {
  decision: MetisExecDecision;
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  command: string;
}): Promise<void> {
  const ctx = await getMetisManagedRuntimeContext(process.env);
  if (!ctx.managedMode) {
    return;
  }
  await appendMetisAuditEvent({
    timestamp: new Date().toISOString(),
    eventType: params.decision.audit.eventType,
    result: params.decision.audit.result,
    decision: params.decision.audit.decision,
    reason: params.decision.audit.reason,
    matchedPattern: params.decision.matchedPattern,
    tool: "exec",
    toolPhase: "before_tool_call",
    managedMode: ctx.managedMode,
    orgId: ctx.enterprise?.orgId,
    policyVersion: ctx.policy?.policyVersion,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    metadata: { command: params.command },
  });
}

export async function emitMetisExecApprovalRequestedAudit(params: {
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  command: string;
}): Promise<void> {
  const ctx = await getMetisManagedRuntimeContext(process.env);
  if (!ctx.managedMode) {
    return;
  }
  await appendMetisAuditEvent({
    timestamp: new Date().toISOString(),
    eventType: "tool.exec.approval_requested",
    result: "pending",
    decision: "requireApproval",
    reason: "approval_required",
    tool: "exec",
    toolPhase: "before_tool_call",
    managedMode: ctx.managedMode,
    orgId: ctx.enterprise?.orgId,
    policyVersion: ctx.policy?.policyVersion,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    metadata: { command: params.command },
  });
}

export async function emitMetisExecApprovalResolvedAudit(params: {
  resolution: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  command: string;
}): Promise<void> {
  const ctx = await getMetisManagedRuntimeContext(process.env);
  if (!ctx.managedMode) {
    return;
  }
  const result =
    params.resolution === "allow-once" || params.resolution === "allow-always"
      ? "approved"
      : params.resolution === "deny"
        ? "denied"
        : params.resolution === "timeout"
          ? "timeout"
          : "cancelled";
  await appendMetisAuditEvent({
    timestamp: new Date().toISOString(),
    eventType: "tool.exec.approval_resolved",
    result,
    decision: "requireApproval",
    reason: params.resolution,
    tool: "exec",
    toolPhase: "before_tool_call",
    managedMode: ctx.managedMode,
    orgId: ctx.enterprise?.orgId,
    policyVersion: ctx.policy?.policyVersion,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    metadata: { command: params.command },
  });
}

export async function emitMetisExecResultAudit(params: {
  toolName: string;
  runId?: string;
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolParams: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}): Promise<void> {
  if (params.toolName !== "exec") {
    return;
  }
  const ctx = await getMetisManagedRuntimeContext(process.env);
  if (!ctx.managedMode) {
    return;
  }
  await appendMetisAuditEvent({
    timestamp: new Date().toISOString(),
    eventType: "tool.exec.result",
    result: params.error ? "error" : "allowed",
    decision: params.error ? "deny" : "allow",
    reason: params.error ? "tool_error" : "allowed",
    tool: "exec",
    toolPhase: "after_tool_call",
    managedMode: ctx.managedMode,
    orgId: ctx.enterprise?.orgId,
    policyVersion: ctx.policy?.policyVersion,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    metadata: {
      command: readExecCommand(params.toolParams),
      durationMs: params.durationMs,
      error: params.error,
      result: params.result,
    },
  });
}
