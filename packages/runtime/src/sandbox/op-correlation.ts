// Durable op-identity correlation (op-stream ruling B1): the DURABLE op id a
// sandbox transport op carries is `{sdk_tool_call_id}:{ordinal}` — minted ABOVE
// the transport, at the semantic layer. The tool call id lives in the model's
// function_call (persisted run history), so a re-dispatched turn re-executes the
// SAME function_call with the SAME call id, and the transport's idempotent
// OpStart turns an at-least-once re-execution into an ATTACH instead of a
// re-run. The ordinal is the deterministic position of the physical sub-op
// inside one tool invocation (a tool that performs read→write→rm mints :0, :1,
// :2), so a re-executed invocation re-mints identical ids.
//
// The correlation rides an AsyncLocalStorage bound around the SDK tool's
// `execute` (see `withExecOpCorrelation` in the runtime barrel): the SDK's tool
// machinery passes `details.toolCall` (with `callId`) into every function-tool
// invocation, and the shell capability's `configureTools` hook lets us wrap
// exec_command without touching the SDK. Per-async-chain storage keeps PARALLEL
// tool calls correctly separated.
//
// This module is deliberately dependency-free (node:async_hooks only) so the
// agent-loop-free sandbox leaf may import it: the leaf READS the context; only
// the runtime barrel (which owns the SDK imports) BINDS it.

import { AsyncLocalStorage } from "node:async_hooks";

interface ToolCallCorrelation {
  /** The sanitized sdk tool call id (a legal NATS subject-token fragment). */
  callId: string;
  /** The next sub-op ordinal within this tool invocation (mutable). */
  ordinal: number;
}

const storage = new AsyncLocalStorage<ToolCallCorrelation>();

/**
 * Sanitize a tool call id into a legal NATS subject TOKEN fragment. The op id
 * is interpolated into the per-op frame subject, whose tokens must not contain
 * whitespace/control characters or the subject-structure characters (`.`,
 * `*`, `>`); the runner refuses illegal ids loudly. The mapping is INJECTIVE
 * (each disallowed char becomes `_<hex>_`), so two distinct call ids can never
 * collide into one op id — a collision would merge two different execs through
 * the idempotent-OpStart dedup and return the wrong result.
 */
export function sanitizeOpIdToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/**
 * Bind a tool-call correlation context around `fn` (the tool's execute). Every
 * durable op id minted inside — however deep in the transport — is
 * `{callId}:{ordinal}` with ordinals starting at 0 per invocation.
 */
export function runWithToolCallCorrelation<T>(callId: string, fn: () => T): T {
  return storage.run({ callId: sanitizeOpIdToken(callId), ordinal: 0 }, fn);
}

/**
 * Mint the next durable op id for the current tool invocation, or null when no
 * correlation context is bound (a non-tool caller, e.g. Channel-A structural
 * exec). Callers fall back to a random unique id — safe (never collides, never
 * wrongly dedups), merely not stable across a turn re-dispatch, which degrades
 * that one op to today's at-least-once semantics.
 */
export function nextDurableOpId(): string | null {
  const context = storage.getStore();
  if (!context) {
    return null;
  }
  const ordinal = context.ordinal;
  context.ordinal += 1;
  return `${context.callId}:${ordinal}`;
}
