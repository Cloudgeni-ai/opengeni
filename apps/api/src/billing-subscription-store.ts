import type { BillingPlanBalance, SubscriptionPlan } from "@opengeni/contracts";
import {
  assertBillingSubscriptionOperationRoot,
  beginBillingSubscriptionOperation,
  completeBillingSubscriptionOperation,
  getBillingSubscriptionOperation,
  nestedPostgresSqlState,
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
  type BillingSubscriptionOperation,
  type BillingSubscriptionOperationKind,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { organizationPlans, planCreditPeriods } from "@opengeni/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export type StoredSubscriptionPlan = {
  plan_key: string;
  stripe_subscription_id: string | null;
};

export interface SubscriptionAccountStore {
  operation(key: string): Promise<BillingSubscriptionOperation | null>;
  beginOperation(input: {
    operationKey: string;
    kind: BillingSubscriptionOperationKind;
    request: Record<string, unknown>;
    intent: Record<string, unknown>;
  }): Promise<BillingSubscriptionOperation>;
  completeOperation(key: string, result: Record<string, unknown>): Promise<void>;
  exists(): Promise<boolean>;
  state(): Promise<StoredSubscriptionPlan | null>;
  customer(provider: string): Promise<string | null>;
  balance(): Promise<BillingPlanBalance | null>;
  save(input: Omit<OrganizationPlanStateInput, "accountId">): Promise<void>;
  replace(input: Omit<PlanCreditPeriodInput, "accountId">): Promise<void>;
  expire(subscriptionId: string): Promise<void>;
}

export interface SubscriptionStore {
  catalog(): Promise<{ revision: number; plans: SubscriptionPlan[] }>;
  locked<T>(accountId: string, run: (store: SubscriptionAccountStore) => Promise<T>): Promise<T>;
}

/** Reuse the SQL seams in one outer transaction, membership/org fence before
 * the credit-account lock. Stripe reads also run under this fence: concurrent
 * deliveries cannot commit an older provider snapshot after a newer one. */
export function subscriptionStore(db: Database): SubscriptionStore {
  assertBillingSubscriptionOperationRoot(db);
  return {
    catalog: () => readSubscriptionPlanCatalog(db),
    locked: (accountId, run) =>
      withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
        );
        return await run({
          operation: (key) => getBillingSubscriptionOperation(tx, accountId, key),
          beginOperation: async (input) => {
            try {
              return await beginBillingSubscriptionOperation(tx, { ...input, accountId });
            } catch (error) {
              if (nestedPostgresSqlState(error) === "P0S02")
                throw new HTTPException(409, {
                  message: "Retry the pending subscription operation before starting another",
                });
              throw error;
            }
          },
          completeOperation: async (operationKey, result) => {
            await completeBillingSubscriptionOperation(tx, { accountId, operationKey, result });
          },
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
          expire: async (subscriptionId) => {
            const periods = await tx
              .select({ id: planCreditPeriods.id })
              .from(planCreditPeriods)
              .where(
                and(
                  eq(planCreditPeriods.accountId, accountId),
                  eq(planCreditPeriods.stripeSubscriptionId, subscriptionId),
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
