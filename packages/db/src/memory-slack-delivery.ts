import { createHash } from "node:crypto";
import {
  stableJson,
  type MemorySlackPublication,
  type MemorySlackPublicationConfiguration,
  type MemorySlackPublicationReceipt,
  type MemorySlackPublicationReceiptKind,
  type MemorySlackPublicationState,
} from "@opengeni/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

export type MemorySlackPublicationActor = {
  kind: "human" | "agent" | "service";
  subjectId: string;
  initiatingHumanSubjectId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  attemptId?: string | null;
};

export type WorkspaceMemorySlackPublicationSnapshot = {
  accountId: string;
  workspaceId: string;
  id: string;
  version: number;
  status: string;
  kind: string;
  scopeType: string;
  namespace: string;
  labels: string[];
  validFrom: string;
  validUntil: string | null;
  supersedesId: string | null;
  supersededById: string | null;
};

export async function getWorkspaceMemorySlackPublicationSnapshot(
  db: Database,
  workspaceId: string,
  memoryId: string,
): Promise<WorkspaceMemorySlackPublicationSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        accountId: schema.knowledgeMemories.accountId,
        workspaceId: schema.knowledgeMemories.workspaceId,
        id: schema.knowledgeMemories.id,
        version: schema.knowledgeMemories.memoryVersion,
        status: schema.knowledgeMemories.status,
        kind: schema.knowledgeMemories.kind,
        scopeType: schema.knowledgeMemories.scopeType,
        namespace: schema.knowledgeMemories.namespace,
        labels: schema.knowledgeMemories.labels,
        validFrom: schema.knowledgeMemories.validFrom,
        validUntil: schema.knowledgeMemories.validUntil,
        supersedesId: schema.knowledgeMemories.supersedesId,
        supersededById: schema.knowledgeMemories.supersededById,
      })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          eq(schema.knowledgeMemories.id, memoryId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...row,
          labels: [...row.labels],
          validFrom: row.validFrom.toISOString(),
          validUntil: row.validUntil?.toISOString() ?? null,
        }
      : null;
  });
}

export type MemorySlackPublicationConfigurationInput = {
  accountId: string;
  workspaceId: string;
  expectedRevision: number;
  enabled: boolean;
  connectionId: string | null;
  slackTeamId: string | null;
  slackChannelId: string | null;
  slackChannelName: string | null;
  autoImportances: Array<"major" | "normal" | "minor">;
  reviewImportances: Array<"major" | "normal" | "minor">;
  subjectId: string;
};

export class MemorySlackPublicationRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Memory Slack publication configuration moved to revision ${currentRevision}`);
    this.name = "MemorySlackPublicationRevisionConflictError";
  }
}

export async function listMemorySlackPublicationConfigurations(
  db: Database,
  workspaceId: string,
  limit = 25,
): Promise<MemorySlackPublicationConfiguration[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.memorySlackPublicationConfigurations)
      .where(eq(schema.memorySlackPublicationConfigurations.workspaceId, workspaceId))
      .orderBy(desc(schema.memorySlackPublicationConfigurations.revision))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map(mapConfiguration);
  });
}

export async function getCurrentMemorySlackPublicationConfiguration(
  db: Database,
  workspaceId: string,
): Promise<MemorySlackPublicationConfiguration | null> {
  const configurations = await listMemorySlackPublicationConfigurations(db, workspaceId, 1);
  return configurations[0] ?? null;
}

export async function createMemorySlackPublicationConfiguration(
  db: Database,
  input: MemorySlackPublicationConfigurationInput,
): Promise<MemorySlackPublicationConfiguration> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, input.workspaceId))
      .for("update");
    const [current] = await scopedDb
      .select({ revision: schema.memorySlackPublicationConfigurations.revision })
      .from(schema.memorySlackPublicationConfigurations)
      .where(eq(schema.memorySlackPublicationConfigurations.workspaceId, input.workspaceId))
      .orderBy(desc(schema.memorySlackPublicationConfigurations.revision))
      .limit(1);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new MemorySlackPublicationRevisionConflictError(currentRevision);
    }
    const [created] = await scopedDb
      .insert(schema.memorySlackPublicationConfigurations)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        revision: currentRevision + 1,
        enabled: input.enabled,
        connectionId: input.connectionId,
        slackTeamId: input.slackTeamId,
        slackChannelId: input.slackChannelId,
        slackChannelName: input.slackChannelName,
        autoImportances: normalizeImportances(input.autoImportances),
        reviewImportances: normalizeImportances(input.reviewImportances),
        createdBySubjectId: boundedSubject(input.subjectId),
      })
      .returning();
    if (!created) throw new Error("Failed to create Memory Slack publication configuration");
    return mapConfiguration(created);
  });
}

export type EnqueueMemorySlackPublicationInput = {
  accountId: string;
  workspaceId: string;
  sourceType: "workspace_memory" | "durable_learning";
  sourceId: string;
  sourceVersion?: string | null;
  sourceIdempotencyKey: string;
  projection: Record<string, unknown>;
  importance: "major" | "normal" | "minor";
  deliveryMode: "auto" | "review";
  actor: MemorySlackPublicationActor;
};

export type EnqueueMemorySlackPublicationResult =
  | { kind: "not_configured" }
  | { kind: "disabled"; configuration: MemorySlackPublicationConfiguration }
  | { kind: "enqueued" | "replayed"; publication: MemorySlackPublication };

export async function enqueueMemorySlackPublication(
  db: Database,
  input: EnqueueMemorySlackPublicationInput,
): Promise<EnqueueMemorySlackPublicationResult> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [configurationRow] = await scopedDb
      .select()
      .from(schema.memorySlackPublicationConfigurations)
      .where(eq(schema.memorySlackPublicationConfigurations.workspaceId, input.workspaceId))
      .orderBy(desc(schema.memorySlackPublicationConfigurations.revision))
      .limit(1);
    if (!configurationRow) return { kind: "not_configured" };
    const configuration = mapConfiguration(configurationRow);
    if (
      !configuration.enabled ||
      !configuration.connectionId ||
      !configuration.slackTeamId ||
      !configuration.slackChannelId
    ) {
      return { kind: "disabled", configuration };
    }

    const projectionJson = stableJson(input.projection);
    const projectionSha256 = createHash("sha256").update(projectionJson, "utf8").digest("hex");
    const operationId = deterministicUuid(
      `memory-slack:${input.workspaceId}:${input.sourceIdempotencyKey}`,
    );
    const state = input.deliveryMode === "auto" ? "queued" : "review_pending";
    const actor = normalizeActor(input.actor);
    const [created] = await scopedDb
      .insert(schema.memorySlackPublications)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        configurationId: configuration.id,
        configurationRevision: configuration.revision,
        connectionId: configuration.connectionId,
        slackTeamId: configuration.slackTeamId,
        slackChannelId: configuration.slackChannelId,
        sourceType: input.sourceType,
        sourceId: bounded(input.sourceId, 1_024, "publication source id"),
        sourceVersion: input.sourceVersion
          ? bounded(input.sourceVersion, 512, "publication source version")
          : null,
        sourceIdempotencyKey: bounded(
          input.sourceIdempotencyKey,
          256,
          "publication source idempotency key",
        ),
        projection: input.projection,
        projectionSha256,
        importance: input.importance,
        deliveryMode: input.deliveryMode,
        state,
        operationId,
        initiatorKind: actor.kind,
        initiatorSubjectId: actor.subjectId,
        initiatingHumanSubjectId: actor.initiatingHumanSubjectId,
        sessionId: actor.sessionId,
        turnId: actor.turnId,
        attemptId: actor.attemptId,
      })
      .onConflictDoNothing({
        target: [
          schema.memorySlackPublications.workspaceId,
          schema.memorySlackPublications.sourceIdempotencyKey,
        ],
      })
      .returning();

    let publicationRow = created;
    if (!publicationRow) {
      [publicationRow] = await scopedDb
        .select()
        .from(schema.memorySlackPublications)
        .where(
          and(
            eq(schema.memorySlackPublications.workspaceId, input.workspaceId),
            eq(schema.memorySlackPublications.sourceIdempotencyKey, input.sourceIdempotencyKey),
          ),
        )
        .limit(1);
      if (!publicationRow) throw new Error("Memory Slack publication conflict disappeared");
      if (
        publicationRow.projectionSha256 !== projectionSha256 ||
        publicationRow.sourceType !== input.sourceType ||
        publicationRow.sourceId !== input.sourceId ||
        publicationRow.sourceVersion !== (input.sourceVersion ?? null) ||
        publicationRow.importance !== input.importance ||
        publicationRow.initiatorKind !== actor.kind ||
        publicationRow.initiatorSubjectId !== actor.subjectId ||
        publicationRow.initiatingHumanSubjectId !== actor.initiatingHumanSubjectId ||
        publicationRow.sessionId !== actor.sessionId ||
        publicationRow.turnId !== actor.turnId ||
        publicationRow.attemptId !== actor.attemptId
      ) {
        throw new Error("Memory Slack publication idempotency key was reused with different input");
      }
      return {
        kind: "replayed",
        publication: await mapPublicationWithReceipts(scopedDb, publicationRow),
      };
    }

    await insertReceipt(scopedDb, publicationRow, {
      kind: "enqueued",
      state,
      actorKind: actor.kind,
      actorSubjectId: actor.subjectId,
    });
    return {
      kind: "enqueued",
      publication: await mapPublicationWithReceipts(scopedDb, publicationRow),
    };
  });
}

export type ClaimedMemorySlackPublication = typeof schema.memorySlackPublications.$inferSelect;

export async function claimMemorySlackPublication(
  db: Database,
  claimHolderId: string,
  claimLeaseMs: number,
): Promise<ClaimedMemorySlackPublication | null> {
  const result = await db.execute(
    sql`select * from opengeni_private.claim_memory_slack_publication(
      ${claimHolderId}::uuid,
      ${claimLeaseMs}
    )`,
  );
  const row = rawRows(result)[0];
  return row ? mapClaimedPublication(row) : null;
}

export async function currentMemorySlackConfigurationMatches(
  db: Database,
  publication: ClaimedMemorySlackPublication,
): Promise<boolean> {
  return await withWorkspaceRls(db, publication.workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.memorySlackPublicationConfigurations)
      .where(eq(schema.memorySlackPublicationConfigurations.workspaceId, publication.workspaceId))
      .orderBy(desc(schema.memorySlackPublicationConfigurations.revision))
      .limit(1);
    return Boolean(
      current?.enabled &&
      current.revision === publication.configurationRevision &&
      current.id === publication.configurationId &&
      current.connectionId === publication.connectionId &&
      current.slackTeamId === publication.slackTeamId &&
      current.slackChannelId === publication.slackChannelId,
    );
  });
}

export async function completeMemorySlackPublication(
  db: Database,
  input: {
    publication: ClaimedMemorySlackPublication;
    claimHolderId: string;
    slackChannelId: string;
    slackMessageTimestamp: string;
  },
): Promise<boolean> {
  return await transitionClaimedPublication(db, input.publication, input.claimHolderId, {
    state: "delivered",
    kind: "delivered",
    actorKind: "service",
    actorSubjectId: "memory-slack-delivery",
    slackChannelId: input.slackChannelId,
    slackMessageTimestamp: input.slackMessageTimestamp,
  });
}

export async function deferMemorySlackPublication(
  db: Database,
  input: {
    publication: ClaimedMemorySlackPublication;
    claimHolderId: string;
    retryAt: Date;
    errorCode: string;
  },
): Promise<boolean> {
  return await transitionClaimedPublication(db, input.publication, input.claimHolderId, {
    state: "retry_wait",
    kind: "retry_scheduled",
    actorKind: "service",
    actorSubjectId: "memory-slack-delivery",
    retryAt: input.retryAt,
    errorCode: input.errorCode,
  });
}

export async function failMemorySlackPublication(
  db: Database,
  input: {
    publication: ClaimedMemorySlackPublication;
    claimHolderId: string;
    errorCode: string;
    cancelled?: boolean;
  },
): Promise<boolean> {
  return await transitionClaimedPublication(db, input.publication, input.claimHolderId, {
    state: input.cancelled ? "cancelled" : "failed",
    kind: input.cancelled ? "cancelled" : "failed",
    actorKind: "service",
    actorSubjectId: "memory-slack-delivery",
    errorCode: input.errorCode,
  });
}

export async function actOnMemorySlackPublication(
  db: Database,
  input: {
    workspaceId: string;
    publicationId: string;
    expectedState: MemorySlackPublicationState;
    action: "approve" | "reject" | "retry";
    subjectId: string;
  },
): Promise<MemorySlackPublication | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.memorySlackPublications)
      .where(
        and(
          eq(schema.memorySlackPublications.workspaceId, input.workspaceId),
          eq(schema.memorySlackPublications.id, input.publicationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!current || current.state !== input.expectedState) return null;
    const transition = manualTransition(input.action, current.state);
    if (!transition) return null;
    const now = new Date();
    const [updated] = await scopedDb
      .update(schema.memorySlackPublications)
      .set({
        state: transition.state,
        claimHolderId: null,
        claimExpiresAt: null,
        retryAt: null,
        lastErrorCode: null,
        ...(transition.terminal ? { terminalAt: now } : { terminalAt: null }),
        updatedAt: now,
      })
      .where(eq(schema.memorySlackPublications.id, current.id))
      .returning();
    if (!updated) return null;
    await insertReceipt(scopedDb, updated, {
      kind: transition.kind,
      state: transition.state,
      actorKind: "human",
      actorSubjectId: boundedSubject(input.subjectId),
    });
    return await mapPublicationWithReceipts(scopedDb, updated);
  });
}

export async function listMemorySlackPublications(
  db: Database,
  workspaceId: string,
  options: { limit?: number; states?: MemorySlackPublicationState[] } = {},
): Promise<MemorySlackPublication[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const conditions = [eq(schema.memorySlackPublications.workspaceId, workspaceId)];
    if (options.states?.length) {
      conditions.push(inArray(schema.memorySlackPublications.state, options.states));
    }
    const rows = await scopedDb
      .select()
      .from(schema.memorySlackPublications)
      .where(and(...conditions))
      .orderBy(
        desc(schema.memorySlackPublications.createdAt),
        desc(schema.memorySlackPublications.id),
      )
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 100));
    return await Promise.all(rows.map((row) => mapPublicationWithReceipts(scopedDb, row)));
  });
}

async function transitionClaimedPublication(
  db: Database,
  publication: ClaimedMemorySlackPublication,
  claimHolderId: string,
  transition: {
    state: "retry_wait" | "delivered" | "failed" | "cancelled";
    kind: "retry_scheduled" | "delivered" | "failed" | "cancelled";
    actorKind: "service";
    actorSubjectId: string;
    retryAt?: Date;
    errorCode?: string;
    slackChannelId?: string;
    slackMessageTimestamp?: string;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, publication.workspaceId, async (scopedDb) => {
    const terminal = ["delivered", "failed", "cancelled"].includes(transition.state);
    const now = new Date();
    const [updated] = await scopedDb
      .update(schema.memorySlackPublications)
      .set({
        state: transition.state,
        claimHolderId: null,
        claimExpiresAt: null,
        retryAt: transition.retryAt ?? null,
        lastErrorCode: transition.errorCode
          ? bounded(transition.errorCode, 128, "publication error code")
          : null,
        slackMessageTimestamp: transition.slackMessageTimestamp ?? null,
        deliveredAt: transition.state === "delivered" ? now : null,
        terminalAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.memorySlackPublications.id, publication.id),
          eq(schema.memorySlackPublications.workspaceId, publication.workspaceId),
          eq(schema.memorySlackPublications.state, "delivering"),
          eq(schema.memorySlackPublications.claimHolderId, claimHolderId),
        ),
      )
      .returning();
    if (!updated) return false;
    await insertReceipt(scopedDb, updated, {
      kind: transition.kind,
      state: transition.state,
      actorKind: transition.actorKind,
      actorSubjectId: transition.actorSubjectId,
      retryAt: transition.retryAt ?? null,
      errorCode: transition.errorCode ?? null,
      slackChannelId: transition.slackChannelId ?? null,
      slackMessageTimestamp: transition.slackMessageTimestamp ?? null,
    });
    return true;
  });
}

async function insertReceipt(
  db: Database,
  publication: typeof schema.memorySlackPublications.$inferSelect,
  input: {
    kind: MemorySlackPublicationReceiptKind;
    state: MemorySlackPublicationState;
    actorKind: "human" | "agent" | "service";
    actorSubjectId: string;
    retryAt?: Date | null;
    errorCode?: string | null;
    slackChannelId?: string | null;
    slackMessageTimestamp?: string | null;
  },
) {
  const [{ nextSequence } = { nextSequence: 1 }] = await db
    .select({
      nextSequence: sql<number>`coalesce(max(${schema.memorySlackPublicationReceipts.sequence}), 0)::int + 1`,
    })
    .from(schema.memorySlackPublicationReceipts)
    .where(eq(schema.memorySlackPublicationReceipts.publicationId, publication.id));
  await db.insert(schema.memorySlackPublicationReceipts).values({
    accountId: publication.accountId,
    workspaceId: publication.workspaceId,
    publicationId: publication.id,
    sequence: Number(nextSequence),
    kind: input.kind,
    state: input.state,
    attemptNumber: publication.attemptCount,
    actorKind: input.actorKind,
    actorSubjectId: boundedSubject(input.actorSubjectId),
    operationId: publication.operationId,
    errorCode: input.errorCode
      ? bounded(input.errorCode, 128, "publication receipt error code")
      : null,
    retryAt: input.retryAt ?? null,
    slackChannelId: input.slackChannelId ?? null,
    slackMessageTimestamp: input.slackMessageTimestamp ?? null,
  });
}

function manualTransition(
  action: "approve" | "reject" | "retry",
  state: MemorySlackPublicationState,
): {
  state: "queued" | "rejected";
  kind: "review_approved" | "review_rejected" | "manual_retry";
  terminal: boolean;
} | null {
  if (action === "approve" && state === "review_pending") {
    return { state: "queued", kind: "review_approved", terminal: false };
  }
  if (action === "reject" && state === "review_pending") {
    return { state: "rejected", kind: "review_rejected", terminal: true };
  }
  if (action === "retry" && state === "failed") {
    return { state: "queued", kind: "manual_retry", terminal: false };
  }
  return null;
}

async function mapPublicationWithReceipts(
  db: Database,
  row: typeof schema.memorySlackPublications.$inferSelect,
): Promise<MemorySlackPublication> {
  const receiptRows = await db
    .select()
    .from(schema.memorySlackPublicationReceipts)
    .where(eq(schema.memorySlackPublicationReceipts.publicationId, row.id))
    .orderBy(asc(schema.memorySlackPublicationReceipts.sequence))
    .limit(100);
  const projection = row.projection;
  const summary = typeof projection["summary"] === "string" ? projection["summary"] : "";
  const authoritativePath = publicationAuthoritativePath(row, projection);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    configurationRevision: row.configurationRevision,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    slackChannelId: row.slackChannelId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    importance: row.importance,
    deliveryMode: row.deliveryMode,
    state: row.state,
    summary: summary.slice(0, 512),
    sourceLabel: row.sourceType === "workspace_memory" ? "Workspace Memory" : "Governed learning",
    authoritativePath,
    initiatorKind: row.initiatorKind,
    initiatorSubjectId: row.initiatorSubjectId,
    initiatingHumanSubjectId: row.initiatingHumanSubjectId,
    attemptCount: row.attemptCount,
    retryAt: row.retryAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    slackMessageTimestamp: row.slackMessageTimestamp,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    receipts: receiptRows.map(mapReceipt),
  };
}

function publicationAuthoritativePath(
  row: typeof schema.memorySlackPublications.$inferSelect,
  projection: Record<string, unknown>,
): string | null {
  if (row.sourceType === "workspace_memory") {
    const authoritative = record(projection["authoritativeRecord"]);
    const memoryId = authoritative?.["memoryId"];
    return typeof memoryId === "string"
      ? `/workspaces/${row.workspaceId}/memory?memoryId=${encodeURIComponent(memoryId)}`
      : null;
  }
  return `/workspaces/${row.workspaceId}/workspace-state`;
}

function mapConfiguration(
  row: typeof schema.memorySlackPublicationConfigurations.$inferSelect,
): MemorySlackPublicationConfiguration {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    revision: row.revision,
    enabled: row.enabled,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    slackChannelId: row.slackChannelId,
    slackChannelName: row.slackChannelName,
    autoImportances: normalizeImportances(row.autoImportances),
    reviewImportances: normalizeImportances(row.reviewImportances),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapReceipt(
  row: typeof schema.memorySlackPublicationReceipts.$inferSelect,
): MemorySlackPublicationReceipt {
  return {
    id: row.id,
    publicationId: row.publicationId,
    sequence: row.sequence,
    kind: row.kind,
    state: row.state,
    attemptNumber: row.attemptNumber,
    actorKind: row.actorKind,
    actorSubjectId: row.actorSubjectId,
    operationId: row.operationId,
    errorCode: row.errorCode,
    retryAt: row.retryAt?.toISOString() ?? null,
    slackChannelId: row.slackChannelId,
    slackMessageTimestamp: row.slackMessageTimestamp,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeImportances(values: readonly string[]) {
  const allowed = new Set(["major", "normal", "minor"] as const);
  return [...new Set(values)]
    .filter((value): value is "major" | "normal" | "minor" =>
      allowed.has(value as "major" | "normal" | "minor"),
    )
    .sort();
}

function normalizeActor(actor: MemorySlackPublicationActor) {
  return {
    kind: actor.kind,
    subjectId: boundedSubject(actor.subjectId),
    initiatingHumanSubjectId: actor.initiatingHumanSubjectId
      ? boundedSubject(actor.initiatingHumanSubjectId)
      : null,
    sessionId: actor.sessionId ?? null,
    turnId: actor.turnId ?? null,
    attemptId: actor.attemptId ?? null,
  };
}

function boundedSubject(value: string) {
  return bounded(value, 1_024, "publication actor subject id");
}

function bounded(value: string, maxBytes: number, label: string) {
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  const rows = record(value)?.["rows"];
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function raw(row: Record<string, unknown>, camel: string, snake: string) {
  return row[camel] ?? row[snake];
}

function mapClaimedPublication(row: Record<string, unknown>): ClaimedMemorySlackPublication {
  const date = (camel: string, snake: string) => {
    const value = raw(row, camel, snake);
    return value instanceof Date ? value : new Date(String(value));
  };
  const nullableDate = (camel: string, snake: string) => {
    const value = raw(row, camel, snake);
    return value == null ? null : value instanceof Date ? value : new Date(String(value));
  };
  const string = (camel: string, snake: string) => String(raw(row, camel, snake));
  const nullableString = (camel: string, snake: string) => {
    const value = raw(row, camel, snake);
    return value == null ? null : String(value);
  };
  return {
    id: string("id", "id"),
    accountId: string("accountId", "account_id"),
    workspaceId: string("workspaceId", "workspace_id"),
    configurationId: string("configurationId", "configuration_id"),
    configurationRevision: Number(raw(row, "configurationRevision", "configuration_revision")),
    connectionId: string("connectionId", "connection_id"),
    slackTeamId: string("slackTeamId", "slack_team_id"),
    slackChannelId: string("slackChannelId", "slack_channel_id"),
    sourceType: string("sourceType", "source_type") as ClaimedMemorySlackPublication["sourceType"],
    sourceId: string("sourceId", "source_id"),
    sourceVersion: nullableString("sourceVersion", "source_version"),
    sourceIdempotencyKey: string("sourceIdempotencyKey", "source_idempotency_key"),
    projection: record(raw(row, "projection", "projection")) ?? {},
    projectionSha256: string("projectionSha256", "projection_sha256"),
    importance: string("importance", "importance") as ClaimedMemorySlackPublication["importance"],
    deliveryMode: string(
      "deliveryMode",
      "delivery_mode",
    ) as ClaimedMemorySlackPublication["deliveryMode"],
    state: string("state", "state") as ClaimedMemorySlackPublication["state"],
    operationId: string("operationId", "operation_id"),
    initiatorKind: string(
      "initiatorKind",
      "initiator_kind",
    ) as ClaimedMemorySlackPublication["initiatorKind"],
    initiatorSubjectId: string("initiatorSubjectId", "initiator_subject_id"),
    initiatingHumanSubjectId: nullableString(
      "initiatingHumanSubjectId",
      "initiating_human_subject_id",
    ),
    sessionId: nullableString("sessionId", "session_id"),
    turnId: nullableString("turnId", "turn_id"),
    attemptId: nullableString("attemptId", "attempt_id"),
    claimHolderId: nullableString("claimHolderId", "claim_holder_id"),
    claimExpiresAt: nullableDate("claimExpiresAt", "claim_expires_at"),
    attemptCount: Number(raw(row, "attemptCount", "attempt_count")),
    retryAt: nullableDate("retryAt", "retry_at"),
    lastErrorCode: nullableString("lastErrorCode", "last_error_code"),
    slackMessageTimestamp: nullableString("slackMessageTimestamp", "slack_message_timestamp"),
    deliveredAt: nullableDate("deliveredAt", "delivered_at"),
    terminalAt: nullableDate("terminalAt", "terminal_at"),
    createdAt: date("createdAt", "created_at"),
    updatedAt: date("updatedAt", "updated_at"),
  };
}
