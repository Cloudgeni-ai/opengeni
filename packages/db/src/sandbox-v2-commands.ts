import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES,
  decodeSandboxJournalPage,
  SandboxJournalCommand,
  SandboxJournalCursor,
  SandboxJournalObservation,
  SandboxMachineRecord,
  type SandboxMachineInstance,
} from "@opengeni/contracts";
import { type Database, type SessionActivityDatabase, withRlsContext } from "./database";
import { lockTurnAttemptWriteFenceTx } from "./session-attempt-write-fence";
import {
  sandboxV2Machines,
  sandboxV2Commands,
  sandboxV2CommandInputs,
  sandboxV2CommandOutput,
  sandboxV2BackgroundCredentials,
} from "./sandbox-v2-schema";
import { sessionBackgroundCommands, sessionPendingToolCalls, sessionTurnAttempts } from "./schema";
import { fromPostgresLosslessJson } from "./lossless-json";
import { sessionAttemptPendingWritersSql } from "./session-attempt-writers";
import {
  settleNativeSessionBackgroundCommandInTransaction,
  type SessionBackgroundCommandTerminalMutation,
} from "./session-background-commands";

/** Trusted worker composition, scoped to ONE accepted causal tool action. Never
 * construct this from a guest handle, provider token or tool-supplied attempt. */
export type SandboxJournalTurnAuthority = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  machineId: string;
  instance: SandboxMachineInstance;
  acceptedActionId: string;
};
/** Internal control worker identity. It permits observation and physical
 * settlement of a retained operation after its agent authority was revoked.
 * It never licenses a new command, input, or an agent output capture. */
export type SandboxJournalControlAuthority = Omit<SandboxJournalTurnAuthority, "acceptedActionId">;
/** Trusted host composition for one retained native job. A public job UUID
 * supplies no authority for another command or any Start/input operation. */
export type SandboxV2BackgroundCommandAuthority = SandboxJournalControlAuthority & {
  jobId: string;
};
export type SandboxJournalControlCandidate = {
  operationId: string;
  /** Original dispatch identity for bound commands. An unbound allocation uses
   * the current matching wrapper only for protected abandonment, never Start.
   * Null means no exact wrapper can be constructed from retained evidence. */
  authority: SandboxJournalControlAuthority | null;
  command: SandboxJournalCommand | null;
};
export type RetainedSandboxJournalCommand = {
  handle: number;
  revision: number;
  command: SandboxJournalCommand;
  stdout: SandboxJournalCursor;
  stderr: SandboxJournalCursor;
};
type CommandRow = typeof sandboxV2Commands.$inferSelect;
type MachineRow = typeof sandboxV2Machines.$inferSelect;
export class SandboxJournalAuthorityError extends Error {
  readonly code = "SANDBOX_V2_COMMAND_AUTHORITY";
}
function fail(message: string): never {
  throw new SandboxJournalAuthorityError(message);
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail("Invalid accepted action digest");
}

/** Advisory internal control inventory. It grants no cancellation, settlement,
 * output or launch rights: each subsequent operation rechecks its exact owner.
 * Restart a scan from the beginning after its final page; concurrently allocated
 * random UUIDs can sort before a cursor. No provider I/O or mutation occurs. */
export async function listPendingSandboxJournalCommands(
  db: Database,
  tenant: { accountId: string; workspaceId: string; machineId: string },
  options: { limit?: number; afterOperationId?: string } = {},
): Promise<{
  items: SandboxJournalControlCandidate[];
  nextOperationId: string | null;
}> {
  tenant = structuredClone(tenant);
  options = { ...options };
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (options.afterOperationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        options.afterOperationId,
      ))
  )
    fail("Invalid bounded command inventory cursor");
  return withRlsContext(db, tenant, async (tx) => {
    const [machine] = await tx
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
    if (!machine) return { items: [], nextOperationId: null };
    const projection = SandboxMachineRecord.parse(machine.projection);
    const rows = await tx
      .select()
      .from(sandboxV2Commands)
      .where(
        and(
          eq(sandboxV2Commands.accountId, tenant.accountId),
          eq(sandboxV2Commands.workspaceId, tenant.workspaceId),
          eq(sandboxV2Commands.machineId, tenant.machineId),
          isNull(sandboxV2Commands.proof),
          eq(sandboxV2Commands.abandoned, false),
          sql`not sandbox_v2_command_has_background_owner(${sandboxV2Commands.operationId})`,
          options.afterOperationId
            ? gt(sandboxV2Commands.operationId, options.afterOperationId)
            : undefined,
        ),
      )
      .orderBy(asc(sandboxV2Commands.operationId))
      .limit(limit);
    const items = rows.map((row): SandboxJournalControlCandidate => {
      const command = row.binding === null ? null : SandboxJournalCommand.parse(row.binding);
      const instance = command
        ? {
            id: row.instanceId,
            bootId: command.bootId,
            diskLineage: command.diskLineage,
          }
        : projection.instance?.id === row.instanceId
          ? projection.instance
          : null;
      return {
        operationId: row.operationId,
        command,
        authority: instance
          ? {
              accountId: row.accountId,
              workspaceId: row.workspaceId,
              sessionId: row.sessionId,
              turnId: row.turnId,
              executionGeneration: row.executionGeneration,
              attemptId: row.attemptId,
              machineId: row.machineId,
              instance: structuredClone(instance),
            }
          : null,
      };
    });
    return {
      items,
      nextOperationId: rows.length === limit ? rows.at(-1)!.operationId : null,
    };
  });
}
function scope(context: SandboxJournalTurnAuthority) {
  return and(
    eq(sandboxV2Commands.accountId, context.accountId),
    eq(sandboxV2Commands.workspaceId, context.workspaceId),
    eq(sandboxV2Commands.sessionId, context.sessionId),
    eq(sandboxV2Commands.attemptId, context.attemptId),
    eq(sandboxV2Commands.turnId, context.turnId),
    eq(sandboxV2Commands.executionGeneration, context.executionGeneration),
    eq(sandboxV2Commands.machineId, context.machineId),
  );
}
function retained(row: CommandRow): RetainedSandboxJournalCommand | null {
  return row.binding
    ? {
        handle: row.handle,
        revision: row.revision,
        command: SandboxJournalCommand.parse(row.binding),
        stdout: SandboxJournalCursor.parse(row.stdout),
        stderr: SandboxJournalCursor.parse(row.stderr),
      }
    : null;
}
async function fenced<T>(
  db: Database,
  authority: SandboxJournalTurnAuthority,
  effect: (
    tx: Database,
    machine: MachineRow,
    projection: SandboxMachineRecord,
    activeAttempt: typeof sessionTurnAttempts.$inferSelect,
  ) => Promise<T>,
): Promise<T> {
  const context = structuredClone(authority);
  if (!context.acceptedActionId || context.acceptedActionId.length > 512)
    fail("Missing accepted causal action");
  return withSandboxV2TurnMachineFence(db, context, effect);
}

/** Trusted database composition for host preparation and command persistence.
 * This exact attempt/incarnation fence grants no provider I/O or new command
 * authority by itself. Every transaction retains the canonical lock order. */
export async function withSandboxV2TurnMachineFence<T>(
  db: Database,
  authority: SandboxJournalControlAuthority,
  effect: (
    tx: Database,
    machine: MachineRow,
    projection: SandboxMachineRecord,
    activeAttempt: typeof sessionTurnAttempts.$inferSelect,
  ) => Promise<T>,
): Promise<T> {
  const context = structuredClone(authority);
  return withRlsContext(db, context, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, context);
    if (!fence.allowed) fail(`Exact turn-attempt authority rejected: ${fence.reason}`);
    if (fence.session.accountId !== context.accountId) fail("Command account changed");
    const [machine] = await tx
      .select()
      .from(sandboxV2Machines)
      .where(
        and(
          eq(sandboxV2Machines.accountId, context.accountId),
          eq(sandboxV2Machines.workspaceId, context.workspaceId),
          eq(sandboxV2Machines.sandboxGroupId, fence.session.sandboxGroupId),
          eq(sandboxV2Machines.id, context.machineId),
        ),
      )
      .for("update")
      .limit(1);
    if (!machine) fail("No admitted machine for this exact session group");
    const projection = SandboxMachineRecord.parse(machine.projection);
    if (
      !isDeepStrictEqual(projection.instance, context.instance) ||
      projection.target === "destroyed"
    )
      fail("Machine incarnation changed");
    return effect(tx, machine, projection, fence.attempt);
  });
}
async function commandRow(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  operationId: string,
): Promise<CommandRow> {
  const [row] = await tx
    .select()
    .from(sandboxV2Commands)
    .where(and(scope(context), eq(sandboxV2Commands.operationId, operationId)))
    .for("update")
    .limit(1);
  if (!row) fail("No exact command owner");
  return row;
}
async function assertBackgroundIntentActive(tx: Database, row: CommandRow) {
  const [job] = await tx
    .select({ state: sessionBackgroundCommands.state })
    .from(sessionBackgroundCommands)
    .where(
      and(
        eq(sessionBackgroundCommands.accountId, row.accountId),
        eq(sessionBackgroundCommands.workspaceId, row.workspaceId),
        eq(sessionBackgroundCommands.sessionId, row.sessionId),
        eq(sessionBackgroundCommands.nativeOperationId, row.operationId),
      ),
    )
    .limit(1);
  if (!job) return;
  if (job.state !== "running") fail("Native background command is stopping or settled");
  const [expired] = await tx
    .select({ id: sandboxV2BackgroundCredentials.jobId })
    .from(sandboxV2BackgroundCredentials)
    .where(
      and(
        eq(sandboxV2BackgroundCredentials.accountId, row.accountId),
        eq(sandboxV2BackgroundCredentials.workspaceId, row.workspaceId),
        eq(sandboxV2BackgroundCredentials.sessionId, row.sessionId),
        eq(sandboxV2BackgroundCredentials.jobId, row.operationId),
        sql`${sandboxV2BackgroundCredentials.expiresAt} <= clock_timestamp()`,
      ),
    )
    .limit(1);
  if (expired) fail("Native background original credentials expired");
}
function match(row: CommandRow, command: SandboxJournalCommand): void {
  if (!isDeepStrictEqual(row.binding, SandboxJournalCommand.parse(command)))
    fail("Retained command binding changed");
}
async function assertGenericCommandControl(tx: Database, row: CommandRow): Promise<void> {
  const [owner] = await tx.execute<{ independent: boolean }>(sql`
    select sandbox_v2_command_has_background_owner(${row.operationId}::uuid) as independent`);
  if (!owner || owner.independent !== false)
    fail("Original background job requires its independent control owner");
}
async function setMachine(tx: Database, row: MachineRow, next: SandboxMachineRecord) {
  if (next.version !== row.version + 1) fail("Invalid machine demand revision");
  await tx
    .update(sandboxV2Machines)
    .set({ version: next.version, projection: next, updatedAt: new Date() })
    .where(and(eq(sandboxV2Machines.id, row.id), eq(sandboxV2Machines.version, row.version)));
}

export async function allocateSandboxJournalOperation(
  db: Database,
  context: SandboxJournalTurnAuthority,
  requestDigest: string,
): Promise<string> {
  return await allocateSandboxJournalOperationWithOwner(db, context, requestDigest);
}

/** Inspect only this original causal action under the same live turn/machine
 * fence as allocation. Absence permits pre-dispatch input preparation; it is
 * not execution authority. Abandoned actions stay immutable tombstones. */
export async function findSandboxJournalOperationId(
  db: Database,
  authority: SandboxJournalTurnAuthority,
  requestDigest: string,
): Promise<string | null> {
  const context = structuredClone(authority);
  digest(requestDigest);
  return fenced(db, context, async (tx) => {
    const prior = await originalOperation(tx, context, requestDigest);
    return prior?.operationId ?? null;
  });
}

async function originalOperation(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  requestDigest: string,
): Promise<CommandRow | null> {
  const [prior] = await tx
    .select()
    .from(sandboxV2Commands)
    .where(
      and(
        eq(sandboxV2Commands.accountId, context.accountId),
        eq(sandboxV2Commands.workspaceId, context.workspaceId),
        eq(sandboxV2Commands.sessionId, context.sessionId),
        eq(sandboxV2Commands.turnId, context.turnId),
        eq(sandboxV2Commands.acceptedActionId, context.acceptedActionId),
      ),
    )
    .limit(1);
  if (!prior) return null;
  if (prior.requestDigest !== requestDigest) fail("Causal command replay changed its request");
  if (
    prior.attemptId !== context.attemptId ||
    prior.executionGeneration !== context.executionGeneration
  )
    fail("Retained causal command requires protected attempt adoption");
  if (prior.abandoned) fail("Causal command action was abandoned before dispatch");
  return prior;
}

/** Reserve a session background intent before any native binding or Start.
 * The job row, original command allocation and machine demand commit together.
 * This reservation alone does not transfer writer/credential authority or
 * permit work after the originating attempt ends. Those gates remain intact. */
export async function allocateSandboxV2BackgroundOperation(
  db: Database,
  authority: SandboxJournalTurnAuthority,
  input: { requestDigest: string; commandText: string },
): Promise<string> {
  input = { ...input };
  digest(input.requestDigest);
  if (
    typeof input.commandText !== "string" ||
    input.commandText.includes("\0") ||
    new TextEncoder().encode(input.commandText).length > 262144
  )
    fail("Invalid bounded native background command");
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        owner: "session-background",
        requestDigest: input.requestDigest,
      }),
    )
    .digest("hex");
  return await allocateSandboxJournalOperationWithOwner(
    db,
    authority,
    requestDigest,
    input.commandText,
  );
}

async function retainBackgroundIntent(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  operationId: string,
  commandText: string,
) {
  const where = and(
    eq(sessionBackgroundCommands.accountId, context.accountId),
    eq(sessionBackgroundCommands.workspaceId, context.workspaceId),
    eq(sessionBackgroundCommands.sessionId, context.sessionId),
    eq(sessionBackgroundCommands.nativeOperationId, operationId),
  );
  const [prior] = await tx.select().from(sessionBackgroundCommands).where(where).limit(1);
  const row =
    prior ??
    (
      await tx
        .insert(sessionBackgroundCommands)
        .values({
          id: operationId,
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          provider: "managed",
          nativeOperationId: operationId,
          commandText,
          commandPreview: commandText.slice(0, 512),
          launchTurnId: context.turnId,
          launchAttemptId: context.attemptId,
          launchExecutionGeneration: context.executionGeneration,
        })
        .onConflictDoNothing()
        .returning()
    )[0];
  if (
    !row ||
    row.id !== operationId ||
    row.provider !== "managed" ||
    row.retainedProcessId !== null ||
    row.launchTurnId !== context.turnId ||
    row.launchAttemptId !== context.attemptId ||
    row.launchExecutionGeneration !== context.executionGeneration ||
    row.commandText !== commandText
  )
    fail("Native background launch intent changed");
}

async function allocateSandboxJournalOperationWithOwner(
  db: Database,
  context: SandboxJournalTurnAuthority,
  requestDigest: string,
  backgroundCommand?: string,
): Promise<string> {
  context = structuredClone(context);
  digest(requestDigest);
  return fenced(db, context, async (tx, machine, projection) => {
    const prior = await originalOperation(tx, context, requestDigest);
    if (prior) {
      if (backgroundCommand !== undefined)
        await retainBackgroundIntent(tx, context, prior.operationId, backgroundCommand);
      return prior.operationId;
    }
    if (
      projection.state !== "running" ||
      (projection.transition &&
        !(projection.transition.kind === "suspend" && projection.transition.phase === "reserved"))
    )
      fail("Machine is not ready for a fresh command");
    const operationId = randomUUID();
    await tx.insert(sandboxV2Commands).values({
      operationId,
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attemptId: context.attemptId,
      executionGeneration: context.executionGeneration,
      machineId: context.machineId,
      instanceId: context.instance.id,
      acceptedActionId: context.acceptedActionId,
      requestDigest,
      stdout: { offset: 0, remainder: "" },
      stderr: { offset: 0, remainder: "" },
    });
    await setMachine(tx, machine, {
      ...projection,
      version: projection.version + 1,
      target: "running",
      idleSince: null,
      transition: projection.transition?.phase === "reserved" ? null : projection.transition,
      demands: [
        ...projection.demands,
        {
          id: operationId,
          kind: "command",
          owner: context.sessionId,
          authority: context.attemptId,
        },
      ],
    });
    if (backgroundCommand !== undefined)
      await retainBackgroundIntent(tx, context, operationId, backgroundCommand);
    return operationId;
  });
}
export async function reserveSandboxJournalCommand(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: SandboxJournalCommand,
): Promise<SandboxJournalCommand> {
  context = structuredClone(context);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  return fenced(db, context, async (tx, _machine, projection) => {
    const row = await commandRow(tx, context, command.operationId);
    if (row.abandoned) fail("Abandoned command cannot acquire dispatch authority");
    if (row.binding) {
      match(row, command);
      fail("Retained dispatch requires observation rather than a fresh Start");
    }
    await assertBackgroundIntentActive(tx, row);
    if (
      row.acceptedActionId !== context.acceptedActionId ||
      command.machineId !== context.machineId ||
      row.instanceId !== context.instance.id ||
      command.bootId !== context.instance.bootId ||
      command.diskLineage !== context.instance.diskLineage ||
      projection.state !== "running" ||
      projection.transition !== null
    )
      fail("Fresh journal dispatch no longer owns this machine");
    await tx
      .update(sandboxV2Commands)
      .set({
        binding: command,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(sandboxV2Commands.operationId, row.operationId));
    return command;
  });
}
export async function loadSandboxJournalCommand(
  db: Database,
  context: SandboxJournalTurnAuthority,
  locator: { handle: number } | { operationId: string },
): Promise<RetainedSandboxJournalCommand | null> {
  context = structuredClone(context);
  locator = structuredClone(locator);
  return fenced(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(sandboxV2Commands)
      .where(
        and(
          scope(context),
          "handle" in locator
            ? eq(sandboxV2Commands.handle, locator.handle)
            : eq(sandboxV2Commands.operationId, locator.operationId),
        ),
      )
      .limit(1);
    return row ? retained(row) : null;
  });
}
export async function assertSandboxJournalCommand(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: SandboxJournalCommand,
  action: "start" | "read" | "input" | "cancel",
): Promise<void> {
  context = structuredClone(context);
  const command = SandboxJournalCommand.parse(input);
  await fenced(db, context, async (tx) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    if (action === "start" || action === "input") await assertBackgroundIntentActive(tx, row);
    if (action === "read" || action === "cancel") await assertGenericCommandControl(tx, row);
    if (
      action === "start" &&
      (row.acceptedActionId !== context.acceptedActionId || row.proof !== null)
    )
      fail("This action cannot launch a retained terminal operation");
    if (
      (action === "start" || action === "input") &&
      (row.instanceId !== context.instance.id ||
        command.bootId !== context.instance.bootId ||
        command.diskLineage !== context.instance.diskLineage)
    )
      fail("Replacement incarnation has no launch/input authority");
  });
}

/** Captures from an unfinished accepted tool action survive observer death.
 * A new action gets only its own bytes; cursor advancement cannot erase the
 * earlier action's unacknowledged result. This is not a completed tool receipt. */
export async function loadSandboxJournalCapturedOutput(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: SandboxJournalCommand,
  options?: { maxStreamBytes: number },
): Promise<{
  stdout: string;
  stderr: string;
  observation: SandboxJournalObservation | null;
  omittedOutputBytes?: number;
}> {
  context = structuredClone(context);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  const maxStreamBytes = options?.maxStreamBytes;
  if (
    maxStreamBytes !== undefined &&
    (!Number.isSafeInteger(maxStreamBytes) ||
      maxStreamBytes < 1 ||
      maxStreamBytes > SANDBOX_V2_MAX_CAPTURE_RESPONSE_BYTES)
  )
    fail("Invalid bounded output window");
  return fenced(db, context, async (tx) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    const selection = {
      revision: sandboxV2CommandOutput.revision,
      acceptedActionId: sandboxV2CommandOutput.acceptedActionId,
      stdout: sandboxV2CommandOutput.stdout,
      stderr: sandboxV2CommandOutput.stderr,
      observation: sandboxV2CommandOutput.observation,
    };
    let stdout = "",
      stderr = "",
      observation: SandboxJournalObservation | null = null;
    let outCursor = { offset: 0, remainder: "" },
      errCursor = { offset: 0, remainder: "" };
    let revision = 0;
    let omittedOutputBytes = 0;
    const append = (previous: string, added: string): string => {
      const text = previous + added;
      if (maxStreamBytes === undefined) return text;
      const bytes = Buffer.from(text);
      if (bytes.length <= maxStreamBytes) return text;
      let start = bytes.length - maxStreamBytes;
      // Start at a whole UTF-8 character. The full decoded text and original
      // byte pages remain in immutable captures; only this response is bounded.
      while ((bytes[start]! & 0xc0) === 0x80) start++;
      omittedOutputBytes += start;
      return bytes.subarray(start).toString("utf8");
    };
    for (;;) {
      // Page protected history inside the same command/attempt transaction so
      // large output does not load all raw pages into worker memory at once.
      const captures = await tx
        .select(selection)
        .from(sandboxV2CommandOutput)
        .where(
          and(
            eq(sandboxV2CommandOutput.operationId, row.operationId),
            gt(sandboxV2CommandOutput.revision, revision),
          ),
        )
        .orderBy(asc(sandboxV2CommandOutput.revision))
        .limit(8);
      if (captures.length === 0) break;
      for (const capture of captures) {
        const page = observationFor(row, capture.observation);
        const proof = terminalProof(page);
        if (
          !Number.isSafeInteger(capture.revision) ||
          capture.revision <= revision ||
          capture.revision > row.revision ||
          page.stdout.offset !== outCursor.offset ||
          page.stderr.offset !== errCursor.offset ||
          (proof && !isDeepStrictEqual(proof, row.proof))
        )
          fail("Captured history has no matching committed cursor or terminal proof");
        const out = decodeSandboxJournalPage(
          outCursor.remainder,
          [Buffer.from(page.stdout.data, "base64")],
          page.stdout.eof,
        );
        const err = decodeSandboxJournalPage(
          errCursor.remainder,
          [Buffer.from(page.stderr.data, "base64")],
          page.stderr.eof,
        );
        if (
          Buffer.from(out.text).toString("base64") !== capture.stdout ||
          Buffer.from(err.text).toString("base64") !== capture.stderr
        )
          fail("Captured history text differs from its exact journal bytes");
        outCursor = { offset: page.stdout.nextOffset, remainder: out.remainder };
        errCursor = { offset: page.stderr.nextOffset, remainder: err.remainder };
        revision = capture.revision;
        if (capture.acceptedActionId === context.acceptedActionId) {
          stdout = append(stdout, out.text);
          stderr = append(stderr, err.text);
          observation = page;
        }
      }
    }
    if (!isDeepStrictEqual(outCursor, row.stdout) || !isDeepStrictEqual(errCursor, row.stderr))
      fail("Captured history does not reconstruct the committed byte cursors");
    return { stdout, stderr, observation, ...(omittedOutputBytes ? { omittedOutputBytes } : {}) };
  });
}

/** Full tool replies use the existing accepted-call ledger. A settled predecessor
 * may supply its completed reply to the same logical turn under unchanged session
 * authority. This grants no command, input or unfinished-call adoption rights. */
export async function loadSandboxJournalToolReply(
  db: Database,
  context: SandboxJournalTurnAuthority,
): Promise<string | null> {
  context = structuredClone(context);
  return fenced(db, context, async (tx, _machine, _projection, activeAttempt) => {
    const [row] = await tx
      .select()
      .from(sessionPendingToolCalls)
      .where(
        and(
          eq(sessionPendingToolCalls.accountId, context.accountId),
          eq(sessionPendingToolCalls.workspaceId, context.workspaceId),
          eq(sessionPendingToolCalls.sessionId, context.sessionId),
          eq(sessionPendingToolCalls.turnId, context.turnId),
          eq(sessionPendingToolCalls.callId, context.acceptedActionId),
        ),
      )
      .limit(1);
    if (
      row &&
      (row.attemptId !== context.attemptId ||
        row.executionGeneration !== context.executionGeneration)
    ) {
      if (row.resultItem === null)
        fail("Accepted tool receipt requires protected attempt adoption");
      const [origin] = await tx
        .select({
          state: sessionTurnAttempts.state,
          closedAt: sessionTurnAttempts.closedAt,
          quiescedAt: sessionTurnAttempts.quiescedAt,
          authorityEpoch: sessionTurnAttempts.authorityEpoch,
          authorityVisibility: sessionTurnAttempts.authorityVisibility,
          authorityOwnerOrganizationMembershipId:
            sessionTurnAttempts.authorityOwnerOrganizationMembershipId,
          pendingWriters: sessionAttemptPendingWritersSql(sql`${sessionTurnAttempts}`),
        })
        .from(sessionTurnAttempts)
        .where(
          and(
            eq(sessionTurnAttempts.id, row.attemptId),
            eq(sessionTurnAttempts.accountId, context.accountId),
            eq(sessionTurnAttempts.workspaceId, context.workspaceId),
            eq(sessionTurnAttempts.sessionId, context.sessionId),
            eq(sessionTurnAttempts.turnId, context.turnId),
            eq(sessionTurnAttempts.executionGeneration, row.executionGeneration),
          ),
        )
        .limit(1);
      // The enclosing fence holds the session/turn locks: an origin cannot be
      // changed or adopted by its canonical lifecycle while this read commits.
      // A closed timestamp alone is never physical-writer settlement evidence.
      if (
        !origin ||
        origin.state !== "closed" ||
        origin.closedAt === null ||
        origin.quiescedAt === null ||
        origin.pendingWriters !== false ||
        row.executionGeneration >= context.executionGeneration ||
        origin.authorityEpoch !== activeAttempt.authorityEpoch ||
        origin.authorityVisibility !== activeAttempt.authorityVisibility ||
        origin.authorityOwnerOrganizationMembershipId !==
          activeAttempt.authorityOwnerOrganizationMembershipId
      )
        fail("Retained tool reply has no settled predecessor authority");
    }
    if (!row?.resultItem) return null;
    const result = fromPostgresLosslessJson(row.resultItem, row.resultItemCodecVersion);
    if (
      result.type !== "function_call_result" ||
      result.callId !== context.acceptedActionId ||
      typeof result.output !== "string"
    )
      fail("Invalid retained sandbox tool reply");
    return result.output;
  });
}

export async function reserveSandboxJournalInput(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: {
    command: SandboxJournalCommand;
    requestDigest: string;
    partIndex: number;
    partCount: number;
    actionDigest: string;
  },
): Promise<number> {
  context = structuredClone(context);
  input = structuredClone(input);
  digest(input.requestDigest);
  digest(input.actionDigest);
  if (
    !Number.isSafeInteger(input.partIndex) ||
    !Number.isSafeInteger(input.partCount) ||
    input.partIndex < 0 ||
    input.partCount < 1 ||
    input.partCount > 4096 ||
    input.partIndex >= input.partCount
  )
    fail("Invalid accepted input part identity");
  const command = SandboxJournalCommand.parse(input.command);
  return fenced(db, context, async (tx) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    await assertBackgroundIntentActive(tx, row);
    if (
      row.instanceId !== context.instance.id ||
      command.bootId !== context.instance.bootId ||
      command.diskLineage !== context.instance.diskLineage ||
      !command.stdin
    )
      fail("No live exact input authority");
    const parts = await tx
      .select()
      .from(sandboxV2CommandInputs)
      .where(
        and(
          eq(sandboxV2CommandInputs.operationId, row.operationId),
          eq(sandboxV2CommandInputs.acceptedActionId, context.acceptedActionId),
        ),
      );
    if (
      parts.some(
        (part) => part.requestDigest !== input.requestDigest || part.partCount !== input.partCount,
      )
    )
      fail("Causal input replay changed its whole request");
    const prior = parts.find((part) => part.partIndex === input.partIndex);
    if (prior) {
      if (prior.actionDigest !== input.actionDigest) fail("Causal input replay changed its part");
      if (row.proof !== null && (row.proof.receipt?.acceptedInputSequence ?? -1) < prior.sequence)
        fail("Terminal evidence cannot prove this input was accepted");
      return prior.sequence;
    }
    if (row.proof !== null) fail("A terminal operation cannot admit new input");
    if (input.partIndex > 0 && !parts.some((part) => part.partIndex === input.partIndex - 1))
      fail("Input parts must be admitted in order");
    // Reserve the entire action's contiguous range at part zero. A concurrent
    // accepted action cannot interleave its bytes between this action's chunks.
    const first = parts.find((part) => part.partIndex === 0);
    if (
      input.partIndex > 0 &&
      (!first || parts.some((part) => part.sequence !== first.sequence + part.partIndex))
    )
      fail("Accepted input range is not contiguous");
    if (input.partIndex === 0 && row.nextInputSequence > Number.MAX_SAFE_INTEGER - input.partCount)
      fail("Input sequence exhausted");
    const sequence =
      input.partIndex === 0 ? row.nextInputSequence : first!.sequence + input.partIndex;
    await tx.insert(sandboxV2CommandInputs).values({
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      operationId: row.operationId,
      acceptedActionId: context.acceptedActionId,
      requestDigest: input.requestDigest,
      partIndex: input.partIndex,
      partCount: input.partCount,
      actionDigest: input.actionDigest,
      sequence,
    });
    await tx
      .update(sandboxV2Commands)
      .set({
        nextInputSequence:
          input.partIndex === 0 ? row.nextInputSequence + input.partCount : row.nextInputSequence,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(sandboxV2Commands.operationId, row.operationId));
    return sequence;
  });
}

function observationFor(
  row: CommandRow,
  input: SandboxJournalObservation,
): SandboxJournalObservation {
  const page = SandboxJournalObservation.parse(input);
  const command = SandboxJournalCommand.parse(row.binding);
  if (
    page.operationId !== row.operationId ||
    (page.specificationDigest !== null &&
      page.specificationDigest !== command.specificationDigest) ||
    (page.receipt &&
      ((page.receipt.acceptedInputSequence !== undefined) !== command.stdin ||
        (page.receipt.incompleteInputSequence !== undefined && !command.pty)))
  )
    fail("Observation does not bind this exact operation");
  return page;
}
function terminalProof(page: SandboxJournalObservation): SandboxJournalObservation | null {
  if (page.state !== "exited" && page.state !== "cancelled") return null;
  return {
    ...page,
    stdout: { offset: 0, nextOffset: 0, data: "", eof: true },
    stderr: { offset: 0, nextOffset: 0, data: "", eof: true },
  };
}
async function commitProof(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  row: CommandRow,
  machine: MachineRow,
  projection: SandboxMachineRecord,
  page: SandboxJournalObservation,
) {
  const proof = terminalProof(page);
  if (!proof) fail("No physical terminal evidence");
  const command = SandboxJournalCommand.parse(row.binding);
  if (
    page.state === "cancelled" &&
    (row.instanceId !== context.instance.id ||
      command.bootId !== context.instance.bootId ||
      command.diskLineage !== context.instance.diskLineage)
  )
    fail("Replacement disk cannot prove never-started cancellation");
  if (row.proof && !isDeepStrictEqual(row.proof, proof))
    fail("Immutable terminal evidence conflicts");
  await releaseCommandDemand(tx, context, row, machine, projection);
  return proof;
}
async function releaseCommandDemand(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  row: CommandRow,
  machine: MachineRow,
  projection: SandboxMachineRecord,
) {
  const demands = projection.demands.filter(
    (demand) =>
      !(
        demand.id === row.operationId &&
        demand.kind === "command" &&
        demand.owner === context.sessionId &&
        demand.authority === context.attemptId
      ),
  );
  if (demands.length !== projection.demands.length)
    await setMachine(tx, machine, {
      ...projection,
      version: projection.version + 1,
      demands,
      idleSince: demands.length ? null : Date.now(),
    });
}
async function abandonUnbound(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  row: CommandRow,
  machine: MachineRow,
  projection: SandboxMachineRecord,
): Promise<boolean> {
  if (row.binding !== null) return false;
  await releaseCommandDemand(tx, context, row, machine, projection);
  if (!row.abandoned)
    await tx
      .update(sandboxV2Commands)
      .set({
        abandoned: true,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(sandboxV2Commands.operationId, row.operationId));
  return true;
}
/** A never-bound allocation crossed no provider boundary. Retain a tombstone
 * instead of a dispatchable hole after environment/validation failure. */
export async function abandonSandboxJournalOperation(
  db: Database,
  context: SandboxJournalTurnAuthority,
  operationId: string,
): Promise<boolean> {
  context = structuredClone(context);
  return fenced(db, context, async (tx, machine, projection) => {
    const row = await commandRow(tx, context, operationId);
    if (row.acceptedActionId !== context.acceptedActionId)
      fail("Cannot abandon another accepted action");
    return abandonUnbound(tx, context, row, machine, projection);
  });
}
export type SandboxJournalCaptureInput = {
  expected: RetainedSandboxJournalCommand;
  next: RetainedSandboxJournalCommand;
  observation: SandboxJournalObservation;
  stdout: string;
  stderr: string;
};

export async function captureSandboxJournalOutput(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: SandboxJournalCaptureInput,
): Promise<boolean> {
  context = structuredClone(context);
  input = structuredClone(input);
  return fenced(db, context, async (tx, machine, projection) => {
    const row = await commandRow(tx, context, input.expected.command.operationId);
    await assertGenericCommandControl(tx, row);
    return persistSandboxJournalCapture(tx, context, row, machine, projection, input);
  });
}

async function persistSandboxJournalCapture(
  tx: Database,
  context: SandboxJournalTurnAuthority,
  row: CommandRow,
  machine: MachineRow,
  projection: SandboxMachineRecord,
  input: SandboxJournalCaptureInput,
) {
  match(row, input.expected.command);
  if (!isDeepStrictEqual(retained(row), input.expected)) return false;
  const page = observationFor(row, input.observation);
  const stdout = SandboxJournalCursor.parse(input.next.stdout),
    stderr = SandboxJournalCursor.parse(input.next.stderr);
  const decodedOut = decodeSandboxJournalPage(
    row.stdout.remainder,
    [Buffer.from(page.stdout.data, "base64")],
    page.stdout.eof,
  );
  const decodedErr = decodeSandboxJournalPage(
    row.stderr.remainder,
    [Buffer.from(page.stderr.data, "base64")],
    page.stderr.eof,
  );
  if (
    input.stdout !== decodedOut.text ||
    input.stderr !== decodedErr.text ||
    stdout.remainder !== decodedOut.remainder ||
    stderr.remainder !== decodedErr.remainder
  )
    fail("Captured text or UTF-8 remainder does not match the exact journal bytes");
  if (
    input.next.handle !== row.handle ||
    input.next.revision !== row.revision + 1 ||
    !isDeepStrictEqual(input.next.command, row.binding) ||
    page.stdout.offset !== row.stdout.offset ||
    page.stderr.offset !== row.stderr.offset ||
    stdout.offset !== page.stdout.nextOffset ||
    stderr.offset !== page.stderr.nextOffset
  )
    fail("Capture changed command or byte cursor");
  if (row.proof && !terminalProof(page)) return false;
  const proof = terminalProof(page)
    ? await commitProof(tx, context, row, machine, projection, page)
    : row.proof;
  // Base64 decoded text also preserves NUL; PostgreSQL text/JSON cannot hold it.
  await tx.insert(sandboxV2CommandOutput).values({
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    operationId: row.operationId,
    acceptedActionId: context.acceptedActionId,
    revision: input.next.revision,
    observation: page,
    stdout: Buffer.from(input.stdout).toString("base64"),
    stderr: Buffer.from(input.stderr).toString("base64"),
  });
  await tx
    .update(sandboxV2Commands)
    .set({
      revision: input.next.revision,
      stdout,
      stderr,
      proof,
      updatedAt: new Date(),
    })
    .where(eq(sandboxV2Commands.operationId, row.operationId));
  return true;
}
export async function recordSandboxJournalControlProof(
  db: Database,
  context: SandboxJournalTurnAuthority,
  input: SandboxJournalCommand,
  observation: SandboxJournalObservation,
): Promise<void> {
  context = structuredClone(context);
  const command = SandboxJournalCommand.parse(structuredClone(input));
  const sampled = SandboxJournalObservation.parse(structuredClone(observation));
  await fenced(db, context, async (tx, machine, projection) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    await assertGenericCommandControl(tx, row);
    const page = observationFor(row, sampled);
    const proof = await commitProof(tx, context, row, machine, projection, page);
    await tx
      .update(sandboxV2Commands)
      .set({ proof, revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(sandboxV2Commands.operationId, row.operationId));
  });
}

async function controlFenced<T>(
  db: Database,
  authority: SandboxJournalControlAuthority,
  action: "read" | "cancel" | "settle" | "owner",
  effect: (
    tx: Database,
    context: SandboxJournalTurnAuthority,
    machine: MachineRow,
    projection: SandboxMachineRecord,
    ownerLive: boolean,
    attempt: typeof sessionTurnAttempts.$inferSelect,
  ) => Promise<T>,
): Promise<T> {
  const context = {
    ...structuredClone(authority),
    acceptedActionId: "control-reconciliation",
  };
  return withRlsContext(db, context, async (tx) => {
    // Use the identical lock prefix as Pause, deletion and agent capture. A
    // revoked fence denies execution, while its locked owner rows still permit
    // the control worker to record a real exit. Revocation itself is not exit.
    const fence = await lockTurnAttemptWriteFenceTx(tx, context);
    const { workspace, session, turn, attempt } = fence;
    if (
      !workspace ||
      !session ||
      !turn ||
      !attempt ||
      workspace.accountId !== context.accountId ||
      session.accountId !== context.accountId ||
      turn.accountId !== context.accountId ||
      turn.sessionId !== context.sessionId ||
      attempt.accountId !== context.accountId ||
      attempt.sessionId !== context.sessionId ||
      attempt.turnId !== context.turnId ||
      attempt.executionGeneration !== context.executionGeneration
    )
      fail("No exact retained control owner");
    if (action === "cancel" && fence.allowed)
      fail("Control cancellation requires revoked agent authority");
    const [machine] = await tx
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
    if (!machine) fail("No exact retained control machine");
    const projection = SandboxMachineRecord.parse(machine.projection);
    if (!isDeepStrictEqual(projection.instance, context.instance))
      fail("Control machine incarnation changed");
    return effect(tx, context, machine, projection, fence.allowed, attempt);
  });
}

/** Internal locked owner composition for narrow maintenance. It does not grant
 * an agent new command/input authority. A maintenance adapter must enforce its
 * retained purpose, closed owner, shared writer gate and exact native proof. */
export const withSandboxV2CommandControlFence = controlFenced;

/** Advisory control decision under the canonical owner locks. Missing or
 * mismatched retained authority throws; it is never treated as revocation.
 * Provider Read/Cancel and terminal commits still recheck their own authority
 * after this transaction closes. */
export async function readSandboxJournalControlOwner(
  db: Database,
  authority: SandboxJournalControlAuthority,
): Promise<"live" | "revoked"> {
  return controlFenced(db, authority, "owner", async (_tx, _context, _machine, _projection, live) =>
    live ? "live" : "revoked",
  );
}

/** Exact-attempt finalizer inventory. The final pending bit uses the shared
 * durable writer predicate, independent of the bounded command page. An empty
 * page, caller cancellation or a timestamp never establishes quiescence.
 * Every later Read/Cancel/settlement still rechecks its own control authority. */
export async function readSandboxJournalAttemptWriters(
  db: Database,
  authority: SandboxJournalControlAuthority,
  options: { limit?: number; afterOperationId?: string } = {},
): Promise<{
  owner: "live" | "revoked";
  pending: boolean;
  commands: { operationId: string; command: SandboxJournalCommand | null }[];
  nextOperationId: string | null;
}> {
  options = { ...options };
  const limit = options.limit ?? 25;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    (options.afterOperationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        options.afterOperationId,
      ))
  )
    fail("Invalid bounded attempt-writer inventory cursor");
  return controlFenced(db, authority, "owner", async (tx, context, _machine, _projection, live) => {
    const [writers] = await tx.execute<{ pending: boolean }>(sql`
      select ${sessionAttemptPendingWritersSql(sql`attempt`)} as pending
      from ${sessionTurnAttempts} attempt where attempt.id=${context.attemptId}::uuid`);
    if (!writers || typeof writers.pending !== "boolean")
      fail("Attempt writer inventory unavailable");
    const rows = await tx
      .select({
        operationId: sandboxV2Commands.operationId,
        binding: sandboxV2Commands.binding,
      })
      .from(sandboxV2Commands)
      .where(
        and(
          eq(sandboxV2Commands.accountId, context.accountId),
          eq(sandboxV2Commands.workspaceId, context.workspaceId),
          eq(sandboxV2Commands.sessionId, context.sessionId),
          eq(sandboxV2Commands.turnId, context.turnId),
          eq(sandboxV2Commands.attemptId, context.attemptId),
          eq(sandboxV2Commands.executionGeneration, context.executionGeneration),
          eq(sandboxV2Commands.machineId, context.machineId),
          eq(sandboxV2Commands.instanceId, context.instance.id),
          isNull(sandboxV2Commands.proof),
          eq(sandboxV2Commands.abandoned, false),
          sql`not sandbox_v2_command_has_background_owner(${sandboxV2Commands.operationId})`,
          options.afterOperationId
            ? gt(sandboxV2Commands.operationId, options.afterOperationId)
            : undefined,
        ),
      )
      .orderBy(asc(sandboxV2Commands.operationId))
      .limit(limit);
    return {
      owner: live ? "live" : "revoked",
      pending: writers.pending,
      commands: rows.map((row) => ({
        operationId: row.operationId,
        command: row.binding === null ? null : SandboxJournalCommand.parse(row.binding),
      })),
      nextOperationId: rows.length === limit ? rows.at(-1)!.operationId : null,
    };
  });
}

export async function assertSandboxJournalControl(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxJournalCommand,
  action: "read" | "cancel",
): Promise<void> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  await controlFenced(db, authority, action, async (tx, context) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    await assertGenericCommandControl(tx, row);
  });
}

/** Coordinator recovery of an unbound allocation after durable revocation.
 * Binding admission uses the same lock prefix, so a late dispatcher loses its
 * authority before this tombstone can release demand. */
export async function abandonUnboundSandboxJournalControl(
  db: Database,
  authority: SandboxJournalControlAuthority,
  operationId: string,
): Promise<boolean> {
  return controlFenced(db, authority, "cancel", async (tx, context, machine, projection) =>
    abandonUnbound(tx, context, await commandRow(tx, context, operationId), machine, projection),
  );
}

export async function settleSandboxJournalControl(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxJournalCommand,
  observation: SandboxJournalObservation,
): Promise<void> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  const sampled = SandboxJournalObservation.parse(structuredClone(observation));
  await controlFenced(db, authority, "settle", async (tx, context, machine, projection) => {
    const row = await commandRow(tx, context, command.operationId);
    match(row, command);
    await assertGenericCommandControl(tx, row);
    const proof = await commitProof(
      tx,
      context,
      row,
      machine,
      projection,
      observationFor(row, sampled),
    );
    if (isDeepStrictEqual(row.proof, proof)) return;
    await tx
      .update(sandboxV2Commands)
      .set({ proof, revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(sandboxV2Commands.operationId, row.operationId));
  });
}

async function backgroundControlFenced<T>(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  action: "read" | "cancel",
  effect: (
    tx: Database,
    context: SandboxJournalTurnAuthority,
    machine: MachineRow,
    projection: SandboxMachineRecord,
    row: CommandRow,
    job: typeof sessionBackgroundCommands.$inferSelect,
  ) => Promise<T>,
) {
  const context = structuredClone(authority);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(context.jobId) ||
    (action !== "read" && action !== "cancel")
  )
    fail("Invalid exact background control purpose");
  return controlFenced(db, context, "owner", async (tx, original, machine, projection) => {
    const [job] = await tx
      .select()
      .from(sessionBackgroundCommands)
      .where(
        and(
          eq(sessionBackgroundCommands.accountId, context.accountId),
          eq(sessionBackgroundCommands.workspaceId, context.workspaceId),
          eq(sessionBackgroundCommands.sessionId, context.sessionId),
          eq(sessionBackgroundCommands.id, context.jobId),
        ),
      )
      .limit(1);
    if (
      !job ||
      job.provider !== "managed" ||
      job.nativeOperationId !== context.jobId ||
      job.launchTurnId !== context.turnId ||
      job.launchAttemptId !== context.attemptId ||
      job.launchExecutionGeneration !== context.executionGeneration ||
      (action === "cancel" && (job.state !== "stopping" || job.cancelRequestedAt === null))
    )
      fail("No exact native background control owner");
    const row = await commandRow(tx, original, context.jobId);
    if (
      row.instanceId !== context.instance.id ||
      (row.binding !== null &&
        (row.binding.bootId !== context.instance.bootId ||
          row.binding.diskLineage !== context.instance.diskLineage))
    )
      fail("Background control incarnation changed");
    // Captures keep the original causal identity. This is an observer/control
    // purpose, never a fresh model invocation or authority to execute its body.
    return effect(
      tx,
      { ...original, acceptedActionId: row.acceptedActionId },
      machine,
      projection,
      row,
      job,
    );
  });
}

/** Original metadata for one job. Resource/output access must additionally be
 * authorized by the installed current job owner before physical observation.
 * Only registered original custody changes its routing and writer ownership. */
export async function loadSandboxV2BackgroundCommandForControl(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
) {
  return backgroundControlFenced(
    db,
    authority,
    "read",
    async (tx, _context, _machine, _projection, row, job) => {
      const [ownership] = await tx.execute<{ independent: boolean }>(sql`
        select sandbox_v2_command_has_background_owner(${row.operationId}::uuid) as independent`);
      if (!ownership) fail("Original background ownership unavailable");
      const [last] = await tx
        .select({ observation: sandboxV2CommandOutput.observation })
        .from(sandboxV2CommandOutput)
        .where(eq(sandboxV2CommandOutput.operationId, row.operationId))
        .orderBy(desc(sandboxV2CommandOutput.revision))
        .limit(1);
      return {
        operationId: row.operationId,
        independent: ownership.independent,
        command: retained(row),
        abandoned: row.abandoned,
        state: job.state,
        cancelRequestedAt: job.cancelRequestedAt,
        outputComplete:
          !!row.proof &&
          !!last &&
          ["exited", "cancelled"].includes(last.observation.state) &&
          last.observation.stdout.eof &&
          last.observation.stderr.eof,
      };
    },
  );
}

/** Fixed static-material deadline. It requests only this original-custody job's
 * cancellation; it grants no renewal, replacement material or exit proof. */
export async function requestSandboxV2BackgroundExpiredCredentialCancellation(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
): Promise<boolean> {
  return backgroundControlFenced(
    db,
    authority,
    "read",
    async (tx, context, _machine, _projection, row, job) => {
      if (job.state !== "running") return job.state === "stopping";
      const [expired] = await tx
        .select({ id: sandboxV2BackgroundCredentials.jobId })
        .from(sandboxV2BackgroundCredentials)
        .where(
          and(
            eq(sandboxV2BackgroundCredentials.accountId, context.accountId),
            eq(sandboxV2BackgroundCredentials.workspaceId, context.workspaceId),
            eq(sandboxV2BackgroundCredentials.sessionId, context.sessionId),
            eq(sandboxV2BackgroundCredentials.jobId, row.operationId),
            isNull(sandboxV2BackgroundCredentials.clearedAt),
            sql`${sandboxV2BackgroundCredentials.expiresAt} <= clock_timestamp()`,
          ),
        )
        .limit(1);
      if (!expired) return false;
      const changed = await tx
        .update(sessionBackgroundCommands)
        .set({
          state: "stopping",
          cancelRequestedAt: sql`clock_timestamp()`,
          cancelRequestedBy: "native_static_credential_expired",
          reconcileAfter: sql`clock_timestamp()`,
          reconcileClaimId: null,
          reconcileClaimedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(sessionBackgroundCommands.id, row.operationId),
            eq(sessionBackgroundCommands.state, "running"),
          ),
        )
        .returning({ id: sessionBackgroundCommands.id });
      return changed.length === 1;
    },
  );
}

export async function assertSandboxV2BackgroundCommandControl(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  input: SandboxJournalCommand,
  action: "read" | "cancel",
): Promise<void> {
  const command = SandboxJournalCommand.parse(structuredClone(input));
  await backgroundControlFenced(
    db,
    authority,
    action,
    async (_tx, _context, _machine, _projection, row) => {
      match(row, command);
    },
  );
}

/** Exact prelaunch cancellation, including while the origin is still live.
 * Only this job's durable cancellation intent licenses abandonment; another
 * stopping job cannot grant control over any foreground or sibling command. */
export async function abandonUnboundSandboxV2BackgroundCommand(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
): Promise<boolean> {
  return backgroundControlFenced(db, authority, "cancel", (tx, context, machine, projection, row) =>
    abandonUnbound(tx, context, row, machine, projection),
  );
}

/** Retain exact observed bytes under the original job/cursor after a turn ends.
 * This grants no input, renewal or dispatch. Only prelaunch registered custody
 * changes writer ownership. Unknown/lost observations cannot become proof. */
export async function captureSandboxV2BackgroundCommandOutput(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  supplied: SandboxJournalCaptureInput,
  afterCapture?: (tx: Database, output: { stdout: string; stderr: string }) => Promise<void>,
): Promise<boolean> {
  const input = structuredClone(supplied);
  return backgroundControlFenced(
    db,
    authority,
    "read",
    async (tx, context, machine, projection, row) => {
      const captured = await persistSandboxJournalCapture(
        tx,
        context,
        row,
        machine,
        projection,
        input,
      );
      if (captured && afterCapture)
        await afterCapture(tx, { stdout: input.stdout, stderr: input.stderr });
      return captured;
    },
  );
}

/** Exact completed native output, or protected never-bound abandonment, may
 * settle this job. Unknown/lost journal observations and partial terminal pages
 * cannot produce a finished event or typed completion input. */
export async function settleSandboxV2BackgroundCommandWithMutation(
  db: Database,
  authority: SandboxV2BackgroundCommandAuthority,
  mutation: SessionBackgroundCommandTerminalMutation,
) {
  return backgroundControlFenced(
    db,
    authority,
    "read",
    async (tx, context, _machine, _projection, row) => {
      const abandoned = row.abandoned && row.binding === null;
      if (!abandoned) {
        const [last] = await tx
          .select({ observation: sandboxV2CommandOutput.observation })
          .from(sandboxV2CommandOutput)
          .where(eq(sandboxV2CommandOutput.operationId, row.operationId))
          .orderBy(desc(sandboxV2CommandOutput.revision))
          .limit(1);
        if (
          !row.proof ||
          !last ||
          !["exited", "cancelled"].includes(last.observation.state) ||
          !last.observation.stdout.eof ||
          !last.observation.stderr.eof
        )
          return null;
      }
      return settleNativeSessionBackgroundCommandInTransaction(
        tx as unknown as SessionActivityDatabase,
        {
          ...context,
          commandId: row.operationId,
          outcome: abandoned ? "lost" : "exited",
          exitCode: row.proof?.state === "exited" ? row.proof.receipt!.leaderExitCode : null,
          reason: abandoned
            ? "native_never_dispatched"
            : row.proof?.state === "cancelled"
              ? "native_cancelled"
              : "native_exited",
        },
        mutation,
      );
    },
  );
}
