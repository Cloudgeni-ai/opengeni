import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  ClientModel,
  DefaultModelSelection,
  ReasoningEffort,
  WorkspaceModelCatalogModel,
  WorkspaceModelCatalogResponse,
} from "@opengeni/sdk";
import {
  defaultEffortForModel,
  findPickerRow,
  projectPickerRows,
  sortPickerRows,
  type PickerModelRow,
} from "@opengeni/react";

/**
 * Services a person or their workspace connected. Organization-paid providers
 * (`organization_byok`) are deliberately absent: an implicit fallback never
 * moves someone onto organization spend ahead of the free deployment model.
 */
const CONNECTED_BILLING_CLASSES = new Set([
  "codex_subscription",
  "supergrok_subscription",
  "byok",
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
 * Without a family (the new-chat composer fallback when both the selected
 * model and the server-resolved default are unavailable), a selectable Codex,
 * SuperGrok, or workspace provider wins over the free deployment model; an
 * organization-paid provider ranks after the free model, and OpenGeni-credit
 * models are never chosen implicitly here. The resolved default is what moves
 * a workspace with credits onto the credits model.
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
    sorted.find((row) => row.billingClass === "organization_byok")?.id ??
    null
  );
}

/**
 * Replacement when the composer's model is no longer selectable. The
 * server-resolved default (saved workspace default, connected subscription,
 * credits model while the organization has credits, deployment default) wins
 * when it is selectable; otherwise the client ranking above applies.
 */
export function composerFallbackModel(input: {
  models: readonly WorkspaceModelCatalogModel[];
  rows: readonly PickerModelRow[];
  defaultSelection: DefaultModelSelection | null;
}): { id: string; effort: ReasoningEffort } | null {
  const resolved = input.defaultSelection;
  if (resolved) {
    const row = findPickerRow([...input.rows], resolved.model);
    if (row?.selectable) return { id: row.id, effort: resolved.reasoningEffort };
  }
  const id =
    preferredConnectedModelId(input.models) ?? input.rows.find((row) => row.selectable)?.id ?? null;
  if (!id) return null;
  const model = input.models.find((candidate) => candidate.id === id);
  return { id, effort: model ? defaultEffortForModel(model) : "low" };
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
    // Connecting a service is a deliberate choice of that service's model.
    modelProvided: true,
    ...(draft.selectedProjectChannelId !== undefined
      ? { selectedProjectChannelId: draft.selectedProjectChannelId }
      : {}),
    options: draft.options,
    expectedRevision: draft.revision,
  });
  return { id: modelId, label: model?.label ?? modelId };
}

/**
 * Stripe success return for an onboarding credit purchase. It reuses the
 * sessions composer launch contract (`?model=&effort=`), so the next chat uses
 * the purchased credits instead of the free default model even before the
 * payment webhook lands. `modelSource=default` marks that policy as the
 * resolved default rather than the person's choice, so the draft keeps
 * following the default and a later subscription connect still replaces it.
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
    url.searchParams.set("modelSource", "default");
  }
  return url.toString();
}

/** Resolve the credits model for a checkout return; a catalog failure never blocks checkout. */
export async function creditsModelForCheckout(
  client: OpenGeniBrowserClient,
  workspaceId: string,
): Promise<{ id: string; effort: string } | null> {
  try {
    return creditsCheckoutModel(await client.getWorkspaceModelCatalog(workspaceId));
  } catch {
    return null;
  }
}

/**
 * The model a credit purchase should land on: the server's credits default
 * (the configured credits model at its configured reasoning, for example GPT-6
 * Luna at extra high). Null when a connected subscription or saved workspace
 * default would still win after the purchase, so the composer keeps that
 * default instead. Older servers publish no resolved default; the first
 * selectable credits model is used there.
 */
export function creditsCheckoutModel(
  catalog: Pick<WorkspaceModelCatalogResponse, "models" | "creditsSelection">,
): { id: string; effort: string } | null {
  if (catalog.creditsSelection !== undefined) {
    const selection = catalog.creditsSelection;
    return selection?.source === "credits"
      ? { id: selection.model, effort: selection.reasoningEffort }
      : null;
  }
  const modelId = preferredConnectedModelId(catalog.models, "credits");
  const model = modelId ? catalog.models.find((candidate) => candidate.id === modelId) : null;
  return model ? { id: model.id, effort: defaultEffortForModel(model) } : null;
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
 * Confirm a client-config included model against the new workspace's live
 * catalog. Client config carries no credential-readiness or workspace-policy
 * signal, so the included path is offered only when the Personal workspace can
 * actually select that model (and, for a free claim, the catalog agrees it is
 * free). Otherwise the caller shows the ordinary connect/credits choice.
 */
export function confirmIncludedModel<T extends { id: string; label: string; free: boolean }>(
  candidate: T,
  models: readonly WorkspaceModelCatalogModel[],
): T | null {
  const model = models.find((row) => row.id === candidate.id);
  if (!model?.availability.selectable) return null;
  if (candidate.free && model.cost !== "free") return null;
  return candidate;
}
