/**
 * Opengeni Console data: managed workspaces, the organization's session review
 * level, the Console audit log, end-user labels, and the reviewable session
 * reads with their metered cost.
 *
 * Authorization lives in the API (`requireConsoleAdministrator` in
 * @opengeni/core): only organization owners and admins reach these reads.
 * This module enforces what they may see, in SQL, on every read:
 *
 * - only workspaces marked in `organization_managed_workspaces`;
 * - only root sessions that are shared, or private to an end user of the
 *   product (`external_user:` owner). A private ("Only me") chat of an
 *   Opengeni account is never selected, in any workspace;
 * - nothing at all when the review level is `off`, and no content (title,
 *   messages, comments, events) when it is `metadata`.
 *
 * Reads run with no session RLS actor (as the system sees the tenant) under
 * the ordinary tenancy RLS of each workspace, and never write session data.
 */
import type {
  ConsoleAuditAction,
  ConsoleAuditEvent,
  ConsoleManagedSource,
  ConsoleReviewLevel,
  ConsoleSessionFeedback,
  ConsoleSessionSummary,
} from "@opengeni/contracts";
import { sql, type SQL } from "drizzle-orm";
import { rawRows, withAccountRls, withoutSessionRlsActor, type Database } from "./database";
import { fromPostgresLosslessText } from "./lossless-json";

/**
 * The private-visibility predicate every Console session read uses. Site
 * conversations are excluded: a visitor's Site chat is theirs alone, even when
 * it is stored as workspace-shared.
 */
export const CONSOLE_REVIEWABLE_SESSION_SQL = (alias: string): SQL =>
  sql.raw(
    `(${alias}.site_access_root_id is null and (${alias}.visibility = 'workspace_shared' or (${alias}.visibility = 'user_private' and ${alias}.owner_subject_id like 'external_user:%')))`,
  );

/** Metered spend of a ledger row, in micro-USD (the credit the organization was charged). */
const LEDGER_SPEND_FILTER = sql.raw(
  `amount_micros < 0 and (type like '%\\_debit' or type = 'byok_platform_fee')`,
);

export const CONSOLE_MAX_WORKSPACE_READS = 2000;

export type ConsoleManagedWorkspaceMarker = {
  workspaceId: string;
  source: ConsoleManagedSource;
  createdByApiKeyId: string | null;
  createdAt: string;
};

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Runs `fn` scoped to the organization, with no session actor. */
async function consoleScope<T>(
  db: Database,
  accountId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withoutSessionRlsActor(() =>
    withAccountRls(db, accountId, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '20s', true),
        set_config('opengeni.console_review', 'on', true)`);
      return await fn(tx);
    }),
  );
}

async function scopeWorkspace(tx: Database, workspaceId: string | null): Promise<void> {
  await tx.execute(sql`select set_config('opengeni.workspace_id', ${workspaceId ?? ""}, true)`);
}

// ---------------------------------------------------------------------------
// Managed workspaces

export type ConsoleOrganizationWorkspace = {
  id: string;
  name: string;
  externalSource: string | null;
  externalId: string | null;
  createdAt: string;
};

/** The organization's shared workspaces (never Personal ones), newest first, without projections. */
export async function listConsoleOrganizationWorkspaces(
  db: Database,
  accountId: string,
): Promise<ConsoleOrganizationWorkspace[]> {
  const rows = await withAccountRls(db, accountId, (tx) =>
    rawRows<{
      id: string;
      name: string;
      external_source: string | null;
      external_id: string | null;
      created_at: Date;
    }>(
      tx,
      sql`select w.id, w.name, w.external_source, w.external_id, w.created_at
        from workspaces w
        where w.account_id = ${accountId}::uuid
          and w.id in (select workspace_id from list_organization_workspace_ids(${accountId}::uuid))
        order by w.created_at desc, w.id desc`,
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    externalSource: row.external_source,
    externalId: row.external_id,
    createdAt: iso(row.created_at),
  }));
}

export async function listManagedWorkspaceMarkers(
  db: Database,
  accountId: string,
): Promise<Map<string, ConsoleManagedWorkspaceMarker>> {
  const rows = await withAccountRls(db, accountId, (tx) =>
    rawRows<{
      workspace_id: string;
      source: ConsoleManagedSource;
      created_by_api_key_id: string | null;
      created_at: Date;
    }>(
      tx,
      sql`select workspace_id, source, created_by_api_key_id, created_at
        from organization_managed_workspaces where account_id = ${accountId}::uuid`,
    ),
  );
  return new Map(
    rows.map((row) => [
      row.workspace_id,
      {
        workspaceId: row.workspace_id,
        source: row.source,
        createdByApiKeyId: row.created_by_api_key_id,
        createdAt: iso(row.created_at),
      },
    ]),
  );
}

export async function isManagedWorkspace(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await withAccountRls(db, accountId, (tx) =>
    rawRows<{ found: number }>(
      tx,
      sql`select 1 as found from organization_managed_workspaces
        where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid`,
    ),
  );
  return !!row;
}

/** Mark a workspace an organization API key created. Never fails the caller's request. */
export async function markWorkspaceManagedByApiKey(
  db: Database,
  input: { accountId: string; workspaceId: string; apiKeyId: string | null },
): Promise<void> {
  await withAccountRls(db, input.accountId, (tx) =>
    tx.execute(sql`insert into organization_managed_workspaces
        (account_id, workspace_id, source, created_by_api_key_id)
      values (${input.accountId}::uuid, ${input.workspaceId}::uuid, 'api_key', ${input.apiKeyId}::uuid)
      on conflict (workspace_id) do nothing`),
  );
}

/** Console: mark or unmark a shared workspace as managed by the product, with an audit row. */
export async function setConsoleWorkspaceKind(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    kind: "managed" | "team";
    actorSubjectId: string;
    actorLabel: string | null;
  },
): Promise<void> {
  await withAccountRls(db, input.accountId, async (tx) => {
    const [before] = await rawRows<{ found: number }>(
      tx,
      sql`select 1 as found from organization_managed_workspaces
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        for update`,
    );
    const wasManaged = !!before;
    if (wasManaged === (input.kind === "managed")) return;
    if (input.kind === "managed") {
      await tx.execute(sql`insert into organization_managed_workspaces
          (account_id, workspace_id, source, marked_by_subject_id)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, 'console', ${input.actorSubjectId})
        on conflict (workspace_id) do nothing`);
    } else {
      await tx.execute(sql`delete from organization_managed_workspaces
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`);
    }
    await insertAudit(tx, {
      accountId: input.accountId,
      actorSubjectId: input.actorSubjectId,
      actorLabel: input.actorLabel,
      action: "workspace.kind_changed",
      workspaceId: input.workspaceId,
      sessionId: null,
      detail: { from: wasManaged ? "managed" : "team", to: input.kind },
    });
  });
}

// ---------------------------------------------------------------------------
// Review level

export type ConsoleReviewSettingsRow = {
  reviewLevel: ConsoleReviewLevel;
  updatedAt: string | null;
  updatedBySubjectId: string | null;
};

export async function getConsoleReviewSettings(
  db: Database,
  accountId: string,
): Promise<ConsoleReviewSettingsRow> {
  const [row] = await withAccountRls(db, accountId, (tx) =>
    rawRows<{ review_level: ConsoleReviewLevel; updated_at: Date; updated_by_subject_id: string }>(
      tx,
      sql`select review_level, updated_at, updated_by_subject_id
        from organization_session_review_settings where account_id = ${accountId}::uuid`,
    ),
  );
  if (!row) return { reviewLevel: "full", updatedAt: null, updatedBySubjectId: null };
  return {
    reviewLevel: row.review_level,
    updatedAt: iso(row.updated_at),
    updatedBySubjectId: row.updated_by_subject_id,
  };
}

export async function setConsoleReviewLevel(
  db: Database,
  input: {
    accountId: string;
    reviewLevel: ConsoleReviewLevel;
    actorSubjectId: string;
    actorLabel: string | null;
  },
): Promise<ConsoleReviewSettingsRow> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [previous] = await rawRows<{ review_level: ConsoleReviewLevel }>(
      tx,
      sql`select review_level from organization_session_review_settings
        where account_id = ${input.accountId}::uuid for update`,
    );
    const from = previous?.review_level ?? "full";
    const [row] = await rawRows<{ updated_at: Date }>(
      tx,
      sql`insert into organization_session_review_settings
          (account_id, review_level, updated_by_subject_id, updated_at)
        values (${input.accountId}::uuid, ${input.reviewLevel}, ${input.actorSubjectId}, now())
        on conflict (account_id) do update set review_level = excluded.review_level,
          updated_by_subject_id = excluded.updated_by_subject_id, updated_at = excluded.updated_at
        returning updated_at`,
    );
    if (from !== input.reviewLevel) {
      await insertAudit(tx, {
        accountId: input.accountId,
        actorSubjectId: input.actorSubjectId,
        actorLabel: input.actorLabel,
        action: "settings.review_level_changed",
        workspaceId: null,
        sessionId: null,
        detail: { from, to: input.reviewLevel },
      });
    }
    return {
      reviewLevel: input.reviewLevel,
      updatedAt: iso(row?.updated_at ?? new Date()),
      updatedBySubjectId: input.actorSubjectId,
    };
  });
}

// ---------------------------------------------------------------------------
// Audit log

type AuditInput = {
  accountId: string;
  actorSubjectId: string;
  actorLabel: string | null;
  action: ConsoleAuditAction;
  workspaceId: string | null;
  sessionId: string | null;
  detail: Record<string, unknown>;
};

async function insertAudit(tx: Database, input: AuditInput): Promise<string> {
  const [row] = await rawRows<{ id: string }>(
    tx,
    sql`insert into organization_console_audit_events
        (account_id, actor_subject_id, actor_label, action, workspace_id, session_id, detail)
      values (${input.accountId}::uuid, ${input.actorSubjectId.slice(0, 512)},
        ${input.actorLabel?.slice(0, 512) ?? null}, ${input.action}, ${input.workspaceId}::uuid,
        ${input.sessionId}::uuid, ${JSON.stringify(input.detail)}::jsonb)
      returning id`,
  );
  return row!.id;
}

export async function recordConsoleAuditEvent(db: Database, input: AuditInput): Promise<string> {
  return await withAccountRls(db, input.accountId, (tx) => insertAudit(tx, input));
}

/**
 * Records a read unless the same reader already has the same entry for this
 * session within the last ten minutes (opening a transcript reads its detail,
 * then pages its events).
 */
export async function recordConsoleAuditEventOnce(
  db: Database,
  input: AuditInput,
): Promise<string> {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [recent] = await rawRows<{ id: string }>(
      tx,
      sql`select id from organization_console_audit_events
        where account_id = ${input.accountId}::uuid
          and actor_subject_id = ${input.actorSubjectId.slice(0, 512)}
          and action = ${input.action}
          and session_id is not distinct from ${input.sessionId}::uuid
          and created_at > now() - interval '10 minutes'
        order by created_at desc
        limit 1`,
    );
    return recent?.id ?? (await insertAudit(tx, input));
  });
}

type AuditCursor = { at: string; id: string };

export function encodeConsoleCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeConsoleCursor<K extends string>(
  value: string,
  keys: readonly K[],
): Record<K, string> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] !== "string" || (record[key] as string).length > 200) return null;
    }
    return record as Record<K, string>;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICROS_RE = /^\d{1,19}$/;

export class ConsoleCursorError extends Error {}

export async function listConsoleAuditEvents(
  db: Database,
  input: { accountId: string; limit: number; cursor?: string; sessionId?: string },
): Promise<{ events: ConsoleAuditEvent[]; nextCursor: string | null }> {
  let cursor: AuditCursor | null = null;
  if (input.cursor) {
    const decoded = decodeConsoleCursor(input.cursor, ["at", "id"] as const);
    if (!decoded || !MICROS_RE.test(decoded.at) || !UUID_RE.test(decoded.id))
      throw new ConsoleCursorError("cursor is invalid");
    cursor = decoded;
  }
  const rows = await withAccountRls(db, input.accountId, (tx) =>
    rawRows<{
      id: string;
      actor_subject_id: string;
      actor_label: string | null;
      action: ConsoleAuditAction;
      workspace_id: string | null;
      session_id: string | null;
      detail: Record<string, unknown>;
      created_at: Date;
      created_us: string;
    }>(
      tx,
      sql`select id, actor_subject_id, actor_label, action, workspace_id, session_id, detail,
          created_at, (extract(epoch from created_at) * 1000000)::bigint::text as created_us
        from organization_console_audit_events
        where account_id = ${input.accountId}::uuid
          ${input.sessionId ? sql`and session_id = ${input.sessionId}::uuid` : sql``}
          ${
            cursor
              ? sql`and (created_at, id) < (timestamptz 'epoch' + (${cursor.at} || ' microseconds')::interval, ${cursor.id}::uuid)`
              : sql``
          }
        order by created_at desc, id desc
        limit ${input.limit + 1}`,
    ),
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.id,
      actorSubjectId: row.actor_subject_id,
      actorLabel: row.actor_label,
      action: row.action,
      workspaceId: row.workspace_id,
      workspaceName: null,
      sessionId: row.session_id,
      detail: row.detail ?? {},
      createdAt: iso(row.created_at),
    })),
    nextCursor:
      rows.length > input.limit && last
        ? encodeConsoleCursor({ at: last.created_us, id: last.id })
        : null,
  };
}

// ---------------------------------------------------------------------------
// End-user labels

const rememberedLabels = new Set<string>();
const REMEMBERED_LABELS_MAX = 20_000;

/**
 * Remember the product's own id for an external user subject so Console can
 * show it. Display only; best effort, never fails the caller.
 */
export async function rememberEndUserLabel(
  db: Database,
  input: { accountId: string; subjectId: string; source: string; externalId: string },
): Promise<void> {
  if (!input.subjectId.startsWith("external_user:")) return;
  const key = `${input.accountId}:${input.subjectId}`;
  if (rememberedLabels.has(key)) return;
  try {
    await withAccountRls(db, input.accountId, (tx) =>
      tx.execute(sql`insert into organization_end_user_labels (account_id, subject_id, source, external_id)
        values (${input.accountId}::uuid, ${input.subjectId}, ${input.source.slice(0, 200)},
          ${input.externalId.slice(0, 1024)})
        on conflict (account_id, subject_id) do nothing`),
    );
    if (rememberedLabels.size >= REMEMBERED_LABELS_MAX) rememberedLabels.clear();
    rememberedLabels.add(key);
  } catch {
    // A label is cosmetic; the next request retries.
  }
}

// ---------------------------------------------------------------------------
// Spend

export type ConsoleWindow = { since: string; until: string };

/** Spend per workspace (null: not tied to a workspace) in the window. */
export async function consoleSpendByWorkspace(
  db: Database,
  accountId: string,
  window: ConsoleWindow,
): Promise<Map<string | null, number>> {
  const rows = await consoleScope(db, accountId, async (tx) => {
    await scopeWorkspace(tx, null);
    return await rawRows<{ workspace_id: string | null; spend: string }>(
      tx,
      sql`select workspace_id, sum(-amount_micros)::bigint::text as spend
        from credit_ledger_entries
        where account_id = ${accountId}::uuid
          and occurred_at >= ${window.since}::timestamptz and occurred_at < ${window.until}::timestamptz
          and ${LEDGER_SPEND_FILTER}
        group by workspace_id`,
    );
  });
  return new Map(rows.map((row) => [row.workspace_id, num(row.spend)]));
}

/** Daily spend split by managed workspaces and the rest, plus the top models. */
export async function consoleSpendBreakdown(
  db: Database,
  accountId: string,
  window: ConsoleWindow,
): Promise<{
  byDay: { date: string; managed: boolean; spendMicros: number }[];
  byModel: {
    model: string;
    spendMicros: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  }[];
}> {
  return await consoleScope(db, accountId, async (tx) => {
    await scopeWorkspace(tx, null);
    const byDay = await rawRows<{ day: string; managed: boolean; spend: string }>(
      tx,
      sql`select to_char(date_trunc('day', ledger.occurred_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
          (managed.workspace_id is not null) as managed,
          sum(-ledger.amount_micros)::bigint::text as spend
        from credit_ledger_entries ledger
        left join organization_managed_workspaces managed
          on managed.account_id = ledger.account_id and managed.workspace_id = ledger.workspace_id
        where ledger.account_id = ${accountId}::uuid
          and ledger.occurred_at >= ${window.since}::timestamptz
          and ledger.occurred_at < ${window.until}::timestamptz
          and ledger.amount_micros < 0
          and (ledger.type like '%\\_debit' or ledger.type = 'byok_platform_fee')
        group by 1, 2 order by 1`,
    );
    // Billed model calls only: a model debit's metadata carries its token
    // counts. One call may be debited in several entries (promotional and
    // paid credit) under one source, so tokens are counted once per call.
    const byModel = await rawRows<{
      model: string;
      spend: string;
      calls: string;
      input_tokens: string;
      output_tokens: string;
      cached_tokens: string;
    }>(
      tx,
      sql`select model,
          sum(spend)::bigint::text as spend,
          count(*) filter (where call)::text as calls,
          coalesce(sum(input_tokens) filter (where call), 0)::bigint::text as input_tokens,
          coalesce(sum(output_tokens) filter (where call), 0)::bigint::text as output_tokens,
          coalesce(sum(cached_tokens) filter (where call), 0)::bigint::text as cached_tokens
        from (
          select coalesce(nullif(metadata ->> 'model', ''), 'other') as model,
            (type = 'model_usage_debit' and source_id is not null) as call,
            sum(-amount_micros) as spend,
            max(case when jsonb_typeof(metadata -> 'inputTokens') = 'number'
              then (metadata ->> 'inputTokens')::numeric end) as input_tokens,
            max(case when jsonb_typeof(metadata -> 'outputTokens') = 'number'
              then (metadata ->> 'outputTokens')::numeric end) as output_tokens,
            max(case when jsonb_typeof(metadata -> 'cachedTokens') = 'number'
              then (metadata ->> 'cachedTokens')::numeric end) as cached_tokens
          from credit_ledger_entries
          where account_id = ${accountId}::uuid
            and occurred_at >= ${window.since}::timestamptz and occurred_at < ${window.until}::timestamptz
            and ${LEDGER_SPEND_FILTER}
          group by 1, 2, source_id
        ) calls
        group by model order by sum(spend) desc limit 20`,
    );
    return {
      byDay: byDay.map((row) => ({
        date: row.day,
        managed: row.managed,
        spendMicros: num(row.spend),
      })),
      byModel: byModel.map((row) => ({
        model: row.model,
        spendMicros: num(row.spend),
        calls: num(row.calls),
        inputTokens: num(row.input_tokens),
        outputTokens: num(row.output_tokens),
        cachedTokens: num(row.cached_tokens),
      })),
    };
  });
}

/** Spend in the managed workspaces each organization key created. */
export async function consoleSpendByApiKey(
  db: Database,
  accountId: string,
  window: ConsoleWindow,
): Promise<{ apiKeyId: string; workspaces: number; spendMicros: number }[]> {
  const rows = await consoleScope(db, accountId, async (tx) => {
    await scopeWorkspace(tx, null);
    return await rawRows<{ api_key_id: string; workspaces: string; spend: string | null }>(
      tx,
      // One pass over the organization's ledger for the window, grouped by
      // workspace, rather than one ledger read per managed workspace.
      sql`select managed.created_by_api_key_id as api_key_id,
          count(distinct managed.workspace_id)::text as workspaces,
          coalesce(sum(spend.amount), 0)::bigint::text as spend
        from organization_managed_workspaces managed
        left join (
          select workspace_id, sum(-amount_micros) as amount from credit_ledger_entries
          where account_id = ${accountId}::uuid and workspace_id is not null
            and occurred_at >= ${window.since}::timestamptz and occurred_at < ${window.until}::timestamptz
            and ${LEDGER_SPEND_FILTER}
          group by workspace_id
        ) spend on spend.workspace_id = managed.workspace_id
        where managed.account_id = ${accountId}::uuid and managed.created_by_api_key_id is not null
        group by managed.created_by_api_key_id`,
    );
  });
  return rows.map((row) => ({
    apiKeyId: row.api_key_id,
    workspaces: num(row.workspaces),
    spendMicros: num(row.spend),
  }));
}

/** Who created each organization key (the subject that created its service account). */
export async function consoleApiKeyCreators(
  db: Database,
  accountId: string,
): Promise<Map<string, string>> {
  const rows = await withAccountRls(db, accountId, (tx) =>
    rawRows<{ api_key_id: string; created_by_subject_id: string | null }>(
      tx,
      sql`select key.id as api_key_id, account.created_by_subject_id
        from api_keys key
        join organization_service_accounts account
          on account.account_id = key.account_id and account.id = key.service_account_id
        where key.account_id = ${accountId}::uuid and key.workspace_id is null`,
    ),
  );
  return new Map(
    rows.flatMap((row) =>
      row.created_by_subject_id ? [[row.api_key_id, row.created_by_subject_id] as const] : [],
    ),
  );
}

// ---------------------------------------------------------------------------
// Session counts

export async function consoleSessionCounts(
  db: Database,
  accountId: string,
  workspaceIds: readonly string[],
  window: ConsoleWindow,
  options: { endUsersFor?: ReadonlySet<string> } = {},
): Promise<{
  sessions: Map<string, number>;
  lastActivity: Map<string, string>;
  endUsers: number;
  truncated: boolean;
}> {
  const sessions = new Map<string, number>();
  const lastActivity = new Map<string, string>();
  const endUsers = new Set<string>();
  const ids = workspaceIds.slice(0, CONSOLE_MAX_WORKSPACE_READS);
  await consoleScope(db, accountId, async (tx) => {
    for (const workspaceId of ids) {
      await scopeWorkspace(tx, workspaceId);
      const [row] = await rawRows<{ sessions: string; last_at: Date | null }>(
        tx,
        sql`select count(*) filter (where updated_at >= ${window.since}::timestamptz)::text as sessions,
            max(updated_at) as last_at
          from sessions
          where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid
            and parent_session_id is null
            and ${CONSOLE_REVIEWABLE_SESSION_SQL("sessions")}`,
      );
      sessions.set(workspaceId, num(row?.sessions));
      if (row?.last_at) lastActivity.set(workspaceId, iso(row.last_at));
      if (options.endUsersFor?.has(workspaceId)) {
        const users = await rawRows<{ subject: string }>(
          tx,
          sql`select distinct coalesce(
              case when owner_subject_id like 'external_user:%' then owner_subject_id end,
              case when created_by_subject_id like 'external_user:%' then created_by_subject_id end
            ) as subject
            from sessions
            where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid
              and parent_session_id is null and updated_at >= ${window.since}::timestamptz
              and (owner_subject_id like 'external_user:%' or created_by_subject_id like 'external_user:%')
            limit 10000`,
        );
        for (const user of users) if (user.subject) endUsers.add(user.subject);
      }
    }
  });
  return {
    sessions,
    lastActivity,
    endUsers: endUsers.size,
    truncated: workspaceIds.length > ids.length,
  };
}

// ---------------------------------------------------------------------------
// Reviewable sessions

type SessionRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  visibility: "workspace_shared" | "user_private";
  owner_subject_id: string | null;
  created_by_subject_id: string | null;
  status: string;
  model: string | null;
  reasoning_effort: string | null;
  created_at: Date;
  updated_at: Date;
  updated_us: string;
};

const SESSION_COLUMNS = sql.raw(`s.id, s.workspace_id, s.title, s.visibility, s.owner_subject_id,
  s.created_by_subject_id, s.status, s.model, s.reasoning_effort, s.created_at, s.updated_at,
  (extract(epoch from s.updated_at) * 1000000)::bigint::text as updated_us`);

function endUserSubject(row: SessionRow): string | null {
  if (row.owner_subject_id?.startsWith("external_user:")) return row.owner_subject_id;
  if (row.created_by_subject_id?.startsWith("external_user:")) return row.created_by_subject_id;
  return null;
}

export type ConsoleSessionCursor = { updatedUs: string; id: string };

export function decodeConsoleSessionCursor(value: string): ConsoleSessionCursor {
  const decoded = decodeConsoleCursor(value, ["u", "i"] as const);
  if (!decoded || !MICROS_RE.test(decoded.u) || !UUID_RE.test(decoded.i))
    throw new ConsoleCursorError("cursor is invalid");
  return { updatedUs: decoded.u, id: decoded.i };
}

/** A PostgreSQL array literal for a bound text[] parameter. */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`).join(",")}}`;
}

function searchPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Newest-first reviewable root sessions across the given managed workspaces,
 * with their turns, ratings, metered cost and opening message. `includeContent`
 * is false for the `metadata` review level: no title, message or search.
 */
export async function listConsoleSessions(
  db: Database,
  input: {
    accountId: string;
    workspaces: readonly { id: string; name: string }[];
    limit: number;
    cursor: ConsoleSessionCursor | null;
    q: string | null;
    includeContent: boolean;
  },
): Promise<{
  sessions: ConsoleSessionSummary[];
  nextCursor: string | null;
  truncated: boolean;
}> {
  const names = new Map(input.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const workspaceIds = input.workspaces.map((workspace) => workspace.id);
  const q = input.includeContent && input.q ? searchPattern(input.q) : null;
  return await consoleScope(db, input.accountId, async (tx) => {
    const candidates: SessionRow[] = [];
    for (const workspaceId of workspaceIds.slice(0, CONSOLE_MAX_WORKSPACE_READS)) {
      await scopeWorkspace(tx, workspaceId);
      const rows = await rawRows<SessionRow>(
        tx,
        sql`select ${SESSION_COLUMNS} from sessions s
          where s.account_id = ${input.accountId}::uuid and s.workspace_id = ${workspaceId}::uuid
            and s.parent_session_id is null
            and ${CONSOLE_REVIEWABLE_SESSION_SQL("s")}
            ${
              input.cursor
                ? sql`and (s.updated_at, s.id) < (timestamptz 'epoch' + (${input.cursor.updatedUs} || ' microseconds')::interval, ${input.cursor.id}::uuid)`
                : sql``
            }
            ${
              q
                ? sql`and (s.title ilike ${q} or exists (
                    select 1 from session_events e
                    where e.workspace_id = s.workspace_id and e.session_id = s.id
                      and e.type = 'user.message' and e.payload ->> 'text' ilike ${q}))`
                : sql``
            }
          order by s.updated_at desc, s.id desc
          limit ${input.limit + 1}`,
      );
      candidates.push(...rows);
    }
    candidates.sort((left, right) => {
      const byTime = BigInt(right.updated_us) - BigInt(left.updated_us);
      if (byTime !== 0n) return byTime > 0n ? 1 : -1;
      return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    });
    const page = candidates.slice(0, input.limit);
    const summaries = await summarizeSessions(tx, input.accountId, page, names, {
      includeContent: input.includeContent,
    });
    const last = page.at(-1);
    return {
      sessions: summaries,
      nextCursor:
        candidates.length > input.limit && last
          ? encodeConsoleCursor({ u: last.updated_us, i: last.id })
          : null,
      truncated: workspaceIds.length > CONSOLE_MAX_WORKSPACE_READS,
    };
  });
}

async function summarizeSessions(
  tx: Database,
  accountId: string,
  rows: readonly SessionRow[],
  names: ReadonlyMap<string, string>,
  options: { includeContent: boolean },
): Promise<ConsoleSessionSummary[]> {
  const byWorkspace = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row);
    byWorkspace.set(row.workspace_id, list);
  }
  const facts = new Map<
    string,
    { turns: number; positive: number; negative: number; spend: number; first: string | null }
  >();
  for (const [workspaceId, list] of byWorkspace) {
    await scopeWorkspace(tx, workspaceId);
    const ids = list.map((row) => row.id);
    const stats = await rawRows<{
      id: string;
      turns: string;
      positive: string;
      negative: string;
      first_message: string | null;
    }>(
      tx,
      sql`select s.id,
          (select count(*) from session_turns t
            where t.workspace_id = s.workspace_id and t.session_id = s.id)::text as turns,
          (select count(*) from feedback_submissions f
            where f.workspace_id = s.workspace_id and f.session_id = s.id
              and f.sentiment = 'positive')::text as positive,
          (select count(*) from feedback_submissions f
            where f.workspace_id = s.workspace_id and f.session_id = s.id
              and f.sentiment = 'negative')::text as negative,
          ${
            options.includeContent
              ? sql`(select left(e.payload ->> 'text', 500) from session_events e
                  where e.workspace_id = s.workspace_id and e.session_id = s.id
                    and e.type = 'user.message' order by e.sequence limit 1)`
              : sql`null::text`
          } as first_message
        from sessions s
        where s.account_id = ${accountId}::uuid and s.workspace_id = ${workspaceId}::uuid
          and s.id = any(${pgTextArray(ids)}::uuid[])`,
    );
    const spend = new Map(
      (
        await rawRows<{ id: string; spend: string }>(
          tx,
          consoleSessionSpendSql(accountId, workspaceId, ids),
        )
      ).map((row) => [row.id, num(row.spend)]),
    );
    for (const stat of stats) {
      facts.set(stat.id, {
        turns: num(stat.turns),
        positive: num(stat.positive),
        negative: num(stat.negative),
        spend: spend.get(stat.id) ?? 0,
        first: stat.first_message,
      });
    }
  }
  await scopeWorkspace(tx, null);
  const subjects = [...new Set(rows.map(endUserSubject).filter((value) => value !== null))];
  const labels = new Map<string, { source: string; external_id: string }>();
  if (subjects.length > 0) {
    const labelRows = await rawRows<{ subject_id: string; source: string; external_id: string }>(
      tx,
      sql`select subject_id, source, external_id from organization_end_user_labels
        where account_id = ${accountId}::uuid and subject_id = any(${pgTextArray(subjects)}::text[])`,
    );
    for (const label of labelRows) labels.set(label.subject_id, label);
  }
  return rows.map((row) => {
    const fact = facts.get(row.id);
    const subject = endUserSubject(row);
    const label = subject ? labels.get(subject) : undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: names.get(row.workspace_id) ?? "",
      title: options.includeContent ? row.title : null,
      firstMessage: options.includeContent ? (fact?.first ?? null) : null,
      visibility: row.visibility === "user_private" ? "private" : "workspace",
      endUser: subject
        ? {
            subjectId: subject,
            externalId: label?.external_id ?? null,
            source: label?.source ?? null,
          }
        : null,
      status: row.status,
      feedback: { positive: fact?.positive ?? 0, negative: fact?.negative ?? 0 },
      turns: fact?.turns ?? 0,
      costMicros: Math.max(0, fact?.spend ?? 0),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  });
}

/**
 * Metered spend of each given root session's tree (the session and its
 * sub-agents) in one workspace: rows of `{ id, spend }`, omitting sessions
 * without debits.
 *
 * A model call is debited under `credit:model_usage_debit:<turn>:<source>`
 * and, for BYOK, `credit:byok_platform_fee:<turn>:<source>`. The keys are
 * built in a materialized CTE so the ledger join is a plain column equality:
 * under row-level security PostgreSQL will not use an index for a join clause
 * that applies a non-leakproof function such as `||`, and probing the unique
 * idempotency index once per key replaces a full ledger scan per session.
 */
export function consoleSessionSpendSql(
  accountId: string,
  workspaceId: string,
  sessionIds: readonly string[],
): SQL {
  return sql`with keys as materialized (
      select root.id as root_id, key.value as idempotency_key
      from sessions root
      join sessions tree
        on tree.workspace_id = root.workspace_id
          and (tree.id = root.id or tree.root_session_id = root.id)
      join model_call_facts fact
        on fact.workspace_id = root.workspace_id and fact.session_id = tree.id
      cross join lateral (values
        ('credit:model_usage_debit:' || fact.turn_id::text || ':' || fact.source_key),
        ('credit:byok_platform_fee:' || fact.turn_id::text || ':' || fact.source_key)
      ) key(value)
      where root.account_id = ${accountId}::uuid and root.workspace_id = ${workspaceId}::uuid
        and root.id = any(${pgTextArray(sessionIds)}::uuid[])
    )
    select keys.root_id::text as id, sum(-ledger.amount_micros)::bigint::text as spend
    from keys
    join credit_ledger_entries ledger on ledger.idempotency_key = keys.idempotency_key
    where ledger.account_id = ${accountId}::uuid and ledger.amount_micros < 0
    group by keys.root_id`;
}

export type ConsoleSessionDetailRow = {
  summary: ConsoleSessionSummary;
  model: string | null;
  reasoningEffort: string | null;
  durationMs: number;
  tokens: { input: number; output: number; cached: number; total: number };
  modelCalls: number;
  models: string[];
  toolCalls: number;
  feedback: ConsoleSessionFeedback[];
};

/**
 * One reviewable root session in a managed workspace, or null when it does
 * not exist, is not a root session, or is an Opengeni account's private chat.
 */
export async function getConsoleSession(
  db: Database,
  input: {
    accountId: string;
    workspace: { id: string; name: string };
    sessionId: string;
    includeContent: boolean;
  },
): Promise<ConsoleSessionDetailRow | null> {
  return await consoleScope(db, input.accountId, async (tx) => {
    await scopeWorkspace(tx, input.workspace.id);
    const [row] = await rawRows<SessionRow>(
      tx,
      sql`select ${SESSION_COLUMNS} from sessions s
        where s.account_id = ${input.accountId}::uuid and s.workspace_id = ${input.workspace.id}::uuid
          and s.id = ${input.sessionId}::uuid and s.parent_session_id is null
          and ${CONSOLE_REVIEWABLE_SESSION_SQL("s")}`,
    );
    if (!row) return null;
    const [summary] = await summarizeSessions(
      tx,
      input.accountId,
      [row],
      new Map([[input.workspace.id, input.workspace.name]]),
      { includeContent: input.includeContent },
    );
    await scopeWorkspace(tx, input.workspace.id);
    const [usage] = await rawRows<{
      calls: string;
      input_tokens: string;
      output_tokens: string;
      cached_tokens: string;
      total_tokens: string;
      models: string[] | null;
    }>(
      tx,
      sql`select count(*)::text as calls,
          coalesce(sum(input_tokens), 0)::text as input_tokens,
          coalesce(sum(output_tokens), 0)::text as output_tokens,
          coalesce(sum(cached_tokens), 0)::text as cached_tokens,
          coalesce(sum(coalesce(total_tokens, coalesce(input_tokens, 0) + coalesce(output_tokens, 0))), 0)::text as total_tokens,
          array_remove(array_agg(distinct model), null) as models
        from model_call_facts
        where workspace_id = ${input.workspace.id}::uuid
          and session_id in (select tree.id from sessions tree
            where tree.workspace_id = ${input.workspace.id}::uuid
              and (tree.id = ${row.id}::uuid or tree.root_session_id = ${row.id}::uuid))`,
    );
    const [timing] = await rawRows<{ first_at: Date | null; last_at: Date | null; tools: string }>(
      tx,
      sql`select min(occurred_at) as first_at, max(occurred_at) as last_at,
          count(*) filter (where type = 'agent.toolCall.created')::text as tools
        from session_events
        where workspace_id = ${input.workspace.id}::uuid and session_id = ${row.id}::uuid`,
    );
    const feedbackRows = await rawRows<{
      sentiment: "positive" | "negative" | null;
      comment: string | null;
      comment_codec_version: number | null;
      turn_id: string | null;
      created_at: Date;
    }>(
      tx,
      sql`select sentiment, comment, comment_codec_version, turn_id, created_at
        from feedback_submissions
        where workspace_id = ${input.workspace.id}::uuid and session_id = ${row.id}::uuid
        order by created_at limit 200`,
    );
    const firstAt = timing?.first_at ? new Date(timing.first_at).getTime() : null;
    const lastAt = timing?.last_at ? new Date(timing.last_at).getTime() : null;
    return {
      summary: summary!,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      durationMs: firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : 0,
      tokens: {
        input: num(usage?.input_tokens),
        output: num(usage?.output_tokens),
        cached: num(usage?.cached_tokens),
        total: num(usage?.total_tokens),
      },
      modelCalls: num(usage?.calls),
      models: usage?.models ?? [],
      toolCalls: num(timing?.tools),
      feedback: feedbackRows.map((feedback) => ({
        sentiment: feedback.sentiment,
        comment:
          input.includeContent && feedback.comment !== null
            ? fromPostgresLosslessText(feedback.comment, feedback.comment_codec_version ?? 0)
            : null,
        turnId: feedback.turn_id,
        createdAt: iso(feedback.created_at),
      })),
    };
  });
}

/** Runs a read of a session Console has already authorized, as the system sees it. */
export async function withConsoleSessionRead<T>(fn: () => Promise<T>): Promise<T> {
  return await withoutSessionRlsActor(fn);
}
