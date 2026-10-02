import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  BillingSummary,
  DefaultModelSelectionSource,
  ReasoningEffort,
  WorkspaceModelCatalogResponse,
} from "@opengeni/sdk";

import {
  confirmIncludedModel,
  includedDefaultModel,
  preferredConnectedModelId,
  type ConnectedModelFamily,
} from "./model-access-onboarding";
import { creditsMarginLabel } from "./model-payment";

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
 * What this deployment offers the new workspace, read from its catalog: the
 * client config's model list is empty before the person has a workspace.
 */
export type ModelStepOffers = {
  codex: boolean;
  supergrok: boolean;
  /** "5%": the markup on the provider's price for credits models. */
  creditsMargin: string | null;
};

export function modelStepOffers(models: WorkspaceModelCatalogResponse["models"]): ModelStepOffers {
  return {
    codex: models.some((model) => model.source === "codex"),
    supergrok: models.some((model) => model.source === "supergrok"),
    creditsMargin: creditsMarginLabel(models),
  };
}

const CONNECTABLE_FAMILIES: readonly ConnectedModelFamily[] = [
  "codex",
  "supergrok",
  "vercel_gateway",
  "openrouter",
];

/** The services already connected here (a person coming back to this step). */
export function connectedModelFamilies(
  models: WorkspaceModelCatalogResponse["models"],
): ConnectedModelFamily[] {
  return CONNECTABLE_FAMILIES.filter(
    (family) => preferredConnectedModelId(models, family) !== null,
  );
}

/**
 * The included default from the live catalog: the resolved default for new
 * chats when it is free, or paid by the deployment on a server that doesn't
 * bill credits.
 */
export function includedModelFromCatalog(
  catalog: Pick<WorkspaceModelCatalogResponse, "models" | "defaultSelection">,
  billingMode: "disabled" | "stripe",
): { id: string; label: string; free: boolean } | null {
  const selection = catalog.defaultSelection;
  if (!selection || selection.source === "subscription" || selection.source === "credits")
    return null;
  const model = catalog.models.find((candidate) => candidate.id === selection.model);
  if (!model?.availability.selectable) return null;
  return includedDefaultModel({ defaultModel: model.id, models: [model], billingMode });
}

/**
 * Load the post-signup model step for the new Personal workspace: confirm the
 * client-config included model against the live catalog (or find it there),
 * say what the deployment offers and what is already connected, and, on a
 * deployment that bills credits, describe any credits the organization
 * already holds. The balance is read only when the resolved default is billed
 * in credits, so a workspace on the free default never probes billing. An
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
  offers: ModelStepOffers | null;
  connected: ConnectedModelFamily[];
}> {
  let catalog: WorkspaceModelCatalogResponse;
  try {
    catalog = await client.getWorkspaceModelCatalog(input.workspaceId);
  } catch {
    return { includedModel: null, startingCredits: null, offers: null, connected: [] };
  }
  const includedModel = input.includedCandidate
    ? confirmIncludedModel(input.includedCandidate, catalog.models)
    : includedModelFromCatalog(catalog, input.billingMode);
  const offers = modelStepOffers(catalog.models);
  const connected = connectedModelFamilies(catalog.models);
  if (input.billingMode !== "stripe" || !creditsBilledDefaultModel(catalog)) {
    return { includedModel, startingCredits: null, offers, connected };
  }
  let billing: BillingSummary | null;
  try {
    billing = await client.getBilling({ accountId: input.organizationId });
  } catch {
    billing = null;
  }
  return {
    includedModel,
    startingCredits: startingCreditsForOnboarding({ catalog, billing }),
    offers,
    connected,
  };
}
