import type {
  ClientModel,
  ReasoningEffort,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";

export type PickerBillingClass = "opengeni_credits" | "codex_subscription" | "byok";

export type PickerModelRow = {
  id: string;
  label: string;
  billingClass: PickerBillingClass;
  billingClassLabel: string;
  selectable: boolean;
  unavailableReason: string | null;
  provider: string;
  providerLabel: string;
  catalog: WorkspaceModelCatalogModel;
};

export type LatencyModeId = "standard" | "priority" | "fast";

const BILLING_CLASS_ORDER: PickerBillingClass[] = [
  "opengeni_credits",
  "codex_subscription",
  "byok",
];

const BILLING_CLASS_LABELS: Record<PickerBillingClass, string> = {
  opengeni_credits: "OpenGeni credits",
  codex_subscription: "Codex subscription",
  byok: "Bring your own key",
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
  if (model.credentialSource?.kind === "connected_subscription") {
    return "codex_subscription";
  }
  if (model.credentialSource?.kind === "workspace_connection") {
    return "byok";
  }
  if (model.billing?.upstreamPayer === "connected_subscription") {
    return "codex_subscription";
  }
  if (model.billing?.upstreamPayer === "workspace") {
    return "byok";
  }
  return "opengeni_credits";
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
  const order: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
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
  return modes
    .filter((mode) => mode.runnable)
    .map((mode) => mode.id);
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

export function payerSummaryForModel(model: ClientModel): string {
  const billing = model.billing;
  if (!billing) {
    return "Route unknown";
  }
  if (billing.metering === "opengeni_credits") {
    return "OpenGeni credits · automatic managed route";
  }
  if (billing.upstreamPayer === "connected_subscription") {
    return "Codex subscription · external billing";
  }
  if (billing.upstreamPayer === "workspace") {
    return "Workspace credentials · external billing";
  }
  return "Deployment route · external billing";
}

export function advancedSourceSummary(model: ClientModel): string | null {
  const source = model.credentialSource;
  if (!source) {
    return null;
  }
  if (source.kind === "connected_subscription") {
    return "Connected Codex subscription";
  }
  if (source.kind === "workspace_connection") {
    return "Workspace API key connection";
  }
  if (source.kind === "deployment") {
    return source.mechanism === "azure_ad_bearer"
      ? "Deployment Azure identity"
      : "Deployment API key";
  }
  return null;
}

export function projectPickerRows(
  models: WorkspaceModelCatalogModel[],
): PickerModelRow[] {
  return models.map((catalog) => {
    const billingClass = billingClassForModel(catalog);
    return {
      id: catalog.id,
      label: catalog.label,
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

export function sortPickerRows(rows: PickerModelRow[]): PickerModelRow[] {
  return [...rows].sort((left, right) => {
    const classDelta =
      BILLING_CLASS_ORDER.indexOf(left.billingClass) -
      BILLING_CLASS_ORDER.indexOf(right.billingClass);
    if (classDelta !== 0) {
      return classDelta;
    }
    if (left.selectable !== right.selectable) {
      return left.selectable ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

export function findPickerRow(
  rows: PickerModelRow[],
  modelId: string,
): PickerModelRow | null {
  return rows.find((row) => row.id === modelId) ?? null;
}

export function ensureSelectedModelRow(
  rows: PickerModelRow[],
  selectedId: string,
  fallbackLabel?: string,
): PickerModelRow[] {
  if (rows.some((row) => row.id === selectedId)) {
    return rows;
  }
  return [
    {
      id: selectedId,
      label: fallbackLabel ?? selectedId,
      billingClass: "opengeni_credits",
      billingClassLabel: billingClassLabel("opengeni_credits"),
      selectable: false,
      unavailableReason: "No longer available",
      provider: "unknown",
      providerLabel: "Unavailable",
      catalog: {
        id: selectedId,
        label: fallbackLabel ?? selectedId,
        provider: "unknown",
        providerLabel: "Unavailable",
        api: "responses",
        credentialReadiness: {
          status: "not_ready",
          reason: "prerequisites_missing",
          basis: "configuration",
          checkedAt: null,
        },
        availability: {
          status: "unavailable",
          selectable: false,
          reason: "unsupported",
          checkedAt: null,
        },
      },
    },
    ...rows,
  ];
}

export function groupPickerRowsByBillingClass(
  rows: PickerModelRow[],
): Array<{ billingClass: PickerBillingClass; label: string; rows: PickerModelRow[] }> {
  const sorted = sortPickerRows(rows);
  const groups: Array<{
    billingClass: PickerBillingClass;
    label: string;
    rows: PickerModelRow[];
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
