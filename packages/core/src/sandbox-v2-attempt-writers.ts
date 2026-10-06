import {
  readSandboxJournalAttemptWriters,
  readSandboxJournalControlOwner,
  type Database,
  type SandboxJournalControlAuthority,
} from "@opengeni/db";
import type { MachineExecTransport } from "@opengeni/runtime/sandbox";
import { createSandboxV2CommandReconciler } from "./sandbox-v2-command-store";
import { reconcileSandboxV2GuestCredentialCleanup } from "./sandbox-v2-credential-cleanup";

/** One bounded pass for ONE original attempt. Use the installed provider's
 * control transport, not an active-agent transport or a legacy shell wrapper.
 * Agent commands receive no Start/input/capture or machine lifecycle operation.
 * The separately retained fixed credential maintenance can start only after
 * revocation, closed ownership and settlement of all other durable writers.
 * A drained result requires durable revocation plus the shared writer predicate
 * being empty after physical settlement. Local callback drainage is separate.
 * Unknown/lost/outage results retain writer demand for later control recovery. */
export async function reconcileSandboxV2AttemptWriters(
  db: Database,
  authority: SandboxJournalControlAuthority,
  transport: MachineExecTransport,
  options: {
    limit?: number;
    afterOperationId?: string;
    signal?: AbortSignal;
    journal?: Parameters<typeof createSandboxV2CommandReconciler>[3];
  } = {},
): Promise<{
  state: "live" | "held" | "drained";
  items: { operationId: string; state: "held" | "settled" | "abandoned" | "deferred" }[];
  nextOperationId: string | null;
}> {
  authority = structuredClone(authority);
  options = { ...options };
  options.signal?.throwIfAborted();
  const page = await readSandboxJournalAttemptWriters(db, authority, options);
  const control = createSandboxV2CommandReconciler(db, authority, transport, options.journal);
  const items: Awaited<ReturnType<typeof reconcileSandboxV2AttemptWriters>>["items"] = [];
  for (const candidate of page.commands) {
    options.signal?.throwIfAborted();
    try {
      // A prior inventory is advisory. Revocation must still be true at the
      // cancellation boundary; the DB canceller checks it again before I/O.
      if (!candidate.command) {
        const abandoned =
          (await readSandboxJournalControlOwner(db, authority)) === "revoked" &&
          (await control.abandonUnbound(candidate.operationId));
        items.push({ operationId: candidate.operationId, state: abandoned ? "abandoned" : "held" });
        continue;
      }
      let observed = await control.inspect(candidate.command, options.signal);
      if (
        observed.state !== "exited" &&
        observed.state !== "cancelled" &&
        (await readSandboxJournalControlOwner(db, authority)) === "revoked"
      )
        observed = await control.cancel(candidate.command, options.signal);
      items.push({
        operationId: candidate.operationId,
        state: observed.state === "exited" || observed.state === "cancelled" ? "settled" : "held",
      });
    } catch {
      options.signal?.throwIfAborted();
      // A transport reply or observer disappearance cannot release ownership.
      items.push({ operationId: candidate.operationId, state: "deferred" });
    }
  }
  options.signal?.throwIfAborted();
  if (page.owner === "revoked") {
    try {
      const cleanup = await reconcileSandboxV2GuestCredentialCleanup(
        db,
        authority,
        transport,
        options,
      );
      if (cleanup.operationId)
        items.push({
          operationId: cleanup.operationId,
          state: cleanup.state === "complete" ? "settled" : "held",
        });
    } catch {
      options.signal?.throwIfAborted();
      // The final shared predicate still retains any unsettled maintenance.
    }
  }
  options.signal?.throwIfAborted();
  const current = await readSandboxJournalAttemptWriters(db, authority, { limit: 1 });
  return {
    state: current.owner === "live" ? "live" : current.pending ? "held" : "drained",
    items,
    nextOperationId: page.nextOperationId,
  };
}
