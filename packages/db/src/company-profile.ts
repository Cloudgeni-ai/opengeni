import { createHash, randomUUID } from "node:crypto";
import {
  CompanyProfileContent,
  CompanyProfileLearningWrite,
  CompanyProfileSnapshot,
  ResolvedCompanyProfileSnapshot,
  type CompanyProfileActivationEvent,
  type CompanyProfileActivationType,
  type CompanyProfileContent as CompanyProfileContentType,
  type CompanyProfileDiffResponse,
  type CompanyProfileHead,
  type CompanyProfileLearningSubjectKind,
  type CompanyProfileListResponse,
  type CompanyProfileMutationResponse,
  type CompanyProfileProvenanceSource,
  type CompanyProfileRevision,
  type CompanyProfileRevisionIntent,
  type CompanyProfileSnapshotEntry,
} from "@opengeni/contracts";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext, withWorkspaceRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import * as schema from "./schema";

type RevisionRow = typeof schema.companyProfileRevisions.$inferSelect;
type HeadRow = typeof schema.companyProfileHeads.$inferSelect;
type EventRow = typeof schema.companyProfileActivationEvents.$inferSelect;

export type CompanyProfileAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export class CompanyProfileConflictError extends Error {
  readonly name = "CompanyProfileConflictError";
  readonly code = "COMPANY_PROFILE_CONFLICT";

  constructor(readonly currentHead: CompanyProfileHead | null) {
    super("The active company profile changed in another request");
  }
}

export class CompanyProfileOperationReuseError extends Error {
  readonly name = "CompanyProfileOperationReuseError";
  readonly code = "COMPANY_PROFILE_OPERATION_REUSED";

  constructor() {
    super("The company-profile operation id was already used for another request");
  }
}

export class CompanyProfileNotFoundError extends Error {
  readonly name = "CompanyProfileNotFoundError";

  constructor(message = "Company-profile revision was not found") {
    super(message);
  }
}

export class CompanyProfileInvalidOperationError extends Error {
  readonly name = "CompanyProfileInvalidOperationError";
}

export class CompanyProfileSnapshotAuthorityError extends Error {
  readonly name = "CompanyProfileSnapshotAuthorityError";
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalProfile(profile: CompanyProfileContentType): CompanyProfileContentType {
  const parsed = CompanyProfileContent.parse(profile);
  return {
    identity: parsed.identity,
    mission: parsed.mission,
    products: parsed.products.map(({ key, content }) => ({ key, content })),
    customers: parsed.customers.map(({ key, content }) => ({ key, content })),
    goals: parsed.goals.map(({ key, content }) => ({ key, content })),
    constraints: parsed.constraints.map(({ key, content }) => ({ key, content })),
  };
}

function canonicalProfileJson(profile: CompanyProfileContentType): string {
  return JSON.stringify(canonicalProfile(profile));
}

function operationFingerprint(operation: string, fields: unknown): string {
  return sha256(JSON.stringify(["company_profile_operation", 1, operation, fields]));
}

function revisionFromRow(row: RevisionRow): CompanyProfileRevision {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    revision: row.revision,
    intent: row.intent as CompanyProfileRevisionIntent,
    profile: CompanyProfileContent.parse(JSON.parse(row.contentJson)),
    contentHash: row.contentHash,
    provenance: {
      source: row.provenanceSource as CompanyProfileProvenanceSource,
      sourceId: row.provenanceSourceId,
    },
    supersedesRevisionId: row.supersedesRevisionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  };
}

function headFromRow(row: HeadRow): CompanyProfileHead {
  return {
    accountId: row.accountId,
    revisionId: row.revisionId,
    revision: row.revision,
    contentHash: row.contentHash,
    activationVersion: row.activationVersion,
    activatedAt: iso(row.activatedAt),
  };
}

function eventFromRow(row: EventRow): CompanyProfileActivationEvent {
  return {
    id: row.id,
    operationId: row.operationId,
    accountId: row.accountId,
    type: row.type as CompanyProfileActivationType,
    activationVersion: row.activationVersion,
    oldRevision:
      row.oldRevisionId === null
        ? null
        : {
            id: row.oldRevisionId,
            revision: row.oldRevision!,
            contentHash: row.oldContentHash!,
          },
    newRevision:
      row.newRevisionId === null
        ? null
        : {
            id: row.newRevisionId,
            revision: row.newRevision!,
            contentHash: row.newContentHash!,
          },
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

async function lockAccount(db: Database, accountId: string): Promise<void> {
  const [account] = await db
    .select({ id: schema.managedAccounts.id })
    .from(schema.managedAccounts)
    .where(eq(schema.managedAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account) throw new CompanyProfileNotFoundError("Organization account was not found");
}

async function getHeadInTransaction(db: Database, accountId: string): Promise<HeadRow | null> {
  const [head] = await db
    .select()
    .from(schema.companyProfileHeads)
    .where(eq(schema.companyProfileHeads.accountId, accountId))
    .for("update")
    .limit(1);
  return head ?? null;
}

async function getRevisionInTransaction(
  db: Database,
  accountId: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const [revision] = await db
    .select()
    .from(schema.companyProfileRevisions)
    .where(
      and(
        eq(schema.companyProfileRevisions.accountId, accountId),
        eq(schema.companyProfileRevisions.id, revisionId),
      ),
    )
    .limit(1);
  return revision ?? null;
}

async function getRevisionByOperation(
  db: Database,
  accountId: string,
  operationId: string,
): Promise<RevisionRow | null> {
  const [revision] = await db
    .select()
    .from(schema.companyProfileRevisions)
    .where(
      and(
        eq(schema.companyProfileRevisions.accountId, accountId),
        eq(schema.companyProfileRevisions.operationId, operationId),
      ),
    )
    .limit(1);
  return revision ?? null;
}

async function getEventByOperation(
  db: Database,
  accountId: string,
  operationId: string,
): Promise<EventRow | null> {
  const [event] = await db
    .select()
    .from(schema.companyProfileActivationEvents)
    .where(
      and(
        eq(schema.companyProfileActivationEvents.accountId, accountId),
        eq(schema.companyProfileActivationEvents.operationId, operationId),
      ),
    )
    .limit(1);
  return event ?? null;
}

async function createRevisionInTransaction(
  db: Database,
  input: {
    operationId: string;
    requestFingerprint: string;
    accountId: string;
    intent: CompanyProfileRevisionIntent;
    profile: CompanyProfileContentType;
    provenanceSource: CompanyProfileProvenanceSource;
    provenanceSourceId: string | null;
    supersedesRevisionId: string | null;
    createdBySubjectId: string;
  },
): Promise<RevisionRow> {
  const contentJson = canonicalProfileJson(input.profile);
  const existing = await getRevisionByOperation(db, input.accountId, input.operationId);
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new CompanyProfileOperationReuseError();
    }
    return existing;
  }
  if (input.supersedesRevisionId !== null) {
    const prior = await getRevisionInTransaction(db, input.accountId, input.supersedesRevisionId);
    if (!prior) {
      throw new CompanyProfileInvalidOperationError(
        "A superseded company-profile revision must exist in the same organization",
      );
    }
  }
  const [created] = await db
    .insert(schema.companyProfileRevisions)
    .values({
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
      accountId: input.accountId,
      intent: input.intent,
      contentJson,
      contentHash: sha256(contentJson),
      provenanceSource: input.provenanceSource,
      provenanceSourceId: input.provenanceSourceId,
      supersedesRevisionId: input.supersedesRevisionId,
      createdBySubjectId: input.createdBySubjectId,
    })
    .returning();
  if (!created) throw new Error("Company-profile revision was not recorded");
  return created;
}

async function activateRevisionInTransaction(
  db: Database,
  input: {
    operationId: string;
    requestFingerprint: string;
    accountId: string;
    target: RevisionRow | null;
    current: HeadRow | null;
    actorSubjectId: string;
    reason: string;
    type: CompanyProfileActivationType;
  },
): Promise<{ head: HeadRow | null; event: EventRow }> {
  const existing = await getEventByOperation(db, input.accountId, input.operationId);
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new CompanyProfileOperationReuseError();
    }
    const replayHead = existing.newRevisionId
      ? ({
          accountId: existing.accountId,
          revisionId: existing.newRevisionId,
          revision: existing.newRevision!,
          contentHash: existing.newContentHash!,
          activationVersion: existing.activationVersion,
          activatedAt: existing.createdAt,
        } satisfies HeadRow)
      : null;
    return { head: replayHead, event: existing };
  }
  const activationVersion = (input.current?.activationVersion ?? 0) + 1;
  const createdAt = new Date();
  const [event] = await db
    .insert(schema.companyProfileActivationEvents)
    .values({
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
      accountId: input.accountId,
      type: input.type,
      activationVersion,
      oldRevisionId: input.current?.revisionId ?? null,
      oldRevision: input.current?.revision ?? null,
      oldContentHash: input.current?.contentHash ?? null,
      newRevisionId: input.target?.id ?? null,
      newRevision: input.target?.revision ?? null,
      newContentHash: input.target?.contentHash ?? null,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
      createdAt,
    })
    .returning();
  if (!event) throw new Error("Company-profile activation event was not recorded");

  if (input.target === null) {
    if (input.current) {
      await db
        .delete(schema.companyProfileHeads)
        .where(eq(schema.companyProfileHeads.accountId, input.accountId));
    }
    return { head: null, event };
  }
  const [head] = input.current
    ? await db
        .update(schema.companyProfileHeads)
        .set({
          revisionId: input.target.id,
          revision: input.target.revision,
          contentHash: input.target.contentHash,
          activationVersion,
          activatedAt: createdAt,
        })
        .where(eq(schema.companyProfileHeads.accountId, input.accountId))
        .returning()
    : await db
        .insert(schema.companyProfileHeads)
        .values({
          accountId: input.accountId,
          revisionId: input.target.id,
          revision: input.target.revision,
          contentHash: input.target.contentHash,
          activationVersion,
          activatedAt: createdAt,
        })
        .returning();
  if (!head) throw new Error("Company-profile active head was not recorded");
  return { head, event };
}

function mutationResponse(
  revision: RevisionRow | null,
  result: { head: HeadRow | null; event: EventRow } | null,
): CompanyProfileMutationResponse {
  return {
    revision: revision ? revisionFromRow(revision) : null,
    head: result?.head ? headFromRow(result.head) : null,
    event: result ? eventFromRow(result.event) : null,
  };
}

export async function updateCompanyProfile(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    profile: CompanyProfileContentType;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
    actorSubjectId: string;
    reason: string;
  },
): Promise<CompanyProfileMutationResponse> {
  const operationId = input.operationId ?? randomUUID();
  const profile = canonicalProfile(input.profile);
  const requestFingerprint = operationFingerprint("admin_update", {
    ...input,
    operationId: undefined,
    profile,
  });
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await lockAccount(scopedDb, input.accountId);
      const existingRevision = await getRevisionByOperation(scopedDb, input.accountId, operationId);
      const existingEvent = await getEventByOperation(scopedDb, input.accountId, operationId);
      if (existingRevision || existingEvent) {
        if (
          !existingRevision ||
          !existingEvent ||
          existingRevision.requestFingerprint !== requestFingerprint ||
          existingEvent.requestFingerprint !== requestFingerprint
        ) {
          throw new CompanyProfileOperationReuseError();
        }
        return mutationResponse(
          existingRevision,
          await activateRevisionInTransaction(scopedDb, {
            operationId,
            requestFingerprint,
            accountId: input.accountId,
            target: existingRevision,
            current: null,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
            type: "activate",
          }),
        );
      }
      const current = await getHeadInTransaction(scopedDb, input.accountId);
      if (
        (current?.revisionId ?? null) !== input.expectedCurrentRevisionId ||
        (current?.activationVersion ?? 0) !== input.expectedActivationVersion
      ) {
        throw new CompanyProfileConflictError(current ? headFromRow(current) : null);
      }
      const revision = await createRevisionInTransaction(scopedDb, {
        operationId,
        requestFingerprint,
        accountId: input.accountId,
        intent: "active",
        profile,
        provenanceSource: "human",
        provenanceSourceId: null,
        supersedesRevisionId: current?.revisionId ?? null,
        createdBySubjectId: input.actorSubjectId,
      });
      const activated = await activateRevisionInTransaction(scopedDb, {
        operationId,
        requestFingerprint,
        accountId: input.accountId,
        target: revision,
        current,
        actorSubjectId: input.actorSubjectId,
        reason: input.reason,
        type: "activate",
      });
      return mutationResponse(revision, activated);
    },
  );
}

async function changeActiveRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    targetRevisionId: string | null;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
    actorSubjectId: string;
    reason: string;
    type: CompanyProfileActivationType;
    requirePreviouslyActive: boolean;
  },
): Promise<CompanyProfileMutationResponse> {
  const operationId = input.operationId ?? randomUUID();
  const requestFingerprint = operationFingerprint(`change_active:${input.type}`, {
    ...input,
    operationId: undefined,
  });
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await lockAccount(scopedDb, input.accountId);
      const revisionOperation = await getRevisionByOperation(
        scopedDb,
        input.accountId,
        operationId,
      );
      if (revisionOperation) throw new CompanyProfileOperationReuseError();
      const existing = await getEventByOperation(scopedDb, input.accountId, operationId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new CompanyProfileOperationReuseError();
        }
        const target = existing.newRevisionId
          ? await getRevisionInTransaction(scopedDb, input.accountId, existing.newRevisionId)
          : null;
        return mutationResponse(
          target,
          await activateRevisionInTransaction(scopedDb, {
            operationId,
            requestFingerprint,
            accountId: input.accountId,
            target,
            current: null,
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
            type: input.type,
          }),
        );
      }
      const current = await getHeadInTransaction(scopedDb, input.accountId);
      if (
        (current?.revisionId ?? null) !== input.expectedCurrentRevisionId ||
        (current?.activationVersion ?? 0) !== input.expectedActivationVersion
      ) {
        throw new CompanyProfileConflictError(current ? headFromRow(current) : null);
      }
      const target = input.targetRevisionId
        ? await getRevisionInTransaction(scopedDb, input.accountId, input.targetRevisionId)
        : null;
      if (input.targetRevisionId && !target) throw new CompanyProfileNotFoundError();
      if ((target?.id ?? null) === (current?.revisionId ?? null)) {
        throw new CompanyProfileInvalidOperationError(
          "The requested company-profile revision is already active",
        );
      }
      if (input.requirePreviouslyActive && target) {
        const [priorActivation] = await scopedDb
          .select({ id: schema.companyProfileActivationEvents.id })
          .from(schema.companyProfileActivationEvents)
          .where(
            and(
              eq(schema.companyProfileActivationEvents.accountId, input.accountId),
              eq(schema.companyProfileActivationEvents.newRevisionId, target.id),
            ),
          )
          .limit(1);
        if (!priorActivation) {
          throw new CompanyProfileInvalidOperationError(
            "Rollback targets must have been active previously",
          );
        }
      }
      const activated = await activateRevisionInTransaction(scopedDb, {
        operationId,
        requestFingerprint,
        accountId: input.accountId,
        target,
        current,
        actorSubjectId: input.actorSubjectId,
        reason: input.reason,
        type: input.type,
      });
      return mutationResponse(target, activated);
    },
  );
}

export async function activateCompanyProfileRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    revisionId: string;
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
    actorSubjectId: string;
    reason: string;
  },
) {
  return await changeActiveRevision(db, {
    ...input,
    targetRevisionId: input.revisionId,
    type: "activate",
    requirePreviouslyActive: false,
  });
}

export async function rollbackCompanyProfileRevision(
  db: Database,
  input: {
    operationId?: string;
    accountId: string;
    workspaceId: string;
    targetRevisionId: string;
    expectedCurrentRevisionId: string;
    expectedActivationVersion: number;
    actorSubjectId: string;
    reason: string;
  },
) {
  return await changeActiveRevision(db, {
    ...input,
    type: "rollback",
    requirePreviouslyActive: true,
  });
}

function profileWithLearningSubject(
  current: CompanyProfileContentType | null,
  subject: { kind: CompanyProfileLearningSubjectKind; content: string; stableKey: string | null },
): CompanyProfileContentType {
  const profile = current ?? {
    identity: null,
    mission: null,
    products: [],
    customers: [],
    goals: [],
    constraints: [],
  };
  if (subject.kind === "company_identity")
    return canonicalProfile({ ...profile, identity: subject.content });
  if (subject.kind === "company_mission")
    return canonicalProfile({ ...profile, mission: subject.content });
  if (!subject.stableKey) {
    throw new CompanyProfileInvalidOperationError(
      "Repeatable company-profile learning subjects require a stable key",
    );
  }
  const field = {
    company_product: "products",
    company_customer: "customers",
    company_goal: "goals",
    company_constraint: "constraints",
  }[subject.kind] as "products" | "customers" | "goals" | "constraints";
  const entries = profile[field].filter((entry) => entry.key !== subject.stableKey);
  entries.push({ key: subject.stableKey, content: subject.content });
  entries.sort((left, right) => left.key.localeCompare(right.key));
  return canonicalProfile({ ...profile, [field]: entries });
}

export type CompanyProfileLearningWriteResult = {
  outcome: "applied" | "proposed";
  revision: CompanyProfileRevision;
  head: CompanyProfileHead | null;
  effectiveBoundary: "next_accepted_attempt";
  rollbackToken: string | null;
};

function rollbackToken(previousRevisionId: string | null, appliedRevisionId: string): string {
  return `company-profile.v1:${previousRevisionId ?? "none"}:${appliedRevisionId}`;
}

export async function writeCompanyProfileLearning(
  db: Database,
  rawInput: CompanyProfileLearningWrite,
): Promise<CompanyProfileLearningWriteResult> {
  const input = CompanyProfileLearningWrite.parse(rawInput);
  const requestFingerprint = operationFingerprint("durable_learning_write", input);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await lockAccount(scopedDb, input.accountId);
      const existingRevision = await getRevisionByOperation(
        scopedDb,
        input.accountId,
        input.operationId,
      );
      const existingEvent = await getEventByOperation(scopedDb, input.accountId, input.operationId);
      if (existingRevision) {
        if (existingRevision.requestFingerprint !== requestFingerprint) {
          throw new CompanyProfileOperationReuseError();
        }
        if (input.authority === "active" && !existingEvent) {
          throw new CompanyProfileOperationReuseError();
        }
        return {
          outcome: input.authority === "active" ? "applied" : "proposed",
          revision: revisionFromRow(existingRevision),
          head:
            existingEvent?.newRevisionId === existingRevision.id
              ? headFromRow({
                  accountId: existingEvent.accountId,
                  revisionId: existingRevision.id,
                  revision: existingRevision.revision,
                  contentHash: existingRevision.contentHash,
                  activationVersion: existingEvent.activationVersion,
                  activatedAt: existingEvent.createdAt,
                })
              : null,
          effectiveBoundary: "next_accepted_attempt",
          rollbackToken:
            input.authority === "active"
              ? rollbackToken(existingEvent?.oldRevisionId ?? null, existingRevision.id)
              : null,
        };
      }
      if (existingEvent) throw new CompanyProfileOperationReuseError();
      const current = await getHeadInTransaction(scopedDb, input.accountId);
      const currentRevision = current
        ? await getRevisionInTransaction(scopedDb, input.accountId, current.revisionId)
        : null;
      if (current && !currentRevision) {
        throw new CompanyProfileInvalidOperationError(
          "The active company-profile revision is missing",
        );
      }
      const profile = profileWithLearningSubject(
        currentRevision ? revisionFromRow(currentRevision).profile : null,
        input.subject,
      );
      const revision = await createRevisionInTransaction(scopedDb, {
        operationId: input.operationId,
        requestFingerprint,
        accountId: input.accountId,
        intent: input.authority,
        profile,
        provenanceSource: "durable_learning",
        provenanceSourceId: input.sourceId,
        supersedesRevisionId: current?.revisionId ?? null,
        createdBySubjectId: input.actorSubjectId,
      });
      if (input.authority === "proposal") {
        return {
          outcome: "proposed",
          revision: revisionFromRow(revision),
          head: null,
          effectiveBoundary: "next_accepted_attempt",
          rollbackToken: null,
        };
      }
      const activated = await activateRevisionInTransaction(scopedDb, {
        operationId: input.operationId,
        requestFingerprint,
        accountId: input.accountId,
        target: revision,
        current,
        actorSubjectId: input.actorSubjectId,
        reason: `Durable learning attempt ${input.operationId}`,
        type: "activate",
      });
      return {
        outcome: "applied",
        revision: revisionFromRow(revision),
        head: activated.head ? headFromRow(activated.head) : null,
        effectiveBoundary: "next_accepted_attempt",
        rollbackToken: rollbackToken(current?.revisionId ?? null, revision.id),
      };
    },
  );
}

export async function rollbackCompanyProfileLearning(
  db: Database,
  input: {
    operationId: string;
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    token: string;
    reason: string;
  },
): Promise<CompanyProfileMutationResponse> {
  const match = /^company-profile\.v1:(none|[0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(input.token);
  if (!match)
    throw new CompanyProfileInvalidOperationError("Invalid company-profile rollback token");
  const priorRevisionId = match[1] === "none" ? null : match[1]!;
  const appliedRevisionId = match[2]!;
  return await changeActiveRevision(db, {
    operationId: input.operationId,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    targetRevisionId: priorRevisionId,
    expectedCurrentRevisionId: appliedRevisionId,
    expectedActivationVersion: await currentActivationVersion(db, input),
    actorSubjectId: input.actorSubjectId,
    reason: input.reason,
    type: "rollback",
    requirePreviouslyActive: priorRevisionId !== null,
  });
}

async function currentActivationVersion(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<number> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [head] = await scopedDb
      .select({ activationVersion: schema.companyProfileHeads.activationVersion })
      .from(schema.companyProfileHeads)
      .where(eq(schema.companyProfileHeads.accountId, input.accountId))
      .limit(1);
    if (!head) throw new CompanyProfileConflictError(null);
    return head.activationVersion;
  });
}

export async function listCompanyProfile(
  db: Database,
  input: { accountId: string; workspaceId: string; afterRevision?: number; limit: number },
): Promise<CompanyProfileListResponse> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [headRows, revisions, events] = await Promise.all([
      scopedDb
        .select()
        .from(schema.companyProfileHeads)
        .where(eq(schema.companyProfileHeads.accountId, input.accountId))
        .limit(1),
      scopedDb
        .select()
        .from(schema.companyProfileRevisions)
        .where(
          and(
            eq(schema.companyProfileRevisions.accountId, input.accountId),
            input.afterRevision
              ? lt(schema.companyProfileRevisions.revision, input.afterRevision)
              : undefined,
          ),
        )
        .orderBy(desc(schema.companyProfileRevisions.revision))
        .limit(input.limit + 1),
      scopedDb
        .select()
        .from(schema.companyProfileActivationEvents)
        .where(eq(schema.companyProfileActivationEvents.accountId, input.accountId))
        .orderBy(desc(schema.companyProfileActivationEvents.activationVersion))
        .limit(100),
    ]);
    const page = revisions.slice(0, input.limit);
    return {
      current: headRows[0] ? headFromRow(headRows[0]) : null,
      revisions: page.map(revisionFromRow),
      activationEvents: events.map(eventFromRow),
      nextAfterRevision: revisions.length > input.limit ? page.at(-1)!.revision : null,
    };
  });
}

export async function getCompanyProfileRevision(
  db: Database,
  input: { accountId: string; workspaceId: string; revisionId: string },
): Promise<CompanyProfileRevision> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const revision = await getRevisionInTransaction(scopedDb, input.accountId, input.revisionId);
    if (!revision) throw new CompanyProfileNotFoundError();
    return revisionFromRow(revision);
  });
}

function unifiedJsonDiff(from: CompanyProfileRevision, to: CompanyProfileRevision): string {
  const before = JSON.stringify(from.profile, null, 2).split("\n");
  const after = JSON.stringify(to.profile, null, 2).split("\n");
  return [
    `--- company-profile-r${from.revision}`,
    `+++ company-profile-r${to.revision}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export async function diffCompanyProfileRevisions(
  db: Database,
  input: { accountId: string; workspaceId: string; fromRevisionId: string; toRevisionId: string },
): Promise<CompanyProfileDiffResponse> {
  const [from, to] = await Promise.all([
    getCompanyProfileRevision(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      revisionId: input.fromRevisionId,
    }),
    getCompanyProfileRevision(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      revisionId: input.toRevisionId,
    }),
  ]);
  return { from, to, format: "unified_json", diff: unifiedJsonDiff(from, to) };
}

export async function getOrCreateCompanyProfileSnapshot(
  db: Database,
  claims: CompanyProfileAttemptClaims,
) {
  try {
    return await withWorkspaceRls(db, claims.workspaceId, async (scopedDb) => {
      const rows = (await scopedDb.execute(sql`
        SELECT
          snapshot.id,
          snapshot.account_id AS "accountId",
          snapshot.workspace_id AS "workspaceId",
          snapshot.session_id AS "sessionId",
          snapshot.turn_id AS "turnId",
          snapshot.attempt_id AS "attemptId",
          snapshot.execution_generation AS "executionGeneration",
          snapshot.profile,
          snapshot.snapshot_hash AS "snapshotHash",
          snapshot.created_at AS "createdAt"
        FROM company_profile_get_or_create_snapshot(
          ${claims.accountId}::uuid,
          ${claims.workspaceId}::uuid,
          ${claims.sessionId}::uuid,
          ${claims.turnId}::uuid,
          ${claims.attemptId}::uuid,
          ${claims.executionGeneration}
        ) snapshot
      `)) as unknown as Array<{
        id: string;
        accountId: string;
        workspaceId: string;
        sessionId: string;
        turnId: string;
        attemptId: string;
        executionGeneration: number;
        profile: unknown;
        snapshotHash: string;
        createdAt: Date | string;
      }>;
      const row = rows[0];
      if (!row) throw new CompanyProfileSnapshotAuthorityError();
      const snapshot = CompanyProfileSnapshot.parse({ ...row, createdAt: iso(row.createdAt) });
      if (!snapshot.profile) return ResolvedCompanyProfileSnapshot.parse(snapshot);
      const revision = await getRevisionInTransaction(
        scopedDb,
        claims.accountId,
        snapshot.profile.id,
      );
      if (!revision || !snapshotMatchesRevision(snapshot.profile, revision)) {
        throw new CompanyProfileInvalidOperationError(
          "Company-profile snapshot references an inexact immutable revision",
        );
      }
      return ResolvedCompanyProfileSnapshot.parse({
        ...snapshot,
        profile: { ...snapshot.profile, profile: revisionFromRow(revision).profile },
      });
    });
  } catch (error) {
    if (["40001", "42501"].includes(nestedPostgresSqlState(error) ?? "")) {
      throw new CompanyProfileSnapshotAuthorityError(
        "Company-profile snapshot requires the exact current attempt and generation",
      );
    }
    throw error;
  }
}

function snapshotMatchesRevision(
  entry: CompanyProfileSnapshotEntry,
  revision: RevisionRow,
): boolean {
  return (
    entry.id === revision.id &&
    entry.revision === revision.revision &&
    entry.contentHash === revision.contentHash
  );
}
