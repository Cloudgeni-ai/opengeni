import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SandboxV2CredentialGenerationDefinition } from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import {
  withSandboxV2TurnMachineFence,
  type SandboxJournalControlAuthority,
} from "./sandbox-v2-commands";
import { sandboxV2CredentialGenerations } from "./sandbox-v2-schema";
import { sessionTurnAttempts } from "./schema";
import { lockSessionEventWriteRows } from "./session-control";
import { sessionAttemptPendingWritersSql } from "./session-attempt-writers";

export class SandboxV2CredentialGenerationError extends Error {
  readonly code = "SANDBOX_V2_CREDENTIAL_GENERATION";
  constructor() {
    super("Retained run credential generation is unavailable or changed");
  }
}
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}
type Row = typeof sandboxV2CredentialGenerations.$inferSelect;
export type RetainedSandboxV2CredentialGeneration = {
  ciphertext: string;
  expiresAt: Date | null;
};
function definition(input: unknown): SandboxV2CredentialGenerationDefinition {
  const result = SandboxV2CredentialGenerationDefinition.safeParse(input);
  if (!result.success) fail();
  return result.data;
}
function ciphertext(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 64 * 1024 * 1024 ||
    !/^v2:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/u.test(value)
  )
    fail();
}
function scope(context: SandboxJournalControlAuthority) {
  return and(
    eq(sandboxV2CredentialGenerations.accountId, context.accountId),
    eq(sandboxV2CredentialGenerations.workspaceId, context.workspaceId),
    eq(sandboxV2CredentialGenerations.sessionId, context.sessionId),
    eq(sandboxV2CredentialGenerations.turnId, context.turnId),
    eq(sandboxV2CredentialGenerations.attemptId, context.attemptId),
    eq(sandboxV2CredentialGenerations.executionGeneration, context.executionGeneration),
    eq(sandboxV2CredentialGenerations.machineId, context.machineId),
    eq(sandboxV2CredentialGenerations.instance, context.instance),
  );
}
function assertIdentity(
  row: Omit<Row, "ciphertext" | "expiresAt" | "createdAt">,
  context: SandboxJournalControlAuthority,
  expected: SandboxV2CredentialGenerationDefinition,
): void {
  if (
    row.accountId !== context.accountId ||
    row.workspaceId !== context.workspaceId ||
    row.sessionId !== context.sessionId ||
    row.attemptId !== context.attemptId ||
    row.machineId !== context.machineId ||
    row.turnId !== context.turnId ||
    row.executionGeneration !== context.executionGeneration ||
    row.generationId !== expected.generationId ||
    !isDeepStrictEqual(row.instance, context.instance) ||
    !isDeepStrictEqual(definition(row.definition), expected) ||
    row.clearedAt !== null
  )
    fail();
}
function retained(
  row: Row,
  context: SandboxJournalControlAuthority,
  expected: SandboxV2CredentialGenerationDefinition,
): RetainedSandboxV2CredentialGeneration {
  assertIdentity(row, context, expected);
  ciphertext(row.ciphertext);
  return { ciphertext: row.ciphertext, expiresAt: row.expiresAt };
}

/** Dispatch authorization reads only small immutable metadata. Do not fetch
 * or decrypt the potentially large credential payload on every model/tool call. */
export async function loadSandboxV2CredentialGenerationMetadata(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxV2CredentialGenerationDefinition,
): Promise<{ expiresAt: Date | null } | null> {
  const context = structuredClone(authority);
  const expected = definition(structuredClone(input));
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx
      .select({
        accountId: sandboxV2CredentialGenerations.accountId,
        workspaceId: sandboxV2CredentialGenerations.workspaceId,
        sessionId: sandboxV2CredentialGenerations.sessionId,
        turnId: sandboxV2CredentialGenerations.turnId,
        attemptId: sandboxV2CredentialGenerations.attemptId,
        executionGeneration: sandboxV2CredentialGenerations.executionGeneration,
        machineId: sandboxV2CredentialGenerations.machineId,
        instance: sandboxV2CredentialGenerations.instance,
        generationId: sandboxV2CredentialGenerations.generationId,
        definition: sandboxV2CredentialGenerations.definition,
        clearedAt: sandboxV2CredentialGenerations.clearedAt,
        expiresAt: sandboxV2CredentialGenerations.expiresAt,
      })
      .from(sandboxV2CredentialGenerations)
      .where(
        and(
          eq(sandboxV2CredentialGenerations.workspaceId, context.workspaceId),
          eq(sandboxV2CredentialGenerations.sessionId, context.sessionId),
          eq(sandboxV2CredentialGenerations.attemptId, context.attemptId),
          eq(sandboxV2CredentialGenerations.generationId, expected.generationId),
        ),
      )
      .limit(1);
    if (!row) return null;
    assertIdentity(row, context, expected);
    return { expiresAt: row.expiresAt };
  });
}

/** Reads ciphertext under the active exact turn/incarnation fence. The host
 * must recheck credential grants before decrypting; storage grants no mint,
 * materialization, activation, renewal or control-worker launch authority. */
export async function loadSandboxV2CredentialGeneration(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxV2CredentialGenerationDefinition,
): Promise<RetainedSandboxV2CredentialGeneration | null> {
  const context = structuredClone(authority);
  const expected = definition(structuredClone(input));
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(sandboxV2CredentialGenerations)
      .where(
        and(
          eq(sandboxV2CredentialGenerations.workspaceId, context.workspaceId),
          eq(sandboxV2CredentialGenerations.sessionId, context.sessionId),
          eq(sandboxV2CredentialGenerations.attemptId, context.attemptId),
          eq(sandboxV2CredentialGenerations.generationId, expected.generationId),
        ),
      )
      .limit(1);
    return row ? retained(row, context, expected) : null;
  });
}

/** Concurrent observers retain one encrypted original before any input bytes
 * are delivered. Losing candidates return the original ciphertext, never
 * overwrite it. A cleared identity cannot be recreated. No plaintext is stored. */
export async function retainSandboxV2CredentialGeneration(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxV2CredentialGenerationDefinition,
  sealed: RetainedSandboxV2CredentialGeneration,
): Promise<RetainedSandboxV2CredentialGeneration> {
  const context = structuredClone(authority);
  const expected = definition(structuredClone(input));
  sealed = structuredClone(sealed);
  ciphertext(sealed.ciphertext);
  if (
    sealed.expiresAt !== null &&
    (!(sealed.expiresAt instanceof Date) || !Number.isFinite(sealed.expiresAt.getTime()))
  )
    fail();
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [prior] = await tx
      .select()
      .from(sandboxV2CredentialGenerations)
      .where(
        and(
          eq(sandboxV2CredentialGenerations.workspaceId, context.workspaceId),
          eq(sandboxV2CredentialGenerations.sessionId, context.sessionId),
          eq(sandboxV2CredentialGenerations.attemptId, context.attemptId),
          eq(sandboxV2CredentialGenerations.generationId, expected.generationId),
        ),
      )
      .limit(1);
    if (prior) return retained(prior, context, expected);
    const [saved] = await tx
      .insert(sandboxV2CredentialGenerations)
      .values({
        ...context,
        generationId: expected.generationId,
        definition: expected,
        ...sealed,
      })
      .returning();
    if (!saved) fail();
    return retained(saved, context, expected);
  });
}

/** Ciphertext erasure only after the exact attempt is closed and physically
 * quiesced, with all durable writers settled. Original machine/boot scope is
 * retained so cleanup cannot touch a successor. The tombstone survives. */
export async function clearSandboxV2CredentialGenerationsForQuiescedAttempt(
  db: Database,
  authority: SandboxJournalControlAuthority,
): Promise<number> {
  const context = structuredClone(authority);
  return withRlsContext(db, context, async (tx) => {
    const locks = await lockSessionEventWriteRows(tx, {
      workspaceId: context.workspaceId,
      controlLock: "share",
      sessionLock: "no_key_update",
      sessionIds: [context.sessionId],
      turnIds: [context.turnId],
      attemptIds: [context.attemptId],
    });
    const session = locks.sessions.find((row) => row.id === context.sessionId);
    const turn = locks.turns.find((row) => row.id === context.turnId);
    const attempt = locks.attempts.find((row) => row.id === context.attemptId);
    if (
      session?.accountId !== context.accountId ||
      turn?.accountId !== context.accountId ||
      turn.sessionId !== context.sessionId ||
      attempt?.accountId !== context.accountId ||
      attempt.sessionId !== context.sessionId ||
      attempt.turnId !== context.turnId ||
      attempt.executionGeneration !== context.executionGeneration ||
      attempt.closedAt === null ||
      attempt.quiescedAt === null
    )
      fail();
    const [writers] = await tx.execute<{ pending: boolean }>(sql`
      select ${sessionAttemptPendingWritersSql(sql`attempt`)} as pending
      from ${sessionTurnAttempts} attempt where attempt.id=${context.attemptId}::uuid`);
    if (!writers || writers.pending) fail();
    const cleared = await tx
      .update(sandboxV2CredentialGenerations)
      .set({ ciphertext: null, clearedAt: new Date() })
      .where(and(scope(context), isNull(sandboxV2CredentialGenerations.clearedAt)))
      .returning({ id: sandboxV2CredentialGenerations.generationId });
    return cleared.length;
  });
}
