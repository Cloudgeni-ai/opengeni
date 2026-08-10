import { createHash } from "node:crypto";
import type {
  EligibleKnowledgeClaim,
  KnowledgeChangeProposalRecord,
  KnowledgeClaimEvidencePolarity,
  KnowledgeClaimOrigin,
  KnowledgeClaimRecord,
  KnowledgeClaimRelationType,
  KnowledgeClaimReviewState,
  KnowledgeDocumentVersionRecord,
  KnowledgeFactObjectKind,
  KnowledgeFactRecord,
  KnowledgeLifecycleEventType,
  KnowledgeLifecycleState,
  KnowledgeProviderRecord,
  KnowledgeSourceAclVersionRecord,
  KnowledgeSourceObjectRecord,
  KnowledgeSourceRecord,
  KnowledgeSyncRunRecord,
  ScopedKnowledgeActor,
  ScopedKnowledgeScope,
} from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { setSubjectRlsContext, withRlsContext } from "./database";
import { nestedPostgresSqlState, safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

const SHA256_RE = /^[0-9a-f]{64}$/;
const OPERATION_ID_MAX_CHARS = 256;
const STABLE_KEY_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

type KnowledgeWriteContext = {
  accountId: string;
  workspaceId: string;
  scope: ScopedKnowledgeScope;
  operationId: string;
  actor: ScopedKnowledgeActor;
};

type KnowledgeReadContext = {
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
  surface: "human" | "agent";
};

type ScopedRow = {
  scopeKind: string;
  scopeWorkspaceId: string | null;
  scopeSubjectId: string | null;
  scopeKey: string;
};

type ConvergentKnowledgeOperationKind =
  | "provider"
  | "source"
  | "source_object"
  | "document_version"
  | "entity"
  | "entity_alias"
  | "fact"
  | "claim_relation";

export class ScopedKnowledgeConflictError extends Error {
  readonly name = "ScopedKnowledgeConflictError";
  readonly code = "SCOPED_KNOWLEDGE_CONFLICT";
}

export class ScopedKnowledgeGenerationConflictError extends Error {
  readonly name = "ScopedKnowledgeGenerationConflictError";
  readonly code = "SCOPED_KNOWLEDGE_GENERATION_CONFLICT";
}

export class ScopedKnowledgeNotFoundError extends Error {
  readonly name = "ScopedKnowledgeNotFoundError";
}

export class ScopedKnowledgeInvalidOperationError extends Error {
  readonly name = "ScopedKnowledgeInvalidOperationError";
}

export class ScopedKnowledgeAuthorityError extends Error {
  readonly name = "ScopedKnowledgeAuthorityError";
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function scopedKnowledgeInputHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export function normalizeScopedKnowledgeKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function scopedKnowledgeScopeKey(scope: ScopedKnowledgeScope): string {
  return `${scope.kind}:${scope.workspaceId ?? "-"}:${scope.subjectId ?? "-"}`;
}

function normalizedStableKey(value: string, label: string, maxChars: number): string {
  const normalized = normalizeScopedKnowledgeKey(value);
  if (
    normalized.length < 1 ||
    normalized.length > maxChars ||
    !STABLE_KEY_RE.test(normalized) ||
    normalized.includes("--")
  ) {
    throw new ScopedKnowledgeInvalidOperationError(`${label} is not a valid normalized key`);
  }
  return normalized;
}

function boundedText(value: string, label: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) {
    throw new ScopedKnowledgeInvalidOperationError(
      `${label} must contain between 1 and ${maxChars} characters`,
    );
  }
  return trimmed;
}

function sha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    throw new ScopedKnowledgeInvalidOperationError(`${label} must be a lowercase SHA-256 hex`);
  }
  return normalized;
}

function validateOperationId(operationId: string): string {
  return boundedText(operationId, "operationId", OPERATION_ID_MAX_CHARS);
}

function validateActor(actor: ScopedKnowledgeActor): void {
  boundedText(actor.subjectId, "actor.subjectId", 1024);
  if (actor.kind === "human") {
    if (actor.initiatingHumanSubjectId !== actor.subjectId) {
      throw new ScopedKnowledgeAuthorityError(
        "A human knowledge actor must preserve itself as the initiating human",
      );
    }
    return;
  }
  if (actor.initiatingHumanSubjectId !== null) {
    boundedText(actor.initiatingHumanSubjectId, "actor.initiatingHumanSubjectId", 1024);
  }
}

function validateScope(
  scope: ScopedKnowledgeScope,
  workspaceId: string,
  initiatingHumanSubjectId: string | null,
): void {
  if (scope.kind === "workspace" && scope.workspaceId !== workspaceId) {
    throw new ScopedKnowledgeAuthorityError(
      "Workspace-scoped knowledge must use the active workspace",
    );
  }
  if (
    scope.kind === "personal" &&
    (scope.subjectId !== initiatingHumanSubjectId ||
      (scope.workspaceId !== null && scope.workspaceId !== workspaceId))
  ) {
    throw new ScopedKnowledgeAuthorityError(
      "Personal knowledge requires the exact initiating human and active workspace anchor",
    );
  }
}

function scopeColumns(scope: ScopedKnowledgeScope) {
  return {
    scopeKind: scope.kind,
    scopeWorkspaceId: scope.workspaceId,
    scopeSubjectId: scope.subjectId,
    scopeKey: scopedKnowledgeScopeKey(scope),
  };
}

function actorColumns(actor: ScopedKnowledgeActor) {
  return {
    actorKind: actor.kind,
    actorSubjectId: actor.subjectId,
    initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
  };
}

async function lockConvergentKnowledgeOperation(
  db: Database,
  input: {
    accountId: string;
    operationKind: ConvergentKnowledgeOperationKind;
    operationNamespace: string;
    operationId: string;
    inputHash: string;
  },
): Promise<string | null> {
  const lockIdentity = [
    "scoped-knowledge",
    input.accountId,
    input.operationKind,
    input.operationNamespace,
    input.operationId,
  ].join(":");
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0::bigint))`);
  const [receipt] = await db
    .select()
    .from(schema.knowledgeOperationReceipts)
    .where(
      and(
        eq(schema.knowledgeOperationReceipts.accountId, input.accountId),
        eq(schema.knowledgeOperationReceipts.operationKind, input.operationKind),
        eq(schema.knowledgeOperationReceipts.operationNamespace, input.operationNamespace),
        eq(schema.knowledgeOperationReceipts.operationId, input.operationId),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  if (receipt.inputHash !== input.inputHash) {
    throw new ScopedKnowledgeConflictError(
      "Knowledge operation id was replayed with different immutable input",
    );
  }
  return receipt.resultId;
}

async function recordConvergentKnowledgeOperation(
  db: Database,
  input: {
    accountId: string;
    scope: ScopedKnowledgeScope;
    operationKind: ConvergentKnowledgeOperationKind;
    operationNamespace: string;
    operationId: string;
    inputHash: string;
    resultId: string;
    actor: ScopedKnowledgeActor;
  },
): Promise<void> {
  await db.insert(schema.knowledgeOperationReceipts).values({
    accountId: input.accountId,
    ...scopeColumns(input.scope),
    operationKind: input.operationKind,
    operationNamespace: input.operationNamespace,
    operationId: input.operationId,
    inputHash: input.inputHash,
    resultId: input.resultId,
    ...actorColumns(input.actor),
  });
}

function scopeFromRow(row: ScopedRow): ScopedKnowledgeScope {
  if (row.scopeKind === "organization") {
    return { kind: "organization", workspaceId: null, subjectId: null };
  }
  if (row.scopeKind === "workspace") {
    return { kind: "workspace", workspaceId: row.scopeWorkspaceId!, subjectId: null };
  }
  return {
    kind: "personal",
    workspaceId: row.scopeWorkspaceId,
    subjectId: row.scopeSubjectId!,
  };
}

function sameScope(row: ScopedRow, scope: ScopedKnowledgeScope): boolean {
  return row.scopeKey === scopedKnowledgeScopeKey(scope);
}

async function withKnowledgeWriteRls<T>(
  db: Database,
  input: KnowledgeWriteContext,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  validateOperationId(input.operationId);
  validateActor(input.actor);
  validateScope(input.scope, input.workspaceId, input.actor.initiatingHumanSubjectId);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if (input.actor.initiatingHumanSubjectId !== null) {
        await setSubjectRlsContext(scopedDb, input.actor.initiatingHumanSubjectId);
      }
      return await fn(scopedDb);
    },
  );
}

async function withKnowledgeReadRls<T>(
  db: Database,
  input: KnowledgeReadContext,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const subjectId = boundedText(input.initiatingSubjectId, "initiatingSubjectId", 1024);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, subjectId);
      return await fn(scopedDb);
    },
  );
}

async function withKnowledgeAuthorityRls<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; initiatingSubjectId: string | null },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const subjectId =
    input.initiatingSubjectId === null
      ? null
      : boundedText(input.initiatingSubjectId, "initiatingSubjectId", 1024);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      if (subjectId !== null) await setSubjectRlsContext(scopedDb, subjectId);
      return await fn(scopedDb);
    },
  );
}

function translatePersistenceError(error: unknown, fallback: string): never {
  const state = nestedPostgresSqlState(error);
  const facts = safeDatabaseErrorFacts(error);
  if (state === "40001") {
    throw new ScopedKnowledgeGenerationConflictError(fallback, { cause: error });
  }
  if (state === "P0002") {
    throw new ScopedKnowledgeNotFoundError(fallback, { cause: error });
  }
  if (state === "42501") {
    throw new ScopedKnowledgeAuthorityError(fallback, { cause: error });
  }
  if (state === "23505") {
    if ((facts.constraint ?? "").includes("generation")) {
      throw new ScopedKnowledgeGenerationConflictError(fallback, { cause: error });
    }
    throw new ScopedKnowledgeConflictError(fallback, { cause: error });
  }
  if (state === "23514" || state === "55000") {
    throw new ScopedKnowledgeInvalidOperationError(fallback, { cause: error });
  }
  throw error;
}

type ProviderRow = typeof schema.knowledgeProviders.$inferSelect;
type SourceRow = typeof schema.knowledgeSources.$inferSelect;
type AclRow = typeof schema.knowledgeSourceAclVersions.$inferSelect;
type SyncRow = typeof schema.knowledgeSyncRuns.$inferSelect;
type ObjectRow = typeof schema.knowledgeSourceObjects.$inferSelect;
type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;
type FactRow = typeof schema.knowledgeFacts.$inferSelect;
type ClaimRow = typeof schema.knowledgeClaims.$inferSelect;
type ProposalRow = typeof schema.knowledgeChangeProposals.$inferSelect;

function providerFromRow(row: ProviderRow): KnowledgeProviderRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    scope: scopeFromRow(row),
    providerKey: row.providerKey,
    externalTenantId: row.externalTenantId,
    lifecycleState: row.lifecycleState as KnowledgeLifecycleState,
    lifecycleGeneration: row.lifecycleGeneration,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function sourceFromRow(row: SourceRow): KnowledgeSourceRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    providerId: row.providerId,
    scope: scopeFromRow(row),
    externalSourceId: row.externalSourceId,
    sourceKind: row.sourceKind,
    sourceUri: row.sourceUri,
    currentAclGeneration: row.currentAclGeneration,
    syncGeneration: row.syncGeneration,
    syncCursor: row.syncCursor,
    lifecycleState: row.lifecycleState as KnowledgeLifecycleState,
    lifecycleGeneration: row.lifecycleGeneration,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function aclFromRow(row: AclRow): KnowledgeSourceAclVersionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sourceId: row.sourceId,
    generation: row.generation,
    aclVersion: row.aclVersion,
    aclHash: row.aclHash,
    audience: scopeFromRow(row),
    agentAccess: row.agentAccess,
    createdAt: iso(row.createdAt),
  };
}

function syncFromRow(row: SyncRow): KnowledgeSyncRunRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sourceId: row.sourceId,
    operationId: row.operationId,
    state: row.state as KnowledgeSyncRunRecord["state"],
    inputSyncGeneration: row.inputSyncGeneration,
    inputLifecycleGeneration: row.inputLifecycleGeneration,
    inputCursor: row.inputCursor,
    outputCursor: row.outputCursor,
    watermark: optionalIso(row.watermark),
    metadata: row.metadata,
    errorCode: row.errorCode,
    startedAt: iso(row.startedAt),
    completedAt: optionalIso(row.completedAt),
  };
}

function objectFromRow(row: ObjectRow): KnowledgeSourceObjectRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sourceId: row.sourceId,
    scope: scopeFromRow(row),
    externalObjectId: row.externalObjectId,
    documentId: row.documentId,
    lifecycleState: row.lifecycleState as KnowledgeLifecycleState,
    lifecycleGeneration: row.lifecycleGeneration,
    versionGeneration: row.versionGeneration,
    currentVersionId: row.currentVersionId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function versionFromRow(row: VersionRow): KnowledgeDocumentVersionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sourceId: row.sourceId,
    objectId: row.objectId,
    scope: scopeFromRow(row),
    versionGeneration: row.versionGeneration,
    externalVersionId: row.externalVersionId,
    contentSha256: row.contentSha256,
    ingestionKey: row.ingestionKey,
    aclVersionId: row.aclVersionId,
    aclGeneration: row.aclGeneration,
    documentId: row.documentId,
    fileId: row.fileId,
    createdAt: iso(row.createdAt),
  };
}

function factFromRow(row: FactRow): KnowledgeFactRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    scope: scopeFromRow(row),
    subjectEntityId: row.subjectEntityId,
    predicateKey: row.predicateKey,
    objectKind: row.objectKind as KnowledgeFactObjectKind,
    objectEntityId: row.objectEntityId,
    objectValue: row.objectValue ?? null,
    objectHash: row.objectHash,
    createdAt: iso(row.createdAt),
  };
}

function claimFromRow(row: ClaimRow): KnowledgeClaimRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    scope: scopeFromRow(row),
    factId: row.factId,
    origin: row.origin as KnowledgeClaimOrigin,
    confidenceBps: row.confidenceBps,
    effectiveAt: iso(row.effectiveAt),
    expiresAt: optionalIso(row.expiresAt),
    extractionMethod: row.extractionMethod,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    modelVersion: row.modelVersion,
    createdAt: iso(row.createdAt),
  };
}

function proposalFromRow(row: ProposalRow): KnowledgeChangeProposalRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    scope: scopeFromRow(row),
    targetKind: row.targetKind as KnowledgeChangeProposalRecord["targetKind"],
    targetScope: row.targetScope,
    targetKey: row.targetKey,
    content: row.content,
    contentHash: row.contentHash,
    claimId: row.claimId,
    evidenceId: row.evidenceId,
    status: "proposed",
    createdAt: iso(row.createdAt),
  };
}

export async function upsertKnowledgeProvider(
  db: Database,
  input: KnowledgeWriteContext & {
    providerKey: string;
    externalTenantId: string;
  },
): Promise<KnowledgeProviderRecord> {
  const providerKey = normalizedStableKey(input.providerKey, "providerKey", 96);
  const externalTenantId = boundedText(input.externalTenantId, "externalTenantId", 1024);
  const inputHash = scopedKnowledgeInputHash({
    scope: input.scope,
    providerKey,
    externalTenantId,
    actor: input.actor,
  });
  return await withKnowledgeWriteRls(db, input, async (scopedDb) => {
    try {
      const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        operationKind: "provider",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
      });
      if (receiptResultId) {
        const [replayed] = await scopedDb
          .select()
          .from(schema.knowledgeProviders)
          .where(eq(schema.knowledgeProviders.id, receiptResultId))
          .limit(1);
        if (!replayed) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Knowledge provider operation receipt has no visible result",
          );
        }
        return providerFromRow(replayed);
      }
      const [created] = await scopedDb
        .insert(schema.knowledgeProviders)
        .values({
          accountId: input.accountId,
          ...scopeColumns(input.scope),
          providerKey,
          externalTenantId,
          operationId: input.operationId,
          inputHash,
          ...actorColumns(input.actor),
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: input.scope,
          operationKind: "provider",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: created.id,
          actor: input.actor,
        });
        return providerFromRow(created);
      }
      const [operation, natural] = await Promise.all([
        scopedDb
          .select()
          .from(schema.knowledgeProviders)
          .where(
            and(
              eq(schema.knowledgeProviders.accountId, input.accountId),
              eq(schema.knowledgeProviders.operationId, input.operationId),
            ),
          )
          .limit(1),
        scopedDb
          .select()
          .from(schema.knowledgeProviders)
          .where(
            and(
              eq(schema.knowledgeProviders.accountId, input.accountId),
              eq(schema.knowledgeProviders.providerKey, providerKey),
              eq(schema.knowledgeProviders.externalTenantId, externalTenantId),
            ),
          )
          .limit(1),
      ]);
      const operationRow = operation[0];
      if (operationRow) {
        if (operationRow.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Provider operation id was replayed with different immutable input",
          );
        }
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: input.scope,
          operationKind: "provider",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: operationRow.id,
          actor: input.actor,
        });
        return providerFromRow(operationRow);
      }
      const naturalRow = natural[0];
      if (!naturalRow || !sameScope(naturalRow, input.scope)) {
        throw new ScopedKnowledgeConflictError("Provider external identity is already bound");
      }
      if (naturalRow.lifecycleState !== "active") {
        throw new ScopedKnowledgeInvalidOperationError(
          "Ordinary provider upsert cannot resurrect a tombstone",
        );
      }
      await recordConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        scope: input.scope,
        operationKind: "provider",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
        resultId: naturalRow.id,
        actor: input.actor,
      });
      return providerFromRow(naturalRow);
    } catch (error) {
      if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
      translatePersistenceError(error, "Knowledge provider upsert conflicted");
    }
  });
}

export async function upsertKnowledgeSource(
  db: Database,
  input: KnowledgeWriteContext & {
    providerId: string;
    externalSourceId: string;
    sourceKind: string;
    sourceUri?: string | null;
  },
): Promise<KnowledgeSourceRecord> {
  const externalSourceId = boundedText(input.externalSourceId, "externalSourceId", 1024);
  const sourceKind = normalizedStableKey(input.sourceKind, "sourceKind", 96);
  const sourceUri =
    input.sourceUri == null ? null : boundedText(input.sourceUri, "sourceUri", 4096);
  const inputHash = scopedKnowledgeInputHash({
    scope: input.scope,
    providerId: input.providerId,
    externalSourceId,
    sourceKind,
    sourceUri,
    actor: input.actor,
  });
  return await withKnowledgeWriteRls(db, input, async (scopedDb) => {
    try {
      const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        operationKind: "source",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
      });
      if (receiptResultId) {
        const [replayed] = await scopedDb
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, receiptResultId))
          .limit(1);
        if (!replayed) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Knowledge source operation receipt has no visible result",
          );
        }
        return sourceFromRow(replayed);
      }
      const [created] = await scopedDb
        .insert(schema.knowledgeSources)
        .values({
          accountId: input.accountId,
          ...scopeColumns(input.scope),
          providerId: input.providerId,
          externalSourceId,
          sourceKind,
          sourceUri,
          operationId: input.operationId,
          inputHash,
          ...actorColumns(input.actor),
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: input.scope,
          operationKind: "source",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: created.id,
          actor: input.actor,
        });
        return sourceFromRow(created);
      }
      const [operation, natural] = await Promise.all([
        scopedDb
          .select()
          .from(schema.knowledgeSources)
          .where(
            and(
              eq(schema.knowledgeSources.accountId, input.accountId),
              eq(schema.knowledgeSources.operationId, input.operationId),
            ),
          )
          .limit(1),
        scopedDb
          .select()
          .from(schema.knowledgeSources)
          .where(
            and(
              eq(schema.knowledgeSources.providerId, input.providerId),
              eq(schema.knowledgeSources.externalSourceId, externalSourceId),
            ),
          )
          .limit(1),
      ]);
      const operationRow = operation[0];
      if (operationRow) {
        if (operationRow.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Source operation id was replayed with different immutable input",
          );
        }
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: input.scope,
          operationKind: "source",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: operationRow.id,
          actor: input.actor,
        });
        return sourceFromRow(operationRow);
      }
      const naturalRow = natural[0];
      if (
        !naturalRow ||
        !sameScope(naturalRow, input.scope) ||
        naturalRow.sourceKind !== sourceKind ||
        naturalRow.sourceUri !== sourceUri
      ) {
        throw new ScopedKnowledgeConflictError(
          "Source external identity is already bound to different immutable metadata",
        );
      }
      if (naturalRow.lifecycleState !== "active") {
        throw new ScopedKnowledgeInvalidOperationError(
          "Ordinary source upsert cannot resurrect a tombstone",
        );
      }
      await recordConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        scope: input.scope,
        operationKind: "source",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
        resultId: naturalRow.id,
        actor: input.actor,
      });
      return sourceFromRow(naturalRow);
    } catch (error) {
      if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
      translatePersistenceError(error, "Knowledge source upsert conflicted");
    }
  });
}

export async function getKnowledgeSourceForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    initiatingSubjectId: string;
  },
): Promise<{ source: KnowledgeSourceRecord; provider: KnowledgeProviderRecord } | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ source: schema.knowledgeSources, provider: schema.knowledgeProviders })
      .from(schema.knowledgeSources)
      .innerJoin(
        schema.knowledgeProviders,
        and(
          eq(schema.knowledgeProviders.accountId, schema.knowledgeSources.accountId),
          eq(schema.knowledgeProviders.id, schema.knowledgeSources.providerId),
          eq(schema.knowledgeProviders.scopeKey, schema.knowledgeSources.scopeKey),
        ),
      )
      .where(
        and(
          eq(schema.knowledgeSources.accountId, input.accountId),
          eq(schema.knowledgeSources.id, input.sourceId),
        ),
      )
      .limit(1);
    return row
      ? { source: sourceFromRow(row.source), provider: providerFromRow(row.provider) }
      : null;
  });
}

export async function getKnowledgeSourceByExternalIdentityForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerId: string;
    externalSourceId: string;
    initiatingSubjectId: string;
  },
): Promise<KnowledgeSourceRecord | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.accountId, input.accountId),
          eq(schema.knowledgeSources.providerId, input.providerId),
          eq(schema.knowledgeSources.externalSourceId, input.externalSourceId),
        ),
      )
      .limit(1);
    return row ? sourceFromRow(row) : null;
  });
}

export async function getKnowledgeSourceAclForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    generation: number;
    initiatingSubjectId: string;
  },
): Promise<KnowledgeSourceAclVersionRecord | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeSourceAclVersions)
      .where(
        and(
          eq(schema.knowledgeSourceAclVersions.accountId, input.accountId),
          eq(schema.knowledgeSourceAclVersions.sourceId, input.sourceId),
          eq(schema.knowledgeSourceAclVersions.generation, input.generation),
        ),
      )
      .limit(1);
    return row ? aclFromRow(row) : null;
  });
}

export async function getKnowledgeSourceObjectForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    externalObjectId: string;
    initiatingSubjectId: string;
  },
): Promise<KnowledgeSourceObjectRecord | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeSourceObjects)
      .where(
        and(
          eq(schema.knowledgeSourceObjects.accountId, input.accountId),
          eq(schema.knowledgeSourceObjects.sourceId, input.sourceId),
          eq(schema.knowledgeSourceObjects.externalObjectId, input.externalObjectId),
        ),
      )
      .limit(1);
    return row ? objectFromRow(row) : null;
  });
}

export async function getKnowledgeDocumentVersionForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    versionId: string;
    initiatingSubjectId: string;
  },
): Promise<KnowledgeDocumentVersionRecord | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeDocumentVersions)
      .where(
        and(
          eq(schema.knowledgeDocumentVersions.accountId, input.accountId),
          eq(schema.knowledgeDocumentVersions.id, input.versionId),
        ),
      )
      .limit(1);
    return row ? versionFromRow(row) : null;
  });
}

export async function getKnowledgeDocumentVersionObservationForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    versionId: string;
    initiatingSubjectId: string;
  },
): Promise<{
  version: KnowledgeDocumentVersionRecord;
  sourceMetadata: Record<string, unknown>;
  sourceUpdatedAt: string | null;
  locationMetadata: Record<string, unknown>;
  documentChunkCount: number;
} | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeDocumentVersions)
      .where(
        and(
          eq(schema.knowledgeDocumentVersions.accountId, input.accountId),
          eq(schema.knowledgeDocumentVersions.id, input.versionId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [document] = row.documentId
      ? await scopedDb
          .select({ chunkCount: schema.documents.chunkCount })
          .from(schema.documents)
          .where(eq(schema.documents.id, row.documentId))
          .limit(1)
      : [];
    return {
      version: versionFromRow(row),
      sourceMetadata: row.sourceMetadata,
      sourceUpdatedAt: optionalIso(row.sourceUpdatedAt),
      locationMetadata: row.locationMetadata,
      documentChunkCount: document?.chunkCount ?? 0,
    };
  });
}

export async function appendKnowledgeSourceAclVersion(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    sourceId: string;
    audience: ScopedKnowledgeScope;
    expectedSourceLifecycleGeneration: number;
    expectedAclGeneration: number;
    aclVersion?: string | null;
    agentAccess: boolean;
    reasonCode: string;
  },
): Promise<KnowledgeSourceAclVersionRecord> {
  const aclVersion =
    input.aclVersion == null ? null : boundedText(input.aclVersion, "aclVersion", 512);
  const reasonCode = normalizedStableKey(input.reasonCode, "reasonCode", 128);
  const inputHash = scopedKnowledgeInputHash({
    sourceId: input.sourceId,
    audience: input.audience,
    expectedSourceLifecycleGeneration: input.expectedSourceLifecycleGeneration,
    expectedAclGeneration: input.expectedAclGeneration,
    aclVersion,
    agentAccess: input.agentAccess,
    reasonCode,
    actor: input.actor,
  });
  const aclHash = scopedKnowledgeInputHash({
    audience: input.audience,
    aclVersion,
    agentAccess: input.agentAccess,
  });
  return await withKnowledgeWriteRls(db, { ...input, scope: input.audience }, async (scopedDb) => {
    try {
      const [existing] = await scopedDb
        .select()
        .from(schema.knowledgeSourceAclVersions)
        .where(
          and(
            eq(schema.knowledgeSourceAclVersions.sourceId, input.sourceId),
            eq(schema.knowledgeSourceAclVersions.operationId, input.operationId),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "ACL operation id was replayed with different input",
          );
        }
        return aclFromRow(existing);
      }
      const [source] = await scopedDb
        .select()
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.id, input.sourceId))
        .limit(1);
      if (!source) throw new ScopedKnowledgeNotFoundError("Knowledge source was not found");
      if (source.lifecycleState !== "active") {
        throw new ScopedKnowledgeInvalidOperationError(
          "Ordinary source-object upsert cannot write beneath a source tombstone",
        );
      }
      const [created] = await scopedDb
        .insert(schema.knowledgeSourceAclVersions)
        .values({
          accountId: input.accountId,
          ...scopeColumns(input.audience),
          sourceId: input.sourceId,
          sourceScopeKey: source.scopeKey,
          generation: input.expectedAclGeneration + 1,
          aclVersion,
          aclHash,
          agentAccess: input.agentAccess,
          operationId: input.operationId,
          inputHash,
          ...actorColumns(input.actor),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [replayed] = await scopedDb
          .select()
          .from(schema.knowledgeSourceAclVersions)
          .where(
            and(
              eq(schema.knowledgeSourceAclVersions.sourceId, input.sourceId),
              eq(schema.knowledgeSourceAclVersions.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (replayed?.inputHash === inputHash) return aclFromRow(replayed);
        throw new ScopedKnowledgeGenerationConflictError(
          "Another ACL version already advanced this source generation",
        );
      }
      await scopedDb.execute(sql`
          SELECT scoped_knowledge_advance_source_acl(
            ${input.accountId}::uuid,
            ${input.sourceId}::uuid,
            ${input.expectedSourceLifecycleGeneration}::bigint,
            ${input.expectedAclGeneration}::bigint,
            ${created.id}::uuid,
            ${input.operationId},
            ${inputHash},
            ${reasonCode},
            ${input.actor.kind},
            ${input.actor.subjectId},
            ${input.actor.initiatingHumanSubjectId}
          )
        `);
      return aclFromRow(created);
    } catch (error) {
      if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
      translatePersistenceError(error, "Knowledge ACL append conflicted");
    }
  });
}

/** Atomically advance the source ACL to a deny generation and revoke every
 * materialized retrieval path. Delivery pause alone is never authorization. */
export async function deauthorizeKnowledgeSourceRetrieval(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    sourceId: string;
    audience: ScopedKnowledgeScope;
    reasonCode: string;
  },
): Promise<KnowledgeSourceAclVersionRecord> {
  const reasonCode = normalizedStableKey(input.reasonCode, "reasonCode", 128);
  return await withKnowledgeWriteRls(db, { ...input, scope: input.audience }, async (scopedDb) => {
    const [source] = await scopedDb
      .select()
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, input.sourceId))
      .limit(1);
    if (!source) throw new ScopedKnowledgeNotFoundError("Knowledge source was not found");
    if (source.lifecycleState !== "active") {
      throw new ScopedKnowledgeInvalidOperationError(
        "A tombstoned knowledge source cannot be deauthorized",
      );
    }
    const acl = await appendKnowledgeSourceAclVersion(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      audience: input.audience,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedAclGeneration: source.currentAclGeneration ?? 0,
      aclVersion: `opengeni-deny:${reasonCode}`,
      agentAccess: false,
      operationId: input.operationId,
      reasonCode,
      actor: input.actor,
    });
    const revokedAt = new Date();
    const versions = await scopedDb
      .select({ documentId: schema.knowledgeDocumentVersions.documentId })
      .from(schema.knowledgeDocumentVersions)
      .where(eq(schema.knowledgeDocumentVersions.sourceId, input.sourceId));
    const documentIds = [
      ...new Set(versions.flatMap((version) => (version.documentId ? [version.documentId] : []))),
    ];
    await scopedDb
      .update(schema.knowledgeSourceSyncIndexObligations)
      .set({
        status: "invalidated",
        aclEligibility: "denied",
        failureCode: reasonCode,
        updatedAt: revokedAt,
      })
      .where(eq(schema.knowledgeSourceSyncIndexObligations.sourceId, input.sourceId));
    if (documentIds.length > 0) {
      await scopedDb
        .update(schema.documents)
        .set({ agentAccess: false, chunkCount: 0, updatedAt: revokedAt })
        .where(inArray(schema.documents.id, documentIds));
      await scopedDb
        .delete(schema.documentChunks)
        .where(inArray(schema.documentChunks.documentId, documentIds));
    }
    return acl;
  });
}

type KnowledgeDocumentObservationMetadata = {
  title: string;
  sourceUri: string;
  sourceVersion: string;
  sourceUpdatedAt: Date | null;
};

async function lockActiveKnowledgeDocumentAuthority(
  scopedDb: Database,
  input: {
    accountId: string;
    sourceId: string;
    expectedSourceLifecycleGeneration: number;
    objectId: string;
    expectedObjectLifecycleGeneration: number;
  },
): Promise<{ currentVersionId: string | null }> {
  await scopedDb.execute(sql`
    SELECT knowledge_source_sync_lock_authority(
      ${input.accountId}::uuid,
      ${input.sourceId}::uuid,
      ${input.objectId}::uuid
    )
  `);
  const [[source], [object]] = await Promise.all([
    scopedDb
      .select({
        lifecycleState: schema.knowledgeSources.lifecycleState,
        lifecycleGeneration: schema.knowledgeSources.lifecycleGeneration,
      })
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, input.sourceId))
      .limit(1),
    scopedDb
      .select({
        sourceId: schema.knowledgeSourceObjects.sourceId,
        lifecycleState: schema.knowledgeSourceObjects.lifecycleState,
        lifecycleGeneration: schema.knowledgeSourceObjects.lifecycleGeneration,
        currentVersionId: schema.knowledgeSourceObjects.currentVersionId,
      })
      .from(schema.knowledgeSourceObjects)
      .where(eq(schema.knowledgeSourceObjects.id, input.objectId))
      .limit(1),
  ]);
  if (
    !source ||
    !object ||
    source.lifecycleState !== "active" ||
    source.lifecycleGeneration !== input.expectedSourceLifecycleGeneration ||
    object.sourceId !== input.sourceId ||
    object.lifecycleState !== "active" ||
    object.lifecycleGeneration !== input.expectedObjectLifecycleGeneration
  ) {
    throw new ScopedKnowledgeGenerationConflictError(
      "Knowledge document metadata authority is no longer active",
    );
  }
  return { currentVersionId: object.currentVersionId };
}

async function convergeKnowledgeDocumentObservationMetadata(
  scopedDb: Database,
  input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
    metadata: KnowledgeDocumentObservationMetadata;
  },
): Promise<void> {
  const updatedAt = new Date();
  const chunkProvenanceMetadata = JSON.stringify({
    documentTitle: input.metadata.title,
    sourceUri: input.metadata.sourceUri,
    sourceTitle: input.metadata.title,
    sourceUpdatedAt: input.metadata.sourceUpdatedAt?.toISOString() ?? null,
    sourceVersion: input.metadata.sourceVersion,
  });
  const [updated] = await scopedDb
    .update(schema.documents)
    .set({
      title: input.metadata.title,
      sourceUri: input.metadata.sourceUri,
      sourceTitle: input.metadata.title,
      sourceVersion: input.metadata.sourceVersion,
      sourceUpdatedAt: input.metadata.sourceUpdatedAt,
      updatedAt,
    })
    .where(
      and(
        eq(schema.documents.accountId, input.accountId),
        eq(schema.documents.workspaceId, input.workspaceId),
        eq(schema.documents.id, input.documentId),
      ),
    )
    .returning({ id: schema.documents.id });
  if (!updated) throw new ScopedKnowledgeNotFoundError("Knowledge document was not found");

  await scopedDb
    .update(schema.documentChunks)
    .set({
      metadata: sql<Record<string, unknown>>`${schema.documentChunks.metadata} ||
        ${chunkProvenanceMetadata}::jsonb`,
    })
    .where(
      and(
        eq(schema.documentChunks.accountId, input.accountId),
        eq(schema.documentChunks.workspaceId, input.workspaceId),
        eq(schema.documentChunks.documentId, input.documentId),
      ),
    );
}

export async function updateKnowledgeSourceDocumentObservationMetadata(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initiatingSubjectId: string;
    sourceId: string;
    expectedSourceLifecycleGeneration: number;
    objectId: string;
    expectedObjectLifecycleGeneration: number;
    versionId: string;
    documentId: string;
    title: string;
    sourceUri: string;
    sourceVersion: string;
    sourceUpdatedAt: string | null;
  },
): Promise<void> {
  const metadata: KnowledgeDocumentObservationMetadata = {
    title: boundedText(input.title, "title", 1000),
    sourceUri: boundedText(input.sourceUri, "sourceUri", 4096),
    sourceVersion: boundedText(input.sourceVersion, "sourceVersion", 1024),
    sourceUpdatedAt: input.sourceUpdatedAt ? new Date(input.sourceUpdatedAt) : null,
  };
  await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const object = await lockActiveKnowledgeDocumentAuthority(scopedDb, input);
    const [version] = await scopedDb
      .select()
      .from(schema.knowledgeDocumentVersions)
      .where(eq(schema.knowledgeDocumentVersions.id, input.versionId))
      .limit(1);
    if (
      !object ||
      !version ||
      object.currentVersionId !== input.versionId ||
      version.sourceId !== input.sourceId ||
      version.objectId !== input.objectId ||
      version.documentId !== input.documentId
    ) {
      throw new ScopedKnowledgeGenerationConflictError(
        "Knowledge document metadata observation is no longer current",
      );
    }
    await convergeKnowledgeDocumentObservationMetadata(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      metadata,
    });
  });
}

export async function beginKnowledgeSyncRun(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    sourceId: string;
    expectedSourceLifecycleGeneration: number;
    expectedSyncGeneration: number;
    inputCursor: string | null;
  },
): Promise<KnowledgeSyncRunRecord> {
  const inputCursor =
    input.inputCursor == null ? null : boundedText(input.inputCursor, "inputCursor", 4096);
  const inputHash = scopedKnowledgeInputHash({
    sourceId: input.sourceId,
    expectedSourceLifecycleGeneration: input.expectedSourceLifecycleGeneration,
    expectedSyncGeneration: input.expectedSyncGeneration,
    inputCursor,
    actor: input.actor,
  });
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [existing] = await scopedDb
          .select()
          .from(schema.knowledgeSyncRuns)
          .where(
            and(
              eq(schema.knowledgeSyncRuns.sourceId, input.sourceId),
              eq(schema.knowledgeSyncRuns.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.inputHash !== inputHash) {
            throw new ScopedKnowledgeConflictError(
              "Sync operation id was replayed with different input",
            );
          }
          return syncFromRow(existing);
        }
        const [source] = await scopedDb
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, input.sourceId))
          .limit(1);
        if (!source) throw new ScopedKnowledgeNotFoundError("Knowledge source was not found");
        if (
          source.lifecycleState !== "active" ||
          source.lifecycleGeneration !== input.expectedSourceLifecycleGeneration ||
          source.syncGeneration !== input.expectedSyncGeneration ||
          source.syncCursor !== inputCursor
        ) {
          throw new ScopedKnowledgeGenerationConflictError(
            "Knowledge source sync generation, cursor, or lifecycle changed",
          );
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeSyncRuns)
          .values({
            accountId: input.accountId,
            scopeKind: source.scopeKind,
            scopeWorkspaceId: source.scopeWorkspaceId,
            scopeSubjectId: source.scopeSubjectId,
            scopeKey: source.scopeKey,
            sourceId: input.sourceId,
            inputSyncGeneration: input.expectedSyncGeneration,
            inputLifecycleGeneration: input.expectedSourceLifecycleGeneration,
            inputCursor,
            inputHash,
            operationId: input.operationId,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (created) return syncFromRow(created);
        const [replayed] = await scopedDb
          .select()
          .from(schema.knowledgeSyncRuns)
          .where(
            and(
              eq(schema.knowledgeSyncRuns.sourceId, input.sourceId),
              eq(schema.knowledgeSyncRuns.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (replayed?.inputHash === inputHash) return syncFromRow(replayed);
        throw new ScopedKnowledgeConflictError("Sync operation identity conflicted");
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge sync start conflicted");
      }
    },
  );
}

export async function getKnowledgeSyncRunForSyncAuthority(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    operationId: string;
    initiatingSubjectId: string;
  },
): Promise<KnowledgeSyncRunRecord | null> {
  return await withKnowledgeReadRls(db, { ...input, surface: "human" }, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeSyncRuns)
      .where(
        and(
          eq(schema.knowledgeSyncRuns.accountId, input.accountId),
          eq(schema.knowledgeSyncRuns.sourceId, input.sourceId),
          eq(schema.knowledgeSyncRuns.operationId, input.operationId),
        ),
      )
      .limit(1);
    return row ? syncFromRow(row) : null;
  });
}

export async function completeKnowledgeSyncRun(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initiatingSubjectId: string | null;
    runId: string;
    state: "succeeded" | "failed";
    outputCursor?: string | null;
    watermark?: string | null;
    metadata?: Record<string, unknown> | undefined;
    errorCode?: string | null;
    reasonCode: string;
  },
): Promise<KnowledgeSyncRunRecord> {
  const outputCursor =
    input.outputCursor == null ? null : boundedText(input.outputCursor, "outputCursor", 4096);
  const errorCode =
    input.errorCode == null ? null : normalizedStableKey(input.errorCode, "errorCode", 128);
  const reasonCode = normalizedStableKey(input.reasonCode, "reasonCode", 128);
  const metadata = input.metadata ?? {};
  if (input.state === "failed" && !errorCode) {
    throw new ScopedKnowledgeInvalidOperationError("A failed sync completion requires errorCode");
  }
  const completionHash = scopedKnowledgeInputHash({
    state: input.state,
    outputCursor: input.state === "succeeded" ? outputCursor : null,
    watermark: input.watermark ?? null,
    metadata,
    errorCode: input.state === "failed" ? errorCode : null,
    reasonCode,
  });
  return await withKnowledgeAuthorityRls(db, input, async (scopedDb) => {
    try {
      await scopedDb.execute(sql`
          SELECT * FROM scoped_knowledge_complete_sync(
            ${input.accountId}::uuid,
            ${input.runId}::uuid,
            ${input.state},
            ${input.state === "succeeded" ? outputCursor : null},
            ${input.watermark ? new Date(input.watermark) : null}::timestamptz,
            ${JSON.stringify(metadata)}::jsonb,
            ${input.state === "failed" ? errorCode : null},
            ${completionHash},
            ${reasonCode}
          )
        `);
      const [row] = await scopedDb
        .select()
        .from(schema.knowledgeSyncRuns)
        .where(
          and(
            eq(schema.knowledgeSyncRuns.accountId, input.accountId),
            eq(schema.knowledgeSyncRuns.id, input.runId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("Knowledge sync completion returned no row");
      return syncFromRow(row);
    } catch (error) {
      if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
      translatePersistenceError(error, "Knowledge sync completion conflicted");
    }
  });
}

export async function upsertKnowledgeSourceObject(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    sourceId: string;
    externalObjectId: string;
    documentId?: string | null;
  },
): Promise<KnowledgeSourceObjectRecord> {
  const externalObjectId = boundedText(input.externalObjectId, "externalObjectId", 1024);
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [source] = await scopedDb
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, input.sourceId))
          .limit(1);
        if (!source) throw new ScopedKnowledgeNotFoundError("Knowledge source was not found");
        const sourceScope = scopeFromRow(source);
        validateScope(sourceScope, input.workspaceId, input.actor.initiatingHumanSubjectId);
        const inputHash = scopedKnowledgeInputHash({
          sourceId: input.sourceId,
          scope: sourceScope,
          externalObjectId,
          documentId: input.documentId ?? null,
          actor: input.actor,
        });
        const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          operationKind: "source_object",
          operationNamespace: input.sourceId,
          operationId: input.operationId,
          inputHash,
        });
        if (receiptResultId) {
          const [replayed] = await scopedDb
            .select()
            .from(schema.knowledgeSourceObjects)
            .where(eq(schema.knowledgeSourceObjects.id, receiptResultId))
            .limit(1);
          if (!replayed) {
            throw new ScopedKnowledgeInvalidOperationError(
              "Knowledge source-object operation receipt has no visible result",
            );
          }
          return objectFromRow(replayed);
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeSourceObjects)
          .values({
            accountId: input.accountId,
            scopeKind: source.scopeKind,
            scopeWorkspaceId: source.scopeWorkspaceId,
            scopeSubjectId: source.scopeSubjectId,
            scopeKey: source.scopeKey,
            sourceId: input.sourceId,
            externalObjectId,
            documentId: input.documentId ?? null,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: sourceScope,
            operationKind: "source_object",
            operationNamespace: input.sourceId,
            operationId: input.operationId,
            inputHash,
            resultId: created.id,
            actor: input.actor,
          });
          return objectFromRow(created);
        }
        const [operation, natural] = await Promise.all([
          scopedDb
            .select()
            .from(schema.knowledgeSourceObjects)
            .where(
              and(
                eq(schema.knowledgeSourceObjects.sourceId, input.sourceId),
                eq(schema.knowledgeSourceObjects.operationId, input.operationId),
              ),
            )
            .limit(1),
          scopedDb
            .select()
            .from(schema.knowledgeSourceObjects)
            .where(
              and(
                eq(schema.knowledgeSourceObjects.sourceId, input.sourceId),
                eq(schema.knowledgeSourceObjects.externalObjectId, externalObjectId),
              ),
            )
            .limit(1),
        ]);
        const operationRow = operation[0];
        if (operationRow) {
          if (operationRow.inputHash !== inputHash) {
            throw new ScopedKnowledgeConflictError(
              "Source-object operation id was replayed with different input",
            );
          }
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: sourceScope,
            operationKind: "source_object",
            operationNamespace: input.sourceId,
            operationId: input.operationId,
            inputHash,
            resultId: operationRow.id,
            actor: input.actor,
          });
          return objectFromRow(operationRow);
        }
        const naturalRow = natural[0];
        if (!naturalRow || naturalRow.documentId !== (input.documentId ?? null)) {
          throw new ScopedKnowledgeConflictError(
            "Source-object external identity is already bound to different immutable metadata",
          );
        }
        if (naturalRow.lifecycleState !== "active") {
          throw new ScopedKnowledgeInvalidOperationError(
            "Ordinary source-object upsert cannot resurrect a tombstone",
          );
        }
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: sourceScope,
          operationKind: "source_object",
          operationNamespace: input.sourceId,
          operationId: input.operationId,
          inputHash,
          resultId: naturalRow.id,
          actor: input.actor,
        });
        return objectFromRow(naturalRow);
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge source-object upsert conflicted");
      }
    },
  );
}

export async function appendKnowledgeDocumentVersion(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    objectId: string;
    expectedSourceLifecycleGeneration: number;
    expectedObjectLifecycleGeneration: number;
    expectedVersionGeneration: number;
    externalVersionId: string;
    contentSha256: string;
    ingestionKey: string;
    sourceCursor?: string | null;
    sourceMetadata?: Record<string, unknown> | undefined;
    sourceCreatedAt?: string | null;
    sourceUpdatedAt?: string | null;
    aclVersionId: string;
    aclGeneration: number;
    documentId?: string | null;
    fileId?: string | null;
    locationMetadata?: Record<string, unknown> | undefined;
    documentObservationMetadata?: {
      title: string;
      sourceUri: string;
      sourceVersion: string;
      sourceUpdatedAt: string | null;
    };
    reasonCode: string;
  },
): Promise<KnowledgeDocumentVersionRecord> {
  const externalVersionId = boundedText(input.externalVersionId, "externalVersionId", 1024);
  const contentSha256 = sha256(input.contentSha256, "contentSha256");
  const ingestionKey = boundedText(input.ingestionKey, "ingestionKey", 512);
  const sourceCursor =
    input.sourceCursor == null ? null : boundedText(input.sourceCursor, "sourceCursor", 4096);
  const reasonCode = normalizedStableKey(input.reasonCode, "reasonCode", 128);
  const documentObservationMetadata = input.documentObservationMetadata
    ? {
        title: boundedText(input.documentObservationMetadata.title, "title", 1000),
        sourceUri: boundedText(input.documentObservationMetadata.sourceUri, "sourceUri", 4096),
        sourceVersion: boundedText(
          input.documentObservationMetadata.sourceVersion,
          "sourceVersion",
          1024,
        ),
        sourceUpdatedAt: input.documentObservationMetadata.sourceUpdatedAt,
      }
    : null;
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [object] = await scopedDb
          .select()
          .from(schema.knowledgeSourceObjects)
          .where(eq(schema.knowledgeSourceObjects.id, input.objectId))
          .limit(1);
        if (!object)
          throw new ScopedKnowledgeNotFoundError("Knowledge source object was not found");
        const objectScope = scopeFromRow(object);
        validateScope(objectScope, input.workspaceId, input.actor.initiatingHumanSubjectId);
        const inputHash = scopedKnowledgeInputHash({
          objectId: input.objectId,
          expectedSourceLifecycleGeneration: input.expectedSourceLifecycleGeneration,
          expectedObjectLifecycleGeneration: input.expectedObjectLifecycleGeneration,
          expectedVersionGeneration: input.expectedVersionGeneration,
          externalVersionId,
          contentSha256,
          ingestionKey,
          sourceCursor,
          sourceMetadata: input.sourceMetadata ?? {},
          sourceCreatedAt: input.sourceCreatedAt ?? null,
          sourceUpdatedAt: input.sourceUpdatedAt ?? null,
          aclVersionId: input.aclVersionId,
          aclGeneration: input.aclGeneration,
          documentId: input.documentId ?? null,
          fileId: input.fileId ?? null,
          locationMetadata: input.locationMetadata ?? {},
          documentObservationMetadata,
          reasonCode,
          actor: input.actor,
        });
        const convergeDocumentObservation = async (version: VersionRow): Promise<void> => {
          if (!documentObservationMetadata) return;
          if (!version.documentId || version.documentId !== (input.documentId ?? null)) {
            throw new ScopedKnowledgeConflictError(
              "Knowledge document observation metadata has no matching document",
            );
          }
          const liveObject = await lockActiveKnowledgeDocumentAuthority(scopedDb, {
            accountId: input.accountId,
            sourceId: object.sourceId,
            expectedSourceLifecycleGeneration: input.expectedSourceLifecycleGeneration,
            objectId: input.objectId,
            expectedObjectLifecycleGeneration: input.expectedObjectLifecycleGeneration,
          });
          if (version.sourceId !== object.sourceId || liveObject.currentVersionId !== version.id) {
            throw new ScopedKnowledgeGenerationConflictError(
              "Knowledge document metadata observation is no longer current",
            );
          }
          await convergeKnowledgeDocumentObservationMetadata(scopedDb, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            documentId: version.documentId,
            metadata: {
              title: documentObservationMetadata.title,
              sourceUri: documentObservationMetadata.sourceUri,
              sourceVersion: documentObservationMetadata.sourceVersion,
              sourceUpdatedAt: documentObservationMetadata.sourceUpdatedAt
                ? new Date(documentObservationMetadata.sourceUpdatedAt)
                : null,
            },
          });
        };
        const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          operationKind: "document_version",
          operationNamespace: input.objectId,
          operationId: input.operationId,
          inputHash,
        });
        if (receiptResultId) {
          const [replayed] = await scopedDb
            .select()
            .from(schema.knowledgeDocumentVersions)
            .where(eq(schema.knowledgeDocumentVersions.id, receiptResultId))
            .limit(1);
          if (!replayed) {
            throw new ScopedKnowledgeInvalidOperationError(
              "Knowledge document-version operation receipt has no visible result",
            );
          }
          await convergeDocumentObservation(replayed);
          return versionFromRow(replayed);
        }
        const existingRows = await scopedDb
          .select()
          .from(schema.knowledgeDocumentVersions)
          .where(
            and(
              eq(schema.knowledgeDocumentVersions.objectId, input.objectId),
              sql`(
                ${schema.knowledgeDocumentVersions.operationId} = ${input.operationId}
                OR ${schema.knowledgeDocumentVersions.ingestionKey} = ${ingestionKey}
              )`,
            ),
          )
          .limit(3);
        const existing = existingRows[0];
        if (existing) {
          if (
            existingRows.some((row) => row.id !== existing.id) ||
            existing.inputHash !== inputHash
          ) {
            throw new ScopedKnowledgeConflictError(
              "Document-version key was replayed with different immutable input",
            );
          }
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: objectScope,
            operationKind: "document_version",
            operationNamespace: input.objectId,
            operationId: input.operationId,
            inputHash,
            resultId: existing.id,
            actor: input.actor,
          });
          await convergeDocumentObservation(existing);
          return versionFromRow(existing);
        }
        const [source, acl] = await Promise.all([
          scopedDb
            .select()
            .from(schema.knowledgeSources)
            .where(eq(schema.knowledgeSources.id, object.sourceId))
            .limit(1),
          scopedDb
            .select()
            .from(schema.knowledgeSourceAclVersions)
            .where(
              and(
                eq(schema.knowledgeSourceAclVersions.id, input.aclVersionId),
                eq(schema.knowledgeSourceAclVersions.sourceId, object.sourceId),
                eq(schema.knowledgeSourceAclVersions.generation, input.aclGeneration),
              ),
            )
            .limit(1),
        ]);
        const sourceRow = source[0];
        if (!sourceRow || !acl[0]) {
          throw new ScopedKnowledgeNotFoundError("Knowledge source or ACL version was not found");
        }
        if (
          object.lifecycleState !== "active" ||
          object.lifecycleGeneration !== input.expectedObjectLifecycleGeneration ||
          object.versionGeneration !== input.expectedVersionGeneration ||
          sourceRow.lifecycleState !== "active" ||
          sourceRow.lifecycleGeneration !== input.expectedSourceLifecycleGeneration ||
          sourceRow.currentAclGeneration !== input.aclGeneration
        ) {
          throw new ScopedKnowledgeGenerationConflictError(
            "Knowledge object/source lifecycle, version, or ACL generation changed",
          );
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeDocumentVersions)
          .values({
            accountId: input.accountId,
            scopeKind: object.scopeKind,
            scopeWorkspaceId: object.scopeWorkspaceId,
            scopeSubjectId: object.scopeSubjectId,
            scopeKey: object.scopeKey,
            sourceId: object.sourceId,
            objectId: object.id,
            versionGeneration: input.expectedVersionGeneration + 1,
            externalVersionId,
            contentSha256,
            ingestionKey,
            sourceCursor,
            sourceMetadata: input.sourceMetadata ?? {},
            sourceCreatedAt: input.sourceCreatedAt ? new Date(input.sourceCreatedAt) : null,
            sourceUpdatedAt: input.sourceUpdatedAt ? new Date(input.sourceUpdatedAt) : null,
            aclVersionId: input.aclVersionId,
            aclGeneration: input.aclGeneration,
            documentId: input.documentId ?? null,
            fileId: input.fileId ?? null,
            locationMetadata: input.locationMetadata ?? {},
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          const [converged] = await scopedDb
            .select()
            .from(schema.knowledgeDocumentVersions)
            .where(
              and(
                eq(schema.knowledgeDocumentVersions.objectId, input.objectId),
                sql`(
                  ${schema.knowledgeDocumentVersions.operationId} = ${input.operationId}
                  OR ${schema.knowledgeDocumentVersions.ingestionKey} = ${ingestionKey}
                )`,
              ),
            )
            .limit(1);
          if (converged?.inputHash === inputHash) {
            await recordConvergentKnowledgeOperation(scopedDb, {
              accountId: input.accountId,
              scope: objectScope,
              operationKind: "document_version",
              operationNamespace: input.objectId,
              operationId: input.operationId,
              inputHash,
              resultId: converged.id,
              actor: input.actor,
            });
            await convergeDocumentObservation(converged);
            return versionFromRow(converged);
          }
          throw new ScopedKnowledgeGenerationConflictError(
            "Another document version already advanced this object generation",
          );
        }
        await scopedDb.execute(sql`
          SELECT scoped_knowledge_advance_object_version(
            ${input.accountId}::uuid,
            ${input.objectId}::uuid,
            ${input.expectedObjectLifecycleGeneration}::bigint,
            ${input.expectedVersionGeneration}::bigint,
            ${created.id}::uuid,
            ${input.operationId},
            ${inputHash},
            ${reasonCode},
            ${input.actor.kind},
            ${input.actor.subjectId},
            ${input.actor.initiatingHumanSubjectId}
          )
        `);
        await convergeDocumentObservation(created);
        if (object.currentVersionId) {
          const [previousVersion] = await scopedDb
            .select({ documentId: schema.knowledgeDocumentVersions.documentId })
            .from(schema.knowledgeDocumentVersions)
            .where(eq(schema.knowledgeDocumentVersions.id, object.currentVersionId))
            .limit(1);
          if (previousVersion?.documentId) {
            const retiredAt = new Date();
            await scopedDb
              .update(schema.knowledgeSourceSyncIndexObligations)
              .set({
                status: "invalidated",
                aclEligibility: "denied",
                failureCode: "superseded_source_version",
                updatedAt: retiredAt,
              })
              .where(
                eq(
                  schema.knowledgeSourceSyncIndexObligations.knowledgeDocumentVersionId,
                  object.currentVersionId,
                ),
              );
            await scopedDb
              .update(schema.documents)
              .set({ agentAccess: false, updatedAt: retiredAt })
              .where(eq(schema.documents.id, previousVersion.documentId));
            if (previousVersion.documentId !== created.documentId) {
              await scopedDb
                .update(schema.documents)
                .set({ chunkCount: 0, updatedAt: retiredAt })
                .where(eq(schema.documents.id, previousVersion.documentId));
              await scopedDb
                .delete(schema.documentChunks)
                .where(eq(schema.documentChunks.documentId, previousVersion.documentId));
            }
          }
        }
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: objectScope,
          operationKind: "document_version",
          operationNamespace: input.objectId,
          operationId: input.operationId,
          inputHash,
          resultId: created.id,
          actor: input.actor,
        });
        return versionFromRow(created);
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge document-version append conflicted");
      }
    },
  );
}

export async function recordKnowledgeLifecycleEvent(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    targetKind: "provider" | "source" | "object";
    targetId: string;
    eventType: Extract<KnowledgeLifecycleEventType, "deleted" | "revoked" | "restored">;
    expectedGeneration: number;
    reasonCode: string;
  },
): Promise<{
  targetId: string;
  lifecycleState: KnowledgeLifecycleState;
  lifecycleGeneration: number;
  replayed: boolean;
}> {
  const reasonCode = normalizedStableKey(input.reasonCode, "reasonCode", 128);
  const inputHash = scopedKnowledgeInputHash({
    targetKind: input.targetKind,
    targetId: input.targetId,
    eventType: input.eventType,
    expectedGeneration: input.expectedGeneration,
    reasonCode,
    actor: input.actor,
  });
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const rows = (await scopedDb.execute(sql`
          SELECT * FROM scoped_knowledge_apply_lifecycle(
            ${input.accountId}::uuid,
            ${input.targetKind},
            ${input.targetId}::uuid,
            ${input.eventType},
            ${input.expectedGeneration}::bigint,
            ${input.operationId},
            ${inputHash},
            ${reasonCode},
            ${input.actor.kind},
            ${input.actor.subjectId},
            ${input.actor.initiatingHumanSubjectId}
          )
        `)) as unknown as Array<{
          target_id: string;
          lifecycle_state: KnowledgeLifecycleState;
          lifecycle_generation: number | string;
          replayed: boolean;
        }>;
        const row = rows[0];
        if (!row) throw new Error("Knowledge lifecycle transition returned no row");
        if (
          (input.targetKind === "source" || input.targetKind === "object") &&
          input.eventType !== "restored"
        ) {
          const retiredAt = new Date();
          const versions = await scopedDb
            .select({ documentId: schema.knowledgeDocumentVersions.documentId })
            .from(schema.knowledgeDocumentVersions)
            .where(
              input.targetKind === "source"
                ? eq(schema.knowledgeDocumentVersions.sourceId, input.targetId)
                : eq(schema.knowledgeDocumentVersions.objectId, input.targetId),
            );
          const documentIds = versions.flatMap((version) =>
            version.documentId ? [version.documentId] : [],
          );
          await scopedDb
            .update(schema.knowledgeSourceSyncIndexObligations)
            .set({
              status: "invalidated",
              aclEligibility: "denied",
              failureCode: `${input.targetKind}_${input.eventType}`,
              updatedAt: retiredAt,
            })
            .where(
              input.targetKind === "source"
                ? eq(schema.knowledgeSourceSyncIndexObligations.sourceId, input.targetId)
                : eq(
                    schema.knowledgeSourceSyncIndexObligations.knowledgeSourceObjectId,
                    input.targetId,
                  ),
            );
          if (documentIds.length > 0) {
            await scopedDb
              .update(schema.documents)
              .set({ agentAccess: false, chunkCount: 0, updatedAt: retiredAt })
              .where(inArray(schema.documents.id, documentIds));
            await scopedDb
              .delete(schema.documentChunks)
              .where(inArray(schema.documentChunks.documentId, documentIds));
          }
        }
        return {
          targetId: row.target_id,
          lifecycleState: row.lifecycle_state,
          lifecycleGeneration: Number(row.lifecycle_generation),
          replayed: row.replayed,
        };
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge lifecycle transition conflicted");
      }
    },
  );
}

export async function restoreKnowledgeSourceObject(
  db: Database,
  input: Omit<Parameters<typeof recordKnowledgeLifecycleEvent>[1], "targetKind" | "eventType">,
) {
  return await recordKnowledgeLifecycleEvent(db, {
    ...input,
    targetKind: "object",
    eventType: "restored",
  });
}

export async function upsertKnowledgeEntity(
  db: Database,
  input: KnowledgeWriteContext & {
    entityType: string;
    normalizedKey: string;
    displayName: string;
  },
): Promise<{
  id: string;
  accountId: string;
  scope: ScopedKnowledgeScope;
  entityType: string;
  normalizedKey: string;
  displayName: string;
  createdAt: string;
}> {
  const entityType = normalizedStableKey(input.entityType, "entityType", 96);
  const normalizedKey = boundedText(
    normalizeScopedKnowledgeKey(input.normalizedKey),
    "normalizedKey",
    512,
  );
  const displayName = boundedText(input.displayName, "displayName", 512);
  const inputHash = scopedKnowledgeInputHash({
    scope: input.scope,
    entityType,
    normalizedKey,
    displayName,
    actor: input.actor,
  });
  return await withKnowledgeWriteRls(db, input, async (scopedDb) => {
    try {
      const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        operationKind: "entity",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
      });
      if (receiptResultId) {
        const [replayed] = await scopedDb
          .select()
          .from(schema.knowledgeEntities)
          .where(eq(schema.knowledgeEntities.id, receiptResultId))
          .limit(1);
        if (!replayed) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Knowledge entity operation receipt has no visible result",
          );
        }
        return {
          id: replayed.id,
          accountId: replayed.accountId,
          scope: scopeFromRow(replayed),
          entityType: replayed.entityType,
          normalizedKey: replayed.normalizedKey,
          displayName: replayed.displayName,
          createdAt: iso(replayed.createdAt),
        };
      }
      const [created] = await scopedDb
        .insert(schema.knowledgeEntities)
        .values({
          accountId: input.accountId,
          ...scopeColumns(input.scope),
          entityType,
          normalizedKey,
          displayName,
          operationId: input.operationId,
          inputHash,
          ...actorColumns(input.actor),
        })
        .onConflictDoNothing()
        .returning();
      if (created) {
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: input.scope,
          operationKind: "entity",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: created.id,
          actor: input.actor,
        });
        return {
          id: created.id,
          accountId: created.accountId,
          scope: scopeFromRow(created),
          entityType: created.entityType,
          normalizedKey: created.normalizedKey,
          displayName: created.displayName,
          createdAt: iso(created.createdAt),
        };
      }
      const [operationRows, naturalRows] = await Promise.all([
        scopedDb
          .select()
          .from(schema.knowledgeEntities)
          .where(
            and(
              eq(schema.knowledgeEntities.accountId, input.accountId),
              eq(schema.knowledgeEntities.operationId, input.operationId),
            ),
          )
          .limit(1),
        scopedDb
          .select()
          .from(schema.knowledgeEntities)
          .where(
            and(
              eq(schema.knowledgeEntities.accountId, input.accountId),
              eq(schema.knowledgeEntities.scopeKey, scopedKnowledgeScopeKey(input.scope)),
              eq(schema.knowledgeEntities.entityType, entityType),
              eq(schema.knowledgeEntities.normalizedKey, normalizedKey),
            ),
          )
          .limit(1),
      ]);
      const operationRow = operationRows[0];
      if (operationRow && operationRow.inputHash !== inputHash) {
        throw new ScopedKnowledgeConflictError(
          "Entity operation id was replayed with different immutable input",
        );
      }
      const row = operationRow ?? naturalRows[0];
      if (!row || row.displayName !== displayName) {
        throw new ScopedKnowledgeConflictError(
          "Entity identity is already bound to different immutable metadata",
        );
      }
      await recordConvergentKnowledgeOperation(scopedDb, {
        accountId: input.accountId,
        scope: input.scope,
        operationKind: "entity",
        operationNamespace: "account",
        operationId: input.operationId,
        inputHash,
        resultId: row.id,
        actor: input.actor,
      });
      return {
        id: row.id,
        accountId: row.accountId,
        scope: scopeFromRow(row),
        entityType: row.entityType,
        normalizedKey: row.normalizedKey,
        displayName: row.displayName,
        createdAt: iso(row.createdAt),
      };
    } catch (error) {
      if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
      translatePersistenceError(error, "Knowledge entity upsert conflicted");
    }
  });
}

export async function attachKnowledgeEntityAlias(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & { entityId: string; alias: string },
): Promise<{ id: string; entityId: string; alias: string; normalizedAlias: string }> {
  const alias = boundedText(input.alias, "alias", 512);
  const normalizedAlias = boundedText(normalizeScopedKnowledgeKey(alias), "normalizedAlias", 512);
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [entity] = await scopedDb
          .select()
          .from(schema.knowledgeEntities)
          .where(eq(schema.knowledgeEntities.id, input.entityId))
          .limit(1);
        if (!entity) throw new ScopedKnowledgeNotFoundError("Knowledge entity was not found");
        validateScope(
          scopeFromRow(entity),
          input.workspaceId,
          input.actor.initiatingHumanSubjectId,
        );
        const inputHash = scopedKnowledgeInputHash({
          entityId: input.entityId,
          alias,
          normalizedAlias,
          actor: input.actor,
        });
        const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          operationKind: "entity_alias",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
        });
        if (receiptResultId) {
          const [replayed] = await scopedDb
            .select()
            .from(schema.knowledgeEntityAliases)
            .where(eq(schema.knowledgeEntityAliases.id, receiptResultId))
            .limit(1);
          if (!replayed) {
            throw new ScopedKnowledgeInvalidOperationError(
              "Knowledge entity-alias operation receipt has no visible result",
            );
          }
          return {
            id: replayed.id,
            entityId: replayed.entityId,
            alias: replayed.alias,
            normalizedAlias: replayed.normalizedAlias,
          };
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeEntityAliases)
          .values({
            accountId: input.accountId,
            scopeKind: entity.scopeKind,
            scopeWorkspaceId: entity.scopeWorkspaceId,
            scopeSubjectId: entity.scopeSubjectId,
            scopeKey: entity.scopeKey,
            entityId: entity.id,
            entityType: entity.entityType,
            alias,
            normalizedAlias,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: scopeFromRow(entity),
            operationKind: "entity_alias",
            operationNamespace: "account",
            operationId: input.operationId,
            inputHash,
            resultId: created.id,
            actor: input.actor,
          });
          return {
            id: created.id,
            entityId: created.entityId,
            alias: created.alias,
            normalizedAlias: created.normalizedAlias,
          };
        }
        const [operationRow] = await scopedDb
          .select()
          .from(schema.knowledgeEntityAliases)
          .where(
            and(
              eq(schema.knowledgeEntityAliases.accountId, input.accountId),
              eq(schema.knowledgeEntityAliases.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (operationRow) {
          if (
            operationRow.inputHash !== inputHash ||
            operationRow.scopeKind !== entity.scopeKind ||
            operationRow.scopeWorkspaceId !== entity.scopeWorkspaceId ||
            operationRow.scopeSubjectId !== entity.scopeSubjectId ||
            operationRow.scopeKey !== entity.scopeKey ||
            operationRow.entityId !== entity.id ||
            operationRow.entityType !== entity.entityType ||
            operationRow.alias !== alias ||
            operationRow.normalizedAlias !== normalizedAlias
          ) {
            throw new ScopedKnowledgeConflictError(
              "Entity-alias operation id was replayed with different immutable input",
            );
          }
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: scopeFromRow(entity),
            operationKind: "entity_alias",
            operationNamespace: "account",
            operationId: input.operationId,
            inputHash,
            resultId: operationRow.id,
            actor: input.actor,
          });
          return {
            id: operationRow.id,
            entityId: operationRow.entityId,
            alias: operationRow.alias,
            normalizedAlias: operationRow.normalizedAlias,
          };
        }
        const [row] = await scopedDb
          .select()
          .from(schema.knowledgeEntityAliases)
          .where(
            and(
              eq(schema.knowledgeEntityAliases.accountId, input.accountId),
              eq(schema.knowledgeEntityAliases.scopeKey, entity.scopeKey),
              eq(schema.knowledgeEntityAliases.entityType, entity.entityType),
              eq(schema.knowledgeEntityAliases.normalizedAlias, normalizedAlias),
            ),
          )
          .limit(1);
        if (!row) throw new ScopedKnowledgeConflictError("Entity alias identity conflicted");
        if (row.entityId !== entity.id) {
          throw new ScopedKnowledgeConflictError(
            "Entity alias is already bound to a different entity",
          );
        }
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: scopeFromRow(entity),
          operationKind: "entity_alias",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: row.id,
          actor: input.actor,
        });
        return {
          id: row.id,
          entityId: row.entityId,
          alias: row.alias,
          normalizedAlias: row.normalizedAlias,
        };
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge entity-alias attach conflicted");
      }
    },
  );
}

export async function upsertKnowledgeFact(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    subjectEntityId: string;
    predicateKey: string;
    object:
      | { kind: "entity"; entityId: string }
      | { kind: Exclude<KnowledgeFactObjectKind, "entity">; value: unknown };
  },
): Promise<KnowledgeFactRecord> {
  const predicateKey = normalizedStableKey(input.predicateKey, "predicateKey", 128);
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const objectEntityId = input.object.kind === "entity" ? input.object.entityId : null;
        const ids = [input.subjectEntityId, ...(objectEntityId ? [objectEntityId] : [])];
        const entities = await scopedDb
          .select()
          .from(schema.knowledgeEntities)
          .where(inArray(schema.knowledgeEntities.id, ids));
        const subject = entities.find((row) => row.id === input.subjectEntityId);
        const objectEntity =
          objectEntityId === null ? null : entities.find((row) => row.id === objectEntityId);
        if (!subject || (input.object.kind === "entity" && !objectEntity)) {
          throw new ScopedKnowledgeNotFoundError("Knowledge fact entity was not found");
        }
        if (objectEntity && objectEntity.scopeKey !== subject.scopeKey) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Knowledge fact entities must use the same exact scope",
          );
        }
        const objectValue =
          input.object.kind === "entity" ? null : canonicalize(input.object.value);
        if (input.object.kind !== "entity" && objectValue === undefined) {
          throw new ScopedKnowledgeInvalidOperationError("Knowledge fact object value is required");
        }
        const objectHash = scopedKnowledgeInputHash(
          input.object.kind === "entity"
            ? { kind: "entity", entityId: input.object.entityId }
            : { kind: input.object.kind, value: objectValue },
        );
        const inputHash = scopedKnowledgeInputHash({
          subjectEntityId: input.subjectEntityId,
          predicateKey,
          object: input.object,
          actor: input.actor,
        });
        const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          operationKind: "fact",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
        });
        if (receiptResultId) {
          const [replayed] = await scopedDb
            .select()
            .from(schema.knowledgeFacts)
            .where(eq(schema.knowledgeFacts.id, receiptResultId))
            .limit(1);
          if (!replayed) {
            throw new ScopedKnowledgeInvalidOperationError(
              "Knowledge fact operation receipt has no visible result",
            );
          }
          return factFromRow(replayed);
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeFacts)
          .values({
            accountId: input.accountId,
            scopeKind: subject.scopeKind,
            scopeWorkspaceId: subject.scopeWorkspaceId,
            scopeSubjectId: subject.scopeSubjectId,
            scopeKey: subject.scopeKey,
            subjectEntityId: subject.id,
            predicateKey,
            objectKind: input.object.kind,
            objectEntityId,
            objectValue,
            objectHash,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: scopeFromRow(subject),
            operationKind: "fact",
            operationNamespace: "account",
            operationId: input.operationId,
            inputHash,
            resultId: created.id,
            actor: input.actor,
          });
          return factFromRow(created);
        }
        const [operationRows, naturalRows] = await Promise.all([
          scopedDb
            .select()
            .from(schema.knowledgeFacts)
            .where(
              and(
                eq(schema.knowledgeFacts.accountId, input.accountId),
                eq(schema.knowledgeFacts.operationId, input.operationId),
              ),
            )
            .limit(1),
          scopedDb
            .select()
            .from(schema.knowledgeFacts)
            .where(
              and(
                eq(schema.knowledgeFacts.scopeKey, subject.scopeKey),
                eq(schema.knowledgeFacts.subjectEntityId, subject.id),
                eq(schema.knowledgeFacts.predicateKey, predicateKey),
                eq(schema.knowledgeFacts.objectHash, objectHash),
              ),
            )
            .limit(1),
        ]);
        const operationRow = operationRows[0];
        if (operationRow && operationRow.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Fact operation id was replayed with different immutable input",
          );
        }
        const row = operationRow ?? naturalRows[0];
        if (!row) throw new ScopedKnowledgeConflictError("Knowledge fact identity conflicted");
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: scopeFromRow(subject),
          operationKind: "fact",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: row.id,
          actor: input.actor,
        });
        return factFromRow(row);
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge fact upsert conflicted");
      }
    },
  );
}

export async function appendKnowledgeClaim(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    factId: string;
    origin: KnowledgeClaimOrigin;
    confidenceBps: number;
    effectiveAt: string;
    expiresAt?: string | null;
    extractionMethod: string;
    extractionMetadata?: Record<string, unknown> | undefined;
    modelProvider?: string | null;
    modelName?: string | null;
    modelVersion?: string | null;
  },
): Promise<KnowledgeClaimRecord> {
  if (
    !Number.isInteger(input.confidenceBps) ||
    input.confidenceBps < 0 ||
    input.confidenceBps > 10_000
  ) {
    throw new ScopedKnowledgeInvalidOperationError("confidenceBps must be between 0 and 10000");
  }
  const extractionMethod = normalizedStableKey(input.extractionMethod, "extractionMethod", 128);
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [fact] = await scopedDb
          .select()
          .from(schema.knowledgeFacts)
          .where(eq(schema.knowledgeFacts.id, input.factId))
          .limit(1);
        if (!fact) throw new ScopedKnowledgeNotFoundError("Knowledge fact was not found");
        validateScope(scopeFromRow(fact), input.workspaceId, input.actor.initiatingHumanSubjectId);
        const inputHash = scopedKnowledgeInputHash({
          factId: input.factId,
          origin: input.origin,
          confidenceBps: input.confidenceBps,
          effectiveAt: new Date(input.effectiveAt).toISOString(),
          expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
          extractionMethod,
          extractionMetadata: input.extractionMetadata ?? {},
          modelProvider: input.modelProvider ?? null,
          modelName: input.modelName ?? null,
          modelVersion: input.modelVersion ?? null,
          actor: input.actor,
        });
        const [created] = await scopedDb
          .insert(schema.knowledgeClaims)
          .values({
            accountId: input.accountId,
            scopeKind: fact.scopeKind,
            scopeWorkspaceId: fact.scopeWorkspaceId,
            scopeSubjectId: fact.scopeSubjectId,
            scopeKey: fact.scopeKey,
            factId: fact.id,
            origin: input.origin,
            confidenceBps: input.confidenceBps,
            effectiveAt: new Date(input.effectiveAt),
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            extractionMethod,
            extractionMetadata: input.extractionMetadata ?? {},
            modelProvider: input.modelProvider ?? null,
            modelName: input.modelName ?? null,
            modelVersion: input.modelVersion ?? null,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        const row =
          created ??
          (
            await scopedDb
              .select()
              .from(schema.knowledgeClaims)
              .where(
                and(
                  eq(schema.knowledgeClaims.accountId, input.accountId),
                  eq(schema.knowledgeClaims.operationId, input.operationId),
                ),
              )
              .limit(1)
          )[0];
        if (!row || row.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Claim operation id was replayed with different immutable input",
          );
        }
        return claimFromRow(row);
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge claim append conflicted");
      }
    },
  );
}

export async function linkKnowledgeClaims(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    relationType: KnowledgeClaimRelationType;
    fromClaimId: string;
    toClaimId: string;
  },
): Promise<{
  id: string;
  relationType: KnowledgeClaimRelationType;
  fromClaimId: string;
  toClaimId: string;
}> {
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        let fromClaimId = input.fromClaimId;
        let toClaimId = input.toClaimId;
        if (input.relationType === "conflicts_with" && fromClaimId.localeCompare(toClaimId) > 0) {
          [fromClaimId, toClaimId] = [toClaimId, fromClaimId];
        }
        const claims = await scopedDb
          .select()
          .from(schema.knowledgeClaims)
          .where(inArray(schema.knowledgeClaims.id, [fromClaimId, toClaimId]));
        if (claims.length !== 2 || claims[0]!.scopeKey !== claims[1]!.scopeKey) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Claim relations require two claims in the same exact scope",
          );
        }
        const claim = claims[0]!;
        const inputHash = scopedKnowledgeInputHash({
          relationType: input.relationType,
          fromClaimId,
          toClaimId,
          actor: input.actor,
        });
        const receiptResultId = await lockConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          operationKind: "claim_relation",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
        });
        if (receiptResultId) {
          const [replayed] = await scopedDb
            .select()
            .from(schema.knowledgeClaimRelations)
            .where(eq(schema.knowledgeClaimRelations.id, receiptResultId))
            .limit(1);
          if (!replayed) {
            throw new ScopedKnowledgeInvalidOperationError(
              "Knowledge claim-relation operation receipt has no visible result",
            );
          }
          return {
            id: replayed.id,
            relationType: replayed.relationType as KnowledgeClaimRelationType,
            fromClaimId: replayed.fromClaimId,
            toClaimId: replayed.toClaimId,
          };
        }
        const [created] = await scopedDb
          .insert(schema.knowledgeClaimRelations)
          .values({
            accountId: input.accountId,
            scopeKind: claim.scopeKind,
            scopeWorkspaceId: claim.scopeWorkspaceId,
            scopeSubjectId: claim.scopeSubjectId,
            scopeKey: claim.scopeKey,
            relationType: input.relationType,
            fromClaimId,
            toClaimId,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: scopeFromRow(claim),
            operationKind: "claim_relation",
            operationNamespace: "account",
            operationId: input.operationId,
            inputHash,
            resultId: created.id,
            actor: input.actor,
          });
          return {
            id: created.id,
            relationType: created.relationType as KnowledgeClaimRelationType,
            fromClaimId: created.fromClaimId,
            toClaimId: created.toClaimId,
          };
        }
        const [operationRow] = await scopedDb
          .select()
          .from(schema.knowledgeClaimRelations)
          .where(
            and(
              eq(schema.knowledgeClaimRelations.accountId, input.accountId),
              eq(schema.knowledgeClaimRelations.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (operationRow) {
          if (
            operationRow.inputHash !== inputHash ||
            operationRow.scopeKind !== claim.scopeKind ||
            operationRow.scopeWorkspaceId !== claim.scopeWorkspaceId ||
            operationRow.scopeSubjectId !== claim.scopeSubjectId ||
            operationRow.scopeKey !== claim.scopeKey ||
            operationRow.relationType !== input.relationType ||
            operationRow.fromClaimId !== fromClaimId ||
            operationRow.toClaimId !== toClaimId
          ) {
            throw new ScopedKnowledgeConflictError(
              "Claim-relation operation id was replayed with different immutable input",
            );
          }
          await recordConvergentKnowledgeOperation(scopedDb, {
            accountId: input.accountId,
            scope: scopeFromRow(claim),
            operationKind: "claim_relation",
            operationNamespace: "account",
            operationId: input.operationId,
            inputHash,
            resultId: operationRow.id,
            actor: input.actor,
          });
          return {
            id: operationRow.id,
            relationType: operationRow.relationType as KnowledgeClaimRelationType,
            fromClaimId: operationRow.fromClaimId,
            toClaimId: operationRow.toClaimId,
          };
        }
        const [row] = await scopedDb
          .select()
          .from(schema.knowledgeClaimRelations)
          .where(
            and(
              eq(schema.knowledgeClaimRelations.accountId, input.accountId),
              eq(schema.knowledgeClaimRelations.scopeKey, claim.scopeKey),
              eq(schema.knowledgeClaimRelations.relationType, input.relationType),
              eq(schema.knowledgeClaimRelations.fromClaimId, fromClaimId),
              eq(schema.knowledgeClaimRelations.toClaimId, toClaimId),
            ),
          )
          .limit(1);
        if (!row) throw new ScopedKnowledgeConflictError("Claim relation identity conflicted");
        await recordConvergentKnowledgeOperation(scopedDb, {
          accountId: input.accountId,
          scope: scopeFromRow(claim),
          operationKind: "claim_relation",
          operationNamespace: "account",
          operationId: input.operationId,
          inputHash,
          resultId: row.id,
          actor: input.actor,
        });
        return {
          id: row.id,
          relationType: row.relationType as KnowledgeClaimRelationType,
          fromClaimId: row.fromClaimId,
          toClaimId: row.toClaimId,
        };
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge claim relation conflicted");
      }
    },
  );
}

export async function appendKnowledgeClaimEvidence(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    claimId: string;
    documentVersionId: string;
    polarity: KnowledgeClaimEvidencePolarity;
    documentChunkId?: string | null;
    chunkIndex?: number | null;
    locator?: string | null;
    quoteHash?: string | null;
    contentHash: string;
  },
): Promise<{
  id: string;
  claimId: string;
  documentVersionId: string;
  polarity: KnowledgeClaimEvidencePolarity;
}> {
  const locator = input.locator == null ? null : boundedText(input.locator, "locator", 2048);
  const quoteHash = input.quoteHash == null ? null : sha256(input.quoteHash, "quoteHash");
  const contentHash = sha256(input.contentHash, "contentHash");
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [claims, versions] = await Promise.all([
          scopedDb
            .select()
            .from(schema.knowledgeClaims)
            .where(eq(schema.knowledgeClaims.id, input.claimId))
            .limit(1),
          scopedDb
            .select()
            .from(schema.knowledgeDocumentVersions)
            .where(eq(schema.knowledgeDocumentVersions.id, input.documentVersionId))
            .limit(1),
        ]);
        const claim = claims[0];
        const version = versions[0];
        if (!claim || !version) {
          throw new ScopedKnowledgeNotFoundError(
            "Knowledge claim or document version was not found",
          );
        }
        if (claim.scopeKey !== version.scopeKey) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Claim evidence cannot cross account or scope provenance",
          );
        }
        const inputHash = scopedKnowledgeInputHash({
          claimId: input.claimId,
          documentVersionId: input.documentVersionId,
          polarity: input.polarity,
          documentChunkId: input.documentChunkId ?? null,
          chunkIndex: input.chunkIndex ?? null,
          locator,
          quoteHash,
          contentHash,
          actor: input.actor,
        });
        const [created] = await scopedDb
          .insert(schema.knowledgeClaimEvidence)
          .values({
            accountId: input.accountId,
            scopeKind: claim.scopeKind,
            scopeWorkspaceId: claim.scopeWorkspaceId,
            scopeSubjectId: claim.scopeSubjectId,
            scopeKey: claim.scopeKey,
            claimId: claim.id,
            documentVersionId: version.id,
            polarity: input.polarity,
            documentChunkId: input.documentChunkId ?? null,
            chunkIndex: input.chunkIndex ?? null,
            locator,
            quoteHash,
            contentHash,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        const row =
          created ??
          (
            await scopedDb
              .select()
              .from(schema.knowledgeClaimEvidence)
              .where(
                and(
                  eq(schema.knowledgeClaimEvidence.accountId, input.accountId),
                  eq(schema.knowledgeClaimEvidence.operationId, input.operationId),
                ),
              )
              .limit(1)
          )[0];
        if (!row || row.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Claim-evidence operation id was replayed with different input",
          );
        }
        return {
          id: row.id,
          claimId: row.claimId,
          documentVersionId: row.documentVersionId,
          polarity: row.polarity as KnowledgeClaimEvidencePolarity,
        };
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge claim evidence conflicted");
      }
    },
  );
}

export async function appendKnowledgeClaimReview(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    claimId: string;
    state: KnowledgeClaimReviewState;
    reason: string;
  },
): Promise<{
  id: string;
  claimId: string;
  state: KnowledgeClaimReviewState;
  reviewRevision: number;
}> {
  const reason = boundedText(input.reason, "reason", 4096);
  if (input.state !== "proposed" && input.actor.kind !== "human") {
    throw new ScopedKnowledgeAuthorityError(
      "Claim approval, rejection, and revocation require the initiating human",
    );
  }
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [claim] = await scopedDb
          .select()
          .from(schema.knowledgeClaims)
          .where(eq(schema.knowledgeClaims.id, input.claimId))
          .limit(1);
        if (!claim) throw new ScopedKnowledgeNotFoundError("Knowledge claim was not found");
        const inputHash = scopedKnowledgeInputHash({
          claimId: input.claimId,
          state: input.state,
          reason,
          actor: input.actor,
        });
        const [created] = await scopedDb
          .insert(schema.knowledgeClaimReviews)
          .values({
            accountId: input.accountId,
            scopeKind: claim.scopeKind,
            scopeWorkspaceId: claim.scopeWorkspaceId,
            scopeSubjectId: claim.scopeSubjectId,
            scopeKey: claim.scopeKey,
            claimId: claim.id,
            state: input.state,
            reason,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        const row =
          created ??
          (
            await scopedDb
              .select()
              .from(schema.knowledgeClaimReviews)
              .where(
                and(
                  eq(schema.knowledgeClaimReviews.accountId, input.accountId),
                  eq(schema.knowledgeClaimReviews.operationId, input.operationId),
                ),
              )
              .limit(1)
          )[0];
        if (!row || row.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Claim-review operation id was replayed with different input",
          );
        }
        return {
          id: row.id,
          claimId: row.claimId,
          state: row.state as KnowledgeClaimReviewState,
          reviewRevision: row.reviewRevision,
        };
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge claim review conflicted");
      }
    },
  );
}

export async function createKnowledgeChangeProposal(
  db: Database,
  input: Omit<KnowledgeWriteContext, "scope"> & {
    claimId: string;
    evidenceId: string;
    targetKind: "instruction_policy" | "preference";
    targetScope: string;
    targetKey?: string | null;
    content: string;
  },
): Promise<KnowledgeChangeProposalRecord> {
  const content = boundedText(input.content, "content", 1_048_576);
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const targetKey =
    input.targetKey == null
      ? null
      : input.targetKind === "preference"
        ? normalizedStableKey(input.targetKey, "targetKey", 96)
        : boundedText(input.targetKey, "targetKey", 96);
  const placeholderScope: ScopedKnowledgeScope = {
    kind: "workspace",
    workspaceId: input.workspaceId,
    subjectId: null,
  };
  return await withKnowledgeWriteRls(
    db,
    { ...input, scope: placeholderScope },
    async (scopedDb) => {
      try {
        const [claim, evidence] = await Promise.all([
          scopedDb
            .select()
            .from(schema.knowledgeClaims)
            .where(eq(schema.knowledgeClaims.id, input.claimId))
            .limit(1),
          scopedDb
            .select()
            .from(schema.knowledgeClaimEvidence)
            .where(eq(schema.knowledgeClaimEvidence.id, input.evidenceId))
            .limit(1),
        ]).then(([claims, evidenceRows]) => [claims[0], evidenceRows[0]] as const);
        if (
          !claim ||
          !evidence ||
          evidence.claimId !== claim.id ||
          evidence.polarity !== "supports"
        ) {
          throw new ScopedKnowledgeInvalidOperationError(
            "Knowledge change proposals require exact supporting claim evidence",
          );
        }
        const inputHash = scopedKnowledgeInputHash({
          claimId: input.claimId,
          evidenceId: input.evidenceId,
          targetKind: input.targetKind,
          targetScope: input.targetScope,
          targetKey,
          contentHash,
          actor: input.actor,
        });
        const [created] = await scopedDb
          .insert(schema.knowledgeChangeProposals)
          .values({
            accountId: input.accountId,
            scopeKind: claim.scopeKind,
            scopeWorkspaceId: claim.scopeWorkspaceId,
            scopeSubjectId: claim.scopeSubjectId,
            scopeKey: claim.scopeKey,
            targetKind: input.targetKind,
            targetScope: input.targetScope,
            targetKey,
            content,
            contentHash,
            claimId: claim.id,
            evidenceId: evidence.id,
            operationId: input.operationId,
            inputHash,
            ...actorColumns(input.actor),
          })
          .onConflictDoNothing()
          .returning();
        const row =
          created ??
          (
            await scopedDb
              .select()
              .from(schema.knowledgeChangeProposals)
              .where(
                and(
                  eq(schema.knowledgeChangeProposals.accountId, input.accountId),
                  eq(schema.knowledgeChangeProposals.operationId, input.operationId),
                ),
              )
              .limit(1)
          )[0];
        if (!row || row.inputHash !== inputHash) {
          throw new ScopedKnowledgeConflictError(
            "Change-proposal operation id was replayed with different input",
          );
        }
        return proposalFromRow(row);
      } catch (error) {
        if (error instanceof Error && error.name.startsWith("ScopedKnowledge")) throw error;
        translatePersistenceError(error, "Knowledge change proposal conflicted");
      }
    },
  );
}

type EligibleRow = {
  claim_id: string;
  claim_account_id: string;
  claim_scope_kind: string;
  claim_scope_workspace_id: string | null;
  claim_scope_subject_id: string | null;
  claim_scope_key: string;
  fact_id: string;
  origin: KnowledgeClaimOrigin;
  confidence_bps: number;
  effective_at: Date | string;
  expires_at: Date | string | null;
  extraction_method: string;
  model_provider: string | null;
  model_name: string | null;
  model_version: string | null;
  claim_created_at: Date | string;
  subject_entity_id: string;
  predicate_key: string;
  object_kind: KnowledgeFactObjectKind;
  object_entity_id: string | null;
  object_value: unknown | null;
  object_hash: string;
  fact_created_at: Date | string;
  supporting_evidence_count: number | string;
};

async function eligibleKnowledgeClaimRows(
  db: Database,
  input: KnowledgeReadContext & { limit: number },
  claimId: string | null,
): Promise<EligibleRow[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new ScopedKnowledgeInvalidOperationError("limit must be between 1 and 100");
  }
  const agentOnly = input.surface === "agent";
  return await withKnowledgeReadRls(db, input, async (scopedDb) => {
    return (await scopedDb.execute(sql`
      SELECT
        claim.id AS claim_id,
        claim.account_id AS claim_account_id,
        claim.scope_kind AS claim_scope_kind,
        claim.scope_workspace_id AS claim_scope_workspace_id,
        claim.scope_subject_id AS claim_scope_subject_id,
        claim.scope_key AS claim_scope_key,
        claim.fact_id,
        claim.origin,
        claim.confidence_bps,
        claim.effective_at,
        claim.expires_at,
        claim.extraction_method,
        claim.model_provider,
        claim.model_name,
        claim.model_version,
        claim.created_at AS claim_created_at,
        fact.subject_entity_id,
        fact.predicate_key,
        fact.object_kind,
        fact.object_entity_id,
        fact.object_value,
        fact.object_hash,
        fact.created_at AS fact_created_at,
        (
          SELECT count(*)::int
          FROM knowledge_claim_evidence support
          WHERE support.claim_id = claim.id AND support.polarity = 'supports'
        ) AS supporting_evidence_count
      FROM knowledge_claims claim
      JOIN knowledge_facts fact ON fact.id = claim.fact_id
        AND fact.account_id = claim.account_id
        AND fact.scope_key = claim.scope_key
      JOIN LATERAL (
        SELECT review.state
        FROM knowledge_claim_reviews review
        WHERE review.claim_id = claim.id
        ORDER BY review.review_revision DESC
        LIMIT 1
      ) latest_review ON latest_review.state = 'approved'
      WHERE claim.effective_at <= transaction_timestamp()
        AND (claim.expires_at IS NULL OR claim.expires_at > transaction_timestamp())
        AND (${claimId}::uuid IS NULL OR claim.id = ${claimId}::uuid)
        AND EXISTS (
          SELECT 1 FROM knowledge_claim_evidence support
          WHERE support.claim_id = claim.id AND support.polarity = 'supports'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM knowledge_claim_evidence support
          LEFT JOIN knowledge_document_versions version
            ON version.id = support.document_version_id
            AND version.account_id = support.account_id
            AND version.scope_key = support.scope_key
          LEFT JOIN knowledge_source_objects object
            ON object.id = version.object_id
            AND object.account_id = version.account_id
            AND object.scope_key = version.scope_key
          LEFT JOIN knowledge_sources source
            ON source.id = version.source_id
            AND source.account_id = version.account_id
            AND source.scope_key = version.scope_key
          LEFT JOIN knowledge_providers provider
            ON provider.id = source.provider_id
            AND provider.account_id = source.account_id
            AND provider.scope_key = source.scope_key
          LEFT JOIN knowledge_source_acl_versions evidence_acl
            ON evidence_acl.id = version.acl_version_id
            AND evidence_acl.account_id = version.account_id
            AND evidence_acl.source_id = version.source_id
            AND evidence_acl.generation = version.acl_generation
          LEFT JOIN knowledge_source_acl_versions current_acl
            ON current_acl.account_id = source.account_id
            AND current_acl.source_id = source.id
            AND current_acl.generation = source.current_acl_generation
          LEFT JOIN documents document
            ON document.id = version.document_id
            AND document.account_id = version.account_id
            AND document.workspace_id = version.scope_workspace_id
          LEFT JOIN document_chunks chunk
            ON chunk.id = support.document_chunk_id
            AND chunk.account_id = support.account_id
            AND chunk.workspace_id = support.scope_workspace_id
            AND chunk.document_id = version.document_id
          WHERE support.claim_id = claim.id
            AND support.polarity = 'supports'
            AND (
              version.id IS NULL
              OR object.id IS NULL OR object.lifecycle_state <> 'active'
              OR source.id IS NULL OR source.lifecycle_state <> 'active'
              OR provider.id IS NULL OR provider.lifecycle_state <> 'active'
              OR evidence_acl.id IS NULL
              OR current_acl.id IS NULL
              OR (${agentOnly} AND (NOT evidence_acl.agent_access OR NOT current_acl.agent_access))
              OR (
                version.document_id IS NOT NULL
                AND (
                  document.id IS NULL
                  OR document.status <> 'ready'
                  OR (
                    document.visibility = 'private'
                    AND document.created_by IS DISTINCT FROM ${input.initiatingSubjectId}
                  )
                  OR (${agentOnly} AND NOT document.agent_access)
                )
              )
              OR (support.document_chunk_id IS NOT NULL AND chunk.id IS NULL)
            )
        )
      ORDER BY claim.created_at DESC, claim.id DESC
      LIMIT ${input.limit}
    `)) as unknown as EligibleRow[];
  });
}

function eligibleFromRow(row: EligibleRow): EligibleKnowledgeClaim {
  const scopeRow: ScopedRow = {
    scopeKind: row.claim_scope_kind,
    scopeWorkspaceId: row.claim_scope_workspace_id,
    scopeSubjectId: row.claim_scope_subject_id,
    scopeKey: row.claim_scope_key,
  };
  return {
    claim: {
      id: row.claim_id,
      accountId: row.claim_account_id,
      scope: scopeFromRow(scopeRow),
      factId: row.fact_id,
      origin: row.origin,
      confidenceBps: Number(row.confidence_bps),
      effectiveAt: iso(row.effective_at),
      expiresAt: optionalIso(row.expires_at),
      extractionMethod: row.extraction_method,
      modelProvider: row.model_provider,
      modelName: row.model_name,
      modelVersion: row.model_version,
      createdAt: iso(row.claim_created_at),
    },
    fact: {
      id: row.fact_id,
      accountId: row.claim_account_id,
      scope: scopeFromRow(scopeRow),
      subjectEntityId: row.subject_entity_id,
      predicateKey: row.predicate_key,
      objectKind: row.object_kind,
      objectEntityId: row.object_entity_id,
      objectValue: row.object_value,
      objectHash: row.object_hash,
      createdAt: iso(row.fact_created_at),
    },
    reviewState: "approved",
    supportingEvidenceCount: Number(row.supporting_evidence_count),
  };
}

export async function listEligibleKnowledgeClaims(
  db: Database,
  input: KnowledgeReadContext & { limit?: number | undefined },
): Promise<EligibleKnowledgeClaim[]> {
  const rows = await eligibleKnowledgeClaimRows(db, { ...input, limit: input.limit ?? 50 }, null);
  return rows.map(eligibleFromRow);
}

export async function getEligibleKnowledgeClaim(
  db: Database,
  input: KnowledgeReadContext & { claimId: string },
): Promise<EligibleKnowledgeClaim | null> {
  const rows = await eligibleKnowledgeClaimRows(db, { ...input, limit: 1 }, input.claimId);
  return rows[0] ? eligibleFromRow(rows[0]) : null;
}
