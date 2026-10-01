import { CREDIT_GRANT_CLASSES, type CreditGrantClass } from "@opengeni/contracts";
import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * Server-side usage analytics reads and writes (migration 0561). Every value
 * is content-free: opaque `user:` subjects for presence, and bounded classes
 * for credit grants. None of these is an authorization input.
 */

/** Fixed presence windows published as `opengeni_active_users{window}`. */
export const ACTIVE_USER_WINDOWS = ["5m", "15m", "1h", "24h", "7d", "30d"] as const;
export type ActiveUserWindow = (typeof ACTIVE_USER_WINDOWS)[number];

/** The only subjects presence accepts: opaque managed-human identifiers. */
export const USER_ACTIVITY_PRESENCE_SUBJECT_PATTERN = /^user:[A-Za-z0-9_-]{8,128}$/;

/** Upper bound of one presence batch; the database function enforces it too. */
export const USER_ACTIVITY_PRESENCE_MAX_BATCH = 1000;

/**
 * Record that these managed humans were active now. Subjects outside the
 * opaque `user:` shape are dropped here and again in the database. The UTC-day
 * change of a row writes the `user.active` lifecycle fact. Returns the number
 * of rows written; rows seen in the last 30 seconds are left untouched.
 */
export async function recordUserActivityPresence(
  db: Database,
  subjectIds: readonly string[],
): Promise<number> {
  const subjects = [...new Set(subjectIds)].filter((subject) =>
    USER_ACTIVITY_PRESENCE_SUBJECT_PATTERN.test(subject),
  );
  if (subjects.length === 0) return 0;
  let written = 0;
  for (let start = 0; start < subjects.length; start += USER_ACTIVITY_PRESENCE_MAX_BATCH) {
    const batch = subjects.slice(start, start + USER_ACTIVITY_PRESENCE_MAX_BATCH);
    const [row] = await rawRows<{ written: number | string | null }>(
      db,
      sql`select opengeni_private.record_user_activity_presence(
        array(select jsonb_array_elements_text(${JSON.stringify(batch)}::jsonb))
      ) as written`,
    );
    written += Number(row?.written ?? 0);
  }
  return written;
}

/** Distinct managed humans seen within each fixed window, including zeroes. */
export async function countActiveUsers(db: Database): Promise<Record<ActiveUserWindow, number>> {
  const counts = Object.fromEntries(ACTIVE_USER_WINDOWS.map((window) => [window, 0])) as Record<
    ActiveUserWindow,
    number
  >;
  const rows = await rawRows<{ time_window: string; user_count: number | string }>(
    db,
    sql`select time_window, user_count from opengeni_private.count_active_users()`,
  );
  for (const row of rows) {
    if ((ACTIVE_USER_WINDOWS as readonly string[]).includes(row.time_window)) {
      counts[row.time_window as ActiveUserWindow] = Number(row.user_count);
    }
  }
  return counts;
}

export type CreditGrantTotals = Record<CreditGrantClass, { count: number; micros: number }>;

/**
 * Positive credit grants observed since migration 0561, by class, including
 * zeroes. The ledger trigger observes every writer: the verified-signup trial
 * trigger, Stripe coupon checkouts, and operator grants.
 */
export async function readCreditGrantTotals(db: Database): Promise<CreditGrantTotals> {
  const totals = Object.fromEntries(
    CREDIT_GRANT_CLASSES.map((grantClass) => [grantClass, { count: 0, micros: 0 }]),
  ) as CreditGrantTotals;
  const rows = await rawRows<{
    grant_class: string;
    grant_count: number | string;
    granted_micros: number | string;
  }>(
    db,
    sql`select grant_class, grant_count, granted_micros from opengeni_private.credit_grant_totals()`,
  );
  for (const row of rows) {
    if ((CREDIT_GRANT_CLASSES as readonly string[]).includes(row.grant_class)) {
      totals[row.grant_class as CreditGrantClass] = {
        count: Number(row.grant_count),
        micros: Number(row.granted_micros),
      };
    }
  }
  return totals;
}
