import {
  compareModelPickerOrder,
  modelPickerBillingClassFor,
  type ModelPickerBillingClass,
} from "@opengeni/sdk/model-picker-order";
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
  opengeni_credits: "OpenGeni",
  external: "External",
  codex_subscription: "Codex",
  supergrok_subscription: "SuperGrok",
  byok: "Workspace providers",
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
  if (model.provider === "workspace-gateway" || model.provider === "workspace-openrouter") {
    return "byok";
  }
  return modelPickerBillingClassFor(model);
}

export function billingClassLabel(billingClass: PickerBillingClass): string {
  return BILLING_CLASS_LABELS[billingClass];
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

export function payerSummaryForModel(model: ClientModel): string {
  if (model.cost === "free") {
    return "Free in this deployment";
  }
  if (model.cost === "credits") {
    return "OpenGeni credits";
  }
  if (model.cost === "subscription") {
    return model.source === "supergrok"
      ? "SuperGrok subscription · external billing"
      : "Codex subscription · external billing";
  }
  if (model.cost === "workspace") {
    return workspaceProviderPayerSummary(model);
  }

  // Older client-config payloads do not carry `cost`; preserve their existing
  // settlement-derived label until every deployment has rolled forward.
  const billing = model.billing;
  if (!billing) {
    return "Route unknown";
  }
  if (billing.metering === "opengeni_credits") {
    return "OpenGeni credits · automatic managed route";
  }
  if (billing.upstreamPayer === "connected_subscription") {
    return model.source === "supergrok"
      ? "SuperGrok subscription · external billing"
      : "Codex subscription · external billing";
  }
  if (billing.upstreamPayer === "workspace") {
    return workspaceProviderPayerSummary(model);
  }
  return "External provider · no OpenGeni credits";
}

export function advancedSourceSummary(model: ClientModel): string | null {
  const source = model.credentialSource;
  if (!source) {
    return model.billing?.metering === "external" && model.billing.upstreamPayer === "deployment"
      ? "Deployment route · no authentication"
      : null;
  }
  if (source.kind === "connected_subscription") {
    return source.provider === "xai"
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
  if (model.provider === "workspace-openrouter") {
    return "Billed to the workspace OpenRouter account";
  }
  if (model.provider === "workspace-gateway" || model.source === "workspace_gateway") {
    return "Billed to the workspace Vercel account";
  }
  return "Billed to the workspace provider account";
}

export function projectPickerRows(models: WorkspaceModelCatalogModel[]): PickerModelRow[] {
  return models
    .filter((catalog) => {
      const billingClass = billingClassForModel(catalog);
      return billingClass === "opengeni_credits" || catalog.credentialReadiness.status === "ready";
    })
    .map((catalog) => {
      const billingClass = billingClassForModel(catalog);
      return {
        id: catalog.id,
        label: catalog.label,
        ...(catalog.shortLabel ? { shortLabel: catalog.shortLabel } : {}),
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
      label: catalog.label,
      ...(catalog.shortLabel ? { shortLabel: catalog.shortLabel } : {}),
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

export function groupPickerRowsByBillingClass(
  rows: PickerModelRow[],
): Array<{ billingClass: PickerBillingClass; label: string; rows: PickerModelRow[] }>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
): Array<{
  billingClass: PickerBillingClass;
  label: string;
  rows: PickerModelRow<TCatalog>[];
}>;
export function groupPickerRowsByBillingClass<TCatalog extends ClientModel>(
  rows: PickerModelRow<TCatalog>[],
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
    const existing = groups.find((group) => group.billingClass === row.billingClass);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    groups.push({
      billingClass: row.billingClass,
      label: row.billingClassLabel,
      rows: [row],
    });
  }
  return groups;
}
