import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * Heedeo signup scoring (migration 1565, docs/signup-abuse-protection.md,
 * "Heedeo shadow scoring"): the runtime mode read, the best-effort verdict
 * write and the owner-only operator listing. Rows hold codes, numbers and ids
 * only, never an email or an address.
 */

export const HEEDEO_SIGNUP_MODES = ["off", "shadow", "enforce"] as const;
export type HeedeoSignupMode = (typeof HEEDEO_SIGNUP_MODES)[number];

export const HEEDEO_SIGNUP_METHODS = [
  "email",
  "google",
  "github",
  "passkey",
  "other",
] as const;
export type HeedeoSignupMethod = (typeof HEEDEO_SIGNUP_METHODS)[number];

export type HeedeoSignupOutcome = "evaluated" | "error" | "skipped" | "refused";

/** The mode is read on every signup and client config; reuse it briefly per process. */
const HEEDEO_SIGNUP_MODE_TTL_MS = 15_000;
let heedeoSignupModeCache: {
  at: number;
  value: Promise<HeedeoSignupMode>;
} | null = null;

/** Forget the cached mode (tests, and right after an operator change). */
export function resetHeedeoSignupModeCache(): void {
  heedeoSignupModeCache = null;
}

/**
 * The deployment's Heedeo signup mode, for a runtime connection. Fails off: a
 * failed read (including a database that predates migration 1565) is "off".
 */
export async function readHeedeoSignupMode(
  db: Database,
): Promise<HeedeoSignupMode> {
  const now = Date.now();
  if (
    heedeoSignupModeCache &&
    now - heedeoSignupModeCache.at < HEEDEO_SIGNUP_MODE_TTL_MS
  ) {
    return await heedeoSignupModeCache.value;
  }
  const value = rawRows<{ mode: string }>(
    db,
    sql`select heedeo.mode from opengeni_private.signup_heedeo_mode_revisions heedeo
      where heedeo.data_schema = current_schema()
      order by heedeo.revision desc limit 1`,
  ).then(
    ([row]) =>
      HEEDEO_SIGNUP_MODES.includes(row?.mode as HeedeoSignupMode)
        ? (row!.mode as HeedeoSignupMode)
        : "off",
    (error: unknown) => {
      console.warn("Heedeo signup mode read failed; scoring stays off", {
        error: error instanceof Error ? error.message : String(error),
      });
      heedeoSignupModeCache = null;
      return "off" as const;
    },
  );
  heedeoSignupModeCache = { at: now, value };
  return await value;
}

export type SignupHeedeoEvaluationRecord = {
  userId: string | null;
  signupMethod: HeedeoSignupMethod;
  mode: Exclude<HeedeoSignupMode, "off">;
  outcome: HeedeoSignupOutcome;
  errorCode?: string | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  tokenPresent: boolean;
  noToken?: boolean | null;
  evaluationId?: string | null;
  score?: number | null;
  band?: string | null;
  flagged?: boolean | null;
  reasonCodes?: readonly string[];
  visitorId?: string | null;
};

const boundedText = (value: string | null | undefined, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
const code = (value: string | null | undefined, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : null;
const integer = (value: number | null | undefined, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : null;

/**
 * Stores one verdict, then deletes verdicts older than 180 days (the table's
 * runtime delete policy matches only those). Runtime connection; the caller
 * treats any failure as best-effort. Values that don't fit the columns are
 * dropped, never failing the write.
 */
export async function recordSignupHeedeoEvaluation(
  db: Database,
  record: SignupHeedeoEvaluationRecord,
): Promise<void> {
  const reasonCodes = [
    ...new Set(
      (record.reasonCodes ?? []).filter((value) =>
        /^[a-z0-9_:.-]{1,64}$/u.test(value),
      ),
    ),
  ].slice(0, 64);
  const httpStatus = integer(record.httpStatus, 0, 999);
  await rawRows(
    db,
    sql`insert into opengeni_private.signup_heedeo_evaluations (data_schema, user_id, signup_method,
      mode, outcome, error_code, http_status, latency_ms, token_present, no_token, evaluation_id,
      score, band, flagged, reason_codes, visitor_id)
    values (current_schema(), ${boundedText(record.userId, 1019)}, ${record.signupMethod},
      ${record.mode}, ${record.outcome}, ${code(record.errorCode, /^[a-z0-9_]{1,64}$/u)},
      ${httpStatus !== null && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null},
      ${integer(record.latencyMs, 0, 600_000)}, ${record.tokenPresent}, ${record.noToken ?? null},
      ${boundedText(record.evaluationId, 200)}, ${integer(record.score, -2_147_483_648, 2_147_483_647)},
      ${code(record.band, /^[a-z_]{1,32}$/u)}, ${record.flagged ?? null},
      ${`{${reasonCodes.map((value) => `"${value}"`).join(",")}}`}::text[],
      ${boundedText(record.visitorId, 200)})`,
  );
  await rawRows(
    db,
    sql`delete from opengeni_private.signup_heedeo_evaluations`,
  );
}

export type SignupHeedeoVerdictOrganization = {
  accountId: string;
  /** The organization's current promotion decision; null without one. */
  decision: string | null;
  decisionRevision: number | null;
  ruleId: string | null;
  policyVersion: string | null;
};

export type SignupHeedeoVerdict = {
  id: string;
  createdAt: string;
  userId: string | null;
  signupMethod: HeedeoSignupMethod;
  mode: Exclude<HeedeoSignupMode, "off">;
  outcome: HeedeoSignupOutcome;
  errorCode: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  tokenPresent: boolean;
  noToken: boolean | null;
  evaluationId: string | null;
  score: number | null;
  band: string | null;
  flagged: boolean | null;
  reasonCodes: string[];
  visitorId: string | null;
  /** Organizations the signed-up user owns, with our own decision on each. */
  organizations: SignupHeedeoVerdictOrganization[];
};

class RolledBackRead<T> extends Error {
  constructor(readonly value: T) {
    super("rolled back read");
  }
}

const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;
const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/**
 * Recent Heedeo verdicts, newest first, each joined to the organization the
 * signup created (`managed_accounts` with `external_source = 'better-auth:user'`
 * and `external_id = user_id`) and our current promotion decision on it. With
 * `accountId`, only verdicts of that organization's signup. Owner connection only, in one read-only transaction
 * that is rolled back. UUIDs, codes and numbers only.
 */
export async function listSignupHeedeoVerdicts(
  ownerDb: Database,
  options: { limit?: number; accountId?: string } = {},
): Promise<SignupHeedeoVerdict[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  try {
    await ownerDb.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await rawRows(txDb, sql`set transaction isolation level repeatable read`);
      await rawRows(txDb, sql`set local statement_timeout = '60s'`);
      await rawRows(
        txDb,
        sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`,
      );
      await rawRows(
        txDb,
        sql`select opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema())`,
      );
      const accountFilter = options.accountId
        ? sql`and exists (select 1 from managed_accounts owner_account
            where owner_account.id = ${options.accountId}::uuid
              and owner_account.external_source = 'better-auth:user'
              and owner_account.external_id = e.user_id)`
        : sql``;
      const rows = await rawRows<Record<string, unknown>>(
        txDb,
        sql`select e.id::text as id, e.created_at, e.user_id, e.signup_method, e.mode, e.outcome,
            e.error_code, e.http_status, e.latency_ms, e.token_present, e.no_token, e.evaluation_id,
            e.score, e.band, e.flagged, e.reason_codes, e.visitor_id,
            coalesce((select jsonb_agg(jsonb_build_object(
                'accountId', a.id,
                'decision', d.decision, 'decisionRevision', d.revision,
                'ruleId', h.rule_id, 'policyVersion', h.policy_version)
                order by a.created_at, a.id)
              from managed_accounts a
              left join promotion_decisions d on d.account_id = a.id
              left join opengeni_private.promotion_decision_history h
                on h.data_schema = e.data_schema and h.account_id = d.account_id
                and h.revision = d.revision
              where e.user_id is not null and a.external_source = 'better-auth:user'
                and a.external_id = e.user_id), '[]'::jsonb) as organizations
          from opengeni_private.signup_heedeo_evaluations e
          where e.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
            ${accountFilter}
          order by e.created_at desc, e.id
          limit ${limit}`,
      );
      throw new RolledBackRead<SignupHeedeoVerdict[]>(
        rows.map((row) => ({
          id: String(row.id),
          createdAt: iso(row.created_at)!,
          userId: (row.user_id as string | null) ?? null,
          signupMethod: row.signup_method as HeedeoSignupMethod,
          mode: row.mode as Exclude<HeedeoSignupMode, "off">,
          outcome: row.outcome as HeedeoSignupOutcome,
          errorCode: (row.error_code as string | null) ?? null,
          httpStatus: num(row.http_status),
          latencyMs: num(row.latency_ms),
          tokenPresent: row.token_present === true,
          noToken: (row.no_token as boolean | null) ?? null,
          evaluationId: (row.evaluation_id as string | null) ?? null,
          score: num(row.score),
          band: (row.band as string | null) ?? null,
          flagged: (row.flagged as boolean | null) ?? null,
          reasonCodes: Array.isArray(row.reason_codes)
            ? (row.reason_codes as string[])
            : [],
          visitorId: (row.visitor_id as string | null) ?? null,
          organizations: (
            (typeof row.organizations === "string"
              ? JSON.parse(row.organizations)
              : row.organizations) as Record<string, unknown>[]
          ).map((organization) => ({
            accountId: String(organization.accountId),
            decision: (organization.decision as string | null) ?? null,
            decisionRevision: num(organization.decisionRevision),
            ruleId: (organization.ruleId as string | null) ?? null,
            policyVersion:
              (organization.policyVersion as string | null) ?? null,
          })),
        })),
      );
    });
  } catch (error) {
    if (error instanceof RolledBackRead)
      return error.value as SignupHeedeoVerdict[];
    throw error;
  }
  throw new Error("Heedeo verdict read did not complete");
}
