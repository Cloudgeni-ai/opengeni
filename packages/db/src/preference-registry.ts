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
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "./index";
import { getSessionTurnForAttempt, withWorkspaceSubjectRls } from "./index";
import { nestedPostgresSqlState, safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

type PreferenceRow = typeof schema.preferenceRegistryPreferences.$inferSelect;
type RevisionRow = typeof schema.preferenceRegistryRevisions.$inferSelect;
type EventRow = typeof schema.preferenceRegistryEvents.$inferSelect;
type SnapshotRow = typeof schema.preferenceRegistrySnapshots.$inferSelect;

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

export type PreferenceRegistryAttemptAuthority = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  initiatingHumanSubjectId: string;
};

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

async function lockedPreference(db: Database, id: string): Promise<PreferenceRow> {
  const [row] = await db
    .select()
    .from(schema.preferenceRegistryPreferences)
    .where(eq(schema.preferenceRegistryPreferences.id, id))
    .for("update")
    .limit(1);
  if (!row) throw new PreferenceRegistryNotFoundError("Preference was not found");
  return row;
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

async function nextEventVersion(db: Database, preferenceId: string): Promise<number> {
  const [row] = await db
    .select({ version: schema.preferenceRegistryEvents.version })
    .from(schema.preferenceRegistryEvents)
    .where(eq(schema.preferenceRegistryEvents.preferenceId, preferenceId))
    .orderBy(desc(schema.preferenceRegistryEvents.version))
    .limit(1);
  return (row?.version ?? 0) + 1;
}

function targetColumns(target: PreferenceRegistryScopeTarget) {
  return {
    scope: target.scope,
    scopeWorkspaceId: target.workspaceId,
    scopeSubjectId: target.subjectId,
  };
}

function eventTargetColumns(prefix: "old" | "new", target: PreferenceRegistryScopeTarget | null) {
  const values = target ?? { scope: null, workspaceId: null, subjectId: null };
  return prefix === "old"
    ? { oldScope: values.scope, oldWorkspaceId: values.workspaceId, oldSubjectId: values.subjectId }
    : {
        newScope: values.scope,
        newWorkspaceId: values.workspaceId,
        newSubjectId: values.subjectId,
      };
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
  },
) {
  const target = targetFor(input.scope, input.workspaceId, input.actorSubjectId);
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
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
        await scopedDb.insert(schema.preferenceRegistryEvents).values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: "proposal_created",
          version: 1,
          newRevisionId: revision.id,
          ...eventTargetColumns("new", target),
          actorSubjectId: input.actorSubjectId,
          reason: importedSources.has(input.provenanceSource)
            ? "Imported source proposal; inactive pending authorized human review"
            : "Human-created preference proposal; inactive pending activation",
        });
        return recordFromRows(preference, null);
      },
    );
  } catch (error) {
    if (isStableKeyConflict(error)) {
      throw new PreferenceRegistryStableKeyConflictError(
        "A preference with this stable key already exists for the target scope",
      );
    }
    throw error;
  }
}

async function activeRevisionRows(
  db: Database,
  rows: PreferenceRow[],
): Promise<Map<string, RevisionRow>> {
  const ids = rows.flatMap((row) => (row.activeRevisionId ? [row.activeRevisionId] : []));
  if (ids.length === 0) return new Map();
  const revisions = await db
    .select()
    .from(schema.preferenceRegistryRevisions)
    .where(inArray(schema.preferenceRegistryRevisions.id, ids));
  return new Map(revisions.map((revision) => [revision.id, revision]));
}

export async function listPreferenceRegistry(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    scope?: PreferenceRegistryScope | undefined;
    status?: PreferenceRegistryStatus | undefined;
    limit: number;
  },
) {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const conditions: SQL[] = [];
    if (input.scope) conditions.push(eq(schema.preferenceRegistryPreferences.scope, input.scope));
    if (input.status && input.status !== "expired") {
      conditions.push(eq(schema.preferenceRegistryPreferences.status, input.status));
    }
    const rows = await scopedDb
      .select()
      .from(schema.preferenceRegistryPreferences)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(
        asc(schema.preferenceRegistryPreferences.stableKey),
        asc(schema.preferenceRegistryPreferences.id),
      )
      .limit(input.limit);
    const revisions = await activeRevisionRows(scopedDb, rows);
    const preferences = rows
      .map((row) =>
        recordFromRows(
          row,
          row.activeRevisionId ? (revisions.get(row.activeRevisionId) ?? null) : null,
        ),
      )
      .filter((record) => !input.status || record.status === input.status);
    return PreferenceRegistryListResponse.parse({ preferences });
  });
}

export async function getPreferenceRegistryDetail(
  db: Database,
  input: { workspaceId: string; subjectId: string; preferenceId: string },
) {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scopedDb) => {
    const [preference] = await scopedDb
      .select()
      .from(schema.preferenceRegistryPreferences)
      .where(eq(schema.preferenceRegistryPreferences.id, input.preferenceId))
      .limit(1);
    if (!preference) throw new PreferenceRegistryNotFoundError("Preference was not found");
    const [revisions, events] = await Promise.all([
      scopedDb
        .select()
        .from(schema.preferenceRegistryRevisions)
        .where(eq(schema.preferenceRegistryRevisions.preferenceId, input.preferenceId))
        .orderBy(desc(schema.preferenceRegistryRevisions.revision)),
      scopedDb
        .select()
        .from(schema.preferenceRegistryEvents)
        .where(eq(schema.preferenceRegistryEvents.preferenceId, input.preferenceId))
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
  });
}

export async function activatePreferenceRegistryRevision(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    revisionId: string;
    expectedCurrentRevisionId: string | null;
    reason: string;
    eventType?: "activated" | "corrected";
  },
) {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
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
        throw new PreferenceRegistryInvalidOperationError(
          "The requested revision is already active",
        );
      }
      const [updated] = await scopedDb
        .update(schema.preferenceRegistryPreferences)
        .set({
          status: "active",
          activeRevisionId: revision.id,
          activeRevision: revision.revision,
          activeContentHash: revision.contentHash,
          activationVersion: preference.activationVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
        .returning();
      if (!updated) throw new Error("Preference activation was not recorded");
      const version = await nextEventVersion(scopedDb, preference.id);
      const [event] = await scopedDb
        .insert(schema.preferenceRegistryEvents)
        .values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: input.eventType ?? "activated",
          version,
          oldRevisionId: preference.activeRevisionId,
          newRevisionId: revision.id,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
        })
        .returning();
      return {
        preference: recordFromRows(updated, revision),
        event: eventFromRow(event!),
      };
    },
  );
}

export async function correctPreferenceRegistry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    expectedCurrentRevisionId: string;
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
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
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
      const [updated] = await scopedDb
        .update(schema.preferenceRegistryPreferences)
        .set({
          status: "active",
          activeRevisionId: revision.id,
          activeRevision: revision.revision,
          activeContentHash: revision.contentHash,
          activationVersion: preference.activationVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
        .returning();
      const [event] = await scopedDb
        .insert(schema.preferenceRegistryEvents)
        .values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: "corrected",
          version: await nextEventVersion(scopedDb, preference.id),
          oldRevisionId: oldRevision.id,
          newRevisionId: revision.id,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
        })
        .returning();
      return { preference: recordFromRows(updated!, revision), event: eventFromRow(event!) };
    },
  );
}

export async function changePreferenceRegistryScope(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    scope: PreferenceRegistryScope;
    expectedScopeVersion: number;
    reason: string;
  },
) {
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.actorSubjectId,
      async (scopedDb) => {
        const preference = await lockedPreference(scopedDb, input.preferenceId);
        if (preference.scopeVersion !== input.expectedScopeVersion) {
          throw new PreferenceRegistryConflictError(
            "The preference scope changed in another request",
            preference.activeRevisionId,
            preference.scopeVersion,
          );
        }
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
        const [updated] = await scopedDb
          .update(schema.preferenceRegistryPreferences)
          .set({
            ...targetColumns(nextTarget),
            scopeVersion: preference.scopeVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
          .returning();
        const [event] = await scopedDb
          .insert(schema.preferenceRegistryEvents)
          .values({
            accountId: input.accountId,
            preferenceId: preference.id,
            type: "scope_changed",
            version: await nextEventVersion(scopedDb, preference.id),
            ...eventTargetColumns("old", oldTarget),
            ...eventTargetColumns("new", nextTarget),
            actorSubjectId: input.actorSubjectId,
            reason: input.reason,
          })
          .returning();
        const active = updated!.activeRevisionId
          ? await revisionForPreference(scopedDb, updated!.id, updated!.activeRevisionId)
          : null;
        return { preference: recordFromRows(updated!, active), event: eventFromRow(event!) };
      },
    );
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
    preferenceId: string;
    expectedCurrentRevisionId: string;
    reason: string;
  },
) {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
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
      const [updated] = await scopedDb
        .update(schema.preferenceRegistryPreferences)
        .set({
          status: "inactive",
          activeRevisionId: null,
          activeRevision: null,
          activeContentHash: null,
          activationVersion: preference.activationVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
        .returning();
      const [event] = await scopedDb
        .insert(schema.preferenceRegistryEvents)
        .values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: "deactivated",
          version: await nextEventVersion(scopedDb, preference.id),
          oldRevisionId: revision.id,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
        })
        .returning();
      return { preference: recordFromRows(updated!, null), event: eventFromRow(event!) };
    },
  );
}

export async function supersedePreferenceRegistry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    replacementPreferenceId: string;
    expectedCurrentRevisionId: string;
    reason: string;
  },
) {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
      if (preference.activeRevisionId !== input.expectedCurrentRevisionId) {
        throw new PreferenceRegistryConflictError(
          "The active preference revision changed before supersession",
          preference.activeRevisionId,
          preference.scopeVersion,
        );
      }
      const replacement = await lockedPreference(scopedDb, input.replacementPreferenceId);
      if (preference.id === replacement.id) {
        throw new PreferenceRegistryInvalidOperationError("A preference cannot supersede itself");
      }
      if (replacement.status !== "active" || !replacement.activeRevisionId) {
        throw new PreferenceRegistryInvalidOperationError("Replacement preference must be active");
      }
      if (preference.scope !== replacement.scope) {
        throw new PreferenceRegistryInvalidOperationError(
          "Supersession requires the same scope tier",
        );
      }
      const [updated] = await scopedDb
        .update(schema.preferenceRegistryPreferences)
        .set({
          status: "superseded",
          supersededByPreferenceId: replacement.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
        .returning();
      const [event] = await scopedDb
        .insert(schema.preferenceRegistryEvents)
        .values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: "superseded",
          version: await nextEventVersion(scopedDb, preference.id),
          oldRevisionId: preference.activeRevisionId,
          relatedPreferenceId: replacement.id,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
        })
        .returning();
      const revision = await revisionForPreference(
        scopedDb,
        preference.id,
        preference.activeRevisionId!,
      );
      return { preference: recordFromRows(updated!, revision), event: eventFromRow(event!) };
    },
  );
}

export async function rejectPreferenceRegistryProposal(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    preferenceId: string;
    revisionId: string;
    reason: string;
  },
) {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.actorSubjectId,
    async (scopedDb) => {
      const preference = await lockedPreference(scopedDb, input.preferenceId);
      if (preference.activeRevisionId !== null || preference.status !== "proposed") {
        throw new PreferenceRegistryInvalidOperationError(
          "Only an inactive proposal can be rejected",
        );
      }
      await revisionForPreference(scopedDb, preference.id, input.revisionId);
      const [updated] = await scopedDb
        .update(schema.preferenceRegistryPreferences)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(schema.preferenceRegistryPreferences.id, preference.id))
        .returning();
      const [event] = await scopedDb
        .insert(schema.preferenceRegistryEvents)
        .values({
          accountId: input.accountId,
          preferenceId: preference.id,
          type: "rejected",
          version: await nextEventVersion(scopedDb, preference.id),
          newRevisionId: input.revisionId,
          actorSubjectId: input.actorSubjectId,
          reason: input.reason,
        })
        .returning();
      return { preference: recordFromRows(updated!, null), event: eventFromRow(event!) };
    },
  );
}

export async function resolvePreferenceRegistryAttemptAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
  },
): Promise<PreferenceRegistryAttemptAuthority> {
  const turn = await getSessionTurnForAttempt(
    db,
    input.workspaceId,
    input.sessionId,
    input.attemptId,
  );
  if (
    !turn ||
    turn.id !== input.turnId ||
    turn.executionGeneration !== input.executionGeneration ||
    turn.initiator.kind !== "subject"
  ) {
    throw new PreferenceRegistryInitiatorError(
      "Preference retrieval requires an exact active attempt with an immutable human initiator",
    );
  }
  return { ...input, initiatingHumanSubjectId: turn.initiator.subjectId };
}

function retrievalHandle(preferenceId: string, revision: RevisionRow): string {
  return `preference://${preferenceId}/revisions/${revision.id}?sha256=${revision.contentHash}`;
}

function descriptorFor(preference: PreferenceRow, revision: RevisionRow) {
  return PreferenceRegistryDescriptor.parse({
    id: preference.id,
    stableKey: preference.stableKey,
    title: revision.title,
    description: revision.description,
    scope: preference.scope,
    activeVersion: preference.activationVersion,
    revisionId: revision.id,
    contentHash: revision.contentHash,
    precedence: {
      tier: preference.scope,
      rank: revision.precedenceRank,
      conflictStrategy: revision.conflictStrategy,
      conflictsWith: revision.conflictsWith,
    },
    provenance: {
      source: revision.provenanceSource,
      sourceIdHash: revision.provenanceSourceId ? contentHash(revision.provenanceSourceId) : null,
      trust: revision.trust,
    },
    expiresAt: revision.expiresAt ? iso(revision.expiresAt) : null,
    retrievalHandle: retrievalHandle(preference.id, revision),
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

function snapshotFromRow(row: SnapshotRow) {
  return PreferenceRegistrySnapshot.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attemptId: row.attemptId,
    executionGeneration: row.executionGeneration,
    initiatingHumanSubjectId: row.initiatingHumanSubjectId,
    descriptorHash: row.descriptorHash,
    descriptors: row.descriptors,
    truncated: row.truncated,
    createdAt: iso(row.createdAt),
  });
}

async function applicableDescriptors(db: Database) {
  const now = new Date();
  const rows = await db
    .select({
      preference: schema.preferenceRegistryPreferences,
      revision: schema.preferenceRegistryRevisions,
    })
    .from(schema.preferenceRegistryPreferences)
    .innerJoin(
      schema.preferenceRegistryRevisions,
      eq(
        schema.preferenceRegistryRevisions.id,
        schema.preferenceRegistryPreferences.activeRevisionId,
      ),
    )
    .where(eq(schema.preferenceRegistryPreferences.status, "active"));
  return boundPreferenceRegistryDescriptors(
    rows
      .filter(({ revision }) => revision.expiresAt === null || revision.expiresAt > now)
      .map(({ preference, revision }) => descriptorFor(preference, revision)),
  );
}

export async function getOrCreatePreferenceRegistrySnapshot(
  db: Database,
  authority: PreferenceRegistryAttemptAuthority,
) {
  return await withWorkspaceSubjectRls(
    db,
    authority.workspaceId,
    authority.initiatingHumanSubjectId,
    async (scopedDb) => {
      const [existing] = await scopedDb
        .select()
        .from(schema.preferenceRegistrySnapshots)
        .where(eq(schema.preferenceRegistrySnapshots.attemptId, authority.attemptId))
        .limit(1);
      if (existing) return snapshotFromRow(existing);
      const bounded = await applicableDescriptors(scopedDb);
      const descriptorJson = JSON.stringify(bounded.descriptors);
      const [created] = await scopedDb
        .insert(schema.preferenceRegistrySnapshots)
        .values({
          accountId: authority.accountId,
          workspaceId: authority.workspaceId,
          sessionId: authority.sessionId,
          turnId: authority.turnId,
          attemptId: authority.attemptId,
          executionGeneration: authority.executionGeneration,
          initiatingHumanSubjectId: authority.initiatingHumanSubjectId,
          descriptors: bounded.descriptors,
          descriptorHash: sql`encode(sha256(convert_to(${descriptorJson}::jsonb::text, 'UTF8')), 'hex')`,
          truncated: bounded.truncated,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return snapshotFromRow(created);
      const [winner] = await scopedDb
        .select()
        .from(schema.preferenceRegistrySnapshots)
        .where(eq(schema.preferenceRegistrySnapshots.attemptId, authority.attemptId))
        .limit(1);
      if (!winner) throw new Error("Preference snapshot conflict did not produce a winner");
      return snapshotFromRow(winner);
    },
  );
}

export async function getPreferenceRegistryFullContent(
  db: Database,
  authority: PreferenceRegistryAttemptAuthority,
  handle: string,
) {
  return await withWorkspaceSubjectRls(
    db,
    authority.workspaceId,
    authority.initiatingHumanSubjectId,
    async (scopedDb) => {
      const [snapshot] = await scopedDb
        .select()
        .from(schema.preferenceRegistrySnapshots)
        .where(eq(schema.preferenceRegistrySnapshots.attemptId, authority.attemptId))
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
            eq(schema.preferenceRegistryRevisions.id, descriptor.revisionId),
            eq(schema.preferenceRegistryRevisions.preferenceId, descriptor.id),
            eq(schema.preferenceRegistryRevisions.contentHash, descriptor.contentHash),
          ),
        )
        .limit(1);
      if (!revision) throw new PreferenceRegistryNotFoundError("Preference revision was not found");
      return PreferenceRegistryFullContent.parse({ descriptor, content: revision.content });
    },
  );
}
