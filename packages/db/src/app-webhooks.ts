import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withWorkspaceRls, type Database } from "./database";

/**
 * App webhooks and app notifications (migration 1543, docs/app-webhooks.md).
 * Every read and write runs under the workspace's row-level security. A
 * delivery names its workspace in its address, so the public intake reads
 * its webhook in that workspace's context without an account.
 */

type Scope = { accountId: string; workspaceId: string };

export type AppWebhookStatus = "active" | "paused";

export type AppWebhookRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  siteId: string;
  name: string;
  collection: string;
  recordsPath: string | null;
  key: string | null;
  fields: string[] | null;
  status: AppWebhookStatus;
  secretHash: string;
  secretEncrypted: string;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
  lastStatus: "succeeded" | "failed" | "rejected" | null;
  lastError: string | null;
};

type Record_ = {
  id: string;
  account_id: string;
  workspace_id: string;
  site_id: string;
  name: string;
  collection: string;
  records_path: string | null;
  key_path: string | null;
  fields: unknown;
  status: AppWebhookStatus;
  secret_hash: string;
  secret_encrypted: string;
  created_by_subject_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_delivery_at: Date | string | null;
  last_status: AppWebhookRow["lastStatus"];
  last_error: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const iso = (value: Date | string): string => new Date(value).toISOString();

function fieldsOf(value: unknown): string[] | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : null;
}

function toRow(record: Record_): AppWebhookRow {
  return {
    id: record.id,
    accountId: record.account_id,
    workspaceId: record.workspace_id,
    siteId: record.site_id,
    name: record.name,
    collection: record.collection,
    recordsPath: record.records_path,
    key: record.key_path,
    fields: fieldsOf(record.fields),
    status: record.status,
    secretHash: record.secret_hash,
    secretEncrypted: record.secret_encrypted,
    createdBySubjectId: record.created_by_subject_id,
    createdAt: iso(record.created_at),
    updatedAt: iso(record.updated_at),
    lastDeliveryAt: record.last_delivery_at === null ? null : iso(record.last_delivery_at),
    lastStatus: record.last_status,
    lastError: record.last_error,
  };
}

/** At most this many webhooks per app. */
export const APP_WEBHOOKS_PER_APP = 20;

export type AppWebhookSettings = {
  name: string;
  collection: string;
  recordsPath: string | null;
  key: string | null;
  fields: string[] | null;
  status: AppWebhookStatus;
};

export async function createAppWebhook(
  db: Database,
  scope: Scope,
  input: AppWebhookSettings & {
    siteId: string;
    secretHash: string;
    secretEncrypted: string;
    createdBySubjectId: string;
  },
): Promise<AppWebhookRow | "limit"> {
  return await withRlsContext(db, scope, async (tx) => {
    const [count] = await rawRows<{ count: number | string }>(
      tx,
      sql`select count(*) as count from app_webhooks
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}`,
    );
    if (Number(count?.count ?? 0) >= APP_WEBHOOKS_PER_APP) return "limit";
    const [row] = await rawRows<Record_>(
      tx,
      sql`insert into app_webhooks (account_id, workspace_id, site_id, name, collection,
          records_path, key_path, fields, status, secret_hash, secret_encrypted, created_by_subject_id)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.name},
          ${input.collection}, ${input.recordsPath}, ${input.key},
          ${input.fields === null ? null : JSON.stringify(input.fields)}::jsonb, ${input.status},
          ${input.secretHash}, ${input.secretEncrypted}, ${input.createdBySubjectId})
        returning *`,
    );
    return toRow(row!);
  });
}

export async function listAppWebhooks(
  db: Database,
  scope: Scope,
  siteId: string,
): Promise<AppWebhookRow[]> {
  if (!UUID.test(siteId)) return [];
  return await withRlsContext(db, scope, async (tx) =>
    (
      await rawRows<Record_>(
        tx,
        sql`select * from app_webhooks
          where workspace_id = ${scope.workspaceId} and site_id = ${siteId}
          order by created_at, id`,
      )
    ).map(toRow),
  );
}

/** One webhook, read in its workspace's context (the public intake knows only the workspace). */
export async function getAppWebhook(
  db: Database,
  workspaceId: string,
  webhookId: string,
): Promise<AppWebhookRow | null> {
  if (!UUID.test(workspaceId) || !UUID.test(webhookId)) return null;
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await rawRows<Record_>(
      tx,
      sql`select * from app_webhooks where workspace_id = ${workspaceId} and id = ${webhookId}`,
    );
    return row ? toRow(row) : null;
  });
}

export async function updateAppWebhook(
  db: Database,
  scope: Scope,
  webhookId: string,
  input: AppWebhookSettings & {
    secretHash?: string;
    secretEncrypted?: string;
    /** The person saving it takes the webhook over. */
    createdBySubjectId?: string;
  },
): Promise<AppWebhookRow | null> {
  return await withRlsContext(db, scope, async (tx) => {
    const [row] = await rawRows<Record_>(
      tx,
      sql`update app_webhooks set name = ${input.name}, collection = ${input.collection},
          records_path = ${input.recordsPath}, key_path = ${input.key},
          fields = ${input.fields === null ? null : JSON.stringify(input.fields)}::jsonb,
          status = ${input.status},
          secret_hash = coalesce(${input.secretHash ?? null}, secret_hash),
          secret_encrypted = coalesce(${input.secretEncrypted ?? null}, secret_encrypted),
          created_by_subject_id = coalesce(${input.createdBySubjectId ?? null}, created_by_subject_id),
          updated_at = now()
        where workspace_id = ${scope.workspaceId} and id = ${webhookId}
        returning *`,
    );
    return row ? toRow(row) : null;
  });
}

export async function deleteAppWebhook(
  db: Database,
  scope: Scope,
  webhookId: string,
): Promise<boolean> {
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`delete from app_webhooks where workspace_id = ${scope.workspaceId} and id = ${webhookId}
        returning id`,
    );
    return rows.length > 0;
  });
}

/**
 * Count one delivery against the webhook's one-minute window, atomically.
 * False when the window is full.
 */
export async function admitAppWebhookDelivery(
  db: Database,
  scope: Scope,
  webhookId: string,
  perMinute: number,
): Promise<boolean> {
  return await withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{ id: string }>(
      tx,
      sql`update app_webhooks set
          window_started_at = case when window_started_at is null
            or window_started_at <= now() - interval '1 minute' then now() else window_started_at end,
          window_count = case when window_started_at is null
            or window_started_at <= now() - interval '1 minute' then 1 else window_count + 1 end
        where workspace_id = ${scope.workspaceId} and id = ${webhookId}
          and (window_started_at is null or window_started_at <= now() - interval '1 minute'
            or window_count < ${perMinute})
        returning id`,
    );
    return rows.length > 0;
  });
}

/** Remember a delivery's outcome for the people managing the webhook. */
export async function recordAppWebhookDelivery(
  db: Database,
  scope: Scope,
  webhookId: string,
  outcome: { status: "succeeded" | "failed" | "rejected"; error: string | null },
): Promise<void> {
  await withRlsContext(db, scope, async (tx) => {
    await tx.execute(
      sql`update app_webhooks set last_delivery_at = now(), last_status = ${outcome.status},
          last_error = ${outcome.error === null ? null : outcome.error.slice(0, 2000)}
        where workspace_id = ${scope.workspaceId} and id = ${webhookId}`,
    );
  });
}

// --- app notifications (site.notify) -------------------------------------------

export type AppNotificationInsert = {
  siteId: string;
  senderSubjectId: string;
  senderLabel: string;
  appTitle: string;
  audience: "people" | "workspace";
  recipients: string[];
  key: string;
  title: string;
  body: string;
  link: string;
};

export type AppNotificationLimits = {
  /** Sends one person may make from one app per window. */
  perSender: number;
  /** Of those, sends to everyone who can open the app. */
  workspacePerSender: number;
  /** The window, in seconds. */
  windowSeconds: number;
};

/**
 * Record one send; the table's trigger delivers it. The sender's recent sends
 * from this app are counted under a transaction lock on the pair, so
 * concurrent sends can't pass the limit together.
 */
export async function insertAppNotification(
  db: Database,
  scope: Scope,
  input: AppNotificationInsert,
  limits: AppNotificationLimits,
): Promise<{ id: string } | { limited: "sender" | "workspace" } | { unavailable: true }> {
  return await withRlsContext(db, scope, async (tx) => {
    // Delivery runs once this role may execute it (granted a release after
    // migration 1543); until then a send is refused rather than stored.
    const [privilege] = await rawRows<{ allowed: boolean }>(
      tx,
      sql`select has_function_privilege(
        'opengeni_private.deliver_app_notification_v1(uuid)', 'EXECUTE') as allowed`,
    );
    if (privilege?.allowed !== true) return { unavailable: true as const };
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`app-notify:${input.siteId}:${input.senderSubjectId}`}, 0))`,
    );
    const [counts] = await rawRows<{ total: number | string; workspace: number | string }>(
      tx,
      sql`select count(*) as total, count(*) filter (where audience = 'workspace') as workspace
        from app_notifications
        where workspace_id = ${scope.workspaceId} and site_id = ${input.siteId}
          and sender_subject_id = ${input.senderSubjectId}
          and created_at > now() - make_interval(secs => ${limits.windowSeconds})`,
    );
    if (Number(counts?.total ?? 0) >= limits.perSender) return { limited: "sender" as const };
    if (
      input.audience === "workspace" &&
      Number(counts?.workspace ?? 0) >= limits.workspacePerSender
    )
      return { limited: "workspace" as const };
    const [row] = await rawRows<{ id: string }>(
      tx,
      sql`insert into app_notifications (account_id, workspace_id, site_id, sender_subject_id,
          sender_label, app_title, audience, recipients, notice_key, title, body, link)
        values (${scope.accountId}, ${scope.workspaceId}, ${input.siteId}, ${input.senderSubjectId},
          ${input.senderLabel}, ${input.appTitle}, ${input.audience},
          array[${sql.join(
            input.recipients.map((recipient) => sql`${recipient}`),
            sql`, `,
          )}]::text[],
          ${input.key}, ${input.title}, ${input.body}, ${input.link})
        returning id`,
    );
    return { id: row!.id };
  });
}
