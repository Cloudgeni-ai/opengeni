import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SandboxMachineRecord, type SandboxMachineDemand } from "@opengeni/contracts";
import { type Database, withRlsContext } from "./database";
import { lockTurnAttemptWriteFenceTx } from "./session-attempt-write-fence";
import { sandboxV2CredentialCleanup, sandboxV2Machines } from "./sandbox-v2-schema";
import { sessionTurnAttempts } from "./schema";

/** Trusted worker identity before a machine exists or has a physical incarnation.
 * The owning group comes from the exact fenced session, never caller input. */
export type SandboxMachineAttemptAuthority = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  machineId: string;
};
export class SandboxMachineAuthorityError extends Error {
  readonly code = "SANDBOX_V2_MACHINE_AUTHORITY";
}
function fail(message: string): never {
  throw new SandboxMachineAuthorityError(message);
}
function demand(context: SandboxMachineAttemptAuthority): SandboxMachineDemand {
  return {
    id: `attempt:${context.attemptId}`,
    kind: "attempt",
    owner: context.sessionId,
    authority: `${context.turnId}:${context.executionGeneration}:${context.attemptId}`,
  };
}

/** Bounded, tenant-scoped recovery inventory, including attempts that died
 * before allocating any command. Discovery grants no authority. Missing or
 * inconsistent owner rows remain held and are returned without an authority;
 * each release rechecks its original exact fence and group before mutation. */
export async function listSandboxMachineAttemptOwners(
  db: Database,
  tenant: { accountId: string; workspaceId: string; machineId: string },
  options: { limit?: number; afterDemandId?: string } = {},
): Promise<{
  items: { demandId: string; authority: SandboxMachineAttemptAuthority | null }[];
  nextDemandId: string | null;
}> {
  tenant = structuredClone(tenant);
  options = { ...options };
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (options.afterDemandId !== undefined &&
      (options.afterDemandId.length === 0 || options.afterDemandId.length > 512))
  )
    fail("Invalid bounded attempt-owner inventory cursor");
  return withRlsContext(db, tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(sandboxV2Machines)
      .where(
        and(
          eq(sandboxV2Machines.accountId, tenant.accountId),
          eq(sandboxV2Machines.workspaceId, tenant.workspaceId),
          eq(sandboxV2Machines.id, tenant.machineId),
        ),
      )
      .limit(1);
    if (!row) return { items: [], nextDemandId: null };
    const machine = SandboxMachineRecord.parse(row.projection);
    const owners = machine.demands
      .filter(
        (item) =>
          item.kind === "attempt" &&
          (options.afterDemandId === undefined || item.id > options.afterDemandId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
    const attemptIds = owners
      .map((item) => item.id.slice("attempt:".length))
      .filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id),
      );
    const attempts = attemptIds.length
      ? await tx
          .select()
          .from(sessionTurnAttempts)
          .where(
            and(
              eq(sessionTurnAttempts.accountId, tenant.accountId),
              eq(sessionTurnAttempts.workspaceId, tenant.workspaceId),
              inArray(sessionTurnAttempts.id, attemptIds),
            ),
          )
      : [];
    const byId = new Map(attempts.map((item) => [item.id, item]));
    return {
      items: owners.map((owner) => {
        const attempt = byId.get(owner.id.slice("attempt:".length));
        const authority = attempt
          ? {
              accountId: tenant.accountId,
              workspaceId: tenant.workspaceId,
              machineId: tenant.machineId,
              sessionId: attempt.sessionId,
              turnId: attempt.turnId,
              executionGeneration: attempt.executionGeneration,
              attemptId: attempt.id,
            }
          : null;
        return {
          demandId: owner.id,
          authority: authority && isDeepStrictEqual(demand(authority), owner) ? authority : null,
        };
      }),
      nextDemandId: owners.length === limit ? owners.at(-1)!.id : null,
    };
  });
}
async function lockMachine(
  tx: Database,
  context: SandboxMachineAttemptAuthority,
  session: { accountId: string; sandboxGroupId: string },
) {
  if (session.accountId !== context.accountId) fail("Machine attempt account changed");
  const [row] = await tx
    .select()
    .from(sandboxV2Machines)
    .where(
      and(
        eq(sandboxV2Machines.accountId, context.accountId),
        eq(sandboxV2Machines.workspaceId, context.workspaceId),
        eq(sandboxV2Machines.sandboxGroupId, session.sandboxGroupId),
        eq(sandboxV2Machines.id, context.machineId),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) fail("No admitted machine for this exact session group");
  return { row, machine: SandboxMachineRecord.parse(row.projection) };
}
async function save(
  tx: Database,
  previous: typeof sandboxV2Machines.$inferSelect,
  next: SandboxMachineRecord,
) {
  next = SandboxMachineRecord.parse(next);
  const rows = await tx
    .update(sandboxV2Machines)
    .set({
      version: next.version,
      projection: next,
      updatedAt: new Date(),
    })
    .where(
      and(eq(sandboxV2Machines.id, previous.id), eq(sandboxV2Machines.version, previous.version)),
    )
    .returning({ id: sandboxV2Machines.id });
  if (rows.length !== 1) fail("Machine demand changed while locked");
  return next;
}

/** Persist wake ownership under the canonical turn fence BEFORE lifecycle I/O.
 * A stopped or not-yet-created machine is allowed; an admitted deletion is not.
 * Lock order matches commands: workspace/session/turn/attempt, then machine. */
export async function acquireSandboxMachineForAttempt(
  db: Database,
  authority: SandboxMachineAttemptAuthority,
): Promise<SandboxMachineRecord> {
  const context = structuredClone(authority);
  return withRlsContext(db, context, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, context);
    if (!fence.allowed) fail(`Exact machine attempt authority rejected: ${fence.reason}`);
    const { row, machine } = await lockMachine(tx, context, fence.session);
    if (machine.target === "destroyed" || machine.state === "destroyed")
      fail("Machine deletion has already been admitted");
    const owner = demand(context);
    const existing = machine.demands.find((item) => item.id === owner.id);
    if (existing && !isDeepStrictEqual(existing, owner))
      fail("Machine attempt demand identity changed");
    const cancelIdle =
      machine.transition?.kind === "suspend" && machine.transition.phase === "reserved";
    if (existing && machine.target === "running" && machine.idleSince === null && !cancelIdle)
      return machine;
    return save(tx, row, {
      ...machine,
      version: machine.version + 1,
      target: "running",
      idleSince: null,
      transition: cancelIdle ? null : machine.transition,
      demands: existing ? machine.demands : [...machine.demands, owner],
    });
  });
}

/** Control-only release after durable revocation/settlement. A live exact owner
 * cannot be released; absence/error is not revocation proof. This removes ONLY
 * the attempt demand. Its physical command demands survive until real terminal
 * evidence is committed, so Pause cannot suspend unproved running processes. */
export async function releaseRevokedSandboxMachineAttempt(
  db: Database,
  authority: SandboxMachineAttemptAuthority,
): Promise<boolean> {
  const context = structuredClone(authority);
  return withRlsContext(db, context, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, context);
    const { workspace, session, turn, attempt } = fence;
    if (!workspace || !session || !turn || !attempt) return false;
    if (
      workspace.accountId !== context.accountId ||
      session.accountId !== context.accountId ||
      turn.accountId !== context.accountId ||
      turn.sessionId !== context.sessionId ||
      attempt.accountId !== context.accountId ||
      attempt.sessionId !== context.sessionId ||
      attempt.turnId !== context.turnId ||
      attempt.executionGeneration !== context.executionGeneration
    )
      fail("No exact retained machine attempt owner");
    if (fence.allowed) return false;
    // Keep this original attempt discoverable by the bounded control inventory
    // until its retained guest cleanup has actual completion evidence.
    const [cleanup] = await tx
      .select({ operationId: sandboxV2CredentialCleanup.operationId })
      .from(sandboxV2CredentialCleanup)
      .where(
        and(
          eq(sandboxV2CredentialCleanup.accountId, context.accountId),
          eq(sandboxV2CredentialCleanup.workspaceId, context.workspaceId),
          eq(sandboxV2CredentialCleanup.sessionId, context.sessionId),
          eq(sandboxV2CredentialCleanup.attemptId, context.attemptId),
          isNull(sandboxV2CredentialCleanup.proof),
        ),
      )
      .limit(1);
    if (cleanup) return false;
    const { row, machine } = await lockMachine(tx, context, session);
    const owner = demand(context);
    const demands = machine.demands.filter((item) => !isDeepStrictEqual(item, owner));
    if (demands.length === machine.demands.length) return false;
    await save(tx, row, {
      ...machine,
      version: machine.version + 1,
      demands,
      idleSince: demands.length ? null : (machine.idleSince ?? Date.now()),
    });
    return true;
  });
}
