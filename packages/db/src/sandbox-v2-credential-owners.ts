import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, ne, or } from "drizzle-orm";
import {
  SandboxV2CredentialTicket,
  type SandboxV2CredentialGenerationDefinition,
} from "@opengeni/contracts";
import type { Database } from "./database";
import {
  withSandboxV2TurnMachineFence,
  type SandboxJournalControlAuthority,
} from "./sandbox-v2-commands";
import { SandboxV2CredentialGenerationError } from "./sandbox-v2-credential-generations";
import {
  sandboxV2Commands,
  sandboxV2CommandOutput,
  sandboxV2CredentialGenerations,
  sandboxV2CredentialOwners,
  sandboxV2PreparationPlans,
} from "./sandbox-v2-schema";

type Row = typeof sandboxV2CredentialOwners.$inferSelect;
export type SandboxV2CredentialOwnerState = {
  version: number;
  active: SandboxV2CredentialTicket | null;
  pending: SandboxV2CredentialTicket | null;
};
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function sandboxV2CredentialWriterIdentity(setupId: string, generationId: string) {
  if (
    [setupId, generationId].some(
      (value) => typeof value !== "string" || !value || value.length > 512 || value.includes("\0"),
    )
  )
    fail();
  const stepId = `credentials:${createHash("sha256").update(generationId).digest("hex")}`;
  const acceptedActionId = `platform-setup-v1:${hash(["platform-setup-v1", setupId])}`;
  return {
    stepId,
    writerActionId: `sandbox-v2:${hash(["sandbox-v2-operation-v1", acceptedActionId, stepId])}`,
  };
}
function ticket(
  setupId: string,
  ordinal: number,
  definition: SandboxV2CredentialGenerationDefinition,
): SandboxV2CredentialTicket {
  return SandboxV2CredentialTicket.parse({
    ordinal,
    definition,
    writerActionId: sandboxV2CredentialWriterIdentity(setupId, definition.generationId)
      .writerActionId,
  });
}
function scope(context: SandboxJournalControlAuthority) {
  return and(
    eq(sandboxV2CredentialOwners.workspaceId, context.workspaceId),
    eq(sandboxV2CredentialOwners.sessionId, context.sessionId),
    eq(sandboxV2CredentialOwners.attemptId, context.attemptId),
  );
}
function state(
  row: Row,
  context: SandboxJournalControlAuthority,
  setupId: string,
): SandboxV2CredentialOwnerState {
  if (
    row.accountId !== context.accountId ||
    row.turnId !== context.turnId ||
    row.executionGeneration !== context.executionGeneration ||
    row.machineId !== context.machineId ||
    !isDeepStrictEqual(row.instance, context.instance) ||
    row.setupId !== setupId ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    row.version >= Number.MAX_SAFE_INTEGER
  )
    fail();
  const active = row.active === null ? null : SandboxV2CredentialTicket.parse(row.active);
  const pending = row.pending === null ? null : SandboxV2CredentialTicket.parse(row.pending);
  if (
    (!active &&
      (!pending ||
        pending.ordinal !== 0 ||
        pending.definition.generationId !== row.initialGenerationId)) ||
    (pending && pending.ordinal !== (active?.ordinal ?? -1) + 1)
  )
    fail();
  for (const value of [active, pending])
    if (value && !isDeepStrictEqual(value, ticket(setupId, value.ordinal, value.definition)))
      fail();
  return { version: row.version, active, pending };
}

/** Establish only the frozen plan's initial identity, before broker I/O. */
export async function retainSandboxV2CredentialOwner(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: { setupId: string; initialGenerationId: string },
): Promise<SandboxV2CredentialOwnerState> {
  const context = structuredClone(authority);
  input = structuredClone(input);
  const initial = ticket(input.setupId, 0, {
    generationId: input.initialGenerationId,
    purpose: "provision",
    forceRefresh: false,
  });
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [prior] = await tx
      .select()
      .from(sandboxV2CredentialOwners)
      .where(scope(context))
      .limit(1);
    if (prior) {
      if (prior.initialGenerationId !== input.initialGenerationId) fail();
      return state(prior, context, input.setupId);
    }
    const [plan] = await tx
      .select()
      .from(sandboxV2PreparationPlans)
      .where(
        and(
          eq(sandboxV2PreparationPlans.workspaceId, context.workspaceId),
          eq(sandboxV2PreparationPlans.sessionId, context.sessionId),
          eq(sandboxV2PreparationPlans.turnId, context.turnId),
          eq(sandboxV2PreparationPlans.setupId, input.setupId),
        ),
      )
      .limit(1);
    if (
      !plan ||
      plan.attemptId !== context.attemptId ||
      plan.machineId !== context.machineId ||
      plan.executionGeneration !== context.executionGeneration ||
      !isDeepStrictEqual(plan.instance, context.instance) ||
      plan.definition.credentialGenerationId !== input.initialGenerationId
    )
      fail();
    const [saved] = await tx
      .insert(sandboxV2CredentialOwners)
      .values({ ...context, ...input, active: null, pending: initial })
      .returning();
    if (!saved) fail();
    return state(saved, context, input.setupId);
  });
}
export async function loadSandboxV2CredentialOwner(
  db: Database,
  authority: SandboxJournalControlAuthority,
  setupId: string,
): Promise<SandboxV2CredentialOwnerState> {
  const context = structuredClone(authority);
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx.select().from(sandboxV2CredentialOwners).where(scope(context)).limit(1);
    if (!row) fail();
    return state(row, context, setupId);
  });
}
/** Expected predecessor prevents a late timer from reserving another renewal.
 * A replacement observer gets the existing pending ticket, never a new ID. */
export async function reserveSandboxV2CredentialRenewal(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: { setupId: string; expectedGenerationId: string },
): Promise<SandboxV2CredentialOwnerState> {
  const context = structuredClone(authority);
  input = structuredClone(input);
  sandboxV2CredentialWriterIdentity(input.setupId, input.expectedGenerationId);
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx.select().from(sandboxV2CredentialOwners).where(scope(context)).limit(1);
    if (!row) fail();
    const original = state(row, context, input.setupId);
    if (!original.active) fail();
    if (original.active.definition.generationId !== input.expectedGenerationId || original.pending)
      return original;
    const pending = ticket(input.setupId, original.active.ordinal + 1, {
      generationId: randomUUID(),
      purpose: "renewal",
      forceRefresh: true,
    });
    const [saved] = await tx
      .update(sandboxV2CredentialOwners)
      .set({ pending, version: row.version + 1, updatedAt: new Date() })
      .where(scope(context))
      .returning();
    if (!saved) fail();
    return state(saved, context, input.setupId);
  });
}

/** Activation consumes the exact writer's protected terminal capture. An HTTP
 * success, caller boolean or timer cannot advance the head. Journal integrity
 * remains a separate release gate; this does not certify guest isolation. */
export async function activateSandboxV2CredentialTicket(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: { setupId: string; ticket: SandboxV2CredentialTicket },
): Promise<SandboxV2CredentialOwnerState> {
  const context = structuredClone(authority);
  input = structuredClone(input);
  const expected = SandboxV2CredentialTicket.parse(input.ticket);
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx.select().from(sandboxV2CredentialOwners).where(scope(context)).limit(1);
    if (!row) fail();
    const original = state(row, context, input.setupId);
    if (original.active && original.active.ordinal >= expected.ordinal) {
      if (
        original.active.ordinal === expected.ordinal &&
        !isDeepStrictEqual(original.active, expected)
      )
        fail();
      return original;
    }
    if (!isDeepStrictEqual(original.pending, expected)) fail();
    const [generation] = await tx
      .select({
        definition: sandboxV2CredentialGenerations.definition,
        expiresAt: sandboxV2CredentialGenerations.expiresAt,
        clearedAt: sandboxV2CredentialGenerations.clearedAt,
      })
      .from(sandboxV2CredentialGenerations)
      .where(
        and(
          eq(sandboxV2CredentialGenerations.workspaceId, context.workspaceId),
          eq(sandboxV2CredentialGenerations.sessionId, context.sessionId),
          eq(sandboxV2CredentialGenerations.attemptId, context.attemptId),
          eq(sandboxV2CredentialGenerations.generationId, expected.definition.generationId),
        ),
      )
      .limit(1);
    if (
      !generation ||
      generation.clearedAt !== null ||
      !isDeepStrictEqual(generation.definition, expected.definition) ||
      (generation.expiresAt && generation.expiresAt.getTime() <= Date.now())
    )
      fail();
    const [command] = await tx
      .select()
      .from(sandboxV2Commands)
      .where(
        and(
          eq(sandboxV2Commands.workspaceId, context.workspaceId),
          eq(sandboxV2Commands.sessionId, context.sessionId),
          eq(sandboxV2Commands.attemptId, context.attemptId),
          eq(sandboxV2Commands.acceptedActionId, expected.writerActionId),
        ),
      )
      .limit(1);
    const proof = command?.proof;
    if (
      !command ||
      command.machineId !== context.machineId ||
      command.executionGeneration !== context.executionGeneration ||
      command.instanceId !== context.instance.id ||
      command.binding?.bootId !== context.instance.bootId ||
      command.binding.diskLineage !== context.instance.diskLineage ||
      proof?.state !== "exited" ||
      proof.receipt?.leaderExitCode !== 0 ||
      (proof.receipt.acceptedInputSequence ?? -1) < 2 ||
      !proof.stdout.eof ||
      !proof.stderr.eof ||
      proof.stderr.nextOffset !== 0 ||
      command.stderr.offset !== 0 ||
      command.stdout.remainder !== "" ||
      command.stderr.remainder !== "" ||
      ![9, 14].includes(command.stdout.offset)
    )
      fail();
    const captures = await tx
      .select({ stdout: sandboxV2CommandOutput.stdout, stderr: sandboxV2CommandOutput.stderr })
      .from(sandboxV2CommandOutput)
      .where(
        and(
          eq(sandboxV2CommandOutput.operationId, command.operationId),
          or(ne(sandboxV2CommandOutput.stdout, ""), ne(sandboxV2CommandOutput.stderr, "")),
        ),
      )
      .orderBy(asc(sandboxV2CommandOutput.revision))
      .limit(32);
    if (captures.length === 32) fail();
    const acknowledgement = captures
      .map((value) => Buffer.from(value.stdout, "base64").toString("utf8"))
      .join("");
    if (
      !["installed", "not_applicable"].includes(acknowledgement) ||
      captures.some((value) => value.stderr !== "")
    )
      fail();
    const [saved] = await tx
      .update(sandboxV2CredentialOwners)
      .set({ active: expected, pending: null, version: row.version + 1, updatedAt: new Date() })
      .where(scope(context))
      .returning();
    if (!saved) fail();
    return state(saved, context, input.setupId);
  });
}
