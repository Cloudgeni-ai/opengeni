import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  BillingSummary,
  DefaultModelSelectionSource,
  ReasoningEffort,
  WorkspaceModelCatalogResponse,
} from "@opengeni/sdk";

import { confirmIncludedModel } from "./model-access-onboarding";

// Onboarding-only helpers, kept apart from `model-access-onboarding.ts` because
// the session route imports that module and these must stay out of its graph.

/**
 * OpenGeni credits the organization already holds when the post-signup model
 * step opens (the one-time verified-signup trial grant, or any other credits).
 */
export type StartingCreditsOnboarding = {
  /** The positive balance, or null when it could not be read. */
  balance: { balanceMicros: number; currency: string } | null;
  /** The server-resolved default new chats use, billed in OpenGeni credits. */
  model: { id: string; label: string; reasoningEffort: ReasoningEffort };
};

/**
 * The server-resolved default for new chats (`defaultSelection`) when it is a
 * selectable model billed in OpenGeni credits. Null on older servers that
 * publish no resolved default, and whenever a subscription, saved workspace
 * default, or free model is what new chats use.
 */
export function creditsBilledDefaultModel(
  catalog: Pick<WorkspaceModelCatalogResponse, "models" | "defaultSelection">,
): (StartingCreditsOnboarding["model"] & { source: DefaultModelSelectionSource }) | null {
  const selection = catalog.defaultSelection;
  if (!selection) return null;
  const model = catalog.models.find((candidate) => candidate.id === selection.model);
  if (!model?.availability.selectable || model.cost !== "credits") return null;
  return {
    id: model.id,
    label: model.label,
    reasoningEffort: selection.reasoningEffort,
    source: selection.source,
  };
}

/**
 * What the post-signup model step says about credits the organization already
 * holds. It applies only while the resolved default is billed in OpenGeni
 * credits and the balance is positive, so the step describes the model new
 * chats actually use. When the balance cannot be read, a resolved default
 * whose source is `credits` (the server reports it only while the balance is
 * positive) still qualifies, without an amount.
 */
export function startingCreditsForOnboarding(input: {
  catalog: Pick<WorkspaceModelCatalogResponse, "models" | "defaultSelection">;
  billing: Pick<BillingSummary, "mode" | "balance"> | null;
}): StartingCreditsOnboarding | null {
  const resolved = creditsBilledDefaultModel(input.catalog);
  if (!resolved) return null;
  const model = {
    id: resolved.id,
    label: resolved.label,
    reasoningEffort: resolved.reasoningEffort,
  };
  if (!input.billing) return resolved.source === "credits" ? { balance: null, model } : null;
  const { mode, balance } = input.billing;
  if (mode !== "stripe" || balance.balanceMicros <= 0) return null;
  return {
    balance: { balanceMicros: balance.balanceMicros, currency: balance.currency },
    model,
  };
}

/**
 * Load the post-signup model step for the new Personal workspace: confirm the
 * client-config included model against the live catalog, and, on a
 * deployment that bills credits, describe any credits the organization already
 * holds. The balance is read only when the resolved default is billed in
 * credits, so a workspace on the free default never probes billing. An
 * unreadable catalog confirms nothing, and the caller shows the ordinary
 * choice screen.
 */
export async function loadModelAccessOnboarding(
  client: Pick<OpenGeniBrowserClient, "getWorkspaceModelCatalog" | "getBilling">,
  input: {
    organizationId: string;
    workspaceId: string;
    billingMode: "disabled" | "stripe";
    includedCandidate: { id: string; label: string; free: boolean } | null;
  },
): Promise<{
  includedModel: { id: string; label: string; free: boolean } | null;
  startingCredits: StartingCreditsOnboarding | null;
}> {
  let catalog: WorkspaceModelCatalogResponse;
  try {
    catalog = await client.getWorkspaceModelCatalog(input.workspaceId);
  } catch {
    return { includedModel: null, startingCredits: null };
  }
  const includedModel = input.includedCandidate
    ? confirmIncludedModel(input.includedCandidate, catalog.models)
    : null;
  if (input.billingMode !== "stripe" || !creditsBilledDefaultModel(catalog)) {
    return { includedModel, startingCredits: null };
  }
  let billing: BillingSummary | null;
  try {
    billing = await client.getBilling({ accountId: input.organizationId });
  } catch {
    billing = null;
  }
  return { includedModel, startingCredits: startingCreditsForOnboarding({ catalog, billing }) };
}
