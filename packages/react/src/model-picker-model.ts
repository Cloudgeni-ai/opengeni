/**
 * The model picker's presentation logic, free of any renderer: which rows show,
 * how they group and filter, and which thinking/latency controls apply. The web
 * menu and native sheets both render from this.
 */
import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  coerceReasoningEffortForModel,
  effortOptionsForModel,
  findPickerRow,
  groupPickerRowsByBillingClass,
  payerSummaryForModel,
  projectClientModelRows,
  runnableLatencyModesForModel,
  scopedBillingClassLabel,
  type PickerBillingClass,
  type PickerModelRow,
} from "./model-policy";

type ClientPickerModelRow = PickerModelRow<ClientModel>;

export type ModelPolicyPickerMessages = {
  label: string;
  loading: string;
  noModels: string;
  connectTitle: string;
  connectBody: string;
  connectAction: string;
  thinking: string;
  fast: string;
  fastRateHint: string;
  codexOnly: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  currentModel?: string;
  noMatches?: string;
  unsupportedAttachments?: string;
  thinkingEffort?: string;
  selected?: string;
  free?: string;

  billingHints: Record<PickerBillingClass, string>;
};

export const defaultModelPolicyPickerMessages: ModelPolicyPickerMessages = {
  label: "Model and effort",
  loading: "Loading model catalog…",
  noModels: "No models available.",
  connectTitle: "Connect a model",
  connectBody: "Use a subscription or a provider key you already have.",
  connectAction: "Open Models",
  thinking: "Thinking",
  fast: "Fast",
  fastRateHint: "2× rate",
  codexOnly: "Codex-only session",
  searchLabel: "Search models or providers",
  searchPlaceholder: "Search models or providers…",
  currentModel: "Current model",
  noMatches: "No matching models. Try a model or provider name.",
  unsupportedAttachments: "This model cannot view the attached images.",
  thinkingEffort: "Thinking effort",
  selected: "Selected",
  free: "Free",

  billingHints: {
    opengeni_credits: "Provided by Opengeni",
    external: "Provider terms and limits apply",
    codex_subscription: "ChatGPT / Codex plan",
    supergrok_subscription: "SuperGrok / xAI plan",
    claude_subscription: "Claude plan",
    byok: "Billed to the connected provider account",
    organization_byok: "Billed to the connected provider account",
  },
};

/** Host branding for one payment group; the icon type belongs to the renderer. */
export type ModelPickerGroupBranding<TIcon = unknown> = {
  label?: string | undefined;
  /** Omit to preserve the default; null hides the supporting text. */
  description?: string | null | undefined;
  /** Decorative, non-interactive content. Omit for the default; null hides it. */
  icon?: TIcon | undefined;
};

export type ModelPickerGroupPresentation<TIcon = unknown> = Partial<
  Record<PickerBillingClass, ModelPickerGroupBranding<TIcon>>
>;

/** The renderer-neutral inputs every picker surface shares. */
export type ModelPickerInput<TIcon = unknown> = {
  groupPresentation?: ModelPickerGroupPresentation<TIcon> | undefined;
  models?: ClientModel[] | undefined;
  rows?: PickerModelRow[] | undefined;
  hasImageAttachments?: boolean | undefined;
  model: string;
  effort: ReasoningEffort;
  latencyMode: LatencyMode;
  codexOnly?: boolean | undefined;
  collapseScopes?: boolean | undefined;
  allowLatencyMode?: boolean | undefined;
  messages?: Partial<ModelPolicyPickerMessages> | undefined;
};

/** Models settings keeps naming who is billed for a key. */
export const SCOPED_BILLING_HINTS: Partial<Record<PickerBillingClass, string>> = {
  byok: "Billed to the workspace provider account",
  organization_byok: "Billed to the organization provider account",
};

export function isCodexPickerModel(model: ClientModel): boolean {
  return model.id.startsWith("codex/") || model.source === "codex";
}

/** The payment group a selection the catalog no longer lists most likely belonged to. */
export function billingClassForMissingSelection(modelId: string): PickerBillingClass {
  if (modelId.startsWith("workspace-claude-subscription/")) return "claude_subscription";
  if (modelId.startsWith("workspace-anthropic/")) return "byok";
  if (modelId.startsWith("organization-claude-subscription/")) return "claude_subscription";
  if (modelId.startsWith("organization-anthropic/")) return "organization_byok";
  if (modelId.startsWith("workspace-gateway/")) return "byok";
  if (modelId.startsWith("workspace-openrouter/")) return "byok";
  // A deployment OpenRouter ID does not encode its workspace-facing cost.
  // Missing rows therefore use the credits-safe rail instead of falsely
  // claiming that an unknown former selection was externally funded.
  if (modelId.startsWith("openrouter/")) return "opengeni_credits";
  if (modelId.startsWith("codex/")) return "codex_subscription";
  if (modelId.startsWith("supergrok/")) return "supergrok_subscription";
  return "opengeni_credits";
}

function applyCodexOnly(
  rows: ClientPickerModelRow[],
  codexOnly: boolean,
  unavailableReason: string,
): ClientPickerModelRow[] {
  if (!codexOnly) return rows;
  return rows.map((row) =>
    isCodexPickerModel(row.catalog)
      ? row
      : {
          ...row,
          selectable: false,
          unavailableReason: row.unavailableReason ?? unavailableReason,
        },
  );
}

/**
 * Host branding for a payment group. While scopes are collapsed, API keys are
 * one group, so either API-key presentation serves both.
 */
export function groupPresentationFor<TIcon>(
  props: {
    groupPresentation?: ModelPickerGroupPresentation<TIcon> | undefined;
    collapseScopes?: boolean | undefined;
  },
  billingClass: PickerBillingClass,
): ModelPickerGroupBranding<TIcon> | undefined {
  const own = props.groupPresentation?.[billingClass];
  if (own !== undefined || props.collapseScopes === false) return own;
  if (billingClass === "byok") return props.groupPresentation?.organization_byok;
  if (billingClass === "organization_byok") return props.groupPresentation?.byok;
  return undefined;
}

export function effectiveRows<TIcon>(props: ModelPickerInput<TIcon>): ClientPickerModelRow[] {
  const rows = props.rows !== undefined ? props.rows : projectClientModelRows(props.models ?? []);
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  return applyCodexOnly(rows, props.codexOnly === true, messages.codexOnly).map((row) => {
    const scoped =
      props.collapseScopes === false
        ? {
            ...row,
            label: row.catalog.label,
            billingClassLabel: scopedBillingClassLabel(row.billingClass),
          }
        : row;
    if (props.collapseScopes === false) {
      if (row.catalog.shortLabel) scoped.shortLabel = row.catalog.shortLabel;
      else delete scoped.shortLabel;
    }
    const label = groupPresentationFor(props, row.billingClass)?.label;
    return label === undefined ? scoped : { ...scoped, billingClassLabel: label };
  });
}

export type ModelPickerMenuGroup = {
  billingClass: PickerBillingClass;
  label: string;
  description: string | null;
  rows: ClientPickerModelRow[];
};

export type ModelPickerThinking = {
  efforts: ReasoningEffort[];
  value: ReasoningEffort;
  showThinking: boolean;
  showFast: boolean;
  /** The selected row cannot run, so its controls are read-only. */
  disabled: boolean;
};

export type ModelPickerMenuView = {
  messages: ModelPolicyPickerMessages;
  rows: ClientPickerModelRow[];
  selected: ClientPickerModelRow | null;
  /** Any row can run; otherwise the surface offers to connect models instead. */
  anySelectable: boolean;
  /** Whether the query is non-empty (decides "no matches" versus "no models"). */
  searching: boolean;
  groups: ModelPickerMenuGroup[];
  matchCount: number;
  /** Thinking and Fast controls for the selected model, or null when it has none. */
  thinking: ModelPickerThinking | null;
  /** The selected model cannot view images the draft carries. */
  unsupportedAttachments: boolean;
};

/** Everything a picker menu shows for this input and search query. */
export function modelPickerMenuView<TIcon>(
  props: ModelPickerInput<TIcon>,
  query: string,
): ModelPickerMenuView {
  const messages = { ...defaultModelPolicyPickerMessages, ...props.messages };
  const rows = effectiveRows(props);
  const selected = findPickerRow(rows, props.model);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = rows.filter((row) => {
    const description = groupPresentationFor(props, row.billingClass)?.description;
    const text =
      `${row.label} ${row.id} ${row.providerLabel} ${row.billingClassLabel} ${description === undefined ? payerSummaryForModel(row.catalog) : (description ?? "")}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const matchingIds = new Set(filtered.map((row) => row.id));
  const groups = groupPickerRowsByBillingClass(rows, {
    codexOnly: props.codexOnly === true,
    selectedId: props.model,
    collapseScopes: props.collapseScopes !== false,
  })
    .map((group) => {
      const presentation = groupPresentationFor(props, group.billingClass);
      const override = presentation?.description;
      const defaultHint =
        props.collapseScopes === false &&
        messages.billingHints[group.billingClass] ===
          defaultModelPolicyPickerMessages.billingHints[group.billingClass]
          ? (SCOPED_BILLING_HINTS[group.billingClass] ?? messages.billingHints[group.billingClass])
          : messages.billingHints[group.billingClass];
      return {
        billingClass: group.billingClass,
        label: presentation?.label ?? group.label,
        rows: group.rows.filter((row) => matchingIds.has(row.id)),
        description:
          override === undefined
            ? group.billingClass === "opengeni_credits"
              ? null
              : defaultHint
            : override,
      };
    })
    .filter((group) => group.rows.length > 0);
  const anySelectable = rows.some((row) => row.selectable);
  const unsupportedAttachments =
    props.hasImageAttachments === true &&
    selected?.catalog.capabilities?.inputModalities.includes("image") === false;
  return {
    messages,
    rows,
    selected,
    anySelectable,
    searching: words.length > 0,
    groups,
    matchCount: filtered.length,
    thinking: selected ? modelPickerThinking(props, selected) : null,
    unsupportedAttachments,
  };
}

function modelPickerThinking(
  props: Pick<ModelPickerInput, "effort" | "allowLatencyMode">,
  selected: ClientPickerModelRow,
): ModelPickerThinking | null {
  const efforts = effortOptionsForModel(selected.catalog);
  const showThinking =
    efforts.length > 1 && selected.catalog.capabilities?.reasoning.runnable !== false;
  const showFast =
    props.allowLatencyMode !== false &&
    runnableLatencyModesForModel(selected.catalog).includes("fast");
  if (!showThinking && !showFast) return null;
  return {
    efforts,
    value: coerceReasoningEffortForModel(selected.catalog, props.effort),
    showThinking,
    showFast,
    disabled: !selected.selectable,
  };
}

export type ModelPickerChoice = {
  /** The new model, or null when the row is already selected. */
  model: string | null;
  /** Always reported, so hosts can commit model and effort together. */
  effort: ReasoningEffort;
  /** Fast falls back to standard when the new model cannot run it. */
  latencyMode: LatencyMode | null;
};

/** What choosing a row changes, or null when the row cannot be chosen. */
export function modelPickerChoice(
  props: Pick<ModelPickerInput, "model" | "effort" | "latencyMode">,
  row: ClientPickerModelRow,
): ModelPickerChoice | null {
  if (!row.selectable) return null;
  return {
    model: row.id === props.model ? null : row.id,
    effort: coerceReasoningEffortForModel(row.catalog, props.effort),
    latencyMode:
      props.latencyMode !== "standard" &&
      !runnableLatencyModesForModel(row.catalog).includes(props.latencyMode)
        ? "standard"
        : null,
  };
}

/** The web segmented control's short labels ("X-high" fits a phone row). */
export function compactEffortLabel(effort: ReasoningEffort, label: string): string {
  return effort === "xhigh" ? "X-high" : label;
}
