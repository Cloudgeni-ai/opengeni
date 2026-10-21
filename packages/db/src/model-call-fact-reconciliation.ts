import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, rlsContextForWorkspace, withRlsContext, type Database } from "./database";
import type { ModelCallFactReconciliation } from "./insights";
import * as schema from "./schema";

const Position = z.object({ at: z.string(), id: z.string().uuid() });
const Checkpoint = z.object({
  since: z.string(),
  until: z.string(),
  complete: z.boolean(),
  phase: z.enum(["ledger", "events"]),
  after: Position.nullable(),
  turn: z
    .object({
      sessionId: z.string().uuid(),
      turnId: z.string().uuid(),
      after: Position.nullable(),
      exhausted: z.boolean(),
    })
    .nullable(),
});
export type ModelFactCheckpoint = z.infer<typeof Checkpoint>;
type UsageEvent = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  turnAttemptId: string | null;
  payload: unknown;
  occurredAt: Date;
};

/** Advance bounded input pages, not an unbounded scan with bounded output.
 * Discovery queues missing keys before repair so every missing turn's history
 * is read once per sweep, including legacy events with no usage_source_key.
 * Progress, queue changes and repairs commit together. Failed or interrupted
 * pages replay safely; permanent gaps cannot starve later ledger rows.
 */
export async function reconcileModelCallFactPage(
  db: Database,
  input: { workspaceId: string; since: Date; until: Date; limit?: number; signal?: AbortSignal },
  insertFact: (db: Database, workspaceId: string, event: UsageEvent) => Promise<boolean>,
): Promise<ModelCallFactReconciliation> {
  input.signal?.throwIfAborted();
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 1_000), 10_000));
  if (
    !Number.isFinite(limit) ||
    !Number.isFinite(input.since.getTime()) ||
    !Number.isFinite(input.until.getTime()) ||
    input.until <= input.since
  ) {
    throw new Error("Invalid model fact reconciliation page");
  }
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  return withRlsContext(db, context, async (scoped) => {
    input.signal?.throwIfAborted();
    const progress = schema.modelCallFactReconciliationProgress;
    const queue = schema.modelCallFactReconciliationCandidates;
    const workspace = eq(queue.workspaceId, input.workspaceId);
    await scoped
      .insert(progress)
      .values({ accountId: context.accountId, workspaceId: input.workspaceId })
      .onConflictDoNothing();
    const [row] = await scoped
      .select({ checkpoint: progress.checkpoint })
      .from(progress)
      .where(eq(progress.workspaceId, input.workspaceId))
      .for("update");
    if (!row) throw new Error("Model fact reconciliation scope disappeared");
    const prior = row.checkpoint === null ? null : Checkpoint.parse(row.checkpoint);
    // A slow sweep may finish after its original lookback has elapsed. Resume
    // from its end, not just now-minus-lookback, so no interval is skipped.
    const checkpoint: ModelFactCheckpoint =
      prior === null || prior.complete
        ? {
            since:
              prior && prior.until < input.since.toISOString()
                ? prior.until
                : input.since.toISOString(),
            until: input.until.toISOString(),
            complete: false,
            phase: "ledger",
            after: null,
            turn: null,
          }
        : prior;
    let missing = 0;
    let repaired = 0;

    if (checkpoint.phase === "ledger") {
      // Source validation and fact lookup happen AFTER LIMIT. Malformed or
      // already-faceted input cannot make a page scan the whole window.
      const [ledger] = await rawRows<{
        last: { at: string; id: string } | null;
        more: boolean;
      }>(
        scoped,
        sql`-- model-fact-ledger-page
        with input_page as materialized (
          select id,occurred_at,session_id,turn_id,source_resource_id,source_resource_type
          from ${schema.usageEvents}
          where workspace_id=${input.workspaceId}::uuid and event_type='model.cost'
            and occurred_at >= ${checkpoint.since}::timestamptz
            and occurred_at < ${checkpoint.until}::timestamptz
            ${checkpoint.after ? sql`and (occurred_at,id)>(${checkpoint.after.at}::timestamptz,${checkpoint.after.id}::uuid)` : sql``}
          order by occurred_at,id limit ${limit + 1}
        ), page as materialized (
          select * from input_page order by occurred_at,id limit ${limit}
        ), candidate as materialized (
          select session_id,turn_id,substr(source_resource_id,38) as source_key
          from page where session_id is not null and turn_id is not null
            and source_resource_type='model_response'
            and left(source_resource_id,37)=turn_id::text||':'
        ), queued as (
          insert into ${queue} (account_id,workspace_id,session_id,turn_id,source_key)
          select ${context.accountId}::uuid,${input.workspaceId}::uuid,candidate.*
          from candidate
          where not exists (select 1 from ${schema.modelCallFacts} fact
            where fact.workspace_id=${input.workspaceId}::uuid
              and fact.turn_id=candidate.turn_id and fact.source_key=candidate.source_key
            offset 0)
          on conflict (workspace_id,turn_id,source_key) do nothing
          returning 1
        )
        select (select jsonb_build_object('at',occurred_at::text,'id',id)
          from page order by occurred_at desc,id desc limit 1) as last,
          (select count(*) > ${limit} from input_page) as more,
          (select count(*) from queued) as queued`,
      );
      if (!ledger) throw new Error("Model fact ledger page disappeared");
      if (ledger.last) checkpoint.after = ledger.last;
      if (!ledger.more) {
        checkpoint.phase = "events";
        checkpoint.after = null;
      }
    }

    if (checkpoint.phase === "events") {
      if (!checkpoint.turn) {
        const [first] = await scoped
          .select({ sessionId: queue.sessionId, turnId: queue.turnId })
          .from(queue)
          .where(workspace)
          .orderBy(queue.turnId, queue.sourceKey)
          .limit(1);
        if (first) checkpoint.turn = { ...first, after: null, exhausted: false };
      }
      const turn = checkpoint.turn;
      if (turn && !turn.exhausted) {
        input.signal?.throwIfAborted();
        // Transfer keys, not full payloads, for unrelated usage history. Keep
        // historical first-event order (including sub-millisecond timestamps).
        const events = await rawRows<{
          id: string;
          at: string;
          source_key: string | null;
          turn_association: string;
        }>(
          scoped,
          sql`
          select id,occurred_at::text as at,payload->>'sourceKey' as source_key,turn_association
          from ${schema.sessionEvents}
          where workspace_id=${input.workspaceId}::uuid and session_id=${turn.sessionId}::uuid
            and turn_id=${turn.turnId}::uuid and type='agent.model.usage'
            ${turn.after ? sql`and (occurred_at,id)>(${turn.after.at}::timestamptz,${turn.after.id}::uuid)` : sql``}
          order by occurred_at,id limit ${limit + 1}`,
        );
        const page = events.slice(0, limit);
        const eventByKey = new Map<string, string>();
        for (const event of page)
          if (
            event.turn_association === "current" &&
            event.source_key !== null &&
            !eventByKey.has(event.source_key)
          )
            eventByKey.set(event.source_key, event.id);
        const keys = Array.from(eventByKey.keys());
        const candidates = keys.length
          ? await scoped
              .select({ sourceKey: queue.sourceKey })
              .from(queue)
              .where(and(workspace, eq(queue.turnId, turn.turnId), inArray(queue.sourceKey, keys)))
          : [];
        let noCandidatesRemain = false;
        if (candidates.length) {
          const ids = candidates.map((c) => eventByKey.get(c.sourceKey)!);
          const rows = await scoped
            .select({
              id: schema.sessionEvents.id,
              accountId: schema.sessionEvents.accountId,
              workspaceId: schema.sessionEvents.workspaceId,
              sessionId: schema.sessionEvents.sessionId,
              turnId: schema.sessionEvents.turnId,
              turnAttemptId: schema.sessionEvents.turnAttemptId,
              payload: schema.sessionEvents.payload,
              occurredAt: schema.sessionEvents.occurredAt,
            })
            .from(schema.sessionEvents)
            .where(
              and(
                eq(schema.sessionEvents.workspaceId, input.workspaceId),
                eq(schema.sessionEvents.sessionId, turn.sessionId),
                inArray(schema.sessionEvents.id, ids),
              ),
            );
          for (const event of rows) {
            input.signal?.throwIfAborted();
            if (await insertFact(scoped, input.workspaceId, event)) repaired++;
          }
          missing += candidates.length;
          await scoped.delete(queue).where(
            and(
              workspace,
              eq(queue.turnId, turn.turnId),
              inArray(
                queue.sourceKey,
                candidates.map((c) => c.sourceKey),
              ),
            ),
          );
          const [remaining] = await scoped
            .select({ sourceKey: queue.sourceKey })
            .from(queue)
            .where(and(workspace, eq(queue.turnId, turn.turnId)))
            .limit(1);
          noCandidatesRemain = !remaining;
        }
        const last = page[page.length - 1];
        if (last) turn.after = { at: last.at, id: last.id };
        turn.exhausted = noCandidatesRemain || events.length <= limit;
      }
      if (turn?.exhausted) {
        // Delete unrepairable keys in pages as well: one huge legacy turn must
        // not turn final cleanup into another unbounded statement.
        const unresolved = await scoped
          .select({ sourceKey: queue.sourceKey })
          .from(queue)
          .where(and(workspace, eq(queue.turnId, turn.turnId)))
          .orderBy(queue.sourceKey)
          .limit(limit + 1);
        const page = unresolved.slice(0, limit);
        if (page.length) {
          missing += page.length;
          await scoped.delete(queue).where(
            and(
              workspace,
              eq(queue.turnId, turn.turnId),
              inArray(
                queue.sourceKey,
                page.map((c) => c.sourceKey),
              ),
            ),
          );
        }
        if (unresolved.length <= limit) checkpoint.turn = null;
      }
      if (!checkpoint.turn) {
        const [remaining] = await scoped
          .select({ turnId: queue.turnId })
          .from(queue)
          .where(workspace)
          .limit(1);
        checkpoint.complete = !remaining;
      }
    }
    input.signal?.throwIfAborted();
    await scoped
      .update(progress)
      .set({ checkpoint })
      .where(
        and(eq(progress.workspaceId, input.workspaceId), eq(progress.accountId, context.accountId)),
      );
    input.signal?.throwIfAborted();
    return { missing, repaired, unrepaired: missing - repaired, truncated: !checkpoint.complete };
  });
}
