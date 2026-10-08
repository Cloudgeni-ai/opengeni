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
  /** Exact model call identity, kept separate from the transport token. */
  sourceCallId: string;
  /** The sanitized sdk tool call id (a legal NATS subject-token fragment). */
  callId: string;
  /** The next sub-op ordinal within this tool invocation (mutable). */
  ordinal: number;
  /** Called before durable adoption starts. The live op-stream client owns
   * cancellation during the transaction, but joined cleanup is not settled. */
  onDurableOpOwnershipTransferStarted?: (opId: string) => void;
  /** The live transfer/cleanup rejected without committed session ownership. */
  onDurableOpOwnershipTransferFailed?: (opId: string) => void;
  /** Called synchronously after durable session adoption commits. This lets
   * observers distinguish a completed transfer from its earlier cancellation
   * delegation; only this completed handoff releases the turn fence. */
  onDurableOpOwnershipTransferred?: (opId: string) => void;
  /** Trusted provider-local proof that preflight rejected this exact command
   * before physical dispatch. Remote error codes/text are never this proof. */
  onRemoteOperationNotDispatched?: (opId: string) => void;
  /** Pins cancellation/observation to the exact backend selected for this op. */
  onRemoteOperationTransportSelected?: (transport: RemoteOperationControl) => void;
}

export type RemoteOperationObservation =
  | { status: "running"; result?: unknown }
  | { status: "completed"; result: unknown; failure?: unknown };

/** Exact provider control surface for one already-dispatched operation. */
export type RemoteOperationControl = {
  cancelExecCommand?(opId: string): Promise<boolean>;
  observeExecCommand?(opId: string): Promise<RemoteOperationObservation>;
};

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
export function runWithToolCallCorrelation<T>(
  callId: string,
  fn: () => T,
  options: {
    onDurableOpOwnershipTransferStarted?: (opId: string) => void;
    onDurableOpOwnershipTransferFailed?: (opId: string) => void;
    onDurableOpOwnershipTransferred?: (opId: string) => void;
    onRemoteOperationNotDispatched?: (opId: string) => void;
    onRemoteOperationTransportSelected?: (transport: RemoteOperationControl) => void;
  } = {},
): T {
  return storage.run(
    {
      sourceCallId: callId,
      callId: sanitizeOpIdToken(callId),
      ordinal: 0,
      ...(options.onDurableOpOwnershipTransferStarted
        ? { onDurableOpOwnershipTransferStarted: options.onDurableOpOwnershipTransferStarted }
        : {}),
      ...(options.onDurableOpOwnershipTransferFailed
        ? { onDurableOpOwnershipTransferFailed: options.onDurableOpOwnershipTransferFailed }
        : {}),
      ...(options.onDurableOpOwnershipTransferred
        ? { onDurableOpOwnershipTransferred: options.onDurableOpOwnershipTransferred }
        : {}),
      ...(options.onRemoteOperationNotDispatched
        ? { onRemoteOperationNotDispatched: options.onRemoteOperationNotDispatched }
        : {}),
      ...(options.onRemoteOperationTransportSelected
        ? { onRemoteOperationTransportSelected: options.onRemoteOperationTransportSelected }
        : {}),
    },
    fn,
  );
}

/** The exact tool whose result owns this async chain's foreground op output. */
export function currentOpToolCallId(): string | null {
  return storage.getStore()?.sourceCallId ?? null;
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

/** Delegate cancellation to the live transfer path without settling joined
 * cleanup. A pending transaction is not durable ownership evidence. */
export function notifyDurableOpOwnershipTransferStarted(opId: string): void {
  storage.getStore()?.onDurableOpOwnershipTransferStarted?.(opId);
}

/** Restore turn cancellation when the live transfer/cleanup rejected without
 * committed adoption. The exact operation remains retained and observable. */
export function notifyDurableOpOwnershipTransferFailed(opId: string): void {
  storage.getStore()?.onDurableOpOwnershipTransferFailed?.(opId);
}

/** Report that one exact provider operation completed its transfer into
 * durable session ownership. Failed adoption deliberately emits no signal. */
export function notifyDurableOpOwnershipTransferred(opId: string): void {
  storage.getStore()?.onDurableOpOwnershipTransferred?.(opId);
}

/** Provider-owned local preflight proof only: no physical command was issued.
 * Never call this based on an RPC error or an uncertain observation outcome. */
export function notifyRemoteOperationNotDispatched(opId: string): void {
  storage.getStore()?.onRemoteOperationNotDispatched?.(opId);
}

/** Bind the current operation to its already-resolved physical backend. */
export function notifyRemoteOperationTransportSelected(transport: RemoteOperationControl): void {
  storage.getStore()?.onRemoteOperationTransportSelected?.(transport);
}
