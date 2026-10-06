import { SandboxMachineRecord, type SandboxMachineScope } from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Database, rawRows, withRlsContext } from "./database";
import { sandboxV2Machines } from "./sandbox-v2-schema";

export type SandboxMachineTenant = SandboxMachineScope & { accountId: string };

export type SandboxMachineInventoryItem = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  machineId: string;
  provider: string;
};

/** Trusted control-worker discovery only. The owner-scoped SQL capability
 * exposes bounded identities, never command bytes, demand owners or credentials.
 * Every subsequent operation must reread the exact tenant machine. A scheduler
 * restarts after the last page so new random IDs are not stranded behind it. */
export async function listSandboxMachineInventory(
  db: Database,
  options: { limit?: number; afterMachineId?: string } = {},
): Promise<{ items: SandboxMachineInventoryItem[]; nextMachineId: string | null }> {
  const limit = options.limit ?? 100;
  const after = options.afterMachineId;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (after !== undefined && !z.uuid().safeParse(after).success)
  )
    throw new Error("Invalid bounded machine inventory cursor");
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    sandbox_group_id: string;
    machine_id: string;
    provider: string;
  }>(
    db,
    sql`select * from list_sandbox_v2_machine_inventory(
    ${limit}::integer, ${after ?? null}::uuid)`,
  );
  const items = rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sandboxGroupId: row.sandbox_group_id,
    machineId: row.machine_id,
    provider: row.provider,
  }));
  return { items, nextMachineId: items.length === limit ? items.at(-1)!.machineId : null };
}

/** Internal control-plane state only. The caller must already hold session or
 * worker authority for this group; a machine ID never grants that authority. */
export async function findSandboxMachine(
  db: Database,
  tenant: SandboxMachineTenant,
): Promise<SandboxMachineRecord | null> {
  return withRlsContext(db, tenant, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(sandboxV2Machines)
      .where(
        and(
          eq(sandboxV2Machines.accountId, tenant.accountId),
          eq(sandboxV2Machines.workspaceId, tenant.workspaceId),
          eq(sandboxV2Machines.sandboxGroupId, tenant.sandboxGroupId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const machine = SandboxMachineRecord.parse(row.projection);
    if (
      machine.id !== row.id ||
      machine.provider !== row.provider ||
      machine.version !== row.version ||
      machine.workspaceId !== row.workspaceId ||
      machine.sandboxGroupId !== row.sandboxGroupId
    ) {
      throw new Error("Sandbox machine projection identity mismatch");
    }
    return machine;
  });
}

/** Admission is called inside the existing tenant-fenced session transaction.
 * Joining an existing group never invokes it. No provider I/O occurs here. */
export async function insertSandboxMachineInTransaction(
  tx: Database,
  accountId: string,
  projection: SandboxMachineRecord,
): Promise<void> {
  const machine = SandboxMachineRecord.parse(projection);
  await tx.insert(sandboxV2Machines).values({
    id: machine.id,
    accountId,
    workspaceId: machine.workspaceId,
    sandboxGroupId: machine.sandboxGroupId,
    provider: machine.provider,
    version: machine.version,
    projection: machine,
  });
}

export async function compareAndSetSandboxMachine(
  db: Database,
  accountId: string,
  previous: SandboxMachineRecord,
  replacement: SandboxMachineRecord,
): Promise<boolean> {
  const next = SandboxMachineRecord.parse(replacement);
  if (
    next.id !== previous.id ||
    next.provider !== previous.provider ||
    next.workspaceId !== previous.workspaceId ||
    next.sandboxGroupId !== previous.sandboxGroupId ||
    next.version !== previous.version + 1 ||
    !Number.isSafeInteger(next.version)
  ) {
    throw new Error("Sandbox machine compare-and-set changes immutable identity or version");
  }
  return withRlsContext(db, { accountId, workspaceId: previous.workspaceId }, async (scoped) => {
    const rows = await scoped
      .update(sandboxV2Machines)
      .set({
        version: next.version,
        projection: next,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxV2Machines.id, previous.id),
          eq(sandboxV2Machines.accountId, accountId),
          eq(sandboxV2Machines.workspaceId, previous.workspaceId),
          eq(sandboxV2Machines.sandboxGroupId, previous.sandboxGroupId),
          eq(sandboxV2Machines.provider, previous.provider),
          eq(sandboxV2Machines.version, previous.version),
        ),
      )
      .returning({ id: sandboxV2Machines.id });
    return rows.length === 1;
  });
}
