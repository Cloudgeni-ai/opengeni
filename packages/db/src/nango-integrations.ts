import { sql } from "drizzle-orm";
import {
  INTEGRATION_BACKEND_CACHE_TTL_MS,
  effectiveNangoIntegrations,
  estimateNangoCostUsd,
  parseNangoIntegrationDefinition,
  type EffectiveNangoIntegration,
  type IntegrationBackendSetting,
} from "@opengeni/contracts";

import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";

/**
 * Nango-backed integrations (migration 1406, docs/nango.md).
 *
 * The operator switch is the append-only `integration_backend_revisions`
 * table; the newest revision per integration key is effective. Runtime roles
 * only read it, and readers keep it at most INTEGRATION_BACKEND_CACHE_TTL_MS,
 * so a flip reaches new catalog reads and the next turn attempt without a
 * release, never a tool call already in flight.
 */

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Newest revision per integration key; empty before migration 1406 is applied. */
export async function readIntegrationBackendSettings(
  db: Database,
): Promise<IntegrationBackendSetting[]> {
  try {
    const rows = await db.transaction(
      async (tx) =>
        await rawRows<{
          revision: number | string;
          integration_key: string;
          backend: string;
          nango_provider_config_key: string | null;
          enabled: boolean;
          definition: unknown;
          changed_at: Date | string;
        }>(
          // Its own transaction, or a savepoint inside a caller's, so a failed
          // read never aborts the caller's work.
          tx,
          sql`
        select distinct on (integration_key)
          revision, integration_key, backend, nango_provider_config_key, enabled, definition, changed_at
        from integration_backend_revisions
        order by integration_key, revision desc
      `,
        ),
    );
    return rows.map((row) => ({
      integrationKey: row.integration_key,
      backend: row.backend === "nango" ? "nango" : "native",
      providerConfigKey: row.nango_provider_config_key,
      enabled: row.enabled === true,
      definition: row.definition ? parseNangoIntegrationDefinition(row.definition) : null,
      revision: Number(row.revision),
      changedAt: (row.changed_at instanceof Date
        ? row.changed_at
        : new Date(row.changed_at)
      ).toISOString(),
    }));
  } catch (error) {
    if (pgCode(error) === "42P01") return [];
    throw error;
  }
}

/**
 * A process-local cache of the switch. A failed refresh keeps serving the last
 * good value (or nothing, which means every integration is native).
 */
export function createIntegrationBackendSettingsCache(
  options: { ttlMs?: number; now?: () => number } = {},
) {
  const ttlMs = Math.min(
    options.ttlMs ?? INTEGRATION_BACKEND_CACHE_TTL_MS,
    INTEGRATION_BACKEND_CACHE_TTL_MS,
  );
  const now = options.now ?? Date.now;
  let value: IntegrationBackendSetting[] = [];
  let loadedAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<IntegrationBackendSetting[]> | null = null;
  return {
    async get(db: Database): Promise<IntegrationBackendSetting[]> {
      if (now() - loadedAt < ttlMs) return value;
      pending ??= readIntegrationBackendSettings(db)
        .then((settings) => {
          value = settings;
          loadedAt = now();
          return settings;
        })
        .catch(() => {
          // Retry soon; keep the last good value meanwhile.
          loadedAt = now() - ttlMs + 5_000;
          return value;
        })
        .finally(() => {
          pending = null;
        });
      return await pending;
    },
    invalidate() {
      loadedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

export type IntegrationBackendSettingsCache = ReturnType<
  typeof createIntegrationBackendSettingsCache
>;

/** The deployment's shared cache; API and worker processes each hold one. */
export const integrationBackendSettingsCache = createIntegrationBackendSettingsCache();

/**
 * The Nango-backed integrations in effect for this deployment right now.
 * Empty (every integration native) unless a Nango secret key is configured.
 */
export async function readEffectiveNangoIntegrations(
  db: Database,
  settings: { nangoSecretKey?: string | null | undefined },
  cache: IntegrationBackendSettingsCache = integrationBackendSettingsCache,
): Promise<Map<string, EffectiveNangoIntegration>> {
  if (!settings.nangoSecretKey) return new Map();
  return effectiveNangoIntegrations(await cache.get(db), true);
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

export type NangoUsageKind =
  | "connection_created"
  | "connection_reconnected"
  | "connection_deleted"
  | "connection_needs_reauth"
  | "proxy_request"
  | "tool_call";

export type NangoUsageEvent = {
  accountId: string;
  workspaceId: string;
  subjectId?: string | null;
  integrationKey: string;
  providerConfigKey: string;
  connectionId?: string | null;
  nangoConnectionId: string;
  kind: NangoUsageKind;
  toolName?: string | null;
  httpMethod?: string | null;
  httpStatus?: number | null;
  requestBytes?: number;
  responseBytes?: number;
  durationMs?: number | null;
  occurredAt?: Date;
};

const MAX_IN_FLIGHT_USAGE_WRITES = 64;
let inFlightUsageWrites = 0;
let droppedUsageWrites = 0;

function clampBytes(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, max);
}

/** Inserts one usage event under the event's workspace scope. Throws on failure. */
export async function insertNangoUsageEvent(db: Database, event: NangoUsageEvent): Promise<void> {
  await withRlsContext(
    db,
    { accountId: event.accountId, workspaceId: event.workspaceId },
    async (scoped) => {
      await scoped.execute(sql`set local statement_timeout = '2s'`);
      await scoped.execute(sql`
        insert into nango_usage_events (
          account_id, workspace_id, occurred_at, subject_id, integration_key, provider_config_key,
          connection_id, nango_connection_id, kind, tool_name, http_method, http_status,
          request_bytes, response_bytes, duration_ms
        ) values (
          ${event.accountId}::uuid, ${event.workspaceId}::uuid,
          ${(event.occurredAt ?? new Date()).toISOString()}::timestamptz,
          ${clip(event.subjectId, 512)}, ${event.integrationKey.slice(0, 64)},
          ${event.providerConfigKey.slice(0, 128)}, ${event.connectionId ?? null}::uuid,
          ${event.nangoConnectionId.slice(0, 255)}, ${event.kind}, ${clip(event.toolName, 200)},
          ${clip(event.httpMethod?.toUpperCase(), 16)},
          ${Number.isInteger(event.httpStatus) ? event.httpStatus : null}::integer,
          ${clampBytes(event.requestBytes)}, ${clampBytes(event.responseBytes)},
          ${Number.isFinite(event.durationMs) ? Math.max(0, Math.trunc(event.durationMs as number)) : null}::integer
        )
      `);
    },
    undefined,
    "none",
  );
}

/**
 * Best-effort usage recording for the tool path: never awaited by callers,
 * never throws, bounded in flight. A dropped event only lowers the estimate.
 */
export function recordNangoUsageEvent(db: Database, event: NangoUsageEvent): void {
  if (inFlightUsageWrites >= MAX_IN_FLIGHT_USAGE_WRITES) {
    droppedUsageWrites += 1;
    return;
  }
  inFlightUsageWrites += 1;
  void insertNangoUsageEvent(db, event)
    .catch(() => {
      droppedUsageWrites += 1;
    })
    .finally(() => {
      inFlightUsageWrites -= 1;
    });
}

export function nangoUsageRecorderStats() {
  return { inFlight: inFlightUsageWrites, dropped: droppedUsageWrites };
}

// ---------------------------------------------------------------------------
// Usage summary (reconciliation)
// ---------------------------------------------------------------------------

export type NangoUsageSummaryRow = {
  accountId: string;
  workspaceId: string;
  integrationKey: string;
  subjectId: string | null;
  connectionSeconds: number;
  connectionDays: number;
  proxyRequests: number;
  toolCalls: number;
  requestBytes: number;
  responseBytes: number;
  computeSeconds: number;
  estimatedCostUsd: { connections: number; transfer: number; compute: number; total: number };
};

export type NangoUsageSummary = {
  since: string;
  until: string;
  rows: NangoUsageSummaryRow[];
  totals: Omit<NangoUsageSummaryRow, "accountId" | "workspaceId" | "integrationKey" | "subjectId">;
};

type LifecycleRow = {
  account_id: string;
  workspace_id: string;
  integration_key: string;
  subject_id: string | null;
  nango_connection_id: string;
  kind: string;
  occurred_at: Date | string;
};

type ActivityRow = {
  account_id: string;
  workspace_id: string;
  integration_key: string;
  subject_id: string | null;
  proxy_requests: number | string;
  tool_calls: number | string;
  request_bytes: number | string;
  response_bytes: number | string;
  compute_seconds: number | string;
};

const toTime = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).getTime();

/**
 * Connection time from lifecycle events: a connection exists from its first
 * created/reconnected event until its deleted event, clipped to the period.
 * Proxy and tool counts, bytes and compute come from activity events. Run it
 * under an account scope (organization admins) or as the owner (operators).
 */
export async function summarizeNangoUsage(
  db: Database,
  input: { since: Date; until: Date; accountId?: string },
): Promise<NangoUsageSummary> {
  const since = input.since;
  const until = input.until;
  const accountFilter = input.accountId ? sql`and account_id = ${input.accountId}::uuid` : sql``;
  let lifecycle: LifecycleRow[] = [];
  let activity: ActivityRow[] = [];
  try {
    lifecycle = await rawRows<LifecycleRow>(
      db,
      // Each connection's state when the period starts (its last lifecycle
      // event before it), then the events inside the period.
      sql`
        select * from (
          select distinct on (account_id, nango_connection_id)
            account_id::text, workspace_id::text, integration_key, subject_id, nango_connection_id,
            kind, occurred_at
          from nango_usage_events
          where kind in ('connection_created', 'connection_reconnected', 'connection_deleted')
            and occurred_at < ${since.toISOString()}::timestamptz ${accountFilter}
          order by account_id, nango_connection_id, occurred_at desc
        ) opening
        union all
        select account_id::text, workspace_id::text, integration_key, subject_id, nango_connection_id,
          kind, occurred_at
        from nango_usage_events
        where kind in ('connection_created', 'connection_reconnected', 'connection_deleted')
          and occurred_at >= ${since.toISOString()}::timestamptz
          and occurred_at < ${until.toISOString()}::timestamptz ${accountFilter}
        order by occurred_at
      `,
    );
    activity = await rawRows<ActivityRow>(
      db,
      sql`
        select account_id::text, workspace_id::text, integration_key, subject_id,
          count(*) filter (where kind = 'proxy_request') as proxy_requests,
          count(*) filter (where kind = 'tool_call') as tool_calls,
          coalesce(sum(request_bytes), 0) as request_bytes,
          coalesce(sum(response_bytes), 0) as response_bytes,
          coalesce(sum(case when kind = 'tool_call'
            then greatest(1, ceil(coalesce(duration_ms, 0) / 1000.0)) else 0 end), 0) as compute_seconds
        from nango_usage_events
        where kind in ('proxy_request', 'tool_call')
          and occurred_at >= ${since.toISOString()}::timestamptz
          and occurred_at < ${until.toISOString()}::timestamptz ${accountFilter}
        group by account_id, workspace_id, integration_key, subject_id
      `,
    );
  } catch (error) {
    if (pgCode(error) !== "42P01") throw error;
  }
  return buildNangoUsageSummary({ since, until, lifecycle, activity });
}

export function buildNangoUsageSummary(input: {
  since: Date;
  until: Date;
  lifecycle: LifecycleRow[];
  activity: ActivityRow[];
}): NangoUsageSummary {
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  const key = (row: {
    account_id: string;
    workspace_id: string;
    integration_key: string;
    subject_id: string | null;
  }) => JSON.stringify([row.account_id, row.workspace_id, row.integration_key, row.subject_id]);
  const rows = new Map<string, NangoUsageSummaryRow>();
  const rowFor = (row: {
    account_id: string;
    workspace_id: string;
    integration_key: string;
    subject_id: string | null;
  }) => {
    const id = key(row);
    let entry = rows.get(id);
    if (!entry) {
      entry = {
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        integrationKey: row.integration_key,
        subjectId: row.subject_id,
        connectionSeconds: 0,
        connectionDays: 0,
        proxyRequests: 0,
        toolCalls: 0,
        requestBytes: 0,
        responseBytes: 0,
        computeSeconds: 0,
        estimatedCostUsd: { connections: 0, transfer: 0, compute: 0, total: 0 },
      };
      rows.set(id, entry);
    }
    return entry;
  };
  // Open intervals per Nango connection (one Nango connection id may be
  // created, deleted and created again).
  const open = new Map<string, { startedAt: number; row: LifecycleRow }>();
  const close = (connectionKey: string, endedAt: number) => {
    const current = open.get(connectionKey);
    if (!current) return;
    open.delete(connectionKey);
    const start = Math.max(current.startedAt, sinceMs);
    const end = Math.min(endedAt, untilMs);
    if (end > start) rowFor(current.row).connectionSeconds += (end - start) / 1000;
  };
  for (const event of [...input.lifecycle].sort(
    (a, b) => toTime(a.occurred_at) - toTime(b.occurred_at),
  )) {
    const connectionKey = `${event.account_id}:${event.nango_connection_id}`;
    const at = toTime(event.occurred_at);
    if (event.kind === "connection_deleted") close(connectionKey, at);
    else if (!open.has(connectionKey)) open.set(connectionKey, { startedAt: at, row: event });
  }
  for (const connectionKey of [...open.keys()]) close(connectionKey, untilMs);
  for (const row of input.activity) {
    const entry = rowFor(row);
    entry.proxyRequests += Number(row.proxy_requests);
    entry.toolCalls += Number(row.tool_calls);
    entry.requestBytes += Number(row.request_bytes);
    entry.responseBytes += Number(row.response_bytes);
    entry.computeSeconds += Number(row.compute_seconds);
  }
  const totals = {
    connectionSeconds: 0,
    connectionDays: 0,
    proxyRequests: 0,
    toolCalls: 0,
    requestBytes: 0,
    responseBytes: 0,
    computeSeconds: 0,
    estimatedCostUsd: { connections: 0, transfer: 0, compute: 0, total: 0 },
  };
  const result = [...rows.values()].map((row) => {
    row.connectionSeconds = Math.round(row.connectionSeconds);
    row.connectionDays = Math.round((row.connectionSeconds / 86_400) * 1000) / 1000;
    row.estimatedCostUsd = estimateNangoCostUsd({
      connectionSeconds: row.connectionSeconds,
      transferBytes: row.requestBytes + row.responseBytes,
      computeSeconds: row.computeSeconds,
    });
    totals.connectionSeconds += row.connectionSeconds;
    totals.proxyRequests += row.proxyRequests;
    totals.toolCalls += row.toolCalls;
    totals.requestBytes += row.requestBytes;
    totals.responseBytes += row.responseBytes;
    totals.computeSeconds += row.computeSeconds;
    return row;
  });
  totals.connectionDays = Math.round((totals.connectionSeconds / 86_400) * 1000) / 1000;
  totals.estimatedCostUsd = estimateNangoCostUsd({
    connectionSeconds: totals.connectionSeconds,
    transferBytes: totals.requestBytes + totals.responseBytes,
    computeSeconds: totals.computeSeconds,
  });
  result.sort((a, b) =>
    [a.accountId, a.workspaceId, a.integrationKey, a.subjectId ?? ""]
      .join("\u0000")
      .localeCompare(
        [b.accountId, b.workspaceId, b.integrationKey, b.subjectId ?? ""].join("\u0000"),
      ),
  );
  return {
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    rows: result,
    totals,
  };
}

// ---------------------------------------------------------------------------
// Operator export
// ---------------------------------------------------------------------------

export type NangoAffectedConnection = {
  organizationId: string;
  organizationName: string;
  workspaceId: string;
  workspaceName: string;
  userId: string | null;
  userEmail: string | null;
  connectionId: string;
  backend: "native" | "nango";
  providerDomain: string;
  status: string;
  accountLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The Nango connection a Nango-backed row stands for. */
  nangoConnectionId: string | null;
};

/** Owner-only: every native and Nango connection of one integration. */
export async function listNangoAffectedConnections(
  db: Database,
  integrationKey: string,
): Promise<NangoAffectedConnection[]> {
  const rows = await db.transaction(async (tx) =>
    rawRows<Record<string, unknown>>(
      tx as unknown as Database,
      sql`select * from nango_affected_connections(${integrationKey})`,
    ),
  );
  const iso = (value: unknown) =>
    value == null ? null : (value instanceof Date ? value : new Date(String(value))).toISOString();
  return rows.map((row) => ({
    organizationId: String(row.organization_id),
    organizationName: String(row.organization_name),
    workspaceId: String(row.workspace_id),
    workspaceName: String(row.workspace_name),
    userId: row.user_id == null ? null : String(row.user_id),
    userEmail: row.user_email == null ? null : String(row.user_email),
    connectionId: String(row.connection_id),
    backend: row.backend === "nango" ? "nango" : "native",
    providerDomain: String(row.provider_domain),
    status: String(row.status),
    accountLabel: row.account_label == null ? null : String(row.account_label),
    createdAt: iso(row.created_at) ?? "",
    lastUsedAt: iso(row.last_used_at),
    nangoConnectionId: row.nango_connection_id == null ? null : String(row.nango_connection_id),
  }));
}
