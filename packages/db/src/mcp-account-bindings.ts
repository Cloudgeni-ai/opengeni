import {
  McpConnectionAccountBindings,
  type McpConnectionAccountBinding,
} from "@opengeni/contracts";

/** Raised only after session-create storage has rolled back a known account
 * admission refusal. It does not refresh, remove or replace accepted identity. */
export class SessionCreateConnectionSelectionUnavailableError extends Error {
  readonly code = "SESSION_CREATE_CONNECTION_SELECTION_UNAVAILABLE";
  readonly retryable = false;

  constructor(cause: unknown) {
    super(
      "An accepted workspace connection is no longer available or its authorization changed. Start a new turn with a current authorized connection selection; do not repeat this call unchanged.",
      { cause },
    );
    this.name = "SessionCreateConnectionSelectionUnavailableError";
  }
}

/** Match the driver record, not a wrapper's query/parameters or arbitrary
 * permission failure. These immutable trigger messages contain no identities. */
export function sessionCreateConnectionSelectionFailure(
  error: unknown,
): SessionCreateConnectionSelectionUnavailableError | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 64) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      [record.code, record.sqlState, record.sqlstate].includes("42501") &&
      typeof record.where === "string" &&
      record.where.startsWith(
        "PL/pgSQL function opengeni_private.fence_mcp_account_bindings() line ",
      ) &&
      (record.message === "MCP workspace account missing" ||
        record.message === "MCP workspace account identity changed")
    ) {
      return new SessionCreateConnectionSelectionUnavailableError(error);
    }
    for (const key of ["cause", "original", "driverError", "error", "errors"]) {
      const nested = record[key];
      const remaining = Math.max(0, 64 - seen.size - pending.length);
      if (Array.isArray(nested)) pending.push(...nested.slice(0, remaining));
      else if (nested !== undefined && remaining > 0) pending.push(nested);
    }
  }
  return null;
}

/** NULL is a pre-account-routing receipt, not an empty accepted selection.
 * Never default it to [] (or default [] to NULL) during replay/inheritance. */
export function parseAcceptedMcpAccountBindings(
  value: unknown,
): McpConnectionAccountBinding[] | null {
  return value == null ? null : McpConnectionAccountBindings.parse(value);
}
