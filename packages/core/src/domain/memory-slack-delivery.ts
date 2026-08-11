import type { MemorySlackPublicationDistribution } from "@opengeni/contracts";
import {
  correctWorkspaceMemory,
  enqueueMemorySlackPublication,
  getCurrentMemorySlackPublicationConfiguration,
  getWorkspaceMemorySlackPublicationSnapshot,
  saveWorkspaceMemory,
  withWorkspaceRls,
  type CorrectWorkspaceMemoryInput,
  type CorrectWorkspaceMemoryResult,
  type Database,
  type EnqueueMemorySlackPublicationResult,
  type MemoryEmbedder,
  type MemorySlackPublicationActor,
  type SaveWorkspaceMemoryInput,
  type SaveWorkspaceMemoryResult,
  type WorkspaceMemorySlackPublicationSnapshot,
} from "@opengeni/db";
import {
  evaluateMemorySlackPublication,
  type MemorySlackOrigin,
  type MemorySlackPublicationDecision,
} from "./memory-slack-publication";

export type MemorySlackPublicationCommitRequest = {
  distribution: MemorySlackPublicationDistribution;
  actor: MemorySlackPublicationActor;
  ownerLabel?: string | null;
  origin?: MemorySlackOrigin;
};

export type MemorySlackPublicationCommitResult = {
  decision: MemorySlackPublicationDecision | null;
  enqueue: EnqueueMemorySlackPublicationResult | null;
};

export async function saveWorkspaceMemoryWithSlackPublication(
  db: Database,
  input: SaveWorkspaceMemoryInput,
  publication: MemorySlackPublicationCommitRequest | null,
  embedder?: MemoryEmbedder,
): Promise<SaveWorkspaceMemoryResult & { slackPublication: MemorySlackPublicationCommitResult }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const result = await saveWorkspaceMemory(scopedDb, input, embedder);
    const slackPublication = publication
      ? await publishSavedMemoryMutation(scopedDb, input, result, publication)
      : { decision: null, enqueue: null };
    return { ...result, slackPublication };
  });
}

export async function correctWorkspaceMemoryWithSlackPublication(
  db: Database,
  input: CorrectWorkspaceMemoryInput,
  publication: MemorySlackPublicationCommitRequest | null,
  embedder?: MemoryEmbedder,
): Promise<
  CorrectWorkspaceMemoryResult & { slackPublication: MemorySlackPublicationCommitResult }
> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const result = await correctWorkspaceMemory(scopedDb, input, embedder);
    if (!publication || result.action !== "superseded" || !result.replacement) {
      return { ...result, slackPublication: { decision: null, enqueue: null } };
    }
    const replacement = await requiredSnapshot(scopedDb, input.workspaceId, result.replacement.id);
    const slackPublication = await evaluateAndEnqueue(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      snapshot: replacement,
      changeKind: "corrected",
      relatedMemoryId: result.memory.id,
      occurredAt: result.replacement.updatedAt,
      publication,
    });
    return { ...result, slackPublication };
  });
}

async function publishSavedMemoryMutation(
  db: Database,
  input: SaveWorkspaceMemoryInput,
  result: SaveWorkspaceMemoryResult,
  publication: MemorySlackPublicationCommitRequest,
): Promise<MemorySlackPublicationCommitResult> {
  if (result.updated || (result.deduped && !result.superseded)) {
    return { decision: null, enqueue: null };
  }

  if (result.superseded) {
    const replacement = await requiredSnapshot(db, input.workspaceId, result.memory.id);
    if (replacement.supersedesId === result.superseded.id) {
      return await evaluateAndEnqueue(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        snapshot: replacement,
        changeKind: "corrected",
        relatedMemoryId: result.superseded.id,
        occurredAt: result.memory.updatedAt,
        publication,
      });
    }
    const retired = await requiredSnapshot(db, input.workspaceId, result.superseded.id);
    return await evaluateAndEnqueue(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      snapshot: retired,
      changeKind: "superseded",
      relatedMemoryId: result.memory.id,
      occurredAt: result.superseded.updatedAt,
      publication,
    });
  }

  const created = await requiredSnapshot(db, input.workspaceId, result.memory.id);
  return await evaluateAndEnqueue(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    snapshot: created,
    changeKind: "created",
    relatedMemoryId: null,
    occurredAt: result.memory.createdAt,
    publication,
  });
}

async function evaluateAndEnqueue(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    snapshot: WorkspaceMemorySlackPublicationSnapshot;
    changeKind: "created" | "corrected" | "superseded";
    relatedMemoryId: string | null;
    occurredAt: string;
    publication: MemorySlackPublicationCommitRequest;
  },
): Promise<MemorySlackPublicationCommitResult> {
  const configuration = await getCurrentMemorySlackPublicationConfiguration(db, input.workspaceId);
  const decision = evaluateMemorySlackPublication({
    context: {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      now: input.occurredAt,
    },
    policy: configuration
      ? {
          enabled: configuration.enabled,
          autoImportances: configuration.autoImportances,
          reviewImportances: configuration.reviewImportances,
        }
      : undefined,
    memory: {
      sourceType: "workspace_memory",
      accountId: input.snapshot.accountId,
      workspaceId: input.snapshot.workspaceId,
      id: input.snapshot.id,
      version: input.snapshot.version,
      status: input.snapshot.status as Parameters<
        typeof evaluateMemorySlackPublication
      >[0]["memory"]["status"],
      kind: input.snapshot.kind as Parameters<
        typeof evaluateMemorySlackPublication
      >[0]["memory"]["kind"],
      scopeType: input.snapshot.scopeType as Parameters<
        typeof evaluateMemorySlackPublication
      >[0]["memory"]["scopeType"],
      namespace: input.snapshot.namespace,
      labels: input.snapshot.labels,
      validFrom: input.snapshot.validFrom,
      validUntil: input.snapshot.validUntil,
      supersedesId: input.snapshot.supersedesId,
      supersededById: input.snapshot.supersededById,
    },
    change: {
      kind: input.changeKind,
      relatedMemoryId: input.relatedMemoryId,
      occurredAt: input.occurredAt,
      origin: input.publication.origin ?? "native",
      ownerLabel: input.publication.ownerLabel ?? null,
    },
    distribution: input.publication.distribution,
  });
  if (!decision.eligible) return { decision, enqueue: null };

  const enqueue = await enqueueMemorySlackPublication(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sourceType: "workspace_memory",
    sourceId: input.snapshot.id,
    sourceVersion: String(input.snapshot.version),
    sourceIdempotencyKey: decision.idempotencyKey,
    projection: decision.projection,
    importance: decision.projection.importance,
    deliveryMode: decision.deliveryMode,
    actor: input.publication.actor,
  });
  return { decision, enqueue };
}

async function requiredSnapshot(db: Database, workspaceId: string, memoryId: string) {
  const snapshot = await getWorkspaceMemorySlackPublicationSnapshot(db, workspaceId, memoryId);
  if (!snapshot) throw new Error("Memory Slack publication source disappeared before commit");
  return snapshot;
}
