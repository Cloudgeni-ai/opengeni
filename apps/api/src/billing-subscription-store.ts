import type { BillingPlanBalance, SubscriptionPlan } from "@opengeni/contracts";
import {
  expirePlanCreditPeriod,
  getBillingCustomer,
  getManagedAccount,
  getOrganizationPlanBalance,
  readSubscriptionPlanCatalog,
  replacePlanCreditPeriod,
  upsertOrganizationPlan,
  withRlsContext,
  type Database,
  type OrganizationPlanStateInput,
  type PlanCreditPeriodInput,
} from "@opengeni/db";
import { organizationPlans, planCreditPeriods } from "@opengeni/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export type StoredSubscriptionPlan = {
  plan_key: string;
  stripe_subscription_id: string | null;
};

export interface SubscriptionAccountStore {
  exists(): Promise<boolean>;
  state(): Promise<StoredSubscriptionPlan | null>;
  customer(provider: string): Promise<string | null>;
  balance(): Promise<BillingPlanBalance | null>;
  save(input: Omit<OrganizationPlanStateInput, "accountId">): Promise<void>;
  replace(input: Omit<PlanCreditPeriodInput, "accountId">): Promise<void>;
  expire(): Promise<void>;
}

export interface SubscriptionStore {
  catalog(): Promise<{ revision: number; plans: SubscriptionPlan[] }>;
  locked<T>(accountId: string, run: (store: SubscriptionAccountStore) => Promise<T>): Promise<T>;
}

/** Reuse the SQL seams in one outer transaction, membership/org fence before
 * the credit-account lock. Stripe reads also run under this fence: concurrent
 * deliveries cannot commit an older provider snapshot after a newer one. */
export function subscriptionStore(db: Database): SubscriptionStore {
  return {
    catalog: () => readSubscriptionPlanCatalog(db),
    locked: (accountId, run) =>
      withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
        );
        return await run({
          exists: async () => Boolean(await getManagedAccount(tx, accountId)),
          state: async () => {
            const [row] = await tx
              .select({
                plan_key: organizationPlans.planKey,
                stripe_subscription_id: organizationPlans.stripeSubscriptionId,
              })
              .from(organizationPlans)
              .where(eq(organizationPlans.accountId, accountId))
              .limit(1);
            return row ?? null;
          },
          customer: async (provider) =>
            (await getBillingCustomer(tx, accountId, provider))?.providerCustomerId ?? null,
          balance: () => getOrganizationPlanBalance(tx, accountId),
          save: async (input) => {
            await upsertOrganizationPlan(tx, { ...input, accountId });
          },
          replace: async (input) => {
            await replacePlanCreditPeriod(tx, { ...input, accountId });
          },
          expire: async () => {
            const periods = await tx
              .select({ id: planCreditPeriods.id })
              .from(planCreditPeriods)
              .where(
                and(
                  eq(planCreditPeriods.accountId, accountId),
                  isNull(planCreditPeriods.expiredAt),
                ),
              );
            for (const period of periods) {
              await expirePlanCreditPeriod(tx, { accountId, periodId: period.id, force: true });
            }
          },
        });
      }),
  };
}
