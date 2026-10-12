import {
  omitOutputOnlyHistoryItemFields,
  attributeCompactionConversation,
  conversionDigest,
  conversionChunkKey,
  conversionWorkUnits,
  validConversionBudget,
  type ConversionTarget,
  type ConversionBudget,
  type ConversionCheckpoint,
  type ConversionManifest,
} from "@opengeni/codex";
import type { SessionEvent } from "@opengeni/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Database, withSessionActivityRlsContext, rawRows } from "./database";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "./lossless-json";
import {
  lockTurnAttemptWriteFenceTx,
  type TurnAttemptFenceRejectReason,
} from "./session-attempt-fence";
import * as schema from "./schema";

/** Internal, dormant API. Call outside placement; never nest its history fence there. */
export type CompactionConversionAttempt = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
};

type Unavailable =
  | TurnAttemptFenceRejectReason
  | "archived"
  | "not_remote"
  | "conversion_refused"
  | "history_changed"
  | "coverage_invalid"
  | "request_unsettled"
  | "checkpoint_conflict"
  | "conversion_budget_exhausted";
type Boundary = {
  maxPosition: number;
  rowCount: number;
  lastClearPosition: number | null;
  lastCompactionId: string | null;
  contentDigest: string;
};

export type CompactionConversionSnapshot = {
  attempt: CompactionConversionAttempt;
  authorityDigest: string;
  boundary: Boundary;
  rows: Array<{
    id: string;
    position: number;
    turnId: string | null;
    createdAt: string;
    item: Record<string, unknown>;
  }>;
  events: Array<{
    sequence: number;
    turnId: string | null;
    createdAt: string;
    payload: Record<string, unknown>;
  }>;
};

const historyScope = (input: CompactionConversionAttempt) =>
  and(
    eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
    eq(schema.sessionHistoryItems.sessionId, input.sessionId),
  );

async function readHistory(tx: Database, input: CompactionConversionAttempt) {
  const rows = await tx
    .select({
      id: schema.sessionHistoryItems.id,
      position: schema.sessionHistoryItems.position,
      turnId: schema.sessionHistoryItems.turnId,
      // Date would discard sub-millisecond transaction provenance.
      createdAt: sql<string>`${schema.sessionHistoryItems.createdAt}::text`,
      item: schema.sessionHistoryItems.item,
      codec: schema.sessionHistoryItems.itemCodecVersion,
    })
    .from(schema.sessionHistoryItems)
    .where(historyScope(input))
    .orderBy(asc(schema.sessionHistoryItems.position));
  const events = await tx
    .select({
      id: schema.sessionEvents.id,
      sequence: schema.sessionEvents.sequence,
      turnId: schema.sessionEvents.turnId,
      createdAt: sql<string>`${schema.sessionEvents.createdAt}::text`,
      payload: schema.sessionEvents.payload,
      codec: schema.sessionEvents.payloadCodecVersion,
    })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.type, "session.context.compacted"),
      ),
    )
    .orderBy(asc(schema.sessionEvents.sequence));
  const decoded = rows.map(({ codec, ...row }) => ({
    ...row,
    item: fromPostgresLosslessJson(row.item, codec),
  }));
  return {
    rows: decoded,
    events: events.map(({ codec, id: _id, ...event }) => ({
      ...event,
      payload: fromPostgresLosslessJson(event.payload, codec) as Record<string, unknown>,
    })),
    boundary: {
      maxPosition: decoded.at(-1)?.position ?? -1,
      rowCount: decoded.length,
      lastClearPosition:
        [...decoded]
          .reverse()
          .find(
            (row) =>
              row.turnId === null &&
              row.item.type === "message" &&
              row.item.role === "user" &&
              row.item.content === "[context cleared]",
          )?.position ?? null,
      lastCompactionId: events.at(-1)?.id ?? null,
      contentDigest: conversionDigest({ rows: decoded, events }),
    },
  };
}

function unavailable(session: typeof schema.sessions.$inferSelect): Unavailable | null {
  if (session.contentArchiveState !== null || session.importedArchiveImportId !== null)
    return "archived";
  if (session.codexCompactionMode !== "remote_v2") return "not_remote";
  if (session.compactionConversionRefusedAt !== null) return "conversion_refused";
  return null;
}

/**
 * Coherent rebuild input under the same session/attempt lock as history writers.
 * Return all audit rows so copied clear markers can be distinguished from real
 * clears by the pure runtime reconstructor. No lock survives the snapshot read.
 */
export async function readCompactionConversionSnapshot(
  db: Database,
  input: CompactionConversionAttempt,
): Promise<
  | { available: true; snapshot: CompactionConversionSnapshot }
  | { available: false; reason: Unavailable }
> {
  return withSessionActivityRlsContext(db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) return { available: false, reason: fence.reason };
    const reason = unavailable(fence.session);
    if (reason) return { available: false, reason };
    return {
      available: true,
      snapshot: {
        attempt: { ...input },
        authorityDigest: conversionDigest(fence.turn.metadata),
        ...(await readHistory(tx, input)),
      },
    };
  });
}

function sameSnapshot(
  input: CompactionConversionAttempt,
  snapshot: CompactionConversionSnapshot,
  boundary: Boundary,
): boolean {
  return (
    (Object.keys(input) as Array<keyof CompactionConversionAttempt>).every(
      (key) => input[key] === snapshot.attempt[key],
    ) &&
    boundary.maxPosition === snapshot.boundary.maxPosition &&
    boundary.rowCount === snapshot.boundary.rowCount &&
    boundary.lastClearPosition === snapshot.boundary.lastClearPosition &&
    boundary.lastCompactionId === snapshot.boundary.lastCompactionId &&
    boundary.contentDigest === snapshot.boundary.contentDigest
  );
}

export type PreparedCompactionConversion = {
  snapshot: CompactionConversionSnapshot;
  snapshotId: string;
  manifest: ConversionManifest;
  target: ConversionTarget;
  budget: ConversionBudget;
};

/** Pure identity preparation. The returned request id grants no dispatch authority. */
export function prepareCompactionConversion(
  snapshot: CompactionConversionSnapshot,
  target: ConversionTarget,
  budget: ConversionBudget,
): PreparedCompactionConversion {
  const source = attributeCompactionConversation(snapshot);
  if (!source.rebuilt || !conversionWorkUnits(source.sourceRows))
    throw new Error("conversion_unsupported_content");
  if (!validConversionBudget(budget)) throw new Error("conversion_budget_exhausted");
  if (!target.provider || !target.modelId || !target.connectionId)
    throw new Error("conversion_target_missing");
  const snapshotId = conversionDigest({
    algorithm: "all_units_v1",
    attempt: snapshot.attempt,
    authorityDigest: snapshot.authorityDigest,
    boundary: snapshot.boundary,
    manifest: source.manifest,
    target,
    budget,
  });
  return {
    snapshot,
    snapshotId,
    manifest: source.manifest,
    target: { ...target },
    budget: { ...budget },
  };
}

export function compactionConversionRequestId(
  plan: PreparedCompactionConversion,
  chunkKey: string,
): string {
  return `compaction-conversion:${plan.snapshotId}:${chunkKey}`;
}

type SavedChunk = {
  operation_id: string;
  checkpoint: ConversionCheckpoint;
  snapshot_id: string;
  bindings_match?: boolean;
};
async function chunks(
  tx: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
): Promise<SavedChunk[]> {
  return rawRows<SavedChunk>(
    tx,
    sql`select operation_id, checkpoint, snapshot_id,
    (turn_id=${input.turnId}::uuid and attempt_id=${input.attemptId}::uuid and generation=${input.executionGeneration}
      and source_digest=${plan.snapshot.boundary.contentDigest} and target_provider=${plan.target.provider}
      and target_model=${plan.target.modelId} and target_connection_id=${plan.target.connectionId}::uuid
      and checkpoint->>'key'=chunk_key) as bindings_match from session_compaction_conversion_chunks
    where account_id=${input.accountId}::uuid and workspace_id=${input.workspaceId}::uuid and session_id=${input.sessionId}::uuid
      and snapshot_id=${plan.snapshotId} order by created_at, chunk_key`,
  );
}

async function verifiedChunks(
  tx: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
): Promise<SavedChunk[] | null> {
  const pending = await chunks(tx, input, plan);
  if (pending.some((row) => !row.bindings_match || !checkpointShape(row.checkpoint))) return null;
  const verified: SavedChunk[] = [];
  while (pending.length) {
    const index = pending.findIndex((row) =>
      row.checkpoint.children.every((key) =>
        verified.some((entry) => entry.checkpoint.key === key),
      ),
    );
    if (index < 0) return null;
    const row = pending.splice(index, 1)[0]!;
    if (
      !validChunk(plan, row.checkpoint, verified) ||
      !(await receiptMatches(tx, input, plan, row.checkpoint.key, row.operation_id))
    )
      return null;
    verified.push(row);
  }
  if (
    verified.length > plan.budget.calls ||
    verified.reduce(
      (sum, row) => sum + row.checkpoint.inputTokens + row.checkpoint.outputTokens,
      0,
    ) > plan.budget.totalTokens
  )
    return null;
  return verified;
}

function planMatches(
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
  current: Awaited<ReturnType<typeof readHistory>>,
  authorityDigest: string,
): boolean {
  if (
    !sameSnapshot(input, plan.snapshot, current.boundary) ||
    authorityDigest !== plan.snapshot.authorityDigest
  )
    return false;
  try {
    const derived = prepareCompactionConversion(
      { ...plan.snapshot, ...current },
      plan.target,
      plan.budget,
    );
    return (
      derived.snapshotId === plan.snapshotId &&
      conversionDigest(derived.manifest) === conversionDigest(plan.manifest)
    );
  } catch {
    return false;
  }
}

async function receiptMatches(
  tx: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
  key: string,
  operationId: string,
): Promise<boolean> {
  const rows = await rawRows(
    tx,
    sql`select operation_id from subscription_operation_leases
    where account_id=${input.accountId}::uuid and workspace_id=${input.workspaceId}::uuid
      and session_id=${input.sessionId}::uuid and turn_id=${input.turnId}::uuid and attempt_id=${input.attemptId}::uuid
      and generation=${input.executionGeneration} and operation_id=${operationId}::uuid and operation_kind='model'
      and provider=${plan.target.provider} and connection_id=${plan.target.connectionId}::uuid
      and request_id=${compactionConversionRequestId(plan, key)} and transport_attempt=1
      and request_outcome='response_received' and request_observed_at is not null`,
  );
  return rows.length === 1;
}

function validChunk(
  plan: PreparedCompactionConversion,
  checkpoint: ConversionCheckpoint,
  previous: readonly SavedChunk[],
): boolean {
  if (!checkpointShape(checkpoint)) return false;
  const { key, summary, outputTokens, ...base } = checkpoint;
  if (
    key !== conversionChunkKey(plan.manifest, plan.target, plan.budget, base) ||
    !summary.trim() ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 1 ||
    outputTokens > plan.budget.outputTokens ||
    !Number.isSafeInteger(base.inputTokens) ||
    base.inputTokens > plan.budget.inputTokens ||
    outputTokens >= base.inputTokens ||
    !base.coverage.length ||
    new Set(base.coverage).size !== base.coverage.length
  )
    return false;
  let text: string;
  let coverage: string[];
  if (base.children.length) {
    if (new Set(base.children).size !== base.children.length) return false;
    if (
      previous.some((row) => row.checkpoint.children.some((child) => base.children.includes(child)))
    )
      return false;
    const selected = base.children.map(
      (child) => previous.find((row) => row.checkpoint.key === child)?.checkpoint,
    );
    if (selected.some((child) => !child)) return false;
    coverage = selected.flatMap((child) => child!.coverage);
    text = selected.map((child) => child!.summary).join("\n");
  } else {
    if (
      previous.some(
        (row) =>
          !row.checkpoint.children.length &&
          row.checkpoint.coverage.some((id) => base.coverage.includes(id)),
      )
    )
      return false;
    const source = attributeCompactionConversation(plan.snapshot);
    if (!source.rebuilt) return false;
    const units = conversionWorkUnits(source.sourceRows);
    if (!units) return false;
    const selected = units.filter((unit) => unit.coverage.some((id) => base.coverage.includes(id)));
    coverage = selected.flatMap((unit) => unit.coverage);
    text = selected.map((unit) => unit.text).join("\n");
  }
  const manifestIds = plan.manifest.rows.map((row) => row.id);
  const start = manifestIds.indexOf(base.coverage[0]!);
  return (
    start >= 0 &&
    conversionDigest(manifestIds.slice(start, start + base.coverage.length)) ===
      conversionDigest(base.coverage) &&
    conversionDigest(coverage) === conversionDigest(base.coverage) &&
    conversionDigest(text) === base.inputDigest
  );
}

function checkpointShape(value: ConversionCheckpoint): boolean {
  return (
    !!value &&
    typeof value.key === "string" &&
    typeof value.inputDigest === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.coverage) &&
    value.coverage.every((id) => typeof id === "string") &&
    Array.isArray(value.children) &&
    value.children.every((id) => typeof id === "string")
  );
}

// A settled response without a checkpoint is a recoverable crash window, not a
// new dispatch permit. E2 must recover that exact response or report refusal.
async function allRequestsAccounted(
  tx: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
  saved: readonly SavedChunk[],
): Promise<boolean> {
  const receipts = await rawRows<{ operation_id: string; request_outcome: string }>(
    tx,
    sql`select operation_id,request_outcome from subscription_operation_leases
    where account_id=${input.accountId}::uuid and workspace_id=${input.workspaceId}::uuid and session_id=${input.sessionId}::uuid
    and request_id like 'compaction-conversion:%'
    and (attempt_id=${input.attemptId}::uuid or request_outcome in ('reserved','unknown'))`,
  );
  return (
    saved.every((row) => row.snapshot_id === plan.snapshotId) &&
    receipts.length === saved.length &&
    receipts.every(
      (r) =>
        r.request_outcome === "response_received" &&
        saved.some((c) => c.operation_id === r.operation_id),
    )
  );
}

/** Persist a successful summary only after the exact core physical request settled.
 * E2 must reserve that request id on its authorized target, with tools disabled.
 * Unknown/refused requests never produce checkpoints or retry dispatch permits.
 */
export async function recordCompactionConversionChunk(
  db: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
  checkpoint: ConversionCheckpoint,
  operationId: string,
): Promise<{ recorded: true; duplicate: boolean } | { recorded: false; reason: Unavailable }> {
  return withSessionActivityRlsContext(db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) return { recorded: false, reason: fence.reason };
    const reason = unavailable(fence.session);
    if (reason) return { recorded: false, reason };
    if (
      !planMatches(input, plan, await readHistory(tx, input), conversionDigest(fence.turn.metadata))
    )
      return { recorded: false, reason: "history_changed" };
    const prior = await verifiedChunks(tx, input, plan);
    if (!prior) return { recorded: false, reason: "coverage_invalid" };
    const existing = prior.find((row) => row.checkpoint.key === checkpoint.key);
    if (existing)
      return existing.operation_id === operationId &&
        conversionDigest(existing.checkpoint) === conversionDigest(checkpoint)
        ? { recorded: true, duplicate: true }
        : { recorded: false, reason: "checkpoint_conflict" };
    if (!validChunk(plan, checkpoint, prior))
      return { recorded: false, reason: "coverage_invalid" };
    if (!(await receiptMatches(tx, input, plan, checkpoint.key, operationId)))
      return { recorded: false, reason: "request_unsettled" };
    if (
      !(await allRequestsAccounted(tx, input, plan, [
        ...prior,
        { operation_id: operationId, checkpoint, snapshot_id: plan.snapshotId },
      ]))
    )
      return { recorded: false, reason: "request_unsettled" };
    const incompatible = await rawRows(
      tx,
      sql`select 1 from session_compaction_conversion_chunks where workspace_id=${input.workspaceId}::uuid
      and session_id=${input.sessionId}::uuid and attempt_id=${input.attemptId}::uuid and source_digest=${plan.snapshot.boundary.contentDigest}
      and snapshot_id<>${plan.snapshotId} limit 1`,
    );
    if (incompatible.length) return { recorded: false, reason: "checkpoint_conflict" };
    const charged = prior.reduce(
      (sum, row) => sum + row.checkpoint.inputTokens + row.checkpoint.outputTokens,
      0,
    );
    if (
      prior.length + 1 > plan.budget.calls ||
      charged + checkpoint.inputTokens + checkpoint.outputTokens > plan.budget.totalTokens
    )
      return { recorded: false, reason: "conversion_budget_exhausted" };
    await tx.execute(sql`insert into session_compaction_conversion_chunks
      (account_id,workspace_id,session_id,turn_id,attempt_id,generation,snapshot_id,source_digest,chunk_key,operation_id,target_provider,target_model,target_connection_id,checkpoint)
      values (${input.accountId}::uuid,${input.workspaceId}::uuid,${input.sessionId}::uuid,${input.turnId}::uuid,${input.attemptId}::uuid,
        ${input.executionGeneration},${plan.snapshotId},${plan.snapshot.boundary.contentDigest},${checkpoint.key},${operationId}::uuid,
        ${plan.target.provider},${plan.target.modelId},${plan.target.connectionId}::uuid,${JSON.stringify(checkpoint)}::jsonb)`);
    return { recorded: true, duplicate: false };
  });
}

export async function readCompactionConversionChunks(
  db: Database,
  input: CompactionConversionAttempt,
  plan: PreparedCompactionConversion,
): Promise<
  | { available: true; checkpoints: ConversionCheckpoint[] }
  | { available: false; reason: Unavailable }
> {
  return withSessionActivityRlsContext(db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) return { available: false, reason: fence.reason };
    const reason = unavailable(fence.session);
    if (reason) return { available: false, reason };
    if (
      !planMatches(input, plan, await readHistory(tx, input), conversionDigest(fence.turn.metadata))
    )
      return { available: false, reason: "history_changed" };
    const saved = await verifiedChunks(tx, input, plan);
    if (!saved) return { available: false, reason: "coverage_invalid" };
    if (!(await allRequestsAccounted(tx, input, plan, saved)))
      return { available: false, reason: "request_unsettled" };
    return { available: true, checkpoints: saved.map((row) => row.checkpoint) };
  });
}

/**
 * One-way conversion OR durable refusal, atomic with the event. The summarizer
 * is deliberately not called here. E2 will supply its prepared portable result.
 * The exact attempt and rebuild boundary are revalidated under the history
 * write fence, so a concurrent append, clear or compaction wins or invalidates
 * this snapshot. No accepted execution policy or provider binding is modified.
 */
export async function finishCompactionConversion(
  db: Database,
  input: CompactionConversionAttempt,
  snapshot: CompactionConversionSnapshot,
  result:
    | { kind: "refused"; reason: "unsupported_layout" | "ambiguous_block" | "missing_event" }
    | {
        kind: "converted";
        plan: PreparedCompactionConversion;
        rootKey: string;
        /** Conversion must summarize every original unit; budget trimming is forbidden. */
        droppedWorkUnits: 0;
      },
): Promise<{ applied: false; reason: Unavailable } | { applied: true; event: SessionEvent }> {
  return withSessionActivityRlsContext(db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) return { applied: false, reason: fence.reason };
    // A committed conversion is the replay receipt, not permission to install
    // again. This exact-attempt read neither creates another event nor calls a model.
    if (
      result.kind === "converted" &&
      fence.session.codexCompactionMode === "portable" &&
      fence.session.contentArchiveState === null &&
      fence.session.importedArchiveImportId === null
    ) {
      const prior = await tx
        .select()
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.turnAttemptId, input.attemptId),
            eq(schema.sessionEvents.type, "session.context.compacted"),
            sql`${schema.sessionEvents.payload}->>'conversionSnapshotId'=${result.plan.snapshotId}`,
            sql`${schema.sessionEvents.payload}->>'conversionRootKey'=${result.rootKey}`,
          ),
        )
        .limit(1);
      if (prior[0]) return { applied: true, event: conversionEvent(prior[0]) };
    }
    const reason = unavailable(fence.session);
    if (reason) return { applied: false, reason };
    const current = await readHistory(tx, input);
    if (!sameSnapshot(input, snapshot, current.boundary))
      return { applied: false, reason: "history_changed" };
    let payload: Record<string, unknown>;
    if (result.kind === "refused") {
      await tx
        .update(schema.sessions)
        .set({ compactionConversionRefusedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      payload = { reason: "compaction_conversion_refused", detail: result.reason };
    } else {
      if (result.droppedWorkUnits !== 0)
        throw new Error(
          "conversion_unsummarized_units: summarize every retained work unit or refuse conversion",
        );
      if (!planMatches(input, result.plan, current, conversionDigest(fence.turn.metadata)))
        return { applied: false, reason: "history_changed" };
      const saved = await verifiedChunks(tx, input, result.plan);
      const root = saved?.find((row) => row.checkpoint.key === result.rootKey)?.checkpoint;
      if (
        !saved ||
        !root ||
        conversionDigest(root.coverage) !==
          conversionDigest(result.plan.manifest.rows.map((row) => row.id))
      )
        return { applied: false, reason: "coverage_invalid" };
      const visited = new Set<string>();
      const visit = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        saved.find((row) => row.checkpoint.key === key)!.checkpoint.children.forEach(visit);
      };
      visit(root.key);
      if (visited.size !== saved.length) return { applied: false, reason: "coverage_invalid" };
      if (!(await allRequestsAccounted(tx, input, result.plan, saved)))
        return { applied: false, reason: "request_unsettled" };
      const source = attributeCompactionConversation(current);
      if (!source.rebuilt) return { applied: false, reason: "coverage_invalid" };
      const supersededFrom = Math.floor(current.boundary.maxPosition) + 1;
      const summaryPosition = supersededFrom;
      const items = [
        {
          type: "message",
          role: "assistant",
          content: root.summary,
          opengeni_context_summary: true,
        },
      ];
      await tx.update(schema.sessionHistoryItems).set({ active: false }).where(historyScope(input));
      await tx.insert(schema.sessionHistoryItems).values(
        withLosslessContentWriteVersion(
          items.map((item, index) => ({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            position: supersededFrom + index,
            item: omitOutputOnlyHistoryItemFields(item),
            active: true,
          })),
          "item",
          "itemCodecVersion",
        ),
      );
      const metadata = { ...fence.turn.metadata };
      if (
        typeof metadata.providerRecoveryCount === "number" &&
        metadata.providerRecoveryCount > 0
      ) {
        delete metadata.providerRecoveryCount;
        delete metadata.providerRecoveryStartedAt;
        delete metadata.providerRecoveryReason;
        await tx
          .update(schema.sessionTurns)
          .set({ metadata, version: fence.turn.version + 1, updatedAt: new Date() })
          .where(eq(schema.sessionTurns.id, input.turnId));
      }
      await tx
        .update(schema.sessions)
        .set({ codexCompactionMode: "portable", lastInputTokens: null, compactRequested: false })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      payload = {
        conversion: "remote_to_portable",
        supersededFrom,
        summaryPosition,
        blockLength: items.length,
        droppedWorkUnits: result.droppedWorkUnits,
        conversionSnapshotId: result.plan.snapshotId,
        conversionRootKey: root.key,
        coverageDigest: source.manifest.digest,
        coveredRows: source.manifest.rows.length,
        summarizedUnits: conversionWorkUnits(source.sourceRows)!.length,
        layout: source.layout,
        omissions: source.omissions,
      };
    }
    const [event] = await tx
      .insert(schema.sessionEvents)
      .values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            turnGeneration: input.executionGeneration,
            turnAttemptId: input.attemptId,
            turnAssociation: "current",
            sequence: fence.session.lastSequence + 1,
            type:
              result.kind === "converted"
                ? "session.context.compacted"
                : "session.context.compaction.skipped",
            payload,
            occurredAt: new Date(),
          },
          "payload",
          "payloadCodecVersion",
        ),
      )
      .returning();
    await tx
      .update(schema.sessions)
      .set({ lastSequence: event!.sequence, updatedAt: new Date() })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      );
    return {
      applied: true,
      event: conversionEvent(event!),
    };
  });
}

function conversionEvent(event: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: event!.id,
    workspaceId: event!.workspaceId,
    sessionId: event!.sessionId,
    sequence: event!.sequence,
    type: event!.type as SessionEvent["type"],
    payload: fromPostgresLosslessJson(event!.payload, event!.payloadCodecVersion),
    occurredAt: event!.occurredAt.toISOString(),
    turnAssociation: "current",
    turnId: event!.turnId,
    turnGeneration: event!.turnGeneration,
    turnAttemptId: event!.turnAttemptId,
    clientEventId: event!.clientEventId,
    duplicateOfEventId: event!.duplicateOfEventId,
    duplicateReason: event!.duplicateReason,
  };
}
