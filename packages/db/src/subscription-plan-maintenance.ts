import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, type Database } from "./database";
import {
  expirePlanCreditPeriod,
  freePlanCreditEligible,
  grantPlanCreditPeriod,
  readSubscriptionPlanCatalog,
  upsertOrganizationPlan,
} from "./subscription-plans";

export const SUBSCRIPTION_PLAN_MAINTENANCE_BATCH_SIZE = 50;

/** Advisory IDs only. The caller must recheck under the organization fence. */
export async function listSubscriptionPlanMaintenanceAccounts(
  db: Database,
  limit = SUBSCRIPTION_PLAN_MAINTENANCE_BATCH_SIZE,
): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("subscription plan maintenance batch size must be between 1 and 100");
  }
  const rows = await rawRows<{ account_id: string }>(
    db,
    sql`select account_id from opengeni_private.list_subscription_plan_maintenance_accounts(${limit})`,
  );
  return rows.map((row) => row.account_id);
}

export async function subscriptionPlanMaintenanceDue(db: Database): Promise<boolean> {
  return (await listSubscriptionPlanMaintenanceAccounts(db, 1)).length > 0;
}

/**
 * One bounded DB-only pass. Organization membership fence precedes the credit
 * advisory lock; never lock the account row. Independent account failures roll
 * back that account, not successful neighbors. Multiple workers converge on the
 * foundation's immutable month/expiry receipts, with no distributed job claim.
 * The worker owns the default-off deployment gate; these helpers do not read env.
 */
export async function maintainSubscriptionPlans(
  db: Database,
  input: { batchSize?: number; onError?: (error: unknown, accountId: string) => void } = {},
) {
  const accounts = await listSubscriptionPlanMaintenanceAccounts(db, input.batchSize);
  const result = {
    examinedAccounts: accounts.length,
    expiredPeriods: 0,
    enrolledFreeAccounts: 0,
    grantedFreePeriods: 0,
    failedAccounts: 0,
  };
  for (const accountId of accounts) {
    try {
      const changed = await withAccountRls(db, accountId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
        );
        // Snapshot time after acquiring the fence. Recheck everything inside
        // this tenant transaction: inventory can be stale by the time we lock.
        const [clock] = await rawRows<{
          now: string;
          period_start: string;
          period_end: string;
          month_key: string;
        }>(
          tx,
          sql`select stamp::text as now,
            anniversary.period_start::text, anniversary.period_end::text,
            to_char(anniversary.period_start at time zone 'UTC', 'YYYY-MM') as month_key
            from managed_accounts account cross join (select clock_timestamp() as stamp) snapshot
            cross join lateral opengeni_private.subscription_plan_free_anniversary(account.created_at, greatest(account.created_at, stamp)) anniversary
            where account.id = ${accountId}::uuid and account.created_at <= stamp`,
        );
        if (!clock) return { expiredPeriods: 0, enrolledFreeAccounts: 0, grantedFreePeriods: 0 };
        const now = new Date(clock.now);
        const periods = await rawRows<{ id: string; period_end: string }>(
          tx,
          sql`select id, period_end::text from plan_credit_periods where account_id = ${accountId}::uuid and expired_at is null`,
        );
        let expiredPeriods = 0;
        for (const period of periods) {
          if (new Date(period.period_end) > now) continue;
          await expirePlanCreditPeriod(tx, { accountId, periodId: period.id });
          expiredPeriods += 1;
        }
        const unchanged = { expiredPeriods, enrolledFreeAccounts: 0, grantedFreePeriods: 0 };
        // Never replace a live paid/manual allowance, including canceled but
        // not-yet-ended subscriptions. Enterprise is always operator-owned.
        if (periods.some((period) => new Date(period.period_end) > now)) return unchanged;
        const [state] = await rawRows<{
          plan_key: string;
          status: string;
          stripe_subscription_id: string | null;
          current_period_end: string | null;
        }>(
          tx,
          sql`select plan_key, status, stripe_subscription_id, current_period_end::text
          from organization_plans where account_id = ${accountId}::uuid`,
        );
        if (
          state &&
          !(
            (state.plan_key === "free" &&
              ["active", "trialing"].includes(state.status) &&
              state.stripe_subscription_id === null) ||
            (["pro", "max"].includes(state.plan_key) &&
              ["canceled", "unpaid", "incomplete_expired"].includes(state.status) &&
              state.current_period_end !== null &&
              new Date(state.current_period_end) <= now)
          )
        )
          return unchanged;
        const eligible =
          (await freePlanCreditEligible(tx, accountId)) &&
          (await readSubscriptionPlanCatalog(tx)).plans.some(
            (plan) => plan.key === "free" && plan.freeCredit,
          );
        const [receipt] = await rawRows<{ id: string }>(
          tx,
          sql`select id from plan_credit_periods
          where account_id = ${accountId}::uuid and idempotency_key = ${`plan-credit:free:${accountId}:${clock.month_key}`}`,
        );
        const transition = !state || state.plan_key !== "free";
        if (!transition && (!eligible || receipt)) return unchanged;
        // Every organization gets a Free seat-cap row at activation; funding
        // still needs the actual signup receipt. Only the current anniversary
        // interval is issued, never historical intervals or a second receipt.
        const periodStart = new Date(clock.period_start);
        const periodEnd = new Date(clock.period_end);
        await upsertOrganizationPlan(tx, {
          accountId,
          planKey: "free",
          status: "active",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        });
        if (eligible && !receipt)
          await grantPlanCreditPeriod(tx, {
            accountId,
            planKey: "free",
            periodStart,
            periodEnd,
          });
        return {
          expiredPeriods,
          enrolledFreeAccounts: transition ? 1 : 0,
          grantedFreePeriods: eligible && !receipt ? 1 : 0,
        };
      });
      result.expiredPeriods += changed.expiredPeriods;
      result.enrolledFreeAccounts += changed.enrolledFreeAccounts;
      result.grantedFreePeriods += changed.grantedFreePeriods;
    } catch (error) {
      result.failedAccounts += 1;
      input.onError?.(error, accountId);
    }
  }
  return result;
}
