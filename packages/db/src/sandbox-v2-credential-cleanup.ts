import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import {
  SandboxJournalCommand,
  SandboxJournalObservation,
  SandboxMachineRecord,
  type SandboxMachineInstance,
} from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import {
  withSandboxV2CommandControlFence,
  withSandboxV2TurnMachineFence,
  type SandboxJournalControlAuthority,
} from "./sandbox-v2-commands";
import type { SandboxMachineAttemptAuthority } from "./sandbox-v2-attempt-demand";
import { sandboxV2CredentialCleanup, sandboxV2Machines } from "./sandbox-v2-schema";

type Row = typeof sandboxV2CredentialCleanup.$inferSelect;
type MachineRow = typeof sandboxV2Machines.$inferSelect;
export class SandboxV2CredentialCleanupError extends Error {
  readonly code = "SANDBOX_V2_CREDENTIAL_CLEANUP";
  constructor() {
    super("Original guest credential cleanup is unavailable or unsettled");
  }
}
function fail(): never {
  throw new SandboxV2CredentialCleanupError();
}
function scope(context: SandboxMachineAttemptAuthority) {
  return and(
    eq(sandboxV2CredentialCleanup.accountId, context.accountId),
    eq(sandboxV2CredentialCleanup.workspaceId, context.workspaceId),
    eq(sandboxV2CredentialCleanup.sessionId, context.sessionId),
    eq(sandboxV2CredentialCleanup.attemptId, context.attemptId),
  );
}
function identity(row: Row, context: SandboxJournalControlAuthority): void {
  if (
    row.turnId !== context.turnId ||
    row.executionGeneration !== context.executionGeneration ||
    row.machineId !== context.machineId ||
    !isDeepStrictEqual(row.instance, context.instance)
  )
    fail();
}
async function locked(tx: Database, context: SandboxJournalControlAuthority): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(sandboxV2CredentialCleanup)
    .where(scope(context))
    .for("update")
    .limit(1);
  if (row) identity(row, context);
  return row ?? null;
}
function demand(context: SandboxJournalControlAuthority, operationId: string) {
  return {
    id: operationId,
    kind: "command" as const,
    owner: context.sessionId,
    authority: context.attemptId,
  };
}
async function updateDemand(
  tx: Database,
  machine: MachineRow,
  projection: SandboxMachineRecord,
  context: SandboxJournalControlAuthority,
  operationId: string,
  remove: boolean,
): Promise<void> {
  const owner = demand(context, operationId);
  const existing = projection.demands.find((item) => item.id === operationId);
  if (existing && !isDeepStrictEqual(existing, owner)) fail();
  if (remove ? !existing : existing) return;
  const demands = remove
    ? projection.demands.filter((item) => item.id !== operationId)
    : [...projection.demands, owner];
  const next = SandboxMachineRecord.parse({
    ...projection,
    version: projection.version + 1,
    demands,
    ...(remove
      ? { idleSince: demands.length ? null : (projection.idleSince ?? Date.now()) }
      : { target: "running", idleSince: null }),
  });
  const changed = await tx
    .update(sandboxV2Machines)
    .set({ version: next.version, projection: next, updatedAt: new Date() })
    .where(
      and(eq(sandboxV2Machines.id, machine.id), eq(sandboxV2Machines.version, machine.version)),
    )
    .returning({ id: sandboxV2Machines.id });
  if (changed.length !== 1) fail();
}
async function otherWriters(
  tx: Database,
  context: SandboxJournalControlAuthority,
  operationId: string,
): Promise<boolean> {
  const [result] = await tx.execute<{
    pending: boolean;
  }>(sql`select sandbox_v2_attempt_writers_pending(
    ${context.accountId}::uuid,${context.workspaceId}::uuid,${context.sessionId}::uuid,${context.attemptId}::uuid,${operationId}::uuid) as pending`);
  if (!result || typeof result.pending !== "boolean") fail();
  return result.pending;
}

/** BEFORE any guest credential write, retain one original maintenance identity
 * and machine demand. The pure trusted builder binds the nonsecret fixed
 * cleanup specification. Recovery cannot select new code or another operation. */
export async function retainSandboxV2CredentialCleanupIntent(
  db: Database,
  authority: SandboxJournalControlAuthority,
  specificationDigest: (operationId: string) => string,
): Promise<{ operationId: string; specificationDigest: string }> {
  const context = structuredClone(authority);
  return withSandboxV2TurnMachineFence(db, context, async (tx, machine, projection) => {
    if (projection.state !== "running" || projection.transition !== null) fail();
    let row = await locked(tx, context);
    const operationId = row?.operationId ?? randomUUID();
    const expected = specificationDigest(operationId);
    if (
      !/^[a-f0-9]{64}$/u.test(expected) ||
      (row && (row.specificationDigest !== expected || row.proof !== null))
    )
      fail();
    if (!row) {
      const [inserted] = await tx
        .insert(sandboxV2CredentialCleanup)
        .values({ ...context, operationId, specificationDigest: expected })
        .returning();
      if (!inserted) fail();
      row = inserted;
    }
    await updateDemand(tx, machine, projection, context, operationId, false);
    return { operationId, specificationDigest: row.specificationDigest };
  });
}

/** Advisory original metadata for a bounded control attempt inventory. No
 * material, provider I/O, new admission or launch permission is returned. */
export async function findSandboxV2CredentialCleanupAuthority(
  db: Database,
  input: SandboxMachineAttemptAuthority,
): Promise<SandboxJournalControlAuthority | null> {
  const context = structuredClone(input);
  return withRlsContext(db, context, async (tx) => {
    const [row] = await tx
      .select({
        turnId: sandboxV2CredentialCleanup.turnId,
        executionGeneration: sandboxV2CredentialCleanup.executionGeneration,
        machineId: sandboxV2CredentialCleanup.machineId,
        instance: sandboxV2CredentialCleanup.instance,
      })
      .from(sandboxV2CredentialCleanup)
      .where(scope(context))
      .limit(1);
    if (!row) return null;
    if (
      row.turnId !== context.turnId ||
      row.executionGeneration !== context.executionGeneration ||
      row.machineId !== context.machineId
    )
      fail();
    return { ...context, instance: structuredClone(row.instance) as SandboxMachineInstance };
  });
}

export async function loadSandboxV2CredentialCleanupForControl(
  db: Database,
  authority: SandboxJournalControlAuthority,
) {
  return withSandboxV2CommandControlFence(
    db,
    authority,
    "owner",
    async (tx, context, _machine, projection, live, attempt) => {
      const row = await locked(tx, context);
      if (!row) return null;
      return {
        operationId: row.operationId,
        specificationDigest: row.specificationDigest,
        binding: row.binding === null ? null : SandboxJournalCommand.parse(row.binding),
        proof: row.proof === null ? null : SandboxJournalObservation.parse(row.proof),
        eligible:
          !live &&
          attempt.closedAt !== null &&
          projection.state === "running" &&
          projection.transition === null &&
          !(await otherWriters(tx, context, row.operationId)),
      };
    },
  );
}

/** The only maintenance launch is this retained fixed cleanup specification,
 * after the original owner closed and every OTHER durable writer settled.
 * Binding is written before I/O. A retained binding permits observation only. */
export async function reserveSandboxV2CredentialCleanupCommand(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxJournalCommand,
): Promise<SandboxJournalCommand> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  return withSandboxV2CommandControlFence(
    db,
    authority,
    "owner",
    async (tx, context, _machine, projection, live, attempt) => {
      const row = await locked(tx, context);
      if (
        !row ||
        live ||
        attempt.closedAt === null ||
        row.binding ||
        row.proof ||
        projection.state !== "running" ||
        projection.transition !== null ||
        (await otherWriters(tx, context, row.operationId))
      )
        fail();
      match(row, context, command);
      if (
        !projection.demands.some((item) =>
          isDeepStrictEqual(item, demand(context, row.operationId)),
        )
      )
        fail();
      await tx
        .update(sandboxV2CredentialCleanup)
        .set({ binding: command, revision: row.revision + 1, updatedAt: new Date() })
        .where(scope(context));
      return command;
    },
  );
}
function match(
  row: Row,
  context: SandboxJournalControlAuthority,
  command: SandboxJournalCommand,
): void {
  if (
    command.operationId !== row.operationId ||
    command.machineId !== context.machineId ||
    command.bootId !== context.instance.bootId ||
    command.diskLineage !== context.instance.diskLineage ||
    command.specificationDigest !== row.specificationDigest ||
    command.stdin ||
    command.pty
  )
    fail();
}

export async function assertSandboxV2CredentialCleanupCommand(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxJournalCommand,
  action: "start" | "read",
): Promise<void> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  await withSandboxV2CommandControlFence(
    db,
    authority,
    "owner",
    async (tx, context, _machine, projection, live, attempt) => {
      const row = await locked(tx, context);
      if (!row || !isDeepStrictEqual(row.binding, command)) fail();
      match(row, context, command);
      if (
        action === "start" &&
        (live ||
          attempt.closedAt === null ||
          row.proof ||
          projection.state !== "running" ||
          projection.transition !== null ||
          (await otherWriters(tx, context, row.operationId)) ||
          !projection.demands.some((item) =>
            isDeepStrictEqual(item, demand(context, row.operationId)),
          ))
      )
        fail();
    },
  );
}

/** Persist the complete fixed acknowledgement and actual zero native exit in
 * the same transaction that releases only this original maintenance demand.
 * Cancellation, EOF alone, failed/lost/unknown observations cannot clear it. */
export async function settleSandboxV2CredentialCleanup(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxJournalCommand,
  observation: SandboxJournalObservation,
): Promise<void> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  const proof = SandboxJournalObservation.parse(structuredClone(observation));
  if (
    proof.operationId !== command.operationId ||
    proof.specificationDigest !== command.specificationDigest ||
    proof.state !== "exited" ||
    proof.receipt?.leaderExitCode !== 0 ||
    !isDeepStrictEqual(proof.stdout, {
      offset: 0,
      nextOffset: 7,
      data: "Y2xlYW5lZA==",
      eof: true,
    }) ||
    !isDeepStrictEqual(proof.stderr, { offset: 0, nextOffset: 0, data: "", eof: true })
  )
    fail();
  await withSandboxV2CommandControlFence(
    db,
    authority,
    "owner",
    async (tx, context, machine, projection, live, attempt) => {
      const row = await locked(tx, context);
      if (
        !row ||
        live ||
        attempt.closedAt === null ||
        !isDeepStrictEqual(row.binding, command) ||
        (await otherWriters(tx, context, row.operationId))
      )
        fail();
      match(row, context, command);
      if (row.proof) {
        if (!isDeepStrictEqual(row.proof, proof)) fail();
      } else
        await tx
          .update(sandboxV2CredentialCleanup)
          .set({ proof, revision: row.revision + 1, updatedAt: new Date() })
          .where(scope(context));
      await updateDemand(tx, machine, projection, context, row.operationId, true);
    },
  );
}
