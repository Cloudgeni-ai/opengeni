import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type SlackFileUploadOperation = typeof schema.slackFileUploadOperations.$inferSelect;
export type SlackFileUploadPhase = SlackFileUploadOperation["phase"];
export type SlackFileUploadScope = { accountId: string; workspaceId: string; sessionId: string };
export type ClaimSlackFileUploadInput = SlackFileUploadScope & {
  interactionId: string;
  connectionId: string;
  fileId: string;
  subjectId: string;
  operationId: string;
  requestDigest: string;
  claimHolderId: string;
  leaseMs: number;
};
export type ClaimSlackFileUploadResult = {
  status: "claimed" | "busy" | "conflict" | "completed";
  operation: SlackFileUploadOperation;
};
type ClaimScope = SlackFileUploadScope & { operationId: string; claimHolderId: string };

/** This ledger is a durability fence, not authority to read files or call Slack. */
export class SlackFileUploadRefusedError extends Error {
  override readonly name = "SlackFileUploadRefusedError";
}

const MAX_LEASE_MS = 120_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateScope(input: ClaimScope): void {
  for (const key of [
    "accountId",
    "workspaceId",
    "sessionId",
    "operationId",
    "claimHolderId",
  ] as const) {
    if (!uuid.test(input[key])) throw new TypeError(`Slack file upload ${key} must be a UUID`);
  }
}

function validateLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    throw new RangeError(
      `Slack file upload leaseMs must be an integer between 1 and ${MAX_LEASE_MS}`,
    );
  }
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function validateClaim(input: ClaimSlackFileUploadInput): void {
  validateScope(input);
  validateLease(input.leaseMs);
  for (const key of ["interactionId", "connectionId", "fileId"] as const) {
    if (!uuid.test(input[key])) throw new TypeError(`Slack file upload ${key} must be a UUID`);
  }
  if (!boundedText(input.subjectId, 1024))
    throw new TypeError("Slack file upload subjectId is invalid");
  if (!/^[a-f0-9]{64}$/.test(input.requestDigest))
    throw new TypeError("Slack file upload requestDigest must be a SHA-256 digest");
}

function operationScope(input: SlackFileUploadScope & { operationId: string }) {
  const table = schema.slackFileUploadOperations;
  return and(
    eq(table.accountId, input.accountId),
    eq(table.workspaceId, input.workspaceId),
    eq(table.sessionId, input.sessionId),
    eq(table.operationId, input.operationId),
  );
}

function liveClaim(input: ClaimScope) {
  const table = schema.slackFileUploadOperations;
  return and(
    operationScope(input),
    eq(table.claimHolderId, input.claimHolderId),
    sql`${table.claimExpiresAt} > clock_timestamp()`,
    ne(table.phase, "completed"),
  );
}

async function lockOperation(tx: Database, input: ClaimScope): Promise<void> {
  // Lock BEFORE evaluating wall-clock expiry. A conditional UPDATE alone can
  // wait on a lock-only transaction after its time predicate was evaluated.
  await tx
    .select({ id: schema.slackFileUploadOperations.id })
    .from(schema.slackFileUploadOperations)
    .where(operationScope(input))
    .for("update")
    .limit(1);
}

function sameBinding(
  operation: SlackFileUploadOperation,
  input: ClaimSlackFileUploadInput,
): boolean {
  return (
    (
      [
        "accountId",
        "workspaceId",
        "sessionId",
        "interactionId",
        "connectionId",
        "fileId",
        "operationId",
      ] as const
    ).every((key) => operation[key] === input[key].toLowerCase()) &&
    operation.subjectId === input.subjectId &&
    operation.requestDigest === input.requestDigest
  );
}

async function validateSource(tx: Database, input: ClaimSlackFileUploadInput): Promise<void> {
  // Ordinary caller RLS applies to BOTH the exact session and the interaction.
  // Do not look up the connection in this workspace: installation HOME may differ.
  const [interaction] = await tx
    .select({ id: schema.slackInteractions.id })
    .from(schema.slackInteractions)
    .innerJoin(
      schema.sessions,
      and(
        eq(schema.sessions.accountId, schema.slackInteractions.accountId),
        eq(schema.sessions.workspaceId, schema.slackInteractions.workspaceId),
        eq(schema.sessions.id, schema.slackInteractions.sessionId),
      ),
    )
    .where(
      and(
        eq(schema.slackInteractions.accountId, input.accountId),
        eq(schema.slackInteractions.workspaceId, input.workspaceId),
        eq(schema.slackInteractions.id, input.interactionId),
        eq(schema.slackInteractions.sessionId, input.sessionId),
        eq(schema.slackInteractions.connectionId, input.connectionId),
        sql`(
          ${schema.slackInteractions.visibility} <> 'private'
          or nullif(current_setting('opengeni.subject_id', true), '') is null
          or ${schema.slackInteractions.owningSubjectId} = nullif(current_setting('opengeni.subject_id', true), '')
          or ${schema.slackInteractions.owningSubjectId} = nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        )`,
      ),
    )
    .for("share")
    .limit(1);
  if (!interaction)
    throw new SlackFileUploadRefusedError("Slack file upload interaction unavailable");
  const [file] = await tx
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.accountId, input.accountId),
        eq(schema.files.workspaceId, input.workspaceId),
        eq(schema.files.id, input.fileId),
        eq(schema.files.status, "ready"),
      ),
    )
    .for("share")
    .limit(1);
  if (!file) throw new SlackFileUploadRefusedError("Slack file upload source file unavailable");
}

/**
 * One workspace-wide operation id binds all intent, including requester and file.
 * Only an expired/released claim can be taken over. An uncertain completion is
 * never reset to upload: the caller must reconcile that exact Slack file share.
 * No provider request or automatic transaction retry occurs in this repository.
 */
export async function claimSlackFileUpload(
  db: Database,
  input: ClaimSlackFileUploadInput,
): Promise<ClaimSlackFileUploadResult> {
  validateClaim(input);
  return await withRlsContext(db, input, async (tx) => {
    const table = schema.slackFileUploadOperations;
    const find = () =>
      tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.accountId, input.accountId),
            eq(table.workspaceId, input.workspaceId),
            eq(table.operationId, input.operationId),
          ),
        )
        .for("update")
        .limit(1);
    let [operation] = await find();
    if (operation && !sameBinding(operation, input)) return { status: "conflict", operation };
    // Replay is not authority: revalidate the live exact source even if completed.
    await validateSource(tx, input);
    if (!operation) {
      const [created] = await tx
        .insert(table)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          interactionId: input.interactionId,
          connectionId: input.connectionId,
          fileId: input.fileId,
          subjectId: input.subjectId,
          operationId: input.operationId,
          requestDigest: input.requestDigest,
          claimHolderId: input.claimHolderId,
          claimExpiresAt: sql`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
        })
        .onConflictDoNothing({ target: [table.workspaceId, table.operationId] })
        .returning();
      if (created) return { status: "claimed", operation: created };
      [operation] = await find();
      if (!operation)
        throw new SlackFileUploadRefusedError("Slack file upload operation unavailable");
      if (!sameBinding(operation, input)) return { status: "conflict", operation };
    }
    if (operation.phase === "completed") return { status: "completed", operation };
    const [reclaimed] = await tx
      .update(table)
      .set({
        phase: operation.phase === "completing" ? "outcome_unknown" : operation.phase,
        claimHolderId: input.claimHolderId,
        claimExpiresAt: sql`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(table.id, operation.id),
          or(isNull(table.claimHolderId), lte(table.claimExpiresAt, sql`clock_timestamp()`)),
        ),
      )
      .returning();
    return reclaimed ? { status: "claimed", operation: reclaimed } : { status: "busy", operation };
  });
}

export async function renewSlackFileUploadClaim(
  db: Database,
  input: ClaimScope & { leaseMs: number },
): Promise<boolean> {
  validateScope(input);
  validateLease(input.leaseMs);
  return await withRlsContext(db, input, async (tx) => {
    const table = schema.slackFileUploadOperations;
    await lockOperation(tx, input);
    const rows = await tx
      .update(table)
      .set({
        claimExpiresAt: sql`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(liveClaim(input))
      .returning({ id: table.id });
    return rows.length === 1;
  });
}

const transitions: Record<SlackFileUploadPhase, readonly SlackFileUploadPhase[]> = {
  pending: ["uploading"],
  uploading: ["uploading", "uploaded"],
  uploaded: ["completing"],
  completing: ["outcome_unknown", "completed"],
  outcome_unknown: ["completed"],
  completed: [],
};

/**
 * Save allocated id BEFORE raw upload; save completing BEFORE provider completion.
 * Only uploading can replace an allocation. uploaded/uncertain/completed recovery
 * must retain the original id. Completion requires provider success or exact
 * share reconciliation at the caller, never absence or lease expiry.
 */
export async function checkpointSlackFileUpload(
  db: Database,
  input: ClaimScope & {
    expectedPhase: SlackFileUploadPhase;
    phase: SlackFileUploadPhase;
    slackFileId?: string;
  },
): Promise<boolean> {
  validateScope(input);
  if (!transitions[input.expectedPhase]?.includes(input.phase)) return false;
  if (input.slackFileId !== undefined && !boundedText(input.slackFileId, 128)) return false;
  if (input.phase === "uploading" && input.slackFileId === undefined) return false;
  return await withRlsContext(db, input, async (tx) => {
    const table = schema.slackFileUploadOperations;
    await lockOperation(tx, input);
    const rows = await tx
      .update(table)
      .set({
        phase: input.phase,
        ...(input.phase === "uploading" ? { slackFileId: input.slackFileId } : {}),
        ...(input.phase === "completed" ? { claimHolderId: null, claimExpiresAt: null } : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          liveClaim(input),
          eq(table.phase, input.expectedPhase),
          input.phase !== "uploading" && input.slackFileId !== undefined
            ? eq(table.slackFileId, input.slackFileId)
            : undefined,
        ),
      )
      .returning({ id: table.id });
    return rows.length === 1;
  }).catch((error: unknown) => {
    // The invoker guard rechecks the clock at the write boundary. If the lease
    // expires between WHERE and that check, rollback still means a failed CAS.
    for (let current = error, depth = 0; current && depth < 5; depth++) {
      const cause = current as { code?: string; message?: string; cause?: unknown };
      if (cause.code === "23514" && cause.message === "Slack file upload claim expired")
        return false;
      current = cause.cause;
    }
    throw error;
  });
}

/** Release only a live holder; completing becomes uncertain, never uploadable. */
export async function releaseSlackFileUploadClaim(db: Database, input: ClaimScope): Promise<void> {
  validateScope(input);
  await withRlsContext(db, input, async (tx) => {
    const table = schema.slackFileUploadOperations;
    await lockOperation(tx, input);
    await tx
      .update(table)
      .set({
        phase: sql`case when ${table.phase} = 'completing' then 'outcome_unknown' else ${table.phase} end`,
        claimHolderId: null,
        claimExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(liveClaim(input));
  });
}
