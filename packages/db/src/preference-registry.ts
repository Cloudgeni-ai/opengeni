import { createHash } from "node:crypto";
import {
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT,
  PREFERENCE_REGISTRY_DESCRIPTOR_MAX_UTF8_BYTES,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  PreferenceRegistryDescriptor,
  PreferenceRegistryDetailResponse,
  PreferenceRegistryEvent,
  PreferenceRegistryFullContent,
  PreferenceRegistryListResponse,
  PreferenceRegistryRecord,
  PreferenceRegistryRevisionSummary,
  PreferenceRegistrySnapshot,
  PreferenceRegistryScopeTarget,
  type CreatePreferenceRegistryProposalRequest,
  type PreferenceRegistryConflictStrategy,
  type PreferenceRegistryProvenanceSource,
  type PreferenceRegistryScope,
  type PreferenceRegistryStatus,
  type PreferenceRegistryTrust,
} from "@opengeni/contracts";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "./index";
import { setSubjectRlsContext, withWorkspaceRls, withWorkspaceSubjectRls } from "./index";
import { nestedPostgresSqlState, safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

type PreferenceRow = typeof schema.preferenceRegistryPreferences.$inferSelect;
type RevisionRow = typeof schema.preferenceRegistryRevisions.$inferSelect;
type EventRow = typeof schema.preferenceRegistryEvents.$inferSelect;

const importedSources = new Set<PreferenceRegistryProvenanceSource>([
  "knowledge_proposal",
  "imported_document",
  "slack",
  "meeting_transcript",
  "call_transcript",
]);

export class PreferenceRegistryNotFoundError extends Error {
  readonly name = "PreferenceRegistryNotFoundError";
}

export class PreferenceRegistryInvalidOperationError extends Error {
  readonly name = "PreferenceRegistryInvalidOperationError";
}

export class PreferenceRegistryConflictError extends Error {
  readonly name = "PreferenceRegistryConflictError";
  readonly code = "PREFERENCE_REGISTRY_CONFLICT";

  constructor(
    message: string,
    readonly currentRevisionId: string | null,
    readonly scopeVersion: number | null,
  ) {
    super(message);
  }
}

export class PreferenceRegistryInitiatorError extends Error {
  readonly name = "PreferenceRegistryInitiatorError";
}

export class PreferenceRegistryStableKeyConflictError extends Error {
  readonly name = "PreferenceRegistryStableKeyConflictError";
  readonly code = "PREFERENCE_REGISTRY_STABLE_KEY_CONFLICT";
}

export type PreferenceRegistryAttemptClaims = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

type PreferenceRegistryAttemptAuthority = PreferenceRegistryAttemptClaims & {
  initiatingHumanSubjectId: string;
};

export type PreferenceRegistryScopeAuthorizer = (scope: PreferenceRegistryScope) => void;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Plain one-line descriptor text; never include full imported source content. */
export function sanitizePreferenceDescriptorText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>{}[\]`]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedDescriptorText(value: string, maxChars: number): string {
  return sanitizePreferenceDescriptorText(value).slice(0, maxChars).trim();
}

function isStableKeyConflict(error: unknown): boolean {
  if (nestedPostgresSqlState(error) !== "23505") return false;
  return (safeDatabaseErrorFacts(error).constraint ?? "").startsWith(
    "preference_registry_preferences_",
  );
}

function targetFor(
  scope: PreferenceRegistryScope,
  workspaceId: string,
  subjectId: string,
): PreferenceRegistryScopeTarget {
  if (scope === "organization") return { scope, workspaceId: null, subjectId: null };
  if (scope === "workspace") return { scope, workspaceId, subjectId: null };
  return { scope, workspaceId: null, subjectId };
}

function targetFromRow(row: PreferenceRow): PreferenceRegistryScopeTarget {
  return {
    scope: row.scope as PreferenceRegistryScope,
    workspaceId: row.scopeWorkspaceId,
    subjectId: row.scopeSubjectId,
  };
}

function trustFor(
  scope: PreferenceRegistryScope,
  source: PreferenceRegistryProvenanceSource,
): PreferenceRegistryTrust {
  if (importedSources.has(source)) return "untrusted_proposal";
  if (scope === "organization") return "organization_managed";
  if (scope === "workspace") return "workspace_managed";
  return "personal";
}

function revisionSummary(row: RevisionRow, scope: PreferenceRegistryScope) {
  return PreferenceRegistryRevisionSummary.parse({
    id: row.id,
    preferenceId: row.preferenceId,
    revision: row.revision,
    contentHash: row.contentHash,
    title: row.title,
    description: row.description,
    precedence: {
      tier: scope,
      rank: row.precedenceRank,
      conflictStrategy: row.conflictStrategy as PreferenceRegistryConflictStrategy,
      conflictsWith: row.conflictsWith,
    },
    provenance: {
      source: row.provenanceSource as PreferenceRegistryProvenanceSource,
      sourceId: row.provenanceSourceId,
      trust: row.trust as PreferenceRegistryTrust,
    },
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    correctsRevisionId: row.correctsRevisionId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
  });
}

function effectiveStatus(
  row: PreferenceRow,
  revision: RevisionRow | null,
  now: Date,
): PreferenceRegistryStatus {
  if (row.status === "active" && revision?.expiresAt && revision.expiresAt <= now) return "expired";
  return row.status as PreferenceRegistryStatus;
}

function recordFromRows(row: PreferenceRow, active: RevisionRow | null, now = new Date()) {
  return PreferenceRegistryRecord.parse({
    id: row.id,
    accountId: row.accountId,
    stableKey: row.stableKey,
    target: targetFromRow(row),
    status: effectiveStatus(row, active, now),
    scopeVersion: row.scopeVersion,
    activationVersion: row.activationVersion,
    activeRevision: active ? revisionSummary(active, row.scope as PreferenceRegistryScope) : null,
    supersededByPreferenceId: row.supersededByPreferenceId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function eventTarget(scope: string | null, workspaceId: string | null, subjectId: string | null) {
  return scope === null
    ? null
    : PreferenceRegistryScopeTarget.parse({ scope, workspaceId, subjectId });
}

function eventFromRow(row: EventRow) {
  return PreferenceRegistryEvent.parse({
    id: row.id,
    accountId: row.accountId,
    preferenceId: row.preferenceId,
    type: row.type,
    version: row.version,
    oldRevisionId: row.oldRevisionId,
    newRevisionId: row.newRevisionId,
    oldTarget: eventTarget(row.oldScope, row.oldWorkspaceId, row.oldSubjectId),
    newTarget: eventTarget(row.newScope, row.newWorkspaceId, row.newSubjectId),
    relatedPreferenceId: row.relatedPreferenceId,
    actorSubjectId: row.actorSubjectId,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  });
}

async function lockPreferenceIds(db: Database, ids: readonly string[]): Promise<string[]> {
  const uniqueIds = [...new Set(ids)].sort();
  const idArray = sql.join(
    uniqueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT preference_id
    FROM preference_registry_lock_heads(ARRAY[${idArray}]::uuid[])
  `)) as unknown as Array<{ preference_id: string }>;
  const lockedIds = rows.map((row) => row.preference_id).sort();
  if (
    lockedIds.length !== uniqueIds.length ||
    lockedIds.some((id, index) => id !== uniqueIds[index])
  ) {
    throw new PreferenceRegistryNotFoundError("Preference was not found");
  }
  return uniqueIds;
}

async function lockedPreference(db: Database, id: string): Promise<PreferenceRow> {
  await lockPreferenceIds(db, [id]);
  const [row] = await db
    .select()
    .from(schema.preferenceRegistryPreferences)
    .where(eq(schema.preferenceRegistryPreferences.id, id))
    .limit(1);
  if (!row) throw new PreferenceRegistryNotFoundError("Preference was not found");
  return row;
}

async function lockedPreferences(db: Database, ids: readonly string[]): Promise<PreferenceRow[]> {
  const uniqueIds = await lockPreferenceIds(db, ids);
  const rows = await db
    .select()
    .from(schema.preferenceRegistryPreferences)
    .where(inArray(schema.preferenceRegistryPreferences.id, uniqueIds))
    .orderBy(asc(schema.preferenceRegistryPreferences.id));
  if (rows.length !== uniqueIds.length) {
    throw new PreferenceRegistryNotFoundError("Preference was not found");
  }
  return rows;
}

async function revisionForPreference(
  db: Database,
  preferenceId: string,
  revisionId: string,
): Promise<RevisionRow> {
  const [row] = await db
    .select()
    .from(schema.preferenceRegistryRevisions)
    .where(
      and(
        eq(schema.preferenceRegistryRevisions.preferenceId, preferenceId),
        eq(schema.preferenceRegistryRevisions.id, revisionId),
      ),
    )
    .limit(1);
  if (!row) throw new PreferenceRegistryNotFoundError("Preference revision was not found");
  return row;
}

function targetColumns(target: PreferenceRegistryScopeTarget) {
  return {
    scope: target.scope,
    scopeWorkspaceId: target.workspaceId,
    scopeSubjectId: target.subjectId,
  };
}

async function withPreferenceRegistryGovernanceRls<T>(
  db: Database,
  input: {
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
  },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  if (input.principalKind !== "human_session") {
    throw new PreferenceRegistryInitiatorError(
      "Preference governance requires an authenticated human session principal",
    );
  }
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const rows = (await scopedDb.execute(sql`
        SELECT set_config('opengeni.principal_kind', ${input.principalKind}, true)
          AS principal_kind
      `)) as unknown as Array<{ principal_kind: string }>;
      if (rows[0]?.principal_kind !== "human_session") {
        throw new PreferenceRegistryInitiatorError(
          "Preference governance principal kind was not applied to the transaction",
        );
      }
      return await fn(scopedDb);
    },
  );
}

function requireExpectedScopeVersion(row: PreferenceRow, expectedScopeVersion: number): void {
  if (row.scopeVersion !== expectedScopeVersion) {
    throw new PreferenceRegistryConflictError(
      "The preference scope changed in another request",
      row.activeRevisionId,
      row.scopeVersion,
    );
  }
}

async function lifecycleEvent(
  db: Database,
  input: {
    operation:
      | "proposal_created"
      | "activate"
      | "correct"
      | "reject"
      | "deactivate"
      | "supersede"
      | "scope";
    preferenceId: string;
    expectedScopeVersion: number;
    expectedRevisionId: string | null;
    revisionId?: string | null;
    newScope?: PreferenceRegistryScope | null;
    relatedPreferenceId?: string | null;
    actorSubjectId: string;
    reason: string;
  },
): Promise<EventRow> {
  const rows = (await db.execute(sql`
    SELECT event_id
    FROM preference_registry_apply_lifecycle(
      ${input.operation},
      ${input.preferenceId}::uuid,
      ${input.expectedScopeVersion},
      ${input.expectedRevisionId}::uuid,
      ${input.revisionId ?? null}::uuid,
      ${input.newScope ?? null},
      ${input.relatedPreferenceId ?? null}::uuid,
      ${input.actorSubjectId},
      ${input.reason}
    )
  `)) as unknown as Array<{ event_id: string }>;
  const eventId = rows[0]?.event_id;
  if (!eventId) throw new Error("Preference lifecycle mutation returned no event");
  const [event] = await db
    .select()
    .from(schema.preferenceRegistryEvents)
    .where(eq(schema.preferenceRegistryEvents.id, eventId))
    .limit(1);
  if (!event) throw new Error("Preference lifecycle event was not visible after mutation");
  return event;
}

async function preferenceAfterMutation(db: Database, preferenceId: string): Promise<PreferenceRow> {
  const [row] = await db
    .select()
    .from(schema.preferenceRegistryPreferences)
    .where(eq(schema.preferenceRegistryPreferences.id, preferenceId))
    .limit(1);
  if (!row) throw new PreferenceRegistryNotFoundError("Preference was not found");
  return row;
}

async function insertRevision(
  db: Database,
  input: {
    accountId: string;
    preferenceId: string;
    scope: PreferenceRegistryScope;
    actorSubjectId: string;
    title: string;
    description: string;
    content: string;
    precedenceRank: number;
    conflictStrategy: PreferenceRegistryConflictStrategy;
    conflictsWith: string[];
    provenanceSource: PreferenceRegistryProvenanceSource;
    provenanceSourceId: string | null;
    expiresAt: string | null;
    correctsRevisionId: string | null;
  },
): Promise<RevisionRow> {
  const title = boundedDescriptorText(input.title, PREFERENCE_REGISTRY_TITLE_MAX_CHARS);
  const description = boundedDescriptorText(
    input.description,
    PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  );
  if (!title || !description) {
    throw new PreferenceRegistryInvalidOperationError(
      "Preference title and description must contain visible plain text",
    );
  }
  const [created] = await db
    .insert(schema.preferenceRegistryRevisions)
    .values({
      accountId: input.accountId,
      preferenceId: input.preferenceId,
      title,
      description,
      content: input.content,
      contentHash: contentHash(input.content),
      precedenceRank: input.precedenceRank,
      conflictStrategy: input.conflictStrategy,
      conflictsWith: [...new Set(input.conflictsWith)].sort(),
      provenanceSource: input.provenanceSource,
      provenanceSourceId: input.provenanceSourceId,
      trust: trustFor(input.scope, input.provenanceSource),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      correctsRevisionId: input.correctsRevisionId,
      createdBySubjectId: input.actorSubjectId,
    })
    .returning();
  if (!created) throw new Error("Preference revision was not created");
  return created;
}

export async function createPreferenceRegistryProposal(
  db: Database,
  input: CreatePreferenceRegistryProposalRequest & {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
  },
) {
  const target = targetFor(input.scope, input.workspaceId, input.actorSubjectId);
  try {
    return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
      const [preference] = await scopedDb
        .insert(schema.preferenceRegistryPreferences)
        .values({
          accountId: input.accountId,
          stableKey: input.stableKey,
          ...targetColumns(target),
          createdBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!preference) throw new Error("Preference proposal was not created");
      const revision = await insertRevision(scopedDb, {
        ...input,
        preferenceId: preference.id,
        correctsRevisionId: null,
      });
      await lifecycleEvent(scopedDb, {
        operation: "proposal_created",
        preferenceId: preference.id,
        expectedScopeVersion: preference.scopeVersion,
        expectedRevisionId: null,
        revisionId: revision.id,
        actorSubjectId: input.actorSubjectId,
        reason: importedSources.has(input.provenanceSource)
          ? "Imported source proposal; inactive pending authorized human review"
          : "Human-created preference proposal; inactive pending activation",
      });
      return recordFromRows(preference, null);
    });
  } catch (error) {
    if (isStableKeyConflict(error)) {
      throw new PreferenceRegistryStableKeyConflictError(
        "A preference with this stable key already exists for the target scope",
      );
    }
    throw error;
  }
}

type PreferenceRegistryListInput = {
  scope?: PreferenceRegistryScope | undefined;
  status?: PreferenceRegistryStatus | undefined;
  limit: number;
};

async function listPreferenceRegistryScoped(db: Database, input: PreferenceRegistryListInput) {
  const now = new Date();
  const conditions: SQL[] = [];
  if (input.scope) conditions.push(eq(schema.preferenceRegistryPreferences.scope, input.scope));
  if (input.status === "active") {
    conditions.push(
      eq(schema.preferenceRegistryPreferences.status, "active"),
      or(
        isNull(schema.preferenceRegistryRevisions.expiresAt),
        gt(schema.preferenceRegistryRevisions.expiresAt, now),
      )!,
    );
  } else if (input.status === "expired") {
    conditions.push(
      eq(schema.preferenceRegistryPreferences.status, "active"),
      lte(schema.preferenceRegistryRevisions.expiresAt, now),
    );
  } else if (input.status) {
    conditions.push(eq(schema.preferenceRegistryPreferences.status, input.status));
  }
  const rows = await db
    .select({
      preference: schema.preferenceRegistryPreferences,
      revision: schema.preferenceRegistryRevisions,
    })
    .from(schema.preferenceRegistryPreferences)
    .leftJoin(
      schema.preferenceRegistryRevisions,
      and(
        eq(
          schema.preferenceRegistryRevisions.id,
          schema.preferenceRegistryPreferences.activeRevisionId,
        ),
        eq(
          schema.preferenceRegistryRevisions.accountId,
          schema.preferenceRegistryPreferences.accountId,
        ),
      ),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      asc(schema.preferenceRegistryPreferences.stableKey),
      asc(schema.preferenceRegistryPreferences.id),
    )
    .limit(input.limit);
  const preferences = rows.map(({ preference, revision }) =>
    recordFromRows(preference, revision, now),
  );
  return PreferenceRegistryListResponse.parse({ preferences });
}

export async function listPreferenceRegistry(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
  } & PreferenceRegistryListInput,
) {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    return await listPreferenceRegistryScoped(scopedDb, input);
  });
}

export async function listPreferenceRegistryForAttempt(
  db: Database,
  input: PreferenceRegistryAttemptClaims & PreferenceRegistryListInput,
) {
  return await withPreferenceRegistryAttemptAuthority(db, input, async (scopedDb) => {
    return await listPreferenceRegistryScoped(scopedDb, input);
  });
}

async function getPreferenceRegistryDetailScoped(db: Database, preferenceId: string) {
  const [preference] = await db
    .select()
    .from(schema.preferenceRegistryPreferences)
    .where(eq(schema.preferenceRegistryPreferences.id, preferenceId))
    .limit(1);
  if (!preference) throw new PreferenceRegistryNotFoundError("Preference was not found");
  const [revisions, events] = await Promise.all([
    db
      .select()
      .from(schema.preferenceRegistryRevisions)
      .where(eq(schema.preferenceRegistryRevisions.preferenceId, preferenceId))
      .orderBy(desc(schema.preferenceRegistryRevisions.revision)),
    db
      .select()
      .from(schema.preferenceRegistryEvents)
      .where(eq(schema.preferenceRegistryEvents.preferenceId, preferenceId))
      .orderBy(desc(schema.preferenceRegistryEvents.version)),
  ]);
  const active = preference.activeRevisionId
    ? (revisions.find((revision) => revision.id === preference.activeRevisionId) ?? null)
    : null;
  return PreferenceRegistryDetailResponse.parse({
    preference: recordFromRows(preference, active),
    revisions: revisions.map((revision) =>
      revisionSummary(revision, preference.scope as PreferenceRegistryScope),
    ),
    events: events.map(eventFromRow),
  });
}

export async function getPreferenceRegistryDetail(
  db: Database,
  input: { workspaceId: string; subjectId: string; preferenceId: string },
) {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    return await getPreferenceRegistryDetailScoped(scopedDb, input.preferenceId);
  });
}

export async function getPreferenceRegistryDetailForAttempt(
  db: Database,
  input: PreferenceRegistryAttemptClaims & { preferenceId: string },
) {
  return await withPreferenceRegistryAttemptAuthority(db, input, async (scopedDb) => {
    return await getPreferenceRegistryDetailScoped(scopedDb, input.preferenceId);
  });
}

export async function activatePreferenceRegistryRevision(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    revisionId: string;
    expectedCurrentRevisionId: string | null;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    reason: string;
    eventType?: "activated" | "corrected";
  },
) {
  return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
    const preference = await lockedPreference(scopedDb, input.preferenceId);
    input.authorizeScope(preference.scope as PreferenceRegistryScope);
    requireExpectedScopeVersion(preference, input.expectedScopeVersion);
    if (preference.activeRevisionId !== input.expectedCurrentRevisionId) {
      throw new PreferenceRegistryConflictError(
        "The active preference revision changed in another request",
        preference.activeRevisionId,
        preference.scopeVersion,
      );
    }
    if (preference.status === "superseded") {
      throw new PreferenceRegistryInvalidOperationError(
        "A superseded preference cannot be activated",
      );
    }
    if (preference.status === "rejected") {
      throw new PreferenceRegistryInvalidOperationError(
        "A rejected preference proposal cannot be activated",
      );
    }
    const revision = await revisionForPreference(scopedDb, preference.id, input.revisionId);
    if (revision.id === preference.activeRevisionId) {
      throw new PreferenceRegistryInvalidOperationError("The requested revision is already active");
    }
    const event = await lifecycleEvent(scopedDb, {
      operation: input.eventType === "corrected" ? "correct" : "activate",
      preferenceId: preference.id,
      expectedScopeVersion: input.expectedScopeVersion,
      expectedRevisionId: input.expectedCurrentRevisionId,
      revisionId: revision.id,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
    });
    const updated = await preferenceAfterMutation(scopedDb, preference.id);
    return {
      preference: recordFromRows(updated, revision),
      event: eventFromRow(event),
    };
  });
}

export async function correctPreferenceRegistry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    expectedCurrentRevisionId: string;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    title: string;
    description: string;
    content: string;
    precedenceRank: number;
    conflictStrategy: PreferenceRegistryConflictStrategy;
    conflictsWith: string[];
    expiresAt: string | null;
    reason: string;
  },
) {
  return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
    const preference = await lockedPreference(scopedDb, input.preferenceId);
    input.authorizeScope(preference.scope as PreferenceRegistryScope);
    requireExpectedScopeVersion(preference, input.expectedScopeVersion);
    if (preference.status === "superseded" || preference.status === "rejected") {
      throw new PreferenceRegistryInvalidOperationError(
        "A rejected or superseded preference cannot be corrected",
      );
    }
    if (preference.activeRevisionId !== input.expectedCurrentRevisionId) {
      throw new PreferenceRegistryConflictError(
        "The active preference revision changed before correction",
        preference.activeRevisionId,
        preference.scopeVersion,
      );
    }
    const oldRevision = await revisionForPreference(
      scopedDb,
      preference.id,
      input.expectedCurrentRevisionId,
    );
    const revision = await insertRevision(scopedDb, {
      ...input,
      scope: preference.scope as PreferenceRegistryScope,
      provenanceSource: "human",
      provenanceSourceId: `correction:${oldRevision.id}`,
      correctsRevisionId: oldRevision.id,
    });
    const event = await lifecycleEvent(scopedDb, {
      operation: "correct",
      preferenceId: preference.id,
      expectedScopeVersion: input.expectedScopeVersion,
      expectedRevisionId: oldRevision.id,
      revisionId: revision.id,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
    });
    const updated = await preferenceAfterMutation(scopedDb, preference.id);
    return { preference: recordFromRows(updated, revision), event: eventFromRow(event) };
  });
}

export async function changePreferenceRegistryScope(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    scope: PreferenceRegistryScope;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    reason: string;
  },
) {
  try {
    return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
      input.authorizeScope(preference.scope as PreferenceRegistryScope);
      input.authorizeScope(input.scope);
      requireExpectedScopeVersion(preference, input.expectedScopeVersion);
      if (preference.status === "superseded" || preference.status === "rejected") {
        throw new PreferenceRegistryInvalidOperationError(
          "A rejected or superseded preference cannot change scope",
        );
      }
      if (preference.scope === input.scope) {
        throw new PreferenceRegistryInvalidOperationError(
          "Preference already uses the requested scope",
        );
      }
      const oldTarget = targetFromRow(preference);
      const nextTarget = targetFor(input.scope, input.workspaceId, input.actorSubjectId);
      const event = await lifecycleEvent(scopedDb, {
        operation: "scope",
        preferenceId: preference.id,
        expectedScopeVersion: input.expectedScopeVersion,
        expectedRevisionId: preference.activeRevisionId,
        newScope: input.scope,
        actorSubjectId: input.actorSubjectId,
        reason: input.reason,
      });
      const updated = await preferenceAfterMutation(scopedDb, preference.id);
      const active = updated.activeRevisionId
        ? await revisionForPreference(scopedDb, updated.id, updated.activeRevisionId)
        : null;
      if (
        event.oldScope !== oldTarget.scope ||
        event.oldWorkspaceId !== oldTarget.workspaceId ||
        event.oldSubjectId !== oldTarget.subjectId ||
        event.newScope !== nextTarget.scope ||
        event.newWorkspaceId !== nextTarget.workspaceId ||
        event.newSubjectId !== nextTarget.subjectId
      ) {
        throw new Error("Preference scope event did not preserve the locked transition");
      }
      return { preference: recordFromRows(updated, active), event: eventFromRow(event) };
    });
  } catch (error) {
    if (isStableKeyConflict(error)) {
      throw new PreferenceRegistryStableKeyConflictError(
        "A preference with this stable key already exists for the target scope",
      );
    }
    throw error;
  }
}

export async function deactivatePreferenceRegistry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    expectedCurrentRevisionId: string;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    reason: string;
  },
) {
  return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
    const preference = await lockedPreference(scopedDb, input.preferenceId);
    input.authorizeScope(preference.scope as PreferenceRegistryScope);
    requireExpectedScopeVersion(preference, input.expectedScopeVersion);
    if (
      preference.status !== "active" ||
      preference.activeRevisionId !== input.expectedCurrentRevisionId
    ) {
      throw new PreferenceRegistryConflictError(
        "The active preference revision changed before deactivation",
        preference.activeRevisionId,
        preference.scopeVersion,
      );
    }
    const revision = await revisionForPreference(
      scopedDb,
      preference.id,
      input.expectedCurrentRevisionId,
    );
    const event = await lifecycleEvent(scopedDb, {
      operation: "deactivate",
      preferenceId: preference.id,
      expectedScopeVersion: input.expectedScopeVersion,
      expectedRevisionId: revision.id,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
    });
    const updated = await preferenceAfterMutation(scopedDb, preference.id);
    return { preference: recordFromRows(updated, null), event: eventFromRow(event) };
  });
}

export async function supersedePreferenceRegistry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    replacementPreferenceId: string;
    expectedCurrentRevisionId: string;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    reason: string;
  },
) {
  return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
    if (input.preferenceId === input.replacementPreferenceId) {
      throw new PreferenceRegistryInvalidOperationError("A preference cannot supersede itself");
    }
    const locked = await lockedPreferences(scopedDb, [
      input.preferenceId,
      input.replacementPreferenceId,
    ]);
    const preference = locked.find((row) => row.id === input.preferenceId)!;
    const replacement = locked.find((row) => row.id === input.replacementPreferenceId)!;
    input.authorizeScope(preference.scope as PreferenceRegistryScope);
    requireExpectedScopeVersion(preference, input.expectedScopeVersion);
    if (preference.activeRevisionId !== input.expectedCurrentRevisionId) {
      throw new PreferenceRegistryConflictError(
        "The active preference revision changed before supersession",
        preference.activeRevisionId,
        preference.scopeVersion,
      );
    }
    if (preference.status !== "active") {
      throw new PreferenceRegistryInvalidOperationError(
        "Only an active preference can be superseded",
      );
    }
    if (replacement.status !== "active" || !replacement.activeRevisionId) {
      throw new PreferenceRegistryInvalidOperationError("Replacement preference must be active");
    }
    const [replacementRevision] = await scopedDb
      .select()
      .from(schema.preferenceRegistryRevisions)
      .where(
        and(
          eq(schema.preferenceRegistryRevisions.id, replacement.activeRevisionId),
          eq(schema.preferenceRegistryRevisions.preferenceId, replacement.id),
          or(
            isNull(schema.preferenceRegistryRevisions.expiresAt),
            gt(schema.preferenceRegistryRevisions.expiresAt, sql`transaction_timestamp()`),
          ),
        ),
      )
      .limit(1);
    if (!replacementRevision) {
      throw new PreferenceRegistryInvalidOperationError(
        "Replacement preference must have an unexpired active revision",
      );
    }
    if (preference.scope !== replacement.scope) {
      throw new PreferenceRegistryInvalidOperationError(
        "Supersession requires the same scope tier",
      );
    }
    const event = await lifecycleEvent(scopedDb, {
      operation: "supersede",
      preferenceId: preference.id,
      expectedScopeVersion: input.expectedScopeVersion,
      expectedRevisionId: preference.activeRevisionId,
      relatedPreferenceId: replacement.id,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
    });
    const updated = await preferenceAfterMutation(scopedDb, preference.id);
    const revision = await revisionForPreference(
      scopedDb,
      preference.id,
      preference.activeRevisionId!,
    );
    return { preference: recordFromRows(updated, revision), event: eventFromRow(event) };
  });
}

export async function rejectPreferenceRegistryProposal(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    principalKind: string | undefined;
    preferenceId: string;
    revisionId: string;
    expectedScopeVersion: number;
    authorizeScope: PreferenceRegistryScopeAuthorizer;
    reason: string;
  },
) {
  return await withPreferenceRegistryGovernanceRls(db, input, async (scopedDb) => {
    const preference = await lockedPreference(scopedDb, input.preferenceId);
    input.authorizeScope(preference.scope as PreferenceRegistryScope);
    requireExpectedScopeVersion(preference, input.expectedScopeVersion);
    if (preference.activeRevisionId !== null || preference.status !== "proposed") {
      throw new PreferenceRegistryInvalidOperationError(
        "Only an inactive proposal can be rejected",
      );
    }
    await revisionForPreference(scopedDb, preference.id, input.revisionId);
    const event = await lifecycleEvent(scopedDb, {
      operation: "reject",
      preferenceId: preference.id,
      expectedScopeVersion: input.expectedScopeVersion,
      expectedRevisionId: null,
      revisionId: input.revisionId,
      actorSubjectId: input.actorSubjectId,
      reason: input.reason,
    });
    const updated = await preferenceAfterMutation(scopedDb, preference.id);
    return { preference: recordFromRows(updated, null), event: eventFromRow(event) };
  });
}

async function withPreferenceRegistryAttemptAuthority<T>(
  db: Database,
  input: PreferenceRegistryAttemptClaims,
  fn: (db: Database, authority: PreferenceRegistryAttemptAuthority) => Promise<T>,
): Promise<T> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = (await scopedDb.execute(sql`
      WITH locked_workspace AS MATERIALIZED (
        SELECT workspace.id, workspace.account_id
        FROM workspaces workspace
        WHERE workspace.id = ${input.workspaceId}::uuid
          AND workspace.account_id = ${input.accountId}::uuid
        FOR KEY SHARE OF workspace
      ), locked_session AS MATERIALIZED (
        SELECT session.id, session.account_id, session.workspace_id, session.active_turn_id
        FROM sessions session
        JOIN locked_workspace workspace
          ON workspace.id = session.workspace_id
          AND workspace.account_id = session.account_id
        WHERE session.id = ${input.sessionId}::uuid
          AND session.active_turn_id = ${input.turnId}::uuid
        FOR SHARE OF session
      ), locked_turn AS MATERIALIZED (
        SELECT turn.id, turn.account_id, turn.workspace_id, turn.session_id,
          turn.active_attempt_id, turn.execution_generation,
          coalesce(
            turn.initiating_human_subject_id,
            case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
          ) as initiating_human_subject_id
        FROM session_turns turn
        JOIN locked_session session
          ON session.id = turn.session_id
          AND session.workspace_id = turn.workspace_id
          AND session.account_id = turn.account_id
        WHERE turn.id = ${input.turnId}::uuid
          AND turn.active_attempt_id = ${input.attemptId}::uuid
          AND turn.execution_generation = ${input.executionGeneration}
          AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
          AND length(btrim(coalesce(
            turn.initiating_human_subject_id,
            case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
          ))) BETWEEN 1 AND 1024
        FOR SHARE OF turn
      ), locked_attempt AS MATERIALIZED (
        SELECT attempt.id, attempt.account_id, attempt.workspace_id,
          attempt.session_id, attempt.turn_id, attempt.execution_generation
        FROM session_turn_attempts attempt
        JOIN locked_turn turn
          ON turn.id = attempt.turn_id
          AND turn.session_id = attempt.session_id
          AND turn.workspace_id = attempt.workspace_id
          AND turn.account_id = attempt.account_id
        WHERE attempt.id = ${input.attemptId}::uuid
          AND attempt.execution_generation = ${input.executionGeneration}
          AND attempt.state IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM session_attempt_interruptions interruption
            WHERE interruption.workspace_id = attempt.workspace_id
              AND interruption.attempt_id = attempt.id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
        FOR SHARE OF attempt
      )
      SELECT turn.initiating_human_subject_id
      FROM locked_workspace workspace
      JOIN locked_session session ON true
      JOIN locked_turn turn ON true
      JOIN locked_attempt attempt ON true
      WHERE workspace.account_id = attempt.account_id
        AND workspace.id = attempt.workspace_id
        AND session.id = attempt.session_id
        AND turn.id = attempt.turn_id
    `)) as unknown as Array<{ initiating_human_subject_id: string }>;
    const initiatingHumanSubjectId = rows[0]?.initiating_human_subject_id;
    if (!initiatingHumanSubjectId) {
      throw new PreferenceRegistryInitiatorError(
        "Preference retrieval requires the exact current attempt, generation, and immutable human initiator",
      );
    }
    const authority = { ...input, initiatingHumanSubjectId };
    await setSubjectRlsContext(scopedDb, initiatingHumanSubjectId);
    return await fn(scopedDb, authority);
  });
}

export function boundPreferenceRegistryDescriptors(
  descriptors: readonly PreferenceRegistryDescriptor[],
): { descriptors: PreferenceRegistryDescriptor[]; truncated: boolean } {
  const scopeOrder: Record<PreferenceRegistryScope, number> = {
    organization: 0,
    workspace: 1,
    user: 2,
  };
  const compareText = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const ordered = [...descriptors].sort(
    (left, right) =>
      scopeOrder[left.scope] - scopeOrder[right.scope] ||
      right.precedence.rank - left.precedence.rank ||
      compareText(left.stableKey, right.stableKey) ||
      compareText(left.id, right.id),
  );
  const selected: PreferenceRegistryDescriptor[] = [];
  for (const descriptor of ordered) {
    if (selected.length >= PREFERENCE_REGISTRY_DESCRIPTOR_MAX_COUNT) break;
    const candidate = [...selected, descriptor];
    if (postgresJsonbTextUtf8Bytes(candidate) > PREFERENCE_REGISTRY_DESCRIPTOR_MAX_UTF8_BYTES) {
      break;
    }
    selected.push(descriptor);
  }
  return { descriptors: selected, truncated: selected.length < ordered.length };
}

function postgresJsonbTextUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + postgresJsonbSpacingBytes(value);
}

function postgresJsonbSpacingBytes(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      Math.max(0, value.length - 1) +
      value.reduce<number>((total, entry) => total + postgresJsonbSpacingBytes(entry), 0)
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.values(value);
    return (
      entries.length +
      Math.max(0, entries.length - 1) +
      entries.reduce<number>((total, entry) => total + postgresJsonbSpacingBytes(entry), 0)
    );
  }
  return 0;
}

export async function getOrCreatePreferenceRegistrySnapshot(
  db: Database,
  claims: PreferenceRegistryAttemptClaims,
) {
  try {
    return await withWorkspaceRls(db, claims.workspaceId, async (scopedDb) => {
      const rows = (await scopedDb.execute(sql`
        SELECT
          snapshot.id,
          snapshot.workspace_id AS "workspaceId",
          snapshot.session_id AS "sessionId",
          snapshot.turn_id AS "turnId",
          snapshot.attempt_id AS "attemptId",
          snapshot.execution_generation AS "executionGeneration",
          snapshot.initiating_human_subject_id AS "initiatingHumanSubjectId",
          snapshot.descriptor_hash AS "descriptorHash",
          snapshot.descriptors,
          snapshot.truncated,
          snapshot.created_at AS "createdAt"
        FROM preference_registry_get_or_create_snapshot(
          ${claims.accountId}::uuid,
          ${claims.workspaceId}::uuid,
          ${claims.sessionId}::uuid,
          ${claims.turnId}::uuid,
          ${claims.attemptId}::uuid,
          ${claims.executionGeneration}
        ) snapshot
      `)) as unknown as Array<{
        id: string;
        workspaceId: string;
        sessionId: string;
        turnId: string;
        attemptId: string;
        executionGeneration: number;
        initiatingHumanSubjectId: string;
        descriptorHash: string;
        descriptors: unknown;
        truncated: boolean;
        createdAt: Date | string;
      }>;
      const snapshot = rows[0];
      if (!snapshot) {
        throw new PreferenceRegistryInitiatorError(
          "Preference snapshot authority conflicts with the accepted human attempt",
        );
      }
      return PreferenceRegistrySnapshot.parse({
        ...snapshot,
        createdAt: iso(snapshot.createdAt),
      });
    });
  } catch (error) {
    if (["40001", "42501"].includes(nestedPostgresSqlState(error) ?? "")) {
      throw new PreferenceRegistryInitiatorError(
        "Preference snapshot requires the exact current attempt, generation, and immutable human initiator",
      );
    }
    throw error;
  }
}

export async function getPreferenceRegistryFullContent(
  db: Database,
  claims: PreferenceRegistryAttemptClaims,
  handle: string,
) {
  return await withPreferenceRegistryAttemptAuthority(db, claims, async (scopedDb, authority) => {
    const [snapshot] = await scopedDb
      .select()
      .from(schema.preferenceRegistrySnapshots)
      .where(
        and(
          eq(schema.preferenceRegistrySnapshots.accountId, authority.accountId),
          eq(schema.preferenceRegistrySnapshots.workspaceId, authority.workspaceId),
          eq(schema.preferenceRegistrySnapshots.sessionId, authority.sessionId),
          eq(schema.preferenceRegistrySnapshots.turnId, authority.turnId),
          eq(schema.preferenceRegistrySnapshots.attemptId, authority.attemptId),
          eq(schema.preferenceRegistrySnapshots.executionGeneration, authority.executionGeneration),
          eq(
            schema.preferenceRegistrySnapshots.initiatingHumanSubjectId,
            authority.initiatingHumanSubjectId,
          ),
        ),
      )
      .limit(1);
    if (!snapshot) {
      throw new PreferenceRegistryInvalidOperationError(
        "Preference summary must be snapshotted before full-content retrieval",
      );
    }
    const descriptor = snapshot.descriptors.find(
      (candidate) => candidate.retrievalHandle === handle,
    );
    if (!descriptor)
      throw new PreferenceRegistryNotFoundError(
        "Preference retrieval handle is not in this attempt snapshot",
      );
    const [revision] = await scopedDb
      .select()
      .from(schema.preferenceRegistryRevisions)
      .where(
        and(
          eq(schema.preferenceRegistryRevisions.accountId, authority.accountId),
          eq(schema.preferenceRegistryRevisions.id, descriptor.revisionId),
          eq(schema.preferenceRegistryRevisions.preferenceId, descriptor.id),
          eq(schema.preferenceRegistryRevisions.contentHash, descriptor.contentHash),
        ),
      )
      .limit(1);
    if (!revision) throw new PreferenceRegistryNotFoundError("Preference revision was not found");
    return PreferenceRegistryFullContent.parse({ descriptor, content: revision.content });
  });
}
