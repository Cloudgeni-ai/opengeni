import { findPickerRow, type PickerModelRow } from "@/lib/model-policy";

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
};

export function freeCreditGap(
  rows: PickerModelRow[],
  model: string,
  preferredModel?: string | null,
): FreeCreditGap | null {
  const current = findPickerRow(rows, model);
  if (current?.catalog.creditFunding !== "unavailable") return null;
  const covered = rows.filter(
    (row) => row.id !== model && row.selectable && row.catalog.creditFunding === "promotional",
  );
  if (covered.length === 0) return null;
  const preferred = preferredModel ? covered.findIndex((row) => row.id === preferredModel) : -1;
  if (preferred > 0) covered.unshift(...covered.splice(preferred, 1));
  return {
    modelLabel: current.label,
    covered: covered.map((row) => ({ id: row.id, label: row.label })),
  };
}

/** Headline for a credit stop that free credits could avoid on another model. */
export function freeCreditGapReason(gap: FreeCreditGap, modelChanged: boolean): string {
  const subject = `Your free credits don't cover ${gap.modelLabel}.`;
  if (modelChanged) return `${subject} Send a message to continue with the selected model.`;
  const [first, second] = gap.covered;
  const examples = second ? `${first!.label} or ${second.label}` : first!.label;
  return `${subject} Switch to a model they cover, such as ${examples}, or add credits.`;
}
