import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import {
  coerceReasoningEffortForModel,
  findPickerRow,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "./model-policy";

/**
 * The session's model has no usable credit while free (promotional) credit
 * still covers other models. Funding comes from the workspace model catalog,
 * which the server computes from the organization balance.
 */
export type FreeCreditGap = {
  /** Label of the model the free credits don't cover. */
  modelLabel: string;
  /** Selectable models the remaining free credits cover, preferred first. */
  covered: { id: string; label: string }[];
  /**
   * The composer already selects another model that can run: a covered or
   * credit-funded model, or one paid another way (connected, subscription, free).
   */
  selectionUsable: boolean;
};

export function freeCreditGap(
  rows: PickerModelRow[],
  model: string,
  options: {
    selectedModel?: string | null | undefined;
    preferredModel?: string | null | undefined;
  } = {},
): FreeCreditGap | null {
  const current = findPickerRow(rows, model);
  if (current?.catalog.creditFunding !== "unavailable") return null;
  const gap = creditCoverageGap(rows, model, current.label, options);
  return gap.covered.length > 0 ? gap : null;
}

/**
 * The API refused a Send or a new chat because no credit pays for its model.
 * The refusal is authoritative even while the catalog still reports older
 * funding, so the gap is named whether or not other models are covered.
 */
export function creditRefusalGap(
  rows: PickerModelRow[],
  model: string,
  options: {
    selectedModel?: string | null | undefined;
    preferredModel?: string | null | undefined;
  } = {},
): FreeCreditGap {
  const label = findPickerRow(rows, model)?.label ?? modelDisplayName(model);
  return creditCoverageGap(rows, model, label, options);
}

function creditCoverageGap(
  rows: PickerModelRow[],
  model: string,
  modelLabel: string,
  options: {
    selectedModel?: string | null | undefined;
    preferredModel?: string | null | undefined;
  },
): FreeCreditGap {
  const covered = rows.filter(
    (row) => row.id !== model && row.selectable && row.catalog.creditFunding === "promotional",
  );
  const { selectedModel, preferredModel } = options;
  const preferred = preferredModel ? covered.findIndex((row) => row.id === preferredModel) : -1;
  if (preferred > 0) covered.unshift(...covered.splice(preferred, 1));
  const selected =
    selectedModel && selectedModel !== model ? findPickerRow(rows, selectedModel) : null;
  return {
    modelLabel,
    covered: covered.map((row) => ({ id: row.id, label: row.label })),
    selectionUsable: Boolean(
      selected?.selectable && selected.catalog.creditFunding !== "unavailable",
    ),
  };
}

/** Headline for a credit stop that free credits could avoid on another model. */
export function freeCreditGapReason(gap: FreeCreditGap): string {
  const subject = `Your free credits don't cover ${gap.modelLabel}.`;
  if (gap.selectionUsable) return `${subject} Send a message to continue with the selected model.`;
  const [first, second] = gap.covered;
  const examples = second ? `${first!.label} or ${second.label}` : first!.label;
  return `${subject} Switch to a model they cover, such as ${examples}, or add credits.`;
}

/**
 * The banner's one-click switch, with the picker's coercion: keep the effort
 * and speed when the new model runs them, otherwise fall back to its default
 * effort and standard speed so the composer policy stays sendable.
 */
export function coveredModelChoice(
  row: PickerModelRow,
  effort: ReasoningEffort,
  latencyMode: LatencyMode,
): { model: string; effort: ReasoningEffort; latencyMode: LatencyMode | null } | null {
  if (!row.selectable) return null;
  return {
    model: row.id,
    effort: coerceReasoningEffortForModel(row.catalog, effort),
    latencyMode:
      latencyMode !== "standard" && !runnableLatencyModesForModel(row.catalog).includes(latencyMode)
        ? "standard"
        : null,
  };
}
