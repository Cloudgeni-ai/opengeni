import { createHash } from "node:crypto";
import { failureDiagnostic, type FailureDiagnosticInput } from "./failure-diagnostic";

// Reviewed invariant messages only. Driver/provider text can contain SQL,
// credentials or user content and must never be copied into public logs.
const REASONS = new Map([
  [
    "System-update outbox replay changed its connection authority subject",
    "connection_authority_replay_mismatch",
  ],
  ["System-update outbox replay changed its accepted MCP accounts", "mcp_accounts_replay_mismatch"],
  [
    "System-update outbox replay changed its xAI authority snapshot",
    "xai_authority_replay_mismatch",
  ],
  ["System-update outbox replay changed its xAI authority subject", "xai_subject_replay_mismatch"],
  [
    "System-update outbox replay changed its Claude authority snapshot",
    "claude_authority_replay_mismatch",
  ],
  [
    "System-update outbox replay changed its Claude authority subject",
    "claude_subject_replay_mismatch",
  ],
  ["Committed idle child-result outbox disappeared", "committed_idle_outbox_missing"],
  ["Runnable system update has no workflow wake revision", "workflow_wake_revision_missing"],
]);

function messageOf(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  try {
    if (!error || typeof error !== "object") return undefined;
    const property = Object.getOwnPropertyDescriptor(error, "message");
    return property && "value" in property && typeof property.value === "string"
      ? property.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** A local, content-free failure summary plus the exact protected correlation.
 * Legacy callers passing only a message still get a stable failure fingerprint;
 * passing the Error preserves its cause and code locations as well. */
export function operationalErrorDiagnostic(input: FailureDiagnosticInput) {
  const diagnostic = failureDiagnostic(input);
  const message = messageOf(input.error);
  const first = diagnostic.causes[0];
  const frame = first?.frames.find((value) => value.source);
  const fingerprint = createHash("sha256")
    .update(message ?? JSON.stringify(diagnostic.causes))
    .digest("hex");
  const opaque = (value: string | undefined) =>
    value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
  return {
    diagnostic,
    attributes: {
      failureDiagnosticId: diagnostic.diagnosticId,
      failureFingerprint: fingerprint,
      failureKind: first?.kind ?? (typeof input.error === "string" ? "Error" : "UnknownError"),
      ...(message && REASONS.has(message) ? { failureReason: REASONS.get(message)! } : {}),
      ...(diagnostic.sqlState ? { failureSqlState: diagnostic.sqlState } : {}),
      ...(frame ? { failureSource: frame.source!, failureLine: frame.line } : {}),
      ...(diagnostic.sessionId ? { sessionKey: opaque(diagnostic.sessionId)! } : {}),
      ...(diagnostic.parentSessionId
        ? { parentSessionKey: opaque(diagnostic.parentSessionId)! }
        : {}),
    },
  };
}
