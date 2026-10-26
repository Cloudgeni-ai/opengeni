import { sql } from "drizzle-orm";
import { rawRows, type Database, withRlsContext } from "./database";

// Native app push storage (0639). Every access goes through the owner-run
// functions; the application role never reads the tables directly.

export const NATIVE_PUSH_RULES = [
  "needs_input",
  "reply_ready",
  "failed",
  "agent",
  // Agent calls (0988): agents working for this person may ring this phone,
  // and, with `call_members`, agents of other members of a shared workspace.
  "call",
  "call_members",
] as const;
export type NativePushRule = (typeof NATIVE_PUSH_RULES)[number];

export type NativePushDeviceRow = {
  platform: "ios" | "android";
  appId: string;
  environment: "development" | "production";
  token: string;
  rules: NativePushRule[];
  /** iOS PushKit token that agent calls ring (0988). */
  voipToken: string | null;
  updatedAt: string;
};

type DeviceRecord = {
  platform: "ios" | "android";
  app_id: string;
  environment: "development" | "production";
  token: string;
  rules: NativePushRule[];
  voip_token?: string | null;
  updated_at: Date | string;
};

function device(row: DeviceRecord): NativePushDeviceRow {
  return {
    platform: row.platform,
    appId: row.app_id,
    environment: row.environment,
    token: row.token,
    rules: row.rules,
    voipToken: row.voip_token ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function textArray(values: readonly string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export async function getNativePushDevice(
  db: Database,
  authSessionId: string,
): Promise<NativePushDeviceRow | null> {
  const [row] = await rawRows<DeviceRecord>(
    db,
    sql`select * from opengeni_private.native_push_device_v2(${authSessionId}::text)`,
  );
  return row ? device(row) : null;
}

export async function registerNativePushDevice(
  db: Database,
  input: {
    authSessionId: string;
    platform: "ios" | "android";
    appId: string;
    environment: "development" | "production";
    token: string;
    rules: readonly NativePushRule[];
    /** iOS PushKit token; without it an iOS phone keeps no call rules. */
    voipToken?: string | null | undefined;
  },
): Promise<NativePushDeviceRow> {
  const [row] = await rawRows<DeviceRecord>(
    db,
    sql`select * from opengeni_private.register_native_push_device_v2(
      ${input.authSessionId}::text, ${input.platform}::text, ${input.appId}::text,
      ${input.environment}::text, ${input.token}::text,
      ${input.rules.length > 0 ? textArray(input.rules) : sql`array[]::text[]`},
      ${input.voipToken ?? null}::text
    )`,
  );
  if (!row) throw new Error("Native push registration returned no row");
  return device(row);
}

export async function unregisterNativePushDevice(
  db: Database,
  authSessionId: string,
): Promise<void> {
  await db.execute(
    sql`select opengeni_private.unregister_native_push_device_v1(${authSessionId}::text)`,
  );
}

/**
 * Push to the person who started a session, on every device that wants
 * `rule`. Runs under the session's workspace RLS context. Returns how many
 * deliveries were queued; repeated `dedupeKey`s are ignored.
 */
export async function enqueueNativePush(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    rule: NativePushRule;
    dedupeKey: string;
    title?: string | null;
    body: string;
    eventType?: string;
  },
): Promise<number> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) => {
      const [row] = await rawRows<{ queued: number }>(
        scoped,
        sql`select opengeni_private.enqueue_native_push_v1(
          ${input.sessionId}::uuid, ${input.rule}::text, ${input.dedupeKey}::text,
          ${input.title ?? null}::text, ${input.body}::text, ${input.eventType ?? "agent.notify"}::text
        ) as queued`,
      );
      return row?.queued ?? 0;
    },
  );
}

export type ClaimedNativePushDelivery = {
  deliveryId: string;
  platform: "ios" | "android";
  appId: string;
  environment: "development" | "production";
  token: string;
  /** The PushKit token, for a call ring on iOS. */
  voipToken: string | null;
  payload: {
    rule: NativePushRule;
    eventType?: string;
    sessionId: string;
    workspaceId: string;
    subjectId: string;
    title?: string;
    body?: string;
    /**
     * An agent notification's subtitle, facts and urgency (0664); a question or
     * approval carries urgency when its person asked for time-sensitive ones (0718).
     */
    subtitle?: string;
    facts?: Array<{ label: string; value: string }>;
    urgency?: "normal" | "time_sensitive";
    /** The session event the push is about, so a tap lands on it (0664). */
    sequence?: number;
    /** A call ring (rule `call`, 0988): the call and when it stops ringing. */
    callId?: string;
    ringUntil?: string;
  };
  attempts: number;
};

export async function claimNativePushDeliveries(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<ClaimedNativePushDelivery[]> {
  const rows = await rawRows<{
    delivery_id: string;
    platform: "ios" | "android";
    app_id: string;
    environment: "development" | "production";
    token: string;
    voip_token: string | null;
    payload: ClaimedNativePushDelivery["payload"];
    attempts: number;
  }>(
    db,
    sql`select * from opengeni_private.claim_native_push_deliveries_v2(
      ${input.claimId}::uuid, ${input.limit ?? 32}::integer, ${input.claimSeconds ?? 60}::integer
    )`,
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    platform: row.platform,
    appId: row.app_id,
    environment: row.environment,
    token: row.token,
    voipToken: row.voip_token ?? null,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

export type NativePushOutcome = "delivered" | "retry" | "failed" | "unregistered";

export async function settleNativePushDelivery(
  db: Database,
  input: {
    claimId: string;
    deliveryId: string;
    outcome: NativePushOutcome;
    error?: string | null;
    retrySeconds?: number;
  },
): Promise<void> {
  await db.execute(
    sql`select opengeni_private.settle_native_push_delivery_v1(
      ${input.claimId}::uuid, ${input.deliveryId}::uuid, ${input.outcome}::text,
      ${input.error ?? null}::text, ${input.retrySeconds ?? 30}::integer
    )`,
  );
}

export async function pruneNativePushDeliveries(
  db: Database,
  input: { retentionHours?: number; limit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ pruned: number }>(
    db,
    sql`select opengeni_private.prune_native_push_deliveries_v1(
      ${input.retentionHours ?? 168}::integer, ${input.limit ?? 1000}::integer
    ) as pruned`,
  );
  return row?.pruned ?? 0;
}
