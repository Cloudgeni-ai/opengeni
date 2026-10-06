import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { SandboxJournalCommand, SandboxJournalObservation } from "@opengeni/contracts";
import type { Database } from "./database";
import type { SandboxJournalControlAuthority } from "./sandbox-v2-commands";
import { sessions } from "./schema";
import {
  sandboxGroupEngines,
  sandboxV2Machines,
  sandboxV2CredentialCleanup,
} from "./sandbox-v2-schema";

function fail(): never {
  throw new Error("Native attempt physical settlement is unavailable or pending");
}

/** Receipt composition only, with the canonical control/session/turn/attempt
 * locks already held. Metadata and the COMPLETE durable writer predicate are
 * authority; a caller flag, bounded inventory, age or EOF alone is not proof.
 * No provider I/O, credential material, decryption or minting occurs here. */
export async function readSandboxV2AttemptQuiescenceTx(
  tx: Database,
  context: Omit<SandboxJournalControlAuthority, "machineId" | "instance">,
  original?: SandboxJournalControlAuthority,
): Promise<{
  engine: "legacy" | "machine-v2";
  credentialAuthority: SandboxJournalControlAuthority | null;
}> {
  const [route] = await tx
    .select({ engine: sandboxGroupEngines.engine, machineId: sandboxV2Machines.id })
    .from(sessions)
    .innerJoin(
      sandboxGroupEngines,
      and(
        eq(sandboxGroupEngines.accountId, sessions.accountId),
        eq(sandboxGroupEngines.workspaceId, sessions.workspaceId),
        eq(sandboxGroupEngines.sandboxGroupId, sessions.sandboxGroupId),
      ),
    )
    .leftJoin(
      sandboxV2Machines,
      and(
        eq(sandboxV2Machines.accountId, sessions.accountId),
        eq(sandboxV2Machines.workspaceId, sessions.workspaceId),
        eq(sandboxV2Machines.sandboxGroupId, sessions.sandboxGroupId),
      ),
    )
    .where(
      and(
        eq(sessions.id, context.sessionId),
        eq(sessions.accountId, context.accountId),
        eq(sessions.workspaceId, context.workspaceId),
      ),
    )
    .limit(1);
  if (!route) fail();
  if (route.engine === "legacy") {
    if (original) fail();
    return { engine: "legacy", credentialAuthority: null };
  }
  if (
    !route.machineId ||
    (original &&
      !isDeepStrictEqual(
        {
          accountId: original.accountId,
          workspaceId: original.workspaceId,
          sessionId: original.sessionId,
          turnId: original.turnId,
          attemptId: original.attemptId,
          executionGeneration: original.executionGeneration,
        },
        context,
      )) ||
    (original && original.machineId !== route.machineId)
  )
    fail();
  const [state] = await tx.execute<{ closed: boolean; pending: boolean; credentials: boolean }>(sql`
    select attempt.state='closed' and attempt.closed_at is not null as closed,
      sandbox_v2_attempt_writers_pending(attempt.account_id,attempt.workspace_id,
        attempt.session_id,attempt.id,NULL) as pending,
      (exists (select 1 from sandbox_v2_credential_generations generation
        where generation.account_id=attempt.account_id and generation.workspace_id=attempt.workspace_id
          and generation.session_id=attempt.session_id and generation.attempt_id=attempt.id)
       or exists (select 1 from sandbox_v2_credential_owners owner
        where owner.account_id=attempt.account_id and owner.workspace_id=attempt.workspace_id
          and owner.session_id=attempt.session_id and owner.attempt_id=attempt.id)) as credentials
    from session_turn_attempts attempt where attempt.id=${context.attemptId}::uuid
      and attempt.account_id=${context.accountId}::uuid and attempt.workspace_id=${context.workspaceId}::uuid
      and attempt.session_id=${context.sessionId}::uuid and attempt.turn_id=${context.turnId}::uuid
      and attempt.execution_generation=${context.executionGeneration}`);
  if (!state?.closed || state.pending) fail();
  const [cleanup] = await tx
    .select()
    .from(sandboxV2CredentialCleanup)
    .where(
      and(
        eq(sandboxV2CredentialCleanup.accountId, context.accountId),
        eq(sandboxV2CredentialCleanup.workspaceId, context.workspaceId),
        eq(sandboxV2CredentialCleanup.sessionId, context.sessionId),
        eq(sandboxV2CredentialCleanup.attemptId, context.attemptId),
      ),
    )
    .limit(1);
  if (!cleanup) {
    if (state.credentials) fail();
    return { engine: "machine-v2", credentialAuthority: null };
  }
  if (
    cleanup.turnId !== context.turnId ||
    cleanup.executionGeneration !== context.executionGeneration ||
    cleanup.machineId !== route.machineId ||
    cleanup.binding === null ||
    cleanup.proof === null ||
    (original && !isDeepStrictEqual(original.instance, cleanup.instance))
  )
    fail();
  const binding = SandboxJournalCommand.parse(cleanup.binding);
  const proof = SandboxJournalObservation.parse(cleanup.proof);
  if (
    binding.operationId !== cleanup.operationId ||
    proof.operationId !== cleanup.operationId ||
    binding.specificationDigest !== cleanup.specificationDigest ||
    proof.specificationDigest !== cleanup.specificationDigest ||
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
  const [mismatch] = await tx.execute<{ changed: boolean }>(sql`select exists (
    select 1 from sandbox_v2_credential_generations generation
    where generation.account_id=${context.accountId}::uuid and generation.workspace_id=${context.workspaceId}::uuid
      and generation.session_id=${context.sessionId}::uuid and generation.attempt_id=${context.attemptId}::uuid
      and (generation.turn_id<>${context.turnId}::uuid
        or generation.execution_generation<>${context.executionGeneration}
        or generation.machine_id<>${route.machineId}::uuid
        or generation.instance<>${JSON.stringify(cleanup.instance)}::jsonb)) as changed`);
  if (!mismatch || mismatch.changed) fail();
  return {
    engine: "machine-v2",
    credentialAuthority: {
      ...context,
      machineId: cleanup.machineId,
      instance: structuredClone(cleanup.instance),
    },
  };
}
