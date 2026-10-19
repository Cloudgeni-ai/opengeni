import {
  compareModelPickerOrder,
  modelPickerBillingClassFor,
  type ModelPickerBillingClass,
} from "@opengeni/sdk/model-picker-order";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { ClientModel, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { type OpenGeniText } from "./messages/runtime";

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
  fundingHint?: string | undefined;
  provider: string;
  providerLabel: string;
  catalog: TCatalog;
};

export type LatencyModeId = "standard" | "priority" | "fast";

const BILLING_CLASS_LABELS = (t: OpenGeniText): Record<PickerBillingClass, string> => ({
  opengeni_credits: t("modelPolicy.models"),
  external: t("modelPolicy.external"),
  codex_subscription: t("modelPolicy.codex"),
  supergrok_subscription: "SuperGrok",
  claude_subscription: t("modelPolicy.claudeSubscription"),
  // Who connected the key (organization or workspace) is a settings fact, not
  // a model choice: both scopes share one label and one picker group.
  byok: t("modelPolicy.apiKeys"),
  organization_byok: t("modelPolicy.apiKeys"),
});

/** Models settings keeps naming who connected the key. */
const SCOPED_BILLING_CLASS_LABELS = (t: OpenGeniText): Record<PickerBillingClass, string> => ({
  ...BILLING_CLASS_LABELS(t),
  byok: t("modelPolicy.workspaceProviders"),
  organization_byok: t("modelPolicy.organizationProviders"),
});

const AVAILABILITY_REASON_LABELS = (t: OpenGeniText): Record<string, string> => ({
  missing_credential: t("modelPolicy.credentialsRequired"),
  needs_reauth: t("modelPolicy.reconnectRequired"),
  credential_not_ready: t("modelPolicy.credentialNotReady"),
  not_entitled: t("modelPolicy.notEntitled"),
  provider_unhealthy: t("modelPolicy.providerUnavailable"),
  policy_blocked: t("modelPolicy.blockedByWorkspacePolicy"),
  unsupported: t("modelPolicy.unsupported"),
  credits_disabled: t("modelPolicy.opengeniCreditsOff"),
});

export function billingClassForModel(model: ClientModel): PickerBillingClass {
  if (
    model.provider === "organization-gateway" ||
    model.provider === "organization-openrouter" ||
    model.provider === "organization-opper"
  ) {
    return "organization_byok";
  }
  if (
    model.provider?.startsWith("workspace-openai-") ||
    model.provider?.startsWith("workspace-azure-openai-")
  )
    return "byok";
  if (
    model.provider === "workspace-gateway" ||
    model.provider === "workspace-openrouter" ||
    model.provider === "workspace-opper"
  ) {
    return "byok";
  }
  return modelPickerBillingClassFor(model);
}

export function billingClassLabel(t: OpenGeniText, billingClass: PickerBillingClass): string {
  return BILLING_CLASS_LABELS(t)[billingClass];
}

/** The group label that names the connection scope, for Models settings only. */
export function scopedBillingClassLabel(t: OpenGeniText, billingClass: PickerBillingClass): string {
  return SCOPED_BILLING_CLASS_LABELS(t)[billingClass];
}

export function availabilityReasonLabel(
  t: OpenGeniText,
  reason: WorkspaceModelCatalogModel["availability"]["reason"],
): string | null {
  if (!reason) {
    return null;
  }
  return AVAILABILITY_REASON_LABELS(t)[reason] ?? t("modelPolicy.unavailable");
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
  t: OpenGeniText,
  models: readonly ClientModel[],
  modelId: string,
  effort: ReasoningEffort | null | undefined,
): { name: string; effort: string | null } {
  const row = findPickerRow(projectClientModelRows(t, [...models]), modelId);
  return {
    name: row?.shortLabel ?? row?.label ?? modelDisplayName(modelId),
    effort:
      row && effort && modelOffersEffortChoice(row.catalog)
        ? labelReasoningEffort(t, effort)
        : null,
  };
}

export function runnableLatencyModesForModel(model: ClientModel): LatencyModeId[] {
  const modes = model.capabilities?.latencyModes ?? [];
  return modes.filter((mode) => mode.runnable).map((mode) => mode.id);
}

export function labelLatencyMode(t: OpenGeniText, mode: LatencyModeId): string {
  if (mode === "fast") {
    return t("modelPolicy.fast");
  }
  if (mode === "priority") {
    return t("modelPolicy.priority");
  }
  return t("modelPolicy.standard");
}

export function labelReasoningEffort(t: OpenGeniText, effort: ReasoningEffort): string {
  if (effort === "xhigh") {
    return t("modelPolicy.extraHigh");
  }
  return effort.slice(0, 1).toUpperCase() + effort.slice(1);
}

/** Payment prompts must use cost policy, never the presentation group. */
export function modelUsesCredits(model: ClientModel | undefined): boolean {
  if (model?.cost !== undefined) return model.cost === "credits";
  return model?.billing?.metering === "opengeni_credits";
}

export function payerSummaryForModel(t: OpenGeniText, model: ClientModel): string {
  if (model.cost === "free") {
    return t("modelPolicy.freeInThisDeployment");
  }
  if (model.cost === "credits") {
    return t("modelPolicy.opengeniCredits");
  }
  if (model.cost === "subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "claude"
      ? t("modelPolicy.claudeSubscriptionExternalBilling")
      : model.source === "supergrok"
        ? t("modelPolicy.supergrokSubscriptionExternalBilling")
        : t("modelPolicy.codexSubscriptionExternalBilling");
  }
  if (model.cost === "workspace") {
    return workspaceProviderPayerSummary(t, model);
  }
  if (model.cost === "organization") {
    return organizationProviderPayerSummary(t, model);
  }

  // Older client-config payloads do not carry `cost`; preserve their existing
  // settlement-derived label until every deployment has rolled forward.
  const billing = model.billing;
  if (!billing) {
    return t("modelPolicy.routeUnknown");
  }
  if (billing.metering === "opengeni_credits") {
    return t("modelPolicy.opengeniCreditsAutomaticManagedRoute");
  }
  if (billing.upstreamPayer === "connected_subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "claude"
      ? t("modelPolicy.claudeSubscriptionExternalBilling")
      : model.source === "supergrok"
        ? t("modelPolicy.supergrokSubscriptionExternalBilling")
        : t("modelPolicy.codexSubscriptionExternalBilling");
  }
  if (billing.upstreamPayer === "workspace") {
    return workspaceProviderPayerSummary(t, model);
  }
  if (billing.upstreamPayer === "organization") {
    return organizationProviderPayerSummary(t, model);
  }
  return billing.upstreamPayer === "deployment"
    ? t("modelPolicy.opengeniNoModelCredits")
    : t("modelPolicy.externalProviderNoOpengeniCredits");
}

export function advancedSourceSummary(t: OpenGeniText, model: ClientModel): string | null {
  const source = model.credentialSource;
  if (!source) {
    return model.billing?.metering === "external" && model.billing.upstreamPayer === "deployment"
      ? t("modelPolicy.deploymentProvidedConnection")
      : null;
  }
  if (source.kind === "connected_subscription") {
    return source.provider === "claude"
      ? t("modelPolicy.connectedClaudeSubscription")
      : source.provider === "xai"
        ? t("modelPolicy.connectedSupergrokSubscription")
        : t("modelPolicy.connectedCodexSubscription");
  }
  if (source.kind === "workspace_connection") {
    if (model.provider === "workspace-openrouter") {
      return t("modelPolicy.workspaceOpenrouterConnection");
    }
    if (model.provider === "workspace-opper") {
      return t("modelPolicy.workspaceOpperConnection");
    }
    if (model.provider === "workspace-gateway" || model.source === "workspace_gateway") {
      return t("modelPolicy.workspaceVercelAiGateway");
    }
    return t("modelPolicy.workspaceProviderConnection");
  }
  if (source.kind === "deployment") {
    return source.mechanism === "azure_ad_bearer"
      ? t("modelPolicy.deploymentAzureIdentity")
      : t("modelPolicy.deploymentApiKey");
  }
  return null;
}

function workspaceProviderPayerSummary(t: OpenGeniText, model: ClientModel): string {
  if (model.provider === "workspace-anthropic")
    return t("modelPolicy.billedToTheWorkspaceAnthropic");
  if (model.provider === "workspace-claude-subscription")
    return t("modelPolicy.usesTheWorkspaceClaudeSubscription");
  if (model.provider === "workspace-openrouter") {
    return t("modelPolicy.billedToTheWorkspaceOpenrouter");
  }
  if (model.provider === "workspace-opper") {
    return t("modelPolicy.billedToTheWorkspaceOpper");
  }
  if (model.provider === "workspace-gateway" || model.source === "workspace_gateway") {
    return t("modelPolicy.billedToTheWorkspaceVercel");
  }
  return t("modelPolicy.billedToTheWorkspaceProvider");
}

function organizationProviderPayerSummary(t: OpenGeniText, model: ClientModel): string {
  if (model.provider === "organization-anthropic")
    return t("modelPolicy.billedToTheOrganizationAnthropic");
  if (model.provider === "organization-claude-subscription")
    return t("modelPolicy.usesTheConnectedClaudeSubscription");
  if (model.provider === "organization-openrouter") {
    return t("modelPolicy.billedToTheOrganizationOpenrouter");
  }
  if (model.provider === "organization-opper") {
    return t("modelPolicy.billedToTheOrganizationOpper");
  }
  if (model.provider === "organization-gateway") {
    return t("modelPolicy.billedToTheOrganizationVercel");
  }
  return t("modelPolicy.billedToTheOrganizationProvider");
}

/**
 * The curated compact label, else a derived one for narrow triggers: the name
 * without trailing access and release-stage qualifiers ("Muse Spark 1.3
 * Contributor Free" → "Muse Spark 1.3"), which the picker's groups and
 * descriptions already carry. Claude names are already family-free
 * ("Opus 5.5") in the shared display name.
 */
function compactLabel(catalog: ClientModel): { shortLabel?: string } {
  if (catalog.shortLabel) return { shortLabel: catalog.shortLabel };
  const name = modelDisplayName(catalog);
  const trimmed = withoutTrailingQualifiers(name);
  return trimmed !== name ? { shortLabel: trimmed } : {};
}

const TRAILING_QUALIFIERS = new Set([
  "free",
  "contributor",
  "preview",
  "beta",
  "experimental",
  "exp",
  "latest",
]);

/** Drops trailing qualifier words ("Free", "Preview", "(free)") while a name remains. */
function withoutTrailingQualifiers(name: string): string {
  const words = name.trim().split(/\s+/u);
  while (words.length > 1) {
    const last = words
      .at(-1)!
      .replace(/^[([]|[)\]]$/gu, "")
      .toLowerCase();
    if (!TRAILING_QUALIFIERS.has(last)) break;
    words.pop();
  }
  return words.join(" ");
}

/**
 * Older published Site hosts list bare `{ id }` rows. A row without readiness
 * or availability is one the server offers, so it is ready and selectable.
 */
export function projectPickerRows(
  t: OpenGeniText,
  models: WorkspaceModelCatalogModel[],
): PickerModelRow[] {
  return models
    .filter((catalog) => (catalog.credentialReadiness?.status ?? "ready") === "ready")
    .map((catalog) => {
      const billingClass = billingClassForModel(catalog);
      const selectable = catalog.availability?.selectable ?? true;
      return {
        id: catalog.id,
        label: modelDisplayName(catalog),
        ...compactLabel(catalog),
        billingClass,
        billingClassLabel: billingClassLabel(t, billingClass),
        selectable,
        fundingHint:
          catalog.creditFunding === "promotional"
            ? t("modelPolicy.freeCredits")
            : catalog.creditFunding === "general"
              ? t("modelPolicy.usesCredits")
              : catalog.creditFunding === "unavailable"
                ? t("modelPolicy.needsCredits")
                : undefined,
        unavailableReason: selectable
          ? null
          : availabilityReasonLabel(t, catalog.availability?.reason ?? null),
        provider: catalog.provider,
        providerLabel: catalog.providerLabel,
        catalog,
      };
    });
}

/** Project the lightweight client-config model list into the same picker contract. */
export function projectClientModelRows(
  t: OpenGeniText,
  models: ClientModel[],
): PickerModelRow<ClientModel>[] {
  return models.map((catalog) => {
    const billingClass = billingClassForModel(catalog);
    return {
      id: catalog.id,
      label: modelDisplayName(catalog),
      ...compactLabel(catalog),
      billingClass,
      billingClassLabel: billingClassLabel(t, billingClass),
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
  t: OpenGeniText,
  rows: PickerModelRow[],
  options?: GroupPickerRowsOptions,
): Array<{ billingClass: PickerBillingClass; label: string; rows: PickerModelRow[] }>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  t: OpenGeniText,
  rows: PickerModelRow<TCatalog>[],
  options?: GroupPickerRowsOptions,
): Array<{
  billingClass: PickerBillingClass;
  label: string;
  rows: PickerModelRow<TCatalog>[];
}>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  t: OpenGeniText,
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
        billingClass === row.billingClass
          ? row.billingClassLabel
          : billingClassLabel(t, billingClass),
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
