import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ClientModel, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import {
  defaultEffortForModel,
  projectPickerRows,
  sortPickerRows,
  type PickerModelRow,
} from "@opengeni/react";

const CONNECTED_BILLING_CLASSES = new Set([
  "codex_subscription",
  "supergrok_subscription",
  "byok",
  "organization_byok",
  "external",
]);

/**
 * The service a person just connected (or paid for) during onboarding. The
 * next chat should use that service, never an unrelated free model that the
 * generic picker order happens to rank first.
 */
export type ConnectedModelFamily =
  | "codex"
  | "supergrok"
  | "vercel_gateway"
  | "openrouter"
  | "credits";

function rowMatchesFamily(row: PickerModelRow, family: ConnectedModelFamily): boolean {
  switch (family) {
    case "codex":
      return row.billingClass === "codex_subscription";
    case "supergrok":
      return row.billingClass === "supergrok_subscription";
    case "vercel_gateway":
      return (
        (row.billingClass === "byok" || row.billingClass === "organization_byok") &&
        (row.catalog.source === "workspace_gateway" ||
          row.provider === "workspace-gateway" ||
          row.provider === "organization-gateway")
      );
    case "openrouter":
      return (
        (row.billingClass === "byok" || row.billingClass === "organization_byok") &&
        (row.provider === "workspace-openrouter" || row.provider === "organization-openrouter")
      );
    case "credits":
      return row.catalog.cost === "credits";
  }
}

/**
 * Model to preselect after a subscription/provider connect or credit purchase.
 *
 * With a `family`, only that family's selectable models qualify, in the
 * operator-configured catalog order; `null` means the connection is not usable
 * yet (the caller offers a retry instead of silently picking something else).
 * Without a family, a selectable connected service wins over the free
 * deployment model, and OpenGeni-credit models are never chosen implicitly.
 */
export function preferredConnectedModelId(
  models: readonly WorkspaceModelCatalogModel[],
  family?: ConnectedModelFamily,
): string | null {
  const rows = projectPickerRows([...models]).filter((row) => row.selectable);
  if (family) return rows.find((row) => rowMatchesFamily(row, family))?.id ?? null;
  const sorted = sortPickerRows(rows);
  return (
    sorted.find((row) => CONNECTED_BILLING_CLASSES.has(row.billingClass))?.id ??
    sorted.find((row) => row.catalog.cost === "free")?.id ??
    null
  );
}

export function isPaymentRequiredError(error: unknown): error is OpenGeniApiError {
  return (
    error instanceof OpenGeniApiError && error.status === 402 && error.code === "payment_required"
  );
}

/** Select the connected model in the actor-private draft without workspace administration. */
export async function applyConnectedModelToNewSessionDraft(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  family?: ConnectedModelFamily,
): Promise<{ id: string; label: string } | null> {
  const catalog = await client.getWorkspaceModelCatalog(workspaceId);
  const modelId = preferredConnectedModelId(catalog.models, family);
  if (!modelId) return null;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  const draft = await client.getNewSessionDraft(workspaceId);
  await client.saveNewSessionDraft(workspaceId, {
    text: draft.text,
    resources: draft.resources,
    tools: draft.tools,
    toolsProvided: draft.toolsProvided,
    model: modelId,
    reasoningEffort: model ? defaultEffortForModel(model) : "low",
    latencyMode: draft.latencyMode,
    ...(draft.selectedProjectChannelId !== undefined
      ? { selectedProjectChannelId: draft.selectedProjectChannelId }
      : {}),
    options: draft.options,
    expectedRevision: draft.revision,
  });
  return { id: modelId, label: model?.label ?? modelId };
}

/**
 * The deployment default model a new person can use without connecting
 * anything: an explicitly free model, or (when this deployment does not bill
 * for credits) a model the deployment itself pays for. Read from client
 * config; never assume a particular model id.
 */
export function includedDefaultModel(config: {
  defaultModel: string;
  models: readonly ClientModel[];
  billingMode?: "disabled" | "stripe" | undefined;
}): { id: string; label: string; free: boolean } | null {
  const model = config.models.find((candidate) => candidate.id === config.defaultModel);
  if (!model) return null;
  if (model.cost === "free") return { id: model.id, label: model.label, free: true };
  if (
    (config.billingMode ?? "disabled") !== "stripe" &&
    (model.cost === undefined || model.cost === "credits") &&
    (model.billing === undefined || model.billing.upstreamPayer === "deployment")
  ) {
    return { id: model.id, label: model.label, free: false };
  }
  return null;
}

/**
 * Stripe success return for an onboarding credit purchase. It reuses the
 * sessions composer launch contract (`?model=&effort=`), so the next chat uses
 * the purchased credits instead of the free default model.
 */
export function creditCheckoutSuccessUrl(
  origin: string,
  workspaceId: string,
  model: { id: string; effort: string } | null,
): string {
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, origin);
  if (model) {
    url.searchParams.set("model", model.id);
    url.searchParams.set("effort", model.effort);
  }
  return url.toString();
}

/** Resolve the credits model for a checkout return; a catalog failure never blocks checkout. */
export async function creditsModelForCheckout(
  client: OpenGeniBrowserClient,
  workspaceId: string,
): Promise<{ id: string; effort: string } | null> {
  try {
    const catalog = await client.getWorkspaceModelCatalog(workspaceId);
    const modelId = preferredConnectedModelId(catalog.models, "credits");
    const model = modelId ? catalog.models.find((candidate) => candidate.id === modelId) : null;
    return model ? { id: model.id, effort: defaultEffortForModel(model) } : null;
  } catch {
    return null;
  }
}
