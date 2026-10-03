import {
  compareModelPickerOrder,
  modelPickerBillingClassFor,
  type ModelPickerBillingClass,
} from "@opengeni/sdk/model-picker-order";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { ClientModel, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";

export type PickerBillingClass = ModelPickerBillingClass;

export type PickerModelRow<TCatalog extends ClientModel = WorkspaceModelCatalogModel> = {
  id: string;
  label: string;
  /** Catalog-curated compact label for dense UI; fall back to `label` when absent. */
  shortLabel?: string | undefined;
  billingClass: PickerBillingClass;
  billingClassLabel: string;
  selectable: boolean;
  unavailableReason: string | null;
  provider: string;
  providerLabel: string;
  catalog: TCatalog;
};

export type LatencyModeId = "standard" | "priority" | "fast";

const BILLING_CLASS_LABELS: Record<PickerBillingClass, string> = {
  opengeni_credits: "Models",
  external: "External",
  codex_subscription: "Codex",
  supergrok_subscription: "SuperGrok",
  claude_subscription: "Claude subscription",
  // Who connected the key (organization or workspace) is a settings fact, not
  // a model choice: both scopes share one label and one picker group.
  byok: "API keys",
  organization_byok: "API keys",
};

/** Models settings keeps naming who connected the key. */
const SCOPED_BILLING_CLASS_LABELS: Record<PickerBillingClass, string> = {
  ...BILLING_CLASS_LABELS,
  byok: "Workspace providers",
  organization_byok: "Organization providers",
};

const AVAILABILITY_REASON_LABELS: Record<string, string> = {
  missing_credential: "Credentials required",
  needs_reauth: "Reconnect required",
  credential_not_ready: "Credential not ready",
  not_entitled: "Not entitled",
  provider_unhealthy: "Provider unavailable",
  policy_blocked: "Blocked by workspace policy",
  unsupported: "Unsupported",
};

export function billingClassForModel(model: ClientModel): PickerBillingClass {
  if (model.provider === "organization-gateway" || model.provider === "organization-openrouter") {
    return "organization_byok";
  }
  if (
    model.provider?.startsWith("workspace-openai-") ||
    model.provider?.startsWith("workspace-azure-openai-")
  )
    return "byok";
  if (model.provider === "workspace-gateway" || model.provider === "workspace-openrouter") {
    return "byok";
  }
  return modelPickerBillingClassFor(model);
}

export function billingClassLabel(billingClass: PickerBillingClass): string {
  return BILLING_CLASS_LABELS[billingClass];
}

/** The group label that names the connection scope, for Models settings only. */
export function scopedBillingClassLabel(billingClass: PickerBillingClass): string {
  return SCOPED_BILLING_CLASS_LABELS[billingClass];
}

export function availabilityReasonLabel(
  reason: WorkspaceModelCatalogModel["availability"]["reason"],
): string | null {
  if (!reason) {
    return null;
  }
  return AVAILABILITY_REASON_LABELS[reason] ?? "Unavailable";
}

export function effortOptionsForModel(model: ClientModel): ReasoningEffort[] {
  const efforts = model.capabilities?.reasoning.efforts;
  if (!efforts || efforts.length === 0) {
    return ["low"];
  }
  const order: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return order.filter((effort) => efforts.includes(effort));
}

export function defaultEffortForModel(model: ClientModel): ReasoningEffort {
  const options = effortOptionsForModel(model);
  const configured = model.capabilities?.reasoning.defaultEffort;
  if (configured && options.includes(configured)) {
    return configured;
  }
  return options[0] ?? "low";
}

export function coerceReasoningEffortForModel(
  model: ClientModel,
  effort: ReasoningEffort,
): ReasoningEffort {
  const options = effortOptionsForModel(model);
  if (options.includes(effort)) {
    return effort;
  }
  return defaultEffortForModel(model);
}

/** Whether the composer offers (and therefore labels) a reasoning-effort choice. */
export function modelOffersEffortChoice(model: ClientModel): boolean {
  return (
    effortOptionsForModel(model).length > 1 && model.capabilities?.reasoning.runnable !== false
  );
}

/**
 * The composer model pill at phone width: the catalog's compact name (falling
 * back to the display name) and the effort label when effort is a choice.
 */
export function compactModelPill(
  models: readonly ClientModel[],
  modelId: string,
  effort: ReasoningEffort | null | undefined,
): { name: string; effort: string | null } {
  const row = findPickerRow(projectClientModelRows([...models]), modelId);
  return {
    name: row?.shortLabel ?? row?.label ?? modelDisplayName(modelId),
    effort:
      row && effort && modelOffersEffortChoice(row.catalog) ? labelReasoningEffort(effort) : null,
  };
}

export function runnableLatencyModesForModel(model: ClientModel): LatencyModeId[] {
  const modes = model.capabilities?.latencyModes ?? [];
  return modes.filter((mode) => mode.runnable).map((mode) => mode.id);
}

export function labelLatencyMode(mode: LatencyModeId): string {
  if (mode === "fast") {
    return "Fast";
  }
  if (mode === "priority") {
    return "Priority";
  }
  return "Standard";
}

export function labelReasoningEffort(effort: ReasoningEffort): string {
  if (effort === "xhigh") {
    return "Extra high";
  }
  return effort.slice(0, 1).toUpperCase() + effort.slice(1);
}

/** Payment prompts must use cost policy, never the presentation group. */
export function modelUsesCredits(model: ClientModel | undefined): boolean {
  if (model?.cost !== undefined) return model.cost === "credits";
  return model?.billing?.metering === "opengeni_credits";
}

export function payerSummaryForModel(model: ClientModel): string {
  if (model.cost === "free") {
    return "Free in this deployment";
  }
  if (model.cost === "credits") {
    return "Opengeni credits";
  }
  if (model.cost === "subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "claude"
      ? "Claude subscription · external billing"
      : model.source === "supergrok"
        ? "SuperGrok subscription · external billing"
        : "Codex subscription · external billing";
  }
  if (model.cost === "workspace") {
    return workspaceProviderPayerSummary(model);
  }
  if (model.cost === "organization") {
    return organizationProviderPayerSummary(model);
  }

  // Older client-config payloads do not carry `cost`; preserve their existing
  // settlement-derived label until every deployment has rolled forward.
  const billing = model.billing;
  if (!billing) {
    return "Route unknown";
  }
  if (billing.metering === "opengeni_credits") {
    return "Opengeni credits · automatic managed route";
  }
  if (billing.upstreamPayer === "connected_subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "claude"
      ? "Claude subscription · external billing"
      : model.source === "supergrok"
        ? "SuperGrok subscription · external billing"
        : "Codex subscription · external billing";
  }
  if (billing.upstreamPayer === "workspace") {
    return workspaceProviderPayerSummary(model);
  }
  if (billing.upstreamPayer === "organization") {
    return organizationProviderPayerSummary(model);
  }
  return billing.upstreamPayer === "deployment"
    ? "Opengeni · no model credits"
    : "External provider · no Opengeni credits";
}

export function advancedSourceSummary(model: ClientModel): string | null {
  const source = model.credentialSource;
  if (!source) {
    return model.billing?.metering === "external" && model.billing.upstreamPayer === "deployment"
      ? "Deployment-provided connection"
      : null;
  }
  if (source.kind === "connected_subscription") {
    return source.provider === "claude"
      ? "Connected Claude subscription"
      : source.provider === "xai"
        ? "Connected SuperGrok subscription"
        : "Connected Codex subscription";
  }
  if (source.kind === "workspace_connection") {
    if (model.provider === "workspace-openrouter") {
      return "Workspace OpenRouter connection";
    }
    if (model.provider === "workspace-gateway" || model.source === "workspace_gateway") {
      return "Workspace Vercel AI Gateway";
    }
    return "Workspace provider connection";
  }
  if (source.kind === "deployment") {
    return source.mechanism === "azure_ad_bearer"
      ? "Deployment Azure identity"
      : "Deployment API key";
  }
  return null;
}

function workspaceProviderPayerSummary(model: ClientModel): string {
  if (model.provider === "workspace-anthropic")
    return "Billed to the workspace Anthropic API account";
  if (model.provider === "workspace-claude-subscription")
    return "Uses the workspace Claude subscription · no OpenGeni credits";
  if (model.provider === "workspace-openrouter") {
    return "Billed to the workspace OpenRouter account";
  }
  if (model.provider === "workspace-gateway" || model.source === "workspace_gateway") {
    return "Billed to the workspace Vercel account";
  }
  return "Billed to the workspace provider account";
}

function organizationProviderPayerSummary(model: ClientModel): string {
  if (model.provider === "organization-anthropic")
    return "Billed to the organization Anthropic API account";
  if (model.provider === "organization-claude-subscription")
    return "Uses the connected Claude subscription · no OpenGeni credits";
  if (model.provider === "organization-openrouter") {
    return "Billed to the organization OpenRouter account";
  }
  if (model.provider === "organization-gateway") {
    return "Billed to the organization Vercel account";
  }
  return "Billed to the organization provider account";
}

/**
 * The curated compact label, else the family-free name for Claude models
 * ("Opus 5.5"): the maker's mark beside it already says Claude.
 */
function compactLabel(catalog: ClientModel): { shortLabel?: string } {
  if (catalog.shortLabel) return { shortLabel: catalog.shortLabel };
  const name = modelDisplayName(catalog);
  return name.startsWith("Claude ") ? { shortLabel: name.slice("Claude ".length) } : {};
}

export function projectPickerRows(models: WorkspaceModelCatalogModel[]): PickerModelRow[] {
  return models
    .filter((catalog) => catalog.credentialReadiness.status === "ready")
    .map((catalog) => {
      const billingClass = billingClassForModel(catalog);
      return {
        id: catalog.id,
        label: modelDisplayName(catalog),
        ...compactLabel(catalog),
        billingClass,
        billingClassLabel: billingClassLabel(billingClass),
        selectable: catalog.availability.selectable,
        unavailableReason: catalog.availability.selectable
          ? null
          : availabilityReasonLabel(catalog.availability.reason),
        provider: catalog.provider,
        providerLabel: catalog.providerLabel,
        catalog,
      };
    });
}

/** Project the lightweight client-config model list into the same picker contract. */
export function projectClientModelRows(models: ClientModel[]): PickerModelRow<ClientModel>[] {
  return models.map((catalog) => {
    const billingClass = billingClassForModel(catalog);
    return {
      id: catalog.id,
      label: modelDisplayName(catalog),
      ...compactLabel(catalog),
      billingClass,
      billingClassLabel: billingClassLabel(billingClass),
      selectable: true,
      unavailableReason: null,
      provider: catalog.provider,
      providerLabel: catalog.providerLabel,
      catalog,
    };
  });
}

export function sortPickerRows<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
): PickerModelRow<TCatalog>[] {
  return [...rows].sort(compareModelPickerOrder);
}

export function findPickerRow<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
  modelId: string,
): PickerModelRow<TCatalog> | null {
  return rows.find((row) => row.id === modelId) ?? null;
}

export type GroupPickerRowsOptions = {
  codexOnly?: boolean;
  /**
   * Default true: organization- and workspace-connected keys share one group
   * and identical copies show once. Models settings passes false.
   */
  collapseScopes?: boolean | undefined;
  /** Kept visible when it has an identical twin (see below). */
  selectedId?: string | undefined;
};

/**
 * Organization- and workspace-connected API keys are one choice for the person
 * picking a model, so they share one group.
 */
function displayGroupFor(billingClass: PickerBillingClass): PickerBillingClass {
  return billingClass === "organization_byok" ? "byok" : billingClass;
}

/**
 * The same model through the same provider kind, whichever scope connected it:
 * `organization-anthropic/claude-opus-5-5` and `workspace-anthropic/claude-opus-5-5`
 * share a key, while OpenRouter and the Anthropic API never do (different
 * accounts and bills).
 */
function scopeFreeIdentity(row: PickerModelRow<ClientModel>): string | null {
  const provider = row.provider.replace(/^(?:organization|workspace)-/, "");
  if (provider === row.provider) return null;
  const upstream =
    row.catalog.deployment?.upstreamModelId ??
    (row.id.startsWith(`${row.provider}/`) ? row.id.slice(row.provider.length + 1) : row.id);
  return `${provider}\u0000${upstream}`;
}

/**
 * Two rows that are the same model through the same provider kind, connected
 * by the organization and by the workspace, are one choice: show one. Keep the
 * current selection, else a selectable row, else the first in picker order.
 */
function prefersTwin<TCatalog extends ClientModel>(
  candidate: PickerModelRow<TCatalog>,
  current: PickerModelRow<TCatalog>,
  selectedId: string | undefined,
): boolean {
  if (selectedId !== undefined && current.id === selectedId) return false;
  if (selectedId !== undefined && candidate.id === selectedId) return true;
  return candidate.selectable && !current.selectable;
}

export function groupPickerRowsByBillingClass(
  rows: PickerModelRow[],
  options?: GroupPickerRowsOptions,
): Array<{ billingClass: PickerBillingClass; label: string; rows: PickerModelRow[] }>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
  options?: GroupPickerRowsOptions,
): Array<{
  billingClass: PickerBillingClass;
  label: string;
  rows: PickerModelRow<TCatalog>[];
}>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
  options?: GroupPickerRowsOptions,
): Array<{
  billingClass: PickerBillingClass;
  label: string;
  rows: PickerModelRow<TCatalog>[];
}> {
  const sorted = sortPickerRows(rows);
  const groups: Array<{
    billingClass: PickerBillingClass;
    label: string;
    rows: PickerModelRow<TCatalog>[];
  }> = [];
  for (const row of sorted) {
    const collapse = options?.collapseScopes !== false;
    const billingClass = collapse ? displayGroupFor(row.billingClass) : row.billingClass;
    const existing = groups.find((group) => group.billingClass === billingClass);
    if (existing) {
      const identity = collapse ? scopeFreeIdentity(row) : null;
      const twin =
        identity === null
          ? -1
          : existing.rows.findIndex((candidate) => scopeFreeIdentity(candidate) === identity);
      if (twin < 0) {
        existing.rows.push(row);
      } else if (prefersTwin(row, existing.rows[twin]!, options?.selectedId)) {
        existing.rows[twin] = row;
      }
      continue;
    }
    groups.push({
      billingClass,
      label:
        billingClass === row.billingClass ? row.billingClassLabel : billingClassLabel(billingClass),
      rows: [row],
    });
  }
  const codexIndex = groups.findIndex((group) => group.billingClass === "codex_subscription");
  const codex = groups[codexIndex];
  const selectableOpenGeni = groups
    .find((group) => group.billingClass === "opengeni_credits")
    ?.rows.filter((row) => row.selectable);
  // Presentation only: never change the catalog/default model ordering or selection.
  const onlyFreeOpenGeni =
    selectableOpenGeni !== undefined &&
    selectableOpenGeni.length > 0 &&
    selectableOpenGeni.every((row) => row.catalog.cost === "free");
  if (
    codex &&
    codex.rows.some((row) => row.selectable) &&
    (options?.codexOnly || onlyFreeOpenGeni)
  ) {
    groups.splice(codexIndex, 1);
    groups.unshift(codex);
  }
  return groups;
}
export { modelDisplayName, modelVendor } from "@opengeni/sdk/model-display";
