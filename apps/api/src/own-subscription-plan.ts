import type { Settings } from "@opengeni/config";
import {
  ownSubscriptionUpgradePlan,
  type OwnSubscriptionPlanV1,
  type WorkspaceModelCatalogResponse,
} from "@opengeni/contracts";
import {
  ownModelFunding,
  ownSubscriptionPlanRequired,
  planAllowsOwnSubscriptions,
  type WorkspaceModelSelection,
} from "@opengeni/core";
import {
  getOrganizationPlanStanding,
  readSubscriptionPlanCatalog,
  type Database,
} from "@opengeni/db";
import { selfServicePlan } from "./billing-subscriptions";

/**
 * The plan this organization needs before its own subscriptions (Codex,
 * Claude, SuperGrok) run: the cheapest self-service catalog plan that
 * includes them, with its catalog name and price. Null when they already run
 * (a plan that includes them, legacy terms, or no paid plans on this
 * deployment) or when the catalog sells no such plan. The same plan reads as
 * admission (`ownSubscriptionPlanAllows`), so the hint and the refusal agree.
 */
export async function ownSubscriptionPlanNeeded(
  db: Database,
  settings: Pick<Settings, "billingMode" | "subscriptionPlansEnabled" | "billingLegacyAccountIds">,
  accountId: string,
): Promise<OwnSubscriptionPlanV1 | null> {
  if (!ownSubscriptionPlanRequired(settings, accountId)) return null;
  if (planAllowsOwnSubscriptions(await getOrganizationPlanStanding(db, accountId))) return null;
  const { plans } = await readSubscriptionPlanCatalog(db);
  const plan = ownSubscriptionUpgradePlan(
    plans.map((entry) => ({ ...entry, selfService: selfServicePlan(entry) })),
  );
  return plan
    ? { key: plan.key, label: plan.label, monthlyPriceMicros: plan.monthlyPriceMicros }
    : null;
}

/**
 * Marks the catalog for an organization whose plan doesn't include its own
 * subscriptions: the plan it needs, once for the page (connect steps say it
 * before anything is connected) and on each own-subscription model (pickers
 * say it on the row). The models stay selectable; Send is refused with the
 * one Upgrade action until the plan changes.
 */
export function withOwnSubscriptionPlan(
  catalog: WorkspaceModelCatalogResponse,
  selections: readonly Pick<WorkspaceModelSelection, "model">[],
  plan: OwnSubscriptionPlanV1 | null,
): WorkspaceModelCatalogResponse {
  if (!plan) return catalog;
  const ownSubscriptionModels = new Set(
    selections
      .filter((selection) => ownModelFunding(selection.model) === "subscription")
      .map((selection) => selection.model.id),
  );
  return {
    ...catalog,
    ownSubscriptionPlan: plan,
    models: catalog.models.map((model) =>
      ownSubscriptionModels.has(model.id) ? { ...model, requiredPlan: plan } : model,
    ),
  };
}
