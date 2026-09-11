import { createHash } from "node:crypto";
import {
  FileAsset,
  KnowledgeFilePreparationResult,
  AgentLearningDefaults,
  AgentLearningOverridePatch,
  AgentInstructionSaveRequest,
  AgentInstructionReviewRequest,
  AgentInstructionReceipt,
  AgentInstructionReviewItem,
  WorkspaceInstructionPolicyTarget,
  KnowledgeEntryListRequest,
  KnowledgeReviewBatch,
  KnowledgeReviewBatchListRequest,
  KnowledgeEntryBatchReviewRequest,
  KnowledgeTaskNotePromotionRequest,
  KnowledgeEntryRecord,
  KnowledgeEntryReviewRequest,
  KnowledgeEntryRestoreRequest,
  KnowledgeEntrySaveRequest,
  KnowledgeEntrySummary,
  KnowledgeEntryWriteReceipt,
  type AgentLearningContext,
  type KnowledgeEntryScope,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, withWorkspaceRls, withWorkspaceSubjectRls, type Database } from "./database";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  LOSSLESS_CONTENT_CODEC_VERSION,
  toPostgresLosslessJson,
  toPostgresLosslessText,
} from "./lossless-json";

/** Trusted host claims. Never deserialize this context from tool/request input. */
export type KnowledgeActor =
  | {
      kind: "service";
      principalKind: "service" | "api_key" | "configured_key" | "mcp_gateway";
      subjectId: string;
      writeScopes: Array<"workspace" | "organization">;
      review: false;
      settingsScopes: [];
    }
  | {
      kind: "human";
      principalKind: "human_session";
      subjectId: string;
      writeScopes: KnowledgeEntryScope[];
      settingsScopes: Array<"workspace" | "personal">;
      review: boolean;
    }
  | {
      kind: "agent";
      sessionId: string;
      turnId: string;
      attemptId: string;
      executionGeneration: number;
    };
export type KnowledgeContext = { accountId: string; workspaceId: string; actor: KnowledgeActor };

async function inKnowledgeContext<T>(
  db: Database,
  context: KnowledgeContext,
  fn: (tx: Database) => Promise<T>,
) {
  if (context.actor.kind === "agent") return withWorkspaceRls(db, context.workspaceId, fn);
  return withWorkspaceSubjectRls(db, context.workspaceId, context.actor.subjectId, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('opengeni.principal_kind', ${context.actor.kind === "agent" ? "agent_attempt" : context.actor.principalKind}, true)`,
    );
    return fn(tx);
  });
}

async function apply(db: Database, context: KnowledgeContext, request: Record<string, unknown>) {
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ receipt: unknown }>(
      tx,
      sql`
      SELECT knowledge_entry_apply(${context.accountId}::uuid,${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS receipt`,
    );
    return KnowledgeEntryWriteReceipt.parse(row?.receipt);
  });
}

/** Freeze before model execution; retries of the logical turn recover the same policy. */
export async function freezeAgentLearningPolicy(db: Database, context: KnowledgeContext) {
  if (context.actor.kind !== "agent")
    throw new Error("Learning snapshots require an exact agent attempt");
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ policy: unknown }>(
      tx,
      sql`SELECT knowledge_entry_read(${context.accountId}::uuid,
      ${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,'{"operation":"policy"}'::jsonb) AS policy`,
    );
    return z
      .object({
        defaultScope: z.enum(["workspace", "personal"]),
        subjectId: z.string().nullable(),
        effective: AgentLearningDefaults,
      })
      .passthrough()
      .parse(row?.policy);
  });
}

export async function saveKnowledgeEntry(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeEntrySaveRequest,
) {
  const request = KnowledgeEntrySaveRequest.parse(input);
  return apply(db, context, {
    ...request,
    operation: "save",
    entry: toPostgresLosslessJson(request.entry),
    codecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
    preview: toPostgresLosslessText(request.entry.content.slice(0, 512)),
    searchText: toPostgresLosslessText(`${request.entry.title}\n${request.entry.content}`),
  });
}

export async function promoteTaskNoteToKnowledge(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeTaskNotePromotionRequest,
) {
  return apply(db, context, {
    ...KnowledgeTaskNotePromotionRequest.parse(input),
    operation: "promote_note",
  });
}

export async function reviewKnowledgeEntry(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeEntryReviewRequest,
) {
  const { decision, entry, ...request } = KnowledgeEntryReviewRequest.parse(input);
  return apply(db, context, {
    ...request,
    operation: entry ? "approve_edit" : decision,
    ...(entry
      ? {
          entry: toPostgresLosslessJson(entry),
          codecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
          preview: toPostgresLosslessText(entry.content.slice(0, 512)),
          searchText: toPostgresLosslessText(`${entry.title}\n${entry.content}`),
        }
      : {}),
  });
}

/** Atomic review of exact revisions; dependencies publish before their findings. */
export async function reviewKnowledgeEntries(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeEntryBatchReviewRequest,
) {
  const request = KnowledgeEntryBatchReviewRequest.parse(input);
  return inKnowledgeContext(db, context, async (tx) => {
    // Same lock/order as individual publication. No unrelated reviewer can
    // change a selected revision between ordering, validation and application.
    await tx.execute(
      sql`SELECT 1 FROM workspaces WHERE id=${context.workspaceId}::uuid AND account_id=${context.accountId}::uuid FOR KEY SHARE`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`knowledge-publication:${context.accountId}`},0))`,
    );
    const remaining = new Map(request.entries.map((entry) => [entry.entryId, entry]));
    const pending = new Map<string, KnowledgeEntryRecord>();
    for (const entry of request.entries) {
      const record = await getKnowledgeEntry(tx, context, entry.entryId, { view: "needs_review" });
      if (record) pending.set(entry.entryId, record);
    }
    const receipts: KnowledgeEntryWriteReceipt[] = [];
    while (remaining.size) {
      let advanced = false;
      for (const [id, entry] of remaining) {
        const record = pending.get(id);
        const content = entry.entry ?? record?.revision.entry;
        const dependencies =
          entry.decision === "approve" && record?.revision.change !== "archive" && content
            ? [
                ...(content.evidence ?? [])
                  .filter(
                    (evidence) =>
                      pending.get(evidence.entryId)?.revision.id === evidence.revisionId,
                  )
                  .map((evidence) => evidence.entryId),
                ...[
                  ...(content.groupIds ?? []),
                  ...(content.relationships ?? []).map((relation) => relation.entryId),
                ].filter(
                  (dependency) =>
                    pending.has(dependency) && !pending.get(dependency)?.publishedRevisionId,
                ),
              ]
            : [];
        if (
          dependencies.some(
            (dependency) =>
              remaining.has(dependency) && remaining.get(dependency)?.decision === "approve",
          )
        )
          continue;
        receipts.push(await reviewKnowledgeEntry(tx, context, entry));
        remaining.delete(id);
        advanced = true;
      }
      if (!advanced)
        throw new z.ZodError([
          {
            code: "custom",
            path: ["entries"],
            message: "Review contains a dependency cycle; review the linked entries first",
          },
        ]);
    }
    return { receipts };
  });
}

export async function restoreKnowledgeEntry(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeEntryRestoreRequest,
) {
  const request = KnowledgeEntryRestoreRequest.parse(input);
  return apply(db, context, { ...request, operation: "restore" });
}

export async function archiveKnowledgeEntry(
  db: Database,
  context: KnowledgeContext,
  input: {
    operationId: string;
    entryId: string;
    expectedVersion: number;
  },
) {
  const request = z
    .object({
      operationId: z.uuid(),
      entryId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict()
    .parse(input);
  return apply(db, context, { ...request, operation: "archive" });
}

const StoredProjection = z
  .object({
    revision: z
      .object({
        entry: z.unknown().nullable(),
        title: z.string(),
        preview: z.string(),
        bodyCodecVersion: z.number().nullable(),
        previewCodecVersion: z.number().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

function decodeProjection(value: unknown, full: true): KnowledgeEntryRecord;
function decodeProjection(value: unknown, full: false): KnowledgeEntrySummary;
function decodeProjection(value: unknown, full: boolean) {
  const stored = StoredProjection.parse(value);
  const {
    bodyCodecVersion,
    previewCodecVersion,
    entry,
    title,
    preview,
    kind,
    groupIds,
    sourceKind,
    ...revision
  } = stored.revision;
  const { revision: _storedRevision, score, excerpts, ...record } = stored;
  const decodedExcerpts = z
    .array(
      z.object({
        field: z.enum(["title", "content"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string(),
        codecVersion: z.number().nullable(),
      }),
    )
    .parse(excerpts ?? [])
    .map(({ codecVersion, text, ...excerpt }) => ({
      ...excerpt,
      text: fromPostgresLosslessText(text, codecVersion),
    }));
  return full
    ? KnowledgeEntryRecord.parse({
        ...record,
        revision: { ...revision, entry: fromPostgresLosslessJson(entry, bodyCodecVersion) },
      })
    : KnowledgeEntrySummary.parse({
        ...record,
        score,
        excerpts: decodedExcerpts,
        revision: {
          ...revision,
          kind,
          groupIds,
          sourceKind,
          title: fromPostgresLosslessJson(title, bodyCodecVersion),
          preview: fromPostgresLosslessText(preview, previewCodecVersion),
        },
      });
}

async function read(
  db: Database,
  context: KnowledgeContext,
  request: Record<string, unknown>,
): Promise<unknown[]> {
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`
      SELECT knowledge_entry_read(${context.accountId}::uuid,${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return z.array(z.unknown()).parse(row?.result);
  });
}

export async function getKnowledgeEntry(
  db: Database,
  context: KnowledgeContext,
  entryId: string,
  options: {
    revisionId?: string | undefined;
    view?: "published" | "needs_review" | "archived" | "rejected" | undefined;
  } = {},
): Promise<KnowledgeEntryRecord | null> {
  const request = z
    .object({
      entryId: z.uuid(),
      revisionId: z.uuid().optional(),
      view: z.enum(["published", "needs_review", "archived", "rejected"]).optional(),
    })
    .strict()
    .parse({ entryId, ...options });
  const rows = await read(db, context, { ...request, operation: "get", limit: 1 });
  return rows[0] ? decodeProjection(rows[0], true) : null;
}

const Cursor = z
  .object({
    v: z.literal(2),
    afterId: z.uuid(),
    afterScore: z.number().finite(),
    queryHash: z.string().length(64),
  })
  .strict();
export async function listKnowledgeEntries(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeEntryListRequest = {},
  embedding?: { model: string; values: number[] } | undefined,
) {
  const { cursor, ...request } = KnowledgeEntryListRequest.parse(input);
  const queryHash = createHash("sha256")
    .update(JSON.stringify({ context, request, embeddingModel: embedding?.model ?? null }))
    .digest("hex");
  let position: z.infer<typeof Cursor> | null = null;
  try {
    position = cursor
      ? Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      : null;
    if (position && position.queryHash !== queryHash) throw new Error("Changed query");
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["cursor"],
        message: "This search changed. Refresh the results to continue.",
      },
    ]);
  }
  const rows = await read(db, context, {
    ...request,
    operation: "list",
    ...(position ? { afterId: position.afterId, afterScore: position.afterScore } : {}),
    ...(embedding
      ? {
          embedding: z.array(z.number().finite()).min(1).max(4096).parse(embedding.values),
          embeddingModel: embedding.model,
        }
      : {}),
  });
  const entries = rows.slice(0, request.limit).map((row) => decodeProjection(row, false));
  return {
    entries,
    nextCursor:
      rows.length > request.limit && entries.length
        ? Buffer.from(
            JSON.stringify({
              v: 2,
              afterId: entries.at(-1)!.id,
              afterScore: entries.at(-1)!.score ?? 0,
              queryHash,
            }),
          ).toString("base64url")
        : null,
  };
}

export async function listKnowledgeReviewBatches(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeReviewBatchListRequest = {},
) {
  const { cursor, ...request } = KnowledgeReviewBatchListRequest.parse(input);
  const queryHash = createHash("sha256")
    .update(JSON.stringify({ context, request, operation: "review_batches" }))
    .digest("hex");
  let position: z.infer<typeof Cursor> | null = null;
  try {
    position = cursor
      ? Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      : null;
    if (position && position.queryHash !== queryHash) throw new Error("Changed filter");
  } catch {
    throw new z.ZodError([
      { code: "custom", path: ["cursor"], message: "Review groups changed. Refresh to continue." },
    ]);
  }
  const rows = z.array(KnowledgeReviewBatch).parse(
    await read(db, context, {
      ...request,
      operation: "review_batches",
      ...(position ? { afterId: position.afterId } : {}),
    }),
  );
  const batches = rows.slice(0, request.limit);
  return {
    batches,
    nextCursor:
      rows.length > request.limit && batches.length
        ? Buffer.from(
            JSON.stringify({ v: 2, afterId: batches.at(-1)!.id, afterScore: 0, queryHash }),
          ).toString("base64url")
        : null,
  };
}

export async function listKnowledgeEntryHistory(
  db: Database,
  context: KnowledgeContext,
  entryId: string,
  beforeRevision?: number,
) {
  const request = z
    .object({ entryId: z.uuid(), beforeRevision: z.number().int().positive().optional() })
    .parse({ entryId, beforeRevision });
  const rows = await read(db, context, { ...request, operation: "history", limit: 20 });
  const entries = rows.slice(0, 20).map((row) => decodeProjection(row, false));
  return { entries, beforeRevision: rows.length > 20 ? entries.at(-1)!.revision.number : null };
}

const SettingsRecord = z.object({
  ownerKey: z.string(),
  contextKey: z.string(),
  version: z.number().int().nonnegative(),
  settings: AgentLearningOverridePatch,
});
function contextKey(context?: AgentLearningContext) {
  return context ? `${context.kind}:${context.id}` : "defaults";
}
async function manageLearning(
  db: Database,
  context: KnowledgeContext,
  request: Record<string, unknown>,
) {
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`
      SELECT agent_learning_manage(${context.accountId}::uuid,${context.workspaceId}::uuid,
        ${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return row?.result;
  });
}
export async function getAgentLearningSettings(
  db: Database,
  context: KnowledgeContext,
  scope: "workspace" | "personal" | "context",
  source?: AgentLearningContext,
) {
  return SettingsRecord.parse(
    await manageLearning(db, context, { operation: "read", scope, contextKey: contextKey(source) }),
  );
}
export async function saveAgentLearningSettings(
  db: Database,
  context: KnowledgeContext,
  input: {
    scope: "workspace" | "personal";
    source?: AgentLearningContext | undefined;
    operationId: string;
    expectedVersion: number;
    settings: AgentLearningOverridePatch;
  },
) {
  const request = z
    .object({
      scope: z.enum(["workspace", "personal"]),
      operationId: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
    })
    .parse(input);
  const settings = input.source
    ? AgentLearningOverridePatch.parse(input.settings)
    : AgentLearningDefaults.parse(input.settings);
  return SettingsRecord.parse(
    await manageLearning(db, context, {
      ...request,
      operation: "save",
      contextKey: contextKey(input.source),
      settings,
    }),
  );
}
export async function listAgentLearningOverrides(
  db: Database,
  context: KnowledgeContext,
  scope: "workspace" | "personal",
) {
  return z
    .array(
      z.object({
        contextKey: z.string(),
        version: z.number().int().positive(),
        settings: AgentLearningOverridePatch,
        updatedAt: z.string(),
        label: z.string(),
      }),
    )
    .parse(await manageLearning(db, context, { operation: "list", scope }));
}

async function instructionOperation(
  db: Database,
  context: KnowledgeContext,
  request: Record<string, unknown>,
) {
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT agent_instruction_apply(${context.accountId}::uuid,
      ${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return row?.result;
  });
}
export async function saveAgentInstruction(
  db: Database,
  context: KnowledgeContext,
  input: AgentInstructionSaveRequest,
) {
  return AgentInstructionReceipt.parse(
    await instructionOperation(db, context, {
      ...AgentInstructionSaveRequest.parse(input),
      operation: "save",
    }),
  );
}

export async function getAgentInstruction(
  db: Database,
  context: KnowledgeContext,
  target: WorkspaceInstructionPolicyTarget,
) {
  return z
    .object({
      target: WorkspaceInstructionPolicyTarget,
      expectedCurrentRevisionId: z.uuid().nullable(),
      expectedActivationVersion: z.number().int().nonnegative(),
      content: z.string().nullable(),
    })
    .parse(
      await instructionOperation(db, context, {
        operation: "get",
        target: WorkspaceInstructionPolicyTarget.parse(target),
      }),
    );
}
export async function reviewAgentInstruction(
  db: Database,
  context: KnowledgeContext,
  input: AgentInstructionReviewRequest,
) {
  const { decision, ...request } = AgentInstructionReviewRequest.parse(input);
  return AgentInstructionReceipt.parse(
    await instructionOperation(db, context, { ...request, operation: decision }),
  );
}
export async function listAgentInstructionReviews(
  db: Database,
  context: KnowledgeContext,
  cursor?: string,
) {
  const request = z.object({ cursor: z.uuid().optional() }).parse({ cursor });
  const rows = z
    .array(AgentInstructionReviewItem)
    .parse(await instructionOperation(db, context, { ...request, operation: "list" }));
  return { entries: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.revisionId : null };
}

/** Host-only parser boundary. The file metadata is never returned by agent tools. */
export async function inspectKnowledgeFilePreparation(
  db: Database,
  context: KnowledgeContext,
  fileId: string,
) {
  const value = await knowledgeFilePreparationOperation(db, context, {
    operation: "inspect",
    fileId: z.uuid().parse(fileId),
  });
  if (value && typeof value === "object" && "status" in value && value.status === "prepare") {
    const raw = z.object({ file: z.record(z.string(), z.unknown()) }).parse(value).file;
    return {
      status: "prepare" as const,
      file: knowledgeOriginalFileAsset(raw),
    };
  }
  return KnowledgeFilePreparationResult.parse(value);
}

/** Concurrent/recovered preparations converge on the first exact saved source. */
export async function completeKnowledgeFilePreparation(
  db: Database,
  context: KnowledgeContext,
  input: { fileId: string; title: string; content: string; sourceVersion?: string },
) {
  return KnowledgeFilePreparationResult.parse(
    await knowledgeFilePreparationOperation(db, context, {
      operation: "complete",
      fileId: z.uuid().parse(input.fileId),
      ...(input.sourceVersion
        ? {
            sourceVersion: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(input.sourceVersion),
          }
        : {}),
      title: toPostgresLosslessJson(input.title),
      content: toPostgresLosslessJson(input.content),
      preview: toPostgresLosslessText(input.content.slice(0, 512)),
      searchText: toPostgresLosslessText(`${input.title}\n${input.content}`),
      codecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
    }),
  );
}
async function knowledgeFilePreparationOperation(
  db: Database,
  context: KnowledgeContext,
  request: Record<string, unknown>,
) {
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_entry_prepare_file(
      ${context.accountId}::uuid,${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,
      ${JSON.stringify(request)}::jsonb) AS result`,
    );
    return row?.result;
  });
}

export function knowledgeOriginalFileAsset(raw: Record<string, unknown>): FileAsset {
  return FileAsset.parse({
    id: raw.id,
    workspaceId: raw.workspace_id,
    status: raw.status,
    filename: raw.filename,
    safeFilename: raw.safe_filename,
    contentType: raw.content_type,
    sizeBytes: Number(raw.size_bytes),
    sha256: raw.sha256,
    bucket: raw.bucket,
    objectKey: raw.object_key,
    scope: raw.private_owner_subject_id ? "personal" : "workspace",
    createdAt: new Date(String(raw.created_at)).toISOString(),
    updatedAt: new Date(String(raw.updated_at)).toISOString(),
  });
}

/** Exact entry visibility first; origin workspace metadata is not an access grant. */
export async function getKnowledgeOriginalFile(
  db: Database,
  context: KnowledgeContext,
  entryId: string,
  revisionId?: string,
) {
  return inKnowledgeContext(db, context, async (tx) => {
    const request = {
      operation: "file",
      entryId: z.uuid().parse(entryId),
      ...(revisionId ? { revisionId: z.uuid().parse(revisionId) } : {}),
    };
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_entry_read(${context.accountId}::uuid,
      ${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS result`,
    );
    return row?.result
      ? knowledgeOriginalFileAsset(z.record(z.string(), z.unknown()).parse(row.result))
      : null;
  });
}

/** Finish only a pre-cutover, human-answered remember confirmation. */
export async function confirmLegacyKnowledge(
  db: Database,
  context: KnowledgeContext,
  request: {
    operationId: string;
    claimId: string;
    humanInputRequestId: string;
  },
) {
  const input = z
    .object({ operationId: z.uuid(), claimId: z.uuid(), humanInputRequestId: z.uuid() })
    .strict()
    .parse(request);
  if (context.actor.kind !== "agent")
    throw new Error("Legacy confirmation requires an exact agent attempt");
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ receipt: unknown }>(
      tx,
      sql`SELECT knowledge_entry_confirm_legacy(
      ${context.accountId}::uuid,${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,
      ${JSON.stringify(input)}::jsonb) AS receipt`,
    );
    return KnowledgeEntryWriteReceipt.parse(row?.receipt);
  });
}

/** Compatibility only: finish an imported native instruction without rebaselining. */
export async function confirmLegacyInstruction(
  db: Database,
  context: KnowledgeContext,
  request: {
    operationId: string;
    proposalId: string;
    decisionReceiptId: string;
    humanInputRequestId: string;
  },
) {
  const input = z
    .object({
      operationId: z.uuid(),
      proposalId: z.uuid(),
      decisionReceiptId: z.uuid(),
      humanInputRequestId: z.uuid(),
    })
    .strict()
    .parse(request);
  if (context.actor.kind !== "agent")
    throw new Error("Legacy confirmation requires an exact agent attempt");
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ receipt: unknown }>(
      tx,
      sql`SELECT knowledge_entry_confirm_legacy(
      ${context.accountId}::uuid,${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,
      ${JSON.stringify(input)}::jsonb) AS receipt`,
    );
    return AgentInstructionReceipt.parse(row?.receipt);
  });
}

/** Protocol recovery runs before the model, including when the retired tool is no longer selected. */
export async function recoverLegacyKnowledgeConfirmations(db: Database, context: KnowledgeContext) {
  if (context.actor.kind !== "agent")
    throw new Error("Confirmation recovery requires an exact attempt");
  return inKnowledgeContext(db, context, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`SELECT knowledge_entry_confirm_legacy(
      ${context.accountId}::uuid,${context.workspaceId}::uuid,${JSON.stringify(context.actor)}::jsonb,
      '{"operation":"recover"}'::jsonb) AS result`,
    );
    return z
      .object({
        receipts: z.array(KnowledgeEntryWriteReceipt),
        instructionReceipts: z.array(AgentInstructionReceipt),
        unavailable: z.number().int().nonnegative(),
      })
      .parse(row?.result);
  });
}

/** Explicit content from this agent's bound source, including its own pending batch.
 * Ambient retrieval continues to return published knowledge only. */
export async function readScheduledKnowledgeSource(
  db: Database,
  context: KnowledgeContext,
  input: {
    entryId?: string;
    afterId?: string;
    offset?: number;
  },
) {
  const request = z
    .object({
      entryId: z.uuid().optional(),
      afterId: z.uuid().optional(),
      offset: z.number().int().min(0).max(100_000_000).optional(),
    })
    .strict()
    .parse(input);
  const rows = await read(db, context, {
    operation: request.entryId ? "source_read" : "source_list",
    limit: 20,
    ...(request.entryId ? { entryId: request.entryId } : {}),
    ...(request.afterId ? { afterId: request.afterId } : {}),
  });
  const records = rows.map((row) =>
    z
      .object({
        entryId: z.uuid(),
        revisionId: z.uuid(),
        title: z.string(),
        content: z.string().optional(),
        codecVersion: z.number(),
        pending: z.boolean(),
      })
      .parse(row),
  );
  const items = records.slice(0, 20).map((row) => {
    const title = z.string().parse(fromPostgresLosslessJson(row.title, row.codecVersion));
    if (row.content === undefined) return { ...row, title };
    const content = z.string().parse(fromPostgresLosslessJson(row.content, row.codecVersion));
    const offset = request.offset ?? 0;
    return {
      ...row,
      title,
      content: content.slice(offset, offset + 16_000),
      offset,
      totalCharacters: content.length,
      nextOffset: offset + 16_000 < content.length ? offset + 16_000 : null,
    };
  });
  return { items, nextCursor: records.length > 20 ? (items.at(-1)?.entryId ?? null) : null };
}
