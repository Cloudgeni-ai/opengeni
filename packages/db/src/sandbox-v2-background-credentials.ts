import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, isNotNull, or } from "drizzle-orm";
import {
  SandboxJournalCommand,
  SandboxJournalObservation,
  SandboxMachineRecord,
  SandboxV2CredentialGenerationDefinition,
} from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import {
  withSandboxV2CommandControlFence,
  type SandboxV2BackgroundCommandAuthority,
} from "./sandbox-v2-commands";
import {
  SandboxV2CredentialGenerationError,
  type RetainedSandboxV2CredentialGeneration,
} from "./sandbox-v2-credential-generations";
import {
  sandboxV2BackgroundCredentials,
  sandboxV2BackgroundOwners,
  sandboxV2Commands,
  sandboxV2CommandOutput,
  sandboxV2Machines,
} from "./sandbox-v2-schema";
import { sandboxV2CredentialWriterIdentity } from "./sandbox-v2-credential-owners";
import { sessionBackgroundCommands, sessions } from "./schema";
import {
  assertSessionAuthoritySnapshot,
  sessionAuthoritySnapshotMatchesSession,
  evaluateSessionWriteAdmissionControl,
} from "./session-control";

/** Original job custody, supplied by trusted host composition. A job UUID from
 * a tool argument or public command receipt grants no credential authority. */
export type SandboxV2BackgroundCredentialAuthority = SandboxV2BackgroundCommandAuthority;
type Row = typeof sandboxV2BackgroundCredentials.$inferSelect;
type MachineRow = typeof sandboxV2Machines.$inferSelect;
function fail(): never {
  throw new SandboxV2CredentialGenerationError();
}
function parse(input: unknown): SandboxV2CredentialGenerationDefinition {
  const result = SandboxV2CredentialGenerationDefinition.safeParse(input);
  if (!result.success || result.data.purpose !== "provision" || result.data.forceRefresh) fail();
  return result.data;
}
async function fenced<T>(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  purpose: "provision" | "recover" | "cleanup",
  effect: (
    tx: Database,
    originalLive: boolean,
    machine: MachineRow,
    projection: SandboxMachineRecord,
  ) => Promise<T>,
) {
  const context = structuredClone(authority);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(context.jobId))
    fail();
  return await withSandboxV2CommandControlFence(
    db,
    context,
    "owner",
    async (tx, original, machine, projection, live, attempt) => {
      if (purpose === "provision" && !live) fail();
      const [job] = await tx
        .select()
        .from(sessionBackgroundCommands)
        .where(
          and(
            eq(sessionBackgroundCommands.id, context.jobId),
            eq(sessionBackgroundCommands.accountId, context.accountId),
            eq(sessionBackgroundCommands.workspaceId, context.workspaceId),
            eq(sessionBackgroundCommands.sessionId, context.sessionId),
          ),
        )
        .limit(1);
      if (
        !job ||
        job.provider !== "managed" ||
        job.nativeOperationId !== context.jobId ||
        (purpose !== "cleanup" && job.state !== "running") ||
        job.launchTurnId !== context.turnId ||
        job.launchAttemptId !== context.attemptId ||
        job.launchExecutionGeneration !== context.executionGeneration ||
        (purpose !== "cleanup" && projection.target === "destroyed")
      )
        fail();
      const [command] = await tx
        .select({
          binding: sandboxV2Commands.binding,
          abandoned: sandboxV2Commands.abandoned,
          proof: sandboxV2Commands.proof,
        })
        .from(sandboxV2Commands)
        .where(
          and(
            eq(sandboxV2Commands.operationId, context.jobId),
            eq(sandboxV2Commands.accountId, context.accountId),
            eq(sandboxV2Commands.workspaceId, context.workspaceId),
            eq(sandboxV2Commands.sessionId, context.sessionId),
            eq(sandboxV2Commands.attemptId, context.attemptId),
            eq(sandboxV2Commands.machineId, context.machineId),
          ),
        )
        .limit(1);
      if (
        !command ||
        (purpose !== "cleanup" &&
          (command.abandoned || command.proof || (purpose === "provision" && command.binding)))
      )
        fail();
      // Fixed cleanup retains no decryption or resource-use authority. It can
      // remove original material after grant revocation, using physical writer
      // settlement checked separately below.
      if (purpose === "cleanup") return await effect(tx, live, machine, projection);
      const [session] = await tx
        .select({
          authorityEpoch: sessions.authorityEpoch,
          executionAuthorityEpoch: sessions.executionAuthorityEpoch,
          visibility: sessions.visibility,
          ownerOrganizationMembershipId: sessions.ownerOrganizationMembershipId,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.accountId, context.accountId),
            eq(sessions.workspaceId, context.workspaceId),
            eq(sessions.id, context.sessionId),
          ),
        )
        .limit(1);
      if (
        !session ||
        !sessionAuthoritySnapshotMatchesSession(
          assertSessionAuthoritySnapshot({
            attemptId: original.attemptId,
            authorityEpoch: attempt.authorityEpoch,
            authorityVisibility: attempt.authorityVisibility,
            authorityOwnerOrganizationMembershipId: attempt.authorityOwnerOrganizationMembershipId,
          }),
          session,
        )
      )
        fail();
      const control = await evaluateSessionWriteAdmissionControl(
        tx,
        context.workspaceId,
        context.sessionId,
      );
      if (control.state !== "active") fail();
      return await effect(tx, live, machine, projection);
    },
  );
}
function scope(context: SandboxV2BackgroundCredentialAuthority) {
  return and(
    eq(sandboxV2BackgroundCredentials.accountId, context.accountId),
    eq(sandboxV2BackgroundCredentials.workspaceId, context.workspaceId),
    eq(sandboxV2BackgroundCredentials.sessionId, context.sessionId),
    eq(sandboxV2BackgroundCredentials.jobId, context.jobId),
  );
}
function assertIdentity(
  row: Pick<
    Row,
    | "accountId"
    | "workspaceId"
    | "sessionId"
    | "jobId"
    | "turnId"
    | "attemptId"
    | "executionGeneration"
    | "machineId"
    | "instance"
    | "generationId"
    | "definition"
    | "expiresAt"
    | "clearedAt"
  >,
  context: SandboxV2BackgroundCredentialAuthority,
  expected: SandboxV2CredentialGenerationDefinition,
) {
  if (
    row.accountId !== context.accountId ||
    row.workspaceId !== context.workspaceId ||
    row.sessionId !== context.sessionId ||
    row.jobId !== context.jobId ||
    row.turnId !== context.turnId ||
    row.attemptId !== context.attemptId ||
    row.executionGeneration !== context.executionGeneration ||
    row.machineId !== context.machineId ||
    !isDeepStrictEqual(row.instance, context.instance) ||
    row.generationId !== expected.generationId ||
    !isDeepStrictEqual(row.definition, expected) ||
    row.clearedAt !== null ||
    (row.expiresAt && row.expiresAt.getTime() <= Date.now())
  )
    fail();
}

/** Recovery reads existing job material under current session authority and the
 * original incarnation. This grants no Start, guest input, renewal or erasure. */
export async function loadSandboxV2BackgroundCredentialGeneration(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxV2CredentialGenerationDefinition,
): Promise<RetainedSandboxV2CredentialGeneration | null> {
  const context = structuredClone(authority);
  const expected = parse(structuredClone(input));
  return await fenced(db, context, "recover", async (tx, live) => {
    const [row] = await tx
      .select()
      .from(sandboxV2BackgroundCredentials)
      .where(scope(context))
      .limit(1);
    if (!row) {
      if (!live) fail();
      return null;
    }
    assertIdentity(row, context, expected);
    if (row.ciphertext === null) fail();
    return { ciphertext: row.ciphertext, expiresAt: row.expiresAt };
  });
}
export async function loadSandboxV2BackgroundCredentialGenerationMetadata(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxV2CredentialGenerationDefinition,
): Promise<{ expiresAt: Date | null } | null> {
  const context = structuredClone(authority);
  const expected = parse(structuredClone(input));
  return await fenced(db, context, "recover", async (tx, live) => {
    const [row] = await tx
      .select({
        accountId: sandboxV2BackgroundCredentials.accountId,
        workspaceId: sandboxV2BackgroundCredentials.workspaceId,
        sessionId: sandboxV2BackgroundCredentials.sessionId,
        jobId: sandboxV2BackgroundCredentials.jobId,
        turnId: sandboxV2BackgroundCredentials.turnId,
        attemptId: sandboxV2BackgroundCredentials.attemptId,
        executionGeneration: sandboxV2BackgroundCredentials.executionGeneration,
        machineId: sandboxV2BackgroundCredentials.machineId,
        instance: sandboxV2BackgroundCredentials.instance,
        generationId: sandboxV2BackgroundCredentials.generationId,
        definition: sandboxV2BackgroundCredentials.definition,
        expiresAt: sandboxV2BackgroundCredentials.expiresAt,
        clearedAt: sandboxV2BackgroundCredentials.clearedAt,
      })
      .from(sandboxV2BackgroundCredentials)
      .where(scope(context))
      .limit(1);
    if (!row) {
      if (!live) fail();
      return null;
    }
    assertIdentity(row, context, expected);
    return { expiresAt: row.expiresAt };
  });
}
/** Only original live, prelaunch authority may create material. A replacement
 * observer may recover its original; it cannot mint after the turn ends. */
export async function retainSandboxV2BackgroundCredentialGeneration(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxV2CredentialGenerationDefinition,
  sealed: RetainedSandboxV2CredentialGeneration,
  cleanupSpecification: (operationId: string) => string,
): Promise<RetainedSandboxV2CredentialGeneration> {
  const context = structuredClone(authority);
  const expected = parse(structuredClone(input));
  sealed = structuredClone(sealed);
  if (
    typeof sealed.ciphertext !== "string" ||
    sealed.ciphertext.length > 64 * 1024 * 1024 ||
    !/^v2:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]+={0,2}$/u.test(sealed.ciphertext) ||
    (sealed.expiresAt !== null &&
      (!(sealed.expiresAt instanceof Date) ||
        !Number.isFinite(sealed.expiresAt.getTime()) ||
        sealed.expiresAt.getTime() <= Date.now()))
  )
    fail();
  return await fenced(db, context, "provision", async (tx, _live, machine, projection) => {
    const [prior] = await tx
      .select()
      .from(sandboxV2BackgroundCredentials)
      .where(scope(context))
      .limit(1);
    if (prior) {
      assertIdentity(prior, context, expected);
      if (
        prior.ciphertext === null ||
        cleanupSpecification(prior.cleanupOperationId) !== prior.cleanupSpecificationDigest
      )
        fail();
      return { ciphertext: prior.ciphertext, expiresAt: prior.expiresAt };
    }
    const cleanupOperationId = randomUUID();
    const cleanupSpecificationDigest = cleanupSpecification(cleanupOperationId);
    if (!/^[a-f0-9]{64}$/u.test(cleanupSpecificationDigest)) fail();
    const [row] = await tx
      .insert(sandboxV2BackgroundCredentials)
      .values({
        ...context,
        generationId: expected.generationId,
        definition: expected,
        ...sealed,
        writerActionId: sandboxV2CredentialWriterIdentity(
          sandboxV2BackgroundCredentialSetupId(context.jobId),
          expected.generationId,
        ).writerActionId,
        cleanupOperationId,
        cleanupSpecificationDigest,
      })
      .returning();
    if (!row) fail();
    assertIdentity(row, context, expected);
    if (row.ciphertext === null) fail();
    await updateCleanupDemand(tx, machine, projection, context, cleanupOperationId, false);
    return { ciphertext: row.ciphertext, expiresAt: row.expiresAt };
  });
}

export function sandboxV2BackgroundCredentialSetupId(jobId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(jobId)) fail();
  return `background-job:v1:${jobId}`;
}

/** A trusted independent control owner must authorize this prelaunch custody.
 * Exact separate credential delivery must already be acknowledged. Binding or
 * ended origin authority can never be relabelled as a fresh independent job. */
export async function retainSandboxV2BackgroundOwner(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
) {
  const context = structuredClone(authority);
  return fenced(db, context, "provision", async (tx, _live, _machine, projection) => {
    const custody = await lockedCustody(tx, context);
    if (
      !custody ||
      custody.ciphertext === null ||
      custody.clearedAt ||
      (custody.expiresAt && custody.expiresAt.getTime() <= Date.now()) ||
      projection.state !== "running" ||
      projection.transition !== null ||
      !projection.demands.some((demand) =>
        isDeepStrictEqual(demand, cleanupDemand(context, custody.cleanupOperationId)),
      )
    )
      fail();
    const [writer] = await tx
      .select()
      .from(sandboxV2Commands)
      .where(
        and(
          eq(sandboxV2Commands.accountId, context.accountId),
          eq(sandboxV2Commands.workspaceId, context.workspaceId),
          eq(sandboxV2Commands.sessionId, context.sessionId),
          eq(sandboxV2Commands.attemptId, context.attemptId),
          eq(sandboxV2Commands.acceptedActionId, custody.writerActionId),
        ),
      )
      .limit(1);
    if (
      !writer ||
      writer.machineId !== context.machineId ||
      writer.turnId !== context.turnId ||
      writer.executionGeneration !== context.executionGeneration ||
      writer.instanceId !== context.instance.id ||
      writer.binding?.bootId !== context.instance.bootId ||
      writer.binding.diskLineage !== context.instance.diskLineage ||
      writer.proof?.state !== "exited" ||
      writer.proof.receipt?.leaderExitCode !== 0 ||
      (writer.proof.receipt.acceptedInputSequence ?? -1) < 2 ||
      ![9, 14].includes(writer.stdout.offset) ||
      writer.stderr.offset !== 0 ||
      writer.stdout.remainder !== "" ||
      writer.stderr.remainder !== ""
    )
      fail();
    const captures = await tx
      .select()
      .from(sandboxV2CommandOutput)
      .where(eq(sandboxV2CommandOutput.operationId, writer.operationId))
      .orderBy(asc(sandboxV2CommandOutput.revision))
      .limit(32);
    const last = captures.at(-1)?.observation;
    if (
      captures.length >= 32 ||
      !last ||
      last.state !== "exited" ||
      !last.stdout.eof ||
      !last.stderr.eof ||
      captures.some((page) => page.stderr !== "") ||
      !["installed", "not_applicable"].includes(
        captures.map((page) => Buffer.from(page.stdout, "base64").toString("utf8")).join(""),
      )
    )
      fail();
    const expected = {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      jobId: context.jobId,
      turnId: context.turnId,
      attemptId: context.attemptId,
      executionGeneration: context.executionGeneration,
      machineId: context.machineId,
      instance: context.instance,
      generationId: custody.generationId,
      writerActionId: custody.writerActionId,
      cleanupOperationId: custody.cleanupOperationId,
    };
    const [prior] = await tx
      .select()
      .from(sandboxV2BackgroundOwners)
      .where(eq(sandboxV2BackgroundOwners.jobId, context.jobId))
      .limit(1);
    const row =
      prior ?? (await tx.insert(sandboxV2BackgroundOwners).values(expected).returning())[0];
    if (
      !row ||
      Object.entries(expected).some(
        ([key, value]) => !isDeepStrictEqual(row[key as keyof typeof row], value),
      )
    )
      fail();
    return row;
  });
}

/** Advisory bounded recovery inventory. Include completed jobs until fixed
 * guest cleanup actually settles their separate custody. Every later control
 * and cleanup operation rechecks original scope/incarnation independently.
 * Recovery may also include sealed custody whose independent registration
 * never completed. It grants no writer exclusion or new dispatch authority. */
export async function listSandboxV2BackgroundOwnersForControl(
  db: Database,
  tenant: { accountId: string; workspaceId: string; machineId: string },
  options: {
    limit?: number;
    afterJobId?: string;
    jobId?: string;
    includeUnregistered?: boolean;
    includeCleared?: boolean;
  } = {},
) {
  tenant = { ...tenant };
  options = { ...options };
  const limit = options.limit ?? 25;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    [options.afterJobId, options.jobId].some(
      (id) =>
        id !== undefined &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id),
    )
  )
    fail();
  return withRlsContext(db, tenant, async (tx) => {
    const rows = await tx
      .select({
        accountId: sandboxV2BackgroundCredentials.accountId,
        workspaceId: sandboxV2BackgroundCredentials.workspaceId,
        sessionId: sandboxV2BackgroundCredentials.sessionId,
        turnId: sandboxV2BackgroundCredentials.turnId,
        attemptId: sandboxV2BackgroundCredentials.attemptId,
        executionGeneration: sandboxV2BackgroundCredentials.executionGeneration,
        machineId: sandboxV2BackgroundCredentials.machineId,
        instance: sandboxV2BackgroundCredentials.instance,
        jobId: sandboxV2BackgroundCredentials.jobId,
      })
      .from(sandboxV2BackgroundCredentials)
      .leftJoin(
        sandboxV2BackgroundOwners,
        and(
          eq(sandboxV2BackgroundCredentials.workspaceId, sandboxV2BackgroundOwners.workspaceId),
          eq(sandboxV2BackgroundCredentials.sessionId, sandboxV2BackgroundOwners.sessionId),
          eq(sandboxV2BackgroundCredentials.jobId, sandboxV2BackgroundOwners.jobId),
        ),
      )
      .where(
        and(
          eq(sandboxV2BackgroundCredentials.accountId, tenant.accountId),
          eq(sandboxV2BackgroundCredentials.workspaceId, tenant.workspaceId),
          eq(sandboxV2BackgroundCredentials.machineId, tenant.machineId),
          options.includeCleared ? undefined : isNull(sandboxV2BackgroundCredentials.clearedAt),
          options.includeUnregistered ? undefined : isNotNull(sandboxV2BackgroundOwners.jobId),
          options.jobId ? eq(sandboxV2BackgroundCredentials.jobId, options.jobId) : undefined,
          options.afterJobId
            ? gt(sandboxV2BackgroundCredentials.jobId, options.afterJobId)
            : undefined,
        ),
      )
      .orderBy(asc(sandboxV2BackgroundCredentials.jobId))
      .limit(limit);
    return {
      items: rows.map((owner) => ({
        authority: {
          accountId: owner.accountId,
          workspaceId: owner.workspaceId,
          sessionId: owner.sessionId,
          turnId: owner.turnId,
          attemptId: owner.attemptId,
          executionGeneration: owner.executionGeneration,
          machineId: owner.machineId,
          instance: structuredClone(owner.instance),
          jobId: owner.jobId,
        },
      })),
      nextJobId: !options.jobId && rows.length === limit ? rows.at(-1)!.jobId : null,
    };
  });
}

function cleanupDemand(context: SandboxV2BackgroundCredentialAuthority, operationId: string) {
  return {
    id: operationId,
    kind: "command" as const,
    owner: context.sessionId,
    authority: context.jobId,
  };
}

async function updateCleanupDemand(
  tx: Database,
  machine: MachineRow,
  projection: SandboxMachineRecord,
  context: SandboxV2BackgroundCredentialAuthority,
  operationId: string,
  remove: boolean,
) {
  const owner = cleanupDemand(context, operationId);
  const existing = projection.demands.find((entry) => entry.id === operationId);
  if (existing && !isDeepStrictEqual(existing, owner)) fail();
  if (remove ? !existing : existing) return;
  const demands = remove
    ? projection.demands.filter((entry) => entry.id !== operationId)
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

async function lockedCustody(tx: Database, context: SandboxV2BackgroundCredentialAuthority) {
  const [row] = await tx
    .select()
    .from(sandboxV2BackgroundCredentials)
    .where(scope(context))
    .for("update")
    .limit(1);
  if (
    row &&
    (row.turnId !== context.turnId ||
      row.attemptId !== context.attemptId ||
      row.executionGeneration !== context.executionGeneration ||
      row.machineId !== context.machineId ||
      !isDeepStrictEqual(row.instance, context.instance))
  )
    fail();
  return row ?? null;
}

async function cleanupEligible(
  tx: Database,
  context: SandboxV2BackgroundCredentialAuthority,
  row: Row,
  projection: SandboxMachineRecord,
) {
  if (
    row.cleanupProof ||
    projection.state !== "running" ||
    projection.transition !== null ||
    !projection.demands.some((entry) =>
      isDeepStrictEqual(entry, cleanupDemand(context, row.cleanupOperationId)),
    )
  )
    return false;
  const commands = await tx
    .select({
      operationId: sandboxV2Commands.operationId,
      acceptedActionId: sandboxV2Commands.acceptedActionId,
      binding: sandboxV2Commands.binding,
      abandoned: sandboxV2Commands.abandoned,
      proof: sandboxV2Commands.proof,
    })
    .from(sandboxV2Commands)
    .where(
      and(
        eq(sandboxV2Commands.accountId, context.accountId),
        eq(sandboxV2Commands.workspaceId, context.workspaceId),
        eq(sandboxV2Commands.sessionId, context.sessionId),
        eq(sandboxV2Commands.attemptId, context.attemptId),
        eq(sandboxV2Commands.machineId, context.machineId),
        eq(sandboxV2Commands.turnId, context.turnId),
        eq(sandboxV2Commands.executionGeneration, context.executionGeneration),
        eq(sandboxV2Commands.instanceId, context.instance.id),
        or(
          eq(sandboxV2Commands.operationId, context.jobId),
          eq(sandboxV2Commands.acceptedActionId, row.writerActionId),
        ),
      ),
    )
    .limit(2);
  const original = commands.find((command) => command.operationId === context.jobId);
  if (!original || (!original.proof && !(original.abandoned && !original.binding))) return false;
  if (original.proof) {
    const [last] = await tx
      .select({ observation: sandboxV2CommandOutput.observation })
      .from(sandboxV2CommandOutput)
      .where(eq(sandboxV2CommandOutput.operationId, context.jobId))
      .orderBy(desc(sandboxV2CommandOutput.revision))
      .limit(1);
    if (
      !last ||
      !["exited", "cancelled"].includes(last.observation.state) ||
      !last.observation.stdout.eof ||
      !last.observation.stderr.eof
    )
      return false;
  }
  const writer = commands.find((command) => command.acceptedActionId === row.writerActionId);
  return !writer || !!writer.proof || (writer.abandoned && !writer.binding);
}

function matchCleanup(
  row: Row,
  context: SandboxV2BackgroundCredentialAuthority,
  command: SandboxJournalCommand,
) {
  if (
    !isDeepStrictEqual(command, {
      kind: "machine-journal-v1",
      machineId: context.machineId,
      operationId: row.cleanupOperationId,
      diskLineage: context.instance.diskLineage,
      bootId: context.instance.bootId,
      specificationDigest: row.cleanupSpecificationDigest,
      stdin: false,
      pty: false,
    })
  )
    fail();
}

/** Advisory maintenance metadata, never ciphertext or renewed job permission.
 * Eligibility follows only the original job and credential writer, so a later
 * unrelated turn does not own this job's cleanup lifetime. */
export async function loadSandboxV2BackgroundCredentialCleanupForControl(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
) {
  const context = structuredClone(authority);
  return fenced(db, context, "cleanup", async (tx, _live, _machine, projection) => {
    const row = await lockedCustody(tx, context);
    if (!row) return null;
    return {
      operationId: row.cleanupOperationId,
      specificationDigest: row.cleanupSpecificationDigest,
      binding: row.cleanupBinding,
      proof: row.cleanupProof,
      eligible: await cleanupEligible(tx, context, row, projection),
    };
  });
}

/** Retain the exact fixed cleanup binding before physical dispatch. A retained
 * binding is only observed on recovery; absence/lost/unknown does not replay it. */
export async function reserveSandboxV2BackgroundCredentialCleanupCommand(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxJournalCommand,
): Promise<SandboxJournalCommand> {
  const context = structuredClone(authority);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  return fenced(db, context, "cleanup", async (tx, _live, _machine, projection) => {
    const row = await lockedCustody(tx, context);
    if (!row || !(await cleanupEligible(tx, context, row, projection))) fail();
    matchCleanup(row, context, command);
    if (row.cleanupBinding) {
      if (!isDeepStrictEqual(row.cleanupBinding, command)) fail();
      return row.cleanupBinding;
    }
    await tx
      .update(sandboxV2BackgroundCredentials)
      .set({
        cleanupBinding: command,
        cleanupRevision: row.cleanupRevision + 1,
        updatedAt: new Date(),
      })
      .where(scope(context));
    return command;
  });
}

export async function assertSandboxV2BackgroundCredentialCleanupCommand(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxJournalCommand,
  action: "start" | "read",
): Promise<void> {
  const context = structuredClone(authority);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  await fenced(db, context, "cleanup", async (tx, _live, _machine, projection) => {
    const row = await lockedCustody(tx, context);
    if (!row || !isDeepStrictEqual(row.cleanupBinding, command)) fail();
    matchCleanup(row, context, command);
    if (action === "start" && !(await cleanupEligible(tx, context, row, projection))) fail();
  });
}

/** Complete original cleanup, ciphertext erasure and removal of only its job
 * demand are atomic. A real job exit alone cannot release credential custody. */
export async function settleSandboxV2BackgroundCredentialCleanup(
  db: Database,
  authority: SandboxV2BackgroundCredentialAuthority,
  input: SandboxJournalCommand,
  observation: SandboxJournalObservation,
): Promise<void> {
  const context = structuredClone(authority);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  const proof = SandboxJournalObservation.parse(structuredClone(observation));
  if (
    proof.operationId !== command.operationId ||
    proof.specificationDigest !== command.specificationDigest ||
    proof.state !== "exited" ||
    proof.receipt?.leaderExitCode !== 0 ||
    proof.receipt.invocationId !== command.operationId ||
    !isDeepStrictEqual(proof.stdout, {
      offset: 0,
      nextOffset: 7,
      data: "Y2xlYW5lZA==",
      eof: true,
    }) ||
    !isDeepStrictEqual(proof.stderr, { offset: 0, nextOffset: 0, data: "", eof: true })
  )
    fail();
  await fenced(db, context, "cleanup", async (tx, _live, machine, projection) => {
    const row = await lockedCustody(tx, context);
    if (!row || !isDeepStrictEqual(row.cleanupBinding, command)) fail();
    matchCleanup(row, context, command);
    if (row.cleanupProof) {
      if (!isDeepStrictEqual(row.cleanupProof, proof) || row.ciphertext !== null || !row.clearedAt)
        fail();
    } else {
      if (!(await cleanupEligible(tx, context, row, projection))) fail();
      const now = new Date();
      await tx
        .update(sandboxV2BackgroundCredentials)
        .set({
          ciphertext: null,
          clearedAt: now,
          cleanupProof: proof,
          cleanupRevision: row.cleanupRevision + 1,
          updatedAt: now,
        })
        .where(scope(context));
    }
    await updateCleanupDemand(tx, machine, projection, context, row.cleanupOperationId, true);
  });
}
