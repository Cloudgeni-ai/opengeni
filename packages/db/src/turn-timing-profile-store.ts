import { sql } from "drizzle-orm";
import { rawRows, rlsContextForWorkspace, withRlsContext, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import * as schema from "./schema";
import {
  computeTurnTimingProfile,
  TURN_TIMING_EVENT_TYPES,
  type TurnTimingAttempt,
  type TurnTimingEvent,
  type TurnTimingProfile,
} from "./turn-timing-profile";

/** The frozen turn dimensions stored next to a profile. */
export type TurnTimingProfileTurn = {
  id: string;
  accountId: string;
  sessionId: string;
  status: string;
  model: string;
  reasoningEffort: string;
  latencyMode: string;
  surface: string | null;
  source: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date;
};

export type RecordedTurnTimingProfile = {
  turn: TurnTimingProfileTurn;
  profile: TurnTimingProfile;
  /** False when the row already existed and was recomputed. */
  inserted: boolean;
};

export type TurnTimingProfilePass = {
  /** Finished turns without a profile that this pass looked at. */
  turns: number;
  /** New profiles written. */
  inserted: number;
  /** Profiles another writer stored first and this pass recomputed. */
  updated: number;
  failed: number;
};

/** Turns read and profiled per transaction. A batching unit, not a limit. */
const DEFAULT_PAGE_SIZE = 50;

type Cursor = { finishedAt: string; id: string };

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

/** A Postgres array literal of plain identifiers (uuids, event type names). */
function pgArray(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

/**
 * The content-free projection of each event the profile reads: phases,
 * durations, ids, names and families. Tool arguments and outputs never leave
 * the database except a router call's invoked tool name and the first
 * characters of an output (to recognise a rejected or failed call). The
 * projection keeps each field at its original path, so projecting a projected
 * payload changes nothing.
 */
const projectedPayload = sql`jsonb_strip_nulls(case e.type
  when 'agent.model.request' then jsonb_build_object(
    'phase', e.payload->'phase',
    'requestId', e.payload->'requestId',
    'transportAttempt', e.payload->'transportAttempt',
    'dispatchId', e.payload->'dispatchId',
    'durationMs', e.payload->'durationMs',
    'dispatchDelayMs', e.payload->'dispatchDelayMs',
    'willRetry', e.payload->'willRetry',
    'provider', e.payload->'provider',
    'model', e.payload->'model',
    'transport', case when jsonb_typeof(e.payload->'transport') = 'object' then jsonb_build_object(
      'kind', e.payload->'transport'->'kind',
      'timing', jsonb_build_object('server', e.payload->'transport'->'timing'->'server')) end)
  when 'agent.model.usage' then jsonb_build_object(
    'provider', e.payload->'provider',
    'model', e.payload->'model',
    'purpose', e.payload->'purpose',
    'timing', e.payload->'timing')
  when 'agent.toolCall.created' then jsonb_build_object(
    'id', e.payload->'id',
    'name', e.payload->'name',
    'toolFamily', e.payload->'toolFamily',
    'arguments', case when e.payload->>'name' = 'tool_invoke' then
      case jsonb_typeof(e.payload->'arguments')
        when 'object' then jsonb_build_object('name', e.payload->'arguments'->'name')
        when 'string' then jsonb_build_object('name', to_jsonb(substring(
          e.payload->>'arguments' from '"name"\\s*:\\s*"([^"]{1,256})"')))
      end end)
  when 'agent.toolCall.output' then jsonb_build_object(
    'id', e.payload->'id',
    'error', e.payload->'error',
    'failed', e.payload->'failed',
    'output', case jsonb_typeof(e.payload->'output')
      when 'string' then to_jsonb(left(e.payload->>'output', 64))
      when 'object' then jsonb_build_object(
        'isError', e.payload->'output'->'isError',
        'text', to_jsonb(left(e.payload->'output'->>'text', 64)))
    end)
  when 'turn.startup.phase.completed' then jsonb_build_object(
    'phase', e.payload->'phase',
    'durationMs', e.payload->'durationMs')
  when 'sandbox.operation.started' then jsonb_build_object('name', e.payload->'name')
  when 'sandbox.operation.completed' then jsonb_build_object('name', e.payload->'name')
  when 'sandbox.operation.failed' then jsonb_build_object('name', e.payload->'name')
  else '{}'::jsonb
end)`;

async function listTurnsMissingProfiles(
  db: Database,
  input: { workspaceId: string; since: Date; until: Date; after: Cursor | null; limit: number },
): Promise<Array<TurnTimingProfileTurn & { cursor: Cursor }>> {
  const rows = await rawRows<Record<string, unknown>>(
    db,
    sql`-- turn-timing-profile-candidates
    select t.id, t.account_id, t.session_id, t.status, t.model, t.reasoning_effort, t.latency_mode,
      t.surface, t.source, t.created_at, t.started_at, t.finished_at,
      t.finished_at::text as finished_at_cursor
    from ${schema.sessionTurns} t
    where t.workspace_id = ${input.workspaceId}::uuid
      and t.finished_at is not null
      and t.finished_at >= ${input.since.toISOString()}::timestamptz
      and t.finished_at < ${input.until.toISOString()}::timestamptz
      ${input.after ? sql`and (t.finished_at, t.id) > (${input.after.finishedAt}::timestamptz, ${input.after.id}::uuid)` : sql``}
      and not exists (select 1 from ${schema.turnTimingProfiles} p
        where p.workspace_id = t.workspace_id and p.turn_id = t.id)
      -- An archived chat's events are purged; its turns are profiled again
      -- only if it is restored.
      and not exists (select 1 from ${schema.sessions} s
        where s.workspace_id = t.workspace_id and s.id = t.session_id
          and s.content_archive_state is not null)
    order by t.finished_at, t.id
    limit ${input.limit}`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    accountId: String(row.account_id),
    sessionId: String(row.session_id),
    status: String(row.status),
    model: String(row.model),
    reasoningEffort: String(row.reasoning_effort),
    latencyMode: String(row.latency_mode),
    surface: row.surface === null || row.surface === undefined ? null : String(row.surface),
    source: String(row.source),
    createdAt: date(row.created_at),
    startedAt: nullableDate(row.started_at),
    finishedAt: date(row.finished_at),
    // Full precision, so the next page starts exactly after this turn.
    cursor: { finishedAt: String(row.finished_at_cursor), id: String(row.id) },
  }));
}

/** Load one page of turns' attempts and projected events in two reads. */
export async function loadTurnTimingInputs(
  db: Database,
  workspaceId: string,
  turns: readonly Pick<TurnTimingProfileTurn, "id" | "accountId" | "sessionId">[],
): Promise<Map<string, { attempts: TurnTimingAttempt[]; events: TurnTimingEvent[] }>> {
  const inputs = new Map<string, { attempts: TurnTimingAttempt[]; events: TurnTimingEvent[] }>();
  if (turns.length === 0) return inputs;
  for (const turn of turns) inputs.set(turn.id, { attempts: [], events: [] });
  const turnIds = turns.map((turn) => turn.id);
  const sessionIds = turns.map((turn) => turn.sessionId);
  const accountIds = turns.map((turn) => turn.accountId);
  const attempts = await rawRows<Record<string, unknown>>(
    db,
    sql`-- turn-timing-profile-attempts
    select a.turn_id, a.id, a.started_at, a.closed_at, a.outcome
    from ${schema.sessionTurnAttempts} a
    join unnest(${pgArray(accountIds)}::uuid[], ${pgArray(sessionIds)}::uuid[], ${pgArray(turnIds)}::uuid[])
      as k(account_id, session_id, turn_id)
      on a.account_id = k.account_id and a.session_id = k.session_id and a.turn_id = k.turn_id
    where a.workspace_id = ${workspaceId}::uuid`,
  );
  for (const row of attempts) {
    inputs.get(String(row.turn_id))?.attempts.push({
      id: String(row.id),
      startedAt: date(row.started_at),
      closedAt: nullableDate(row.closed_at),
      outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    });
  }
  const events = await rawRows<Record<string, unknown>>(
    db,
    sql`-- turn-timing-profile-events
    select e.turn_id, e.type, e.sequence, e.occurred_at, e.turn_attempt_id,
      e.payload_codec_version, ${projectedPayload} as payload
    from ${schema.sessionEvents} e
    where e.workspace_id = ${workspaceId}::uuid
      and e.turn_id = any(${pgArray(turnIds)}::uuid[])
      and e.type = any(${pgArray(TURN_TIMING_EVENT_TYPES)}::text[])
      and e.duplicate_of_event_id is null`,
  );
  for (const row of events) {
    const payload = fromPostgresLosslessJson(
      row.payload,
      row.payload_codec_version === null || row.payload_codec_version === undefined
        ? null
        : Number(row.payload_codec_version),
    );
    inputs.get(String(row.turn_id))?.events.push({
      type: String(row.type),
      sequence: Number(row.sequence),
      occurredAt: date(row.occurred_at),
      attemptId:
        row.turn_attempt_id === null || row.turn_attempt_id === undefined
          ? null
          : String(row.turn_attempt_id),
      payload:
        payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {},
    });
  }
  return inputs;
}

async function upsertProfile(
  db: Database,
  workspaceId: string,
  turn: TurnTimingProfileTurn,
  profile: TurnTimingProfile,
): Promise<boolean> {
  const s = profile.segments;
  const values = {
    accountId: turn.accountId,
    workspaceId,
    sessionId: turn.sessionId,
    turnId: turn.id,
    version: profile.version,
    status: turn.status,
    model: turn.model,
    provider: profile.provider,
    reasoningEffort: turn.reasoningEffort,
    latencyMode: turn.latencyMode,
    surface: turn.surface,
    source: turn.source,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
    wallMs: profile.wallMs,
    queueMs: s.queue,
    turnStartMs: s.turn_start,
    dispatchMs: s.dispatch,
    modelInferenceMs: s.model_inference,
    modelProviderOtherMs: s.model_provider_other,
    modelNetworkMs: s.model_network,
    modelUnsplitMs: s.model_unsplit,
    modelStalledMs: s.model_stalled,
    webSearchMs: s.web_search,
    mcpToolMs: s.mcp_tool,
    sandboxToolMs: s.sandbox_tool,
    ownToolMs: s.own_tool,
    sandboxSetupMs: s.sandbox_setup,
    humanWaitMs: s.human_wait,
    capacityWaitMs: s.capacity_wait,
    afterModelMs: s.after_model,
    afterToolMs: s.after_tool,
    recoveryMs: s.recovery,
    turnEndMs: s.turn_end,
    attempts: profile.attempts,
    modelRequests: profile.modelRequests,
    toolCalls: profile.toolCalls,
    steps: profile.steps,
  };
  const { accountId: _a, workspaceId: _w, turnId: _t, ...update } = values;
  const [row] = await db
    .insert(schema.turnTimingProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.turnTimingProfiles.workspaceId, schema.turnTimingProfiles.turnId],
      set: { ...update, computedAt: sql`statement_timestamp()` },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return row?.inserted === true;
}

/**
 * Compute and store the profile of one turn, replacing any earlier one. The
 * caller supplies the workspace-scoped database.
 */
export async function recordTurnTimingProfile(
  db: Database,
  workspaceId: string,
  turn: TurnTimingProfileTurn,
): Promise<RecordedTurnTimingProfile> {
  const inputs = (await loadTurnTimingInputs(db, workspaceId, [turn])).get(turn.id)!;
  const profile = computeTurnTimingProfile({ turn, ...inputs });
  const inserted = await upsertProfile(db, workspaceId, turn, profile);
  return { turn, profile, inserted };
}

/**
 * Profile every turn of one workspace that finished in `[since, until)` and
 * has no profile yet, page by page, each page in its own workspace-scoped
 * transaction. Idempotent: running it again finds nothing new, and two
 * replicas racing on a turn write the same row. A turn whose profile cannot be
 * computed is counted and skipped; the pass moves on.
 */
export async function recordMissingTurnTimingProfiles(
  db: Database,
  input: {
    workspaceId: string;
    since: Date;
    until: Date;
    pageSize?: number;
    signal?: AbortSignal;
    onError?: (error: unknown, turnId: string) => void;
    /** Called for each stored profile once its page has committed. */
    onRecorded?: (recorded: RecordedTurnTimingProfile) => void;
  },
): Promise<TurnTimingProfilePass> {
  if (
    !Number.isFinite(input.since.getTime()) ||
    !Number.isFinite(input.until.getTime()) ||
    input.until <= input.since
  ) {
    throw new Error("Invalid turn timing profile window");
  }
  const pageSize = Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE));
  const context = await rlsContextForWorkspace(db, input.workspaceId);
  const pass: TurnTimingProfilePass = { turns: 0, inserted: 0, updated: 0, failed: 0 };
  let after: Cursor | null = null;
  for (;;) {
    input.signal?.throwIfAborted();
    const page = await withRlsContext(db, context, async (scoped) => {
      const turns = await listTurnsMissingProfiles(scoped, {
        workspaceId: input.workspaceId,
        since: input.since,
        until: input.until,
        after,
        limit: pageSize,
      });
      const inputs = await loadTurnTimingInputs(scoped, input.workspaceId, turns);
      const recorded: RecordedTurnTimingProfile[] = [];
      let failed = 0;
      for (const { cursor: _cursor, ...turn } of turns) {
        try {
          const profile = computeTurnTimingProfile({ turn, ...inputs.get(turn.id)! });
          // A savepoint, so a failed write leaves the page's transaction usable.
          const inserted = await scoped.transaction((savepoint) =>
            upsertProfile(savepoint as unknown as Database, input.workspaceId, turn, profile),
          );
          recorded.push({ turn, profile, inserted });
        } catch (error) {
          // Computing is pure; a failure here is a malformed history or a
          // write conflict. Never let one turn stop the pass.
          failed += 1;
          input.onError?.(error, turn.id);
        }
      }
      return { turns, recorded, failed };
    });
    pass.turns += page.turns.length;
    pass.failed += page.failed;
    for (const recorded of page.recorded) {
      if (recorded.inserted) pass.inserted += 1;
      else pass.updated += 1;
      input.onRecorded?.(recorded);
    }
    const last = page.turns.at(-1);
    if (!last || page.turns.length < pageSize) return pass;
    after = last.cursor;
  }
}
