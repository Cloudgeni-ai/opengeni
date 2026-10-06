import {
  listPendingSandboxJournalCommands,
  listSandboxMachineAttemptOwners,
  readSandboxJournalControlOwner,
  releaseRevokedSandboxMachineAttempt,
  findSandboxV2CredentialCleanupAuthority,
  type Database,
} from "@opengeni/db";
import { type MachineExecTransport } from "@opengeni/runtime/sandbox";
import { createSandboxV2CommandReconciler } from "./sandbox-v2-command-store";
import { reconcileSandboxV2GuestCredentialCleanup } from "./sandbox-v2-credential-cleanup";

type RecoveryItem = {
  kind: "attempt" | "command" | "credential-cleanup";
  id: string;
  status: "released" | "held" | "settled" | "abandoned" | "deferred";
};

/** One finite, tenant-scoped control pass. Inventory is advisory; every release,
 * provider request and terminal commit independently rechecks the exact retained
 * owner. Agent commands receive no Start, stdin, output capture or lifecycle
 * dispatch. Separately retained fixed credential cleanup has narrow maintenance
 * launch authority only after its original closed owner and other writers drain.
 * Errors and unknown/lost observations retain demand. A caller schedules later
 * passes and restarts each inventory after its final page, so random-ID inserts
 * cannot remain forever behind a cursor. This does not expire command ownership.
 * The trusted host supplies the original provider's pinned transport, never a
 * fallback adapter or a transport which starts/replaces a stopped machine. */
export async function reconcileSandboxV2MachineCommands(
  db: Database,
  tenant: { accountId: string; workspaceId: string; machineId: string },
  transport: MachineExecTransport,
  options: {
    limit?: number;
    afterDemandId?: string;
    afterOperationId?: string;
    scanAttempts?: boolean;
    scanCommands?: boolean;
    signal?: AbortSignal;
    journal?: Parameters<typeof createSandboxV2CommandReconciler>[3];
    /** Private diagnostics only; never attach errors/receipts to model output.
     * Diagnostic failure must not stop reconciliation of other owners. */
    onDeferred?: (item: RecoveryItem, error: unknown) => void | PromiseLike<void>;
  } = {},
): Promise<{
  items: RecoveryItem[];
  nextDemandId: string | null;
  nextOperationId: string | null;
}> {
  tenant = structuredClone(tenant);
  options = { ...options };
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid bounded machine recovery limit");
  options.signal?.throwIfAborted();
  // Inventory errors propagate: absence/error never proves ownership ended.
  const attempts =
    options.scanAttempts === false
      ? { items: [], nextDemandId: null }
      : await listSandboxMachineAttemptOwners(db, tenant, {
          limit,
          ...(options.afterDemandId !== undefined ? { afterDemandId: options.afterDemandId } : {}),
        });
  const commands =
    options.scanCommands === false
      ? { items: [], nextOperationId: null }
      : await listPendingSandboxJournalCommands(db, tenant, {
          limit,
          ...(options.afterOperationId !== undefined
            ? { afterOperationId: options.afterOperationId }
            : {}),
        });
  const items: RecoveryItem[] = [];
  const defer = (item: RecoveryItem, error: unknown) => {
    options.signal?.throwIfAborted();
    const deferred: RecoveryItem = { ...item, status: "deferred" };
    items.push(deferred);
    // Do not wait for an unbounded logger, but consume async failures too.
    try {
      void Promise.resolve(options.onDeferred?.(deferred, error)).catch(() => {});
    } catch {
      /* Diagnostics grant no authority. */
    }
  };
  for (const candidate of attempts.items) {
    options.signal?.throwIfAborted();
    const item: RecoveryItem = { kind: "attempt", id: candidate.demandId, status: "held" };
    if (!candidate.authority) {
      items.push({ ...item, status: "deferred" });
      continue;
    }
    try {
      const cleanupAuthority = await findSandboxV2CredentialCleanupAuthority(
        db,
        candidate.authority,
      );
      if (cleanupAuthority) {
        const cleanup = await reconcileSandboxV2GuestCredentialCleanup(
          db,
          cleanupAuthority,
          transport,
          options,
        );
        if (cleanup.operationId)
          items.push({
            kind: "credential-cleanup",
            id: cleanup.operationId,
            status: cleanup.state === "complete" ? "settled" : "held",
          });
      }
      const released = await releaseRevokedSandboxMachineAttempt(db, candidate.authority);
      items.push({ ...item, status: released ? "released" : "held" });
    } catch (error) {
      defer(item, error);
    }
  }
  for (const candidate of commands.items) {
    options.signal?.throwIfAborted();
    const item: RecoveryItem = { kind: "command", id: candidate.operationId, status: "held" };
    if (!candidate.authority) {
      items.push({ ...item, status: "deferred" });
      continue;
    }
    try {
      const owner = await readSandboxJournalControlOwner(db, candidate.authority);
      const control = createSandboxV2CommandReconciler(
        db,
        candidate.authority,
        transport,
        options.journal,
      );
      if (!candidate.command) {
        const abandoned =
          owner === "revoked" && (await control.abandonUnbound(candidate.operationId));
        items.push({ ...item, status: abandoned ? "abandoned" : "held" });
        continue;
      }
      let observation = await control.inspect(candidate.command, options.signal);
      if (
        owner === "revoked" &&
        observation.state !== "exited" &&
        observation.state !== "cancelled"
      )
        observation = await control.cancel(candidate.command, options.signal);
      items.push({
        ...item,
        status:
          observation.state === "exited" || observation.state === "cancelled" ? "settled" : "held",
      });
    } catch (error) {
      defer(item, error);
    }
  }
  return { items, nextDemandId: attempts.nextDemandId, nextOperationId: commands.nextOperationId };
}
