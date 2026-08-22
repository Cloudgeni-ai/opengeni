import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";

import {
  coerceReasoningEffortForModel,
  findPickerRow,
  type PickerModelRow,
  runnableLatencyModesForModel,
} from "@/lib/model-policy";

export type AgentBrainPromptModelPreference = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

export type AgentBrainPromptModelSelection = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

/**
 * Pick a workspace-selectable model for the Company Brain "Create with OpenGeni"
 * prompt. The preferred (app-context) model wins when the workspace catalog
 * marks it selectable; otherwise the first selectable row of the already-sorted
 * catalog is used. Returns `null` when the catalog has no selectable row, so the
 * caller can keep the form disabled instead of submitting a model the workspace
 * policy would reject.
 */
export function resolveAgentBrainPromptModel(
  rows: PickerModelRow[],
  preferred: AgentBrainPromptModelPreference,
): AgentBrainPromptModelSelection | null {
  const preferredRow = findPickerRow(rows, preferred.model);
  const row = preferredRow?.selectable
    ? preferredRow
    : rows.find((candidate) => candidate.selectable);
  if (!row) {
    return null;
  }
  const reasoningEffort = coerceReasoningEffortForModel(row.catalog, preferred.reasoningEffort);
  const latencyMode: LatencyMode =
    preferred.latencyMode !== "standard" &&
    runnableLatencyModesForModel(row.catalog).includes(preferred.latencyMode)
      ? preferred.latencyMode
      : "standard";
  return { model: row.id, reasoningEffort, latencyMode };
}
