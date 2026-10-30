import { sql } from "drizzle-orm";
import { rawRows, type Database, withRlsContext } from "./database";

// Native app push storage (0639). Every access goes through the owner-run
// functions; the application role never reads the tables directly.

export const NATIVE_PUSH_RULES = [
  "needs_input",
  "reply_ready",
  "failed",
  "agent",
  // Agent calls (1107): agents working for this person may ring this phone,
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
  /** iOS PushKit token that agent calls ring (1107). */
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

/**
 * 1107's agent call routines and the native push v2 functions that carry the
 * iOS VoIP token. A later migration grants them all together.
 */
const AGENT_CALL_ROUTINES = [
  "opengeni_private.native_push_device_v2(text)",
  "opengeni_private.register_native_push_device_v2(text, text, text, text, text, text[], text)",
  "opengeni_private.claim_native_push_deliveries_v2(uuid, integer, integer)",
  "opengeni_private.agent_call_device_count_v1(text, boolean)",
  "opengeni_private.agent_call_ringing_v1(text)",
  "opengeni_private.ring_agent_call_v1(uuid, boolean)",
] as const;

/**
 * Whether the runtime may call 1107's routines yet. False while their EXECUTE
 * grant is withheld (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES) or
 * they are absent; until then native push keeps its v1 functions and no phone
 * takes agent calls. A separate statement: EXECUTE is checked when a statement
 * starts, so a guard inside the calling statement would not avoid the error.
 */
export async function agentCallRoutinesGranted(db: Pick<Database, "execute">): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select bool_and(coalesce(
        has_function_privilege(to_regprocedure(signature)::oid, 'EXECUTE'), false
      )) as granted
      from unnest(${textArray(AGENT_CALL_ROUTINES)}) as signature`,
  );
  return row?.granted === true;
}

const CALL_RULES: ReadonlySet<NativePushRule> = new Set(["call", "call_members"]);

export async function getNativePushDevice(
  db: Database,
  authSessionId: string,
): Promise<NativePushDeviceRow | null> {
  const granted = await agentCallRoutinesGranted(db);
  const [row] = await rawRows<DeviceRecord>(
    db,
    granted
      ? sql`select * from opengeni_private.native_push_device_v2(${authSessionId}::text)`
      : sql`select * from opengeni_private.native_push_device_v1(${authSessionId}::text)`,
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
    /**
     * iOS PushKit token; without it an iOS phone keeps no call rules. Until
     * the agent call routines are granted, no phone keeps call rules.
     */
    voipToken?: string | null | undefined;
  },
): Promise<NativePushDeviceRow> {
  const granted = await agentCallRoutinesGranted(db);
  const rules = granted ? input.rules : input.rules.filter((rule) => !CALL_RULES.has(rule));
  const ruleArray = rules.length > 0 ? textArray(rules) : sql`array[]::text[]`;
  const [row] = await rawRows<DeviceRecord>(
    db,
    granted
      ? sql`select * from opengeni_private.register_native_push_device_v2(
          ${input.authSessionId}::text, ${input.platform}::text, ${input.appId}::text,
          ${input.environment}::text, ${input.token}::text, ${ruleArray},
          ${input.voipToken ?? null}::text
        )`
      : sql`select * from opengeni_private.register_native_push_device_v1(
          ${input.authSessionId}::text, ${input.platform}::text, ${input.appId}::text,
          ${input.environment}::text, ${input.token}::text, ${ruleArray}
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
    /** A call ring (rule `call`, 1107): the call and when it stops ringing. */
    callId?: string;
    ringUntil?: string;
  };
  attempts: number;
};

export async function claimNativePushDeliveries(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<ClaimedNativePushDelivery[]> {
  const granted = await agentCallRoutinesGranted(db);
  const limit = input.limit ?? 32;
  const claimSeconds = input.claimSeconds ?? 60;
  const rows = await rawRows<{
    delivery_id: string;
    platform: "ios" | "android";
    app_id: string;
    environment: "development" | "production";
    token: string;
    voip_token?: string | null;
    payload: ClaimedNativePushDelivery["payload"];
    attempts: number;
  }>(
    db,
    granted
      ? sql`select * from opengeni_private.claim_native_push_deliveries_v2(
          ${input.claimId}::uuid, ${limit}::integer, ${claimSeconds}::integer
        )`
      : sql`select * from opengeni_private.claim_native_push_deliveries_v1(
          ${input.claimId}::uuid, ${limit}::integer, ${claimSeconds}::integer
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
