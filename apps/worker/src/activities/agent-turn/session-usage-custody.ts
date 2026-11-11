import type { HeldSessionUsageReceipt } from "@opengeni/core";
import { settleSessionUsageReceipt, SessionUsageLimitUnavailableError } from "@opengeni/db";
import type { TurnActivityServices as ActivityServices } from "../types";

/**
 * Attempt-scoped custody for per-task usage receipts whose write failed after
 * the provider response was received.
 *
 * The response is never lost or re-requested because of an accounting
 * failure: settlement hands the content-free receipt here (original source
 * identity, amount, pricing source) and the turn keeps the response. Before
 * the next model request (every admission check) and before the turn
 * completes, held receipts are written; if that still fails, the attempt
 * stops for the workflow's DB-only recovery lane and carries the held
 * receipts in its typed failure detail (durable in workflow history), which
 * the lane writes before any replacement attempt. Writes are idempotent per
 * source identity, so overlapping writers (the `agent.model.usage` event
 * meter, a later flush and the recovery lane) record the call once.
 */

type Scope = { accountId: string; workspaceId: string };
type Entry = Scope & { receipts: Map<string, HeldSessionUsageReceipt> };

/** Bound on receipts carried through one recovery failure detail. */
export const MAX_RECOVERY_SESSION_USAGE_RECEIPTS = 64;
const MAX_HELD_SESSIONS = 4096;
const FLUSH_DELAYS_MS = [0, 250, 1_000];

const held = new Map<string, Entry>();

/** Recovery reason and detail code for a task whose earlier single-call receipt is still owed. */
export const SESSION_USAGE_CUSTODY_PENDING = "session_usage_custody_pending";
/**
 * How long a parked turn waits before its replacement attempt re-checks
 * admission (database reads only). An owner fills its receipt within
 * seconds; a dead owner's marker is disclosed by maintenance after 30
 * minutes, so a task waits at most about 60 rechecks.
 */
export const SESSION_USAGE_CUSTODY_RECHECK_MS = 30_000;

/** A fenced or overdue custody marker (not a database outage) refused the next model request. */
export function sessionUsageCustodyPending(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (current instanceof SessionUsageLimitUnavailableError) {
      return current.reason === "custody_pending";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function holdSessionUsageReceipt(scope: Scope, receipt: HeldSessionUsageReceipt): void {
  let entry = held.get(receipt.sessionId);
  if (!entry) {
    if (held.size >= MAX_HELD_SESSIONS) {
      // Oldest sessions only: their receipts already travelled with a
      // recovery failure or will be re-imported from durable usage events.
      const oldest = held.keys().next().value;
      if (oldest !== undefined) held.delete(oldest);
    }
    entry = { accountId: scope.accountId, workspaceId: scope.workspaceId, receipts: new Map() };
    held.set(receipt.sessionId, entry);
  }
  entry.receipts.set(receipt.sourceId, receipt);
}

/** Held receipts for one turn, bounded, for a post-claim recovery failure detail. */
export function heldSessionUsageReceiptsForTurn(turnId: string): HeldSessionUsageReceipt[] {
  const receipts: HeldSessionUsageReceipt[] = [];
  for (const entry of held.values()) {
    for (const receipt of entry.receipts.values()) {
      if (receipt.turnId === turnId) receipts.push(receipt);
      if (receipts.length >= MAX_RECOVERY_SESSION_USAGE_RECEIPTS) return receipts;
    }
  }
  return receipts;
}

export function heldSessionUsageReceiptCount(sessionId?: string): number {
  if (sessionId !== undefined) return held.get(sessionId)?.receipts.size ?? 0;
  let count = 0;
  for (const entry of held.values()) count += entry.receipts.size;
  return count;
}

/**
 * The `agent.model.usage` event for a held receipt committed. Its appending
 * transaction meters the same source identity through the database trigger
 * (or, for a root still preparing, leaves the event for the bounded import),
 * and a trigger failure would have rolled the event back. When the event
 * carries exactly the held amount, the receipt is therefore durable and the
 * hold is dropped, so completion does not stop for a write that is already
 * done. A different or unknown event amount keeps the hold: only the direct
 * write can record (or fill) that value.
 */
export function releaseHeldSessionUsageReceiptMeteredByEvent(input: {
  sessionId: string;
  sourceId: string;
  amountMicros: number | null;
  pricingSource: string | null;
}): boolean {
  const entry = held.get(input.sessionId);
  const receipt = entry?.receipts.get(input.sourceId);
  if (!entry || !receipt) return false;
  if (receipt.amountMicros !== input.amountMicros) return false;
  if (receipt.amountMicros !== null && receipt.pricingSource !== input.pricingSource) return false;
  entry.receipts.delete(input.sourceId);
  if (entry.receipts.size === 0 && held.get(input.sessionId) === entry) {
    held.delete(input.sessionId);
  }
  return true;
}

/** Write receipts with their original identities; throws the last database error. */
export async function writeSessionUsageReceipts(
  db: ActivityServices["db"],
  scope: Scope,
  receipts: readonly HeldSessionUsageReceipt[],
): Promise<void> {
  for (const receipt of receipts) {
    await settleSessionUsageReceipt(db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: receipt.sessionId,
      sourceId: receipt.sourceId,
      turnId: receipt.turnId,
      amountMicros: receipt.amountMicros,
      pricingSource: receipt.amountMicros === null ? null : receipt.pricingSource,
      model: receipt.model,
    });
  }
}

/**
 * Write every receipt held for this session before another model request or
 * turn completion. Retries briefly; a persistent failure rethrows the
 * database error so the attempt enters post-claim DB recovery with the
 * receipts still held for its failure detail.
 */
export async function flushHeldSessionUsageReceipts(
  db: ActivityServices["db"],
  sessionId: string,
): Promise<void> {
  const entry = held.get(sessionId);
  if (!entry || entry.receipts.size === 0) return;
  let lastError: unknown;
  for (const delay of FLUSH_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      // A parallel call (session title) may hold another receipt meanwhile.
      while (entry.receipts.size > 0) {
        for (const [sourceId, receipt] of [...entry.receipts]) {
          await writeSessionUsageReceipts(db, entry, [receipt]);
          entry.receipts.delete(sourceId);
        }
      }
      if (entry.receipts.size === 0 && held.get(sessionId) === entry) held.delete(sessionId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Test-only reset of process custody. */
export function resetSessionUsageReceiptCustodyForTests(): void {
  held.clear();
}
