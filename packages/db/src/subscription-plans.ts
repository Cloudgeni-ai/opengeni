import { SubscriptionPlanCatalog, type BillingPlanBalance } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, type Database } from "./database";

/** No cache: changes made with `bun run plans:catalog` are effective immediately. */
export async function readSubscriptionPlanCatalog(db: Database) {
  const [row] = await rawRows<{ revision: string; catalog: unknown }>(
    db,
    sql`select revision, catalog from opengeni_private.subscription_plan_catalog_revisions order by revision desc limit 1`,
  );
  if (!row) throw new Error("Subscription plan catalog is missing");
  return { revision: Number(row.revision), plans: SubscriptionPlanCatalog.parse(row.catalog) };
}

export type OrganizationPlanStateInput = {
  accountId: string;
  planKey: string;
  status:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused"
    | "incomplete"
    | "incomplete_expired";
  stripeSubscriptionId?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
};

export async function upsertOrganizationPlan(db: Database, input: OrganizationPlanStateInput) {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{ state: Record<string, unknown> }>(
      tx,
      sql`
      select upsert_organization_plan(${input.accountId}::uuid, ${input.planKey}, ${input.status},
        ${input.stripeSubscriptionId ?? null}, ${input.currentPeriodStart?.toISOString() ?? null}::timestamptz,
        ${input.currentPeriodEnd?.toISOString() ?? null}::timestamptz, ${input.cancelAtPeriodEnd ?? false}) as state`,
    );
    return row!.state;
  });
}

/** SQL receipt field names intentionally match the persisted periods table. */
export type PlanCreditPeriod = {
  id: string;
  account_id: string;
  plan_key: string;
  catalog_revision: number;
  stripe_subscription_id: string | null;
  period_start: string;
  period_end: string;
  granted_micros: number;
  opening_debt_micros: number;
  grant_entry_id: string;
  idempotency_key: string;
  granted_at: string;
  expired_at: string | null;
  expiry_entry_id: string | null;
  usage_at_expiry_micros: number | null;
};
export type PlanCreditPeriodInput = {
  accountId: string;
  planKey: string;
  periodStart: Date;
  periodEnd: Date;
  stripeSubscriptionId?: string | null;
};

async function writePeriod(db: Database, input: PlanCreditPeriodInput, replace: boolean) {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const routine = replace ? sql`replace_plan_credit_period` : sql`grant_plan_credit_period`;
    const [row] = await rawRows<{ period: PlanCreditPeriod }>(
      tx,
      sql`
      select ${routine}(${input.accountId}::uuid, ${input.planKey}, ${input.periodStart.toISOString()}::timestamptz,
        ${input.periodEnd.toISOString()}::timestamptz, ${input.stripeSubscriptionId ?? null}) as period`,
    );
    return row!.period;
  });
}

/** One receipt per subscription/start/plan (Free: account/UTC month); changed terms fail. */
export const grantPlanCreditPeriod = (db: Database, input: PlanCreditPeriodInput) =>
  writePeriod(db, input, false);
/** Atomically expire the old allowance and grant a full new one. Replays never expire the new period. */
export const replacePlanCreditPeriod = (db: Database, input: PlanCreditPeriodInput) =>
  writePeriod(db, input, true);

export async function expirePlanCreditPeriod(
  db: Database,
  input: { accountId: string; periodId: string; force?: boolean },
) {
  return await withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<{ period: PlanCreditPeriod }>(
      tx,
      sql`select expire_plan_credit_period(${input.accountId}::uuid, ${input.periodId}::uuid, ${input.force ?? false}) as period`,
    );
    return row!.period;
  });
}

/** Called under the existing account lock before any new ledger settlement. */
export async function expireEndedPlanCreditPeriods(
  db: Database,
  accountId: string,
): Promise<number> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ expired: number }>(
      tx,
      sql`select expire_ended_plan_credit_periods(${accountId}::uuid) as expired`,
    );
    return row!.expired;
  });
}

/** One post-lock cutoff for expiry, allocation and the resulting ledger entry. */
export async function beginPlanCreditSettlement(db: Database, accountId: string): Promise<string> {
  const [row] = await rawRows<{ settledAt: string }>(
    db,
    sql`select begin_plan_credit_settlement(${accountId}::uuid)::text as "settledAt"`,
  );
  return row!.settledAt;
}

export async function freePlanCreditEligible(db: Database, accountId: string): Promise<boolean> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ eligible: boolean }>(
      tx,
      sql`select free_plan_credit_eligible(${accountId}::uuid) as eligible`,
    );
    return row!.eligible;
  });
}

export async function getOrganizationPlanBalance(
  db: Database,
  accountId: string,
): Promise<BillingPlanBalance | null> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ plan: BillingPlanBalance | null }>(
      tx,
      sql`select read_organization_plan_balance(${accountId}::uuid) as plan`,
    );
    return row!.plan;
  });
}
