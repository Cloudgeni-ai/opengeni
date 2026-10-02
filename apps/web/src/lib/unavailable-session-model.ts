import type {
  DefaultModelSelection,
  LatencyMode,
  ReasoningEffort,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";

import { displayModel } from "@/lib/format";
import { composerFallbackModel } from "@/lib/model-access-onboarding";
import {
  findPickerRow,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "@/lib/model-policy";

/**
 * Is the session's stored model absent from the loaded workspace catalog?
 * The catalog lists every model a new selection may use, including connected
 * subscriptions that are not ready, so absence means the model was retired or
 * removed and the API refuses it (`details.code: "model_unavailable"`).
 * Unknown while the catalog is loading, failed, or empty.
 */
export function sessionModelMissingFromCatalog(input: {
  model: string;
  models: readonly WorkspaceModelCatalogModel[];
  loading: boolean;
  error: string | null;
}): boolean {
  if (input.loading || input.error !== null || input.models.length === 0) return false;
  return !input.models.some(
    (candidate) => candidate.id === input.model || candidate.aliases?.includes(input.model),
  );
}

/**
 * A readable name for a model the catalog no longer describes. Known product
 * ids get their display label; otherwise the last id segment without a
 * routing variant (`openrouter/vendor/name:free` becomes `name`).
 */
export function unavailableModelName(modelId: string): string {
  const display = displayModel(modelId);
  if (display !== modelId) return display;
  const lastSegment = modelId.split("/").filter(Boolean).at(-1) ?? modelId;
  return lastSegment.replace(/:[^:]+$/, "") || modelId;
}

export type UnavailableModelReplacement = {
  model: string;
  label: string;
  reasoningEffort: ReasoningEffort;
  /** Set only when the session's speed is not runnable on the replacement. */
  latencyMode: LatencyMode | null;
};

/**
 * The composer selection offered in place of an unavailable session model:
 * the server-resolved default when selectable, else the client ranking. A
 * remote-compaction session stays on Codex models. Applies only to the next
 * message; accepted turns and history keep their frozen model.
 */
export function unavailableModelReplacement(input: {
  models: readonly WorkspaceModelCatalogModel[];
  rows: readonly PickerModelRow[];
  defaultSelection: DefaultModelSelection | null;
  latencyMode: LatencyMode;
  codexOnly: boolean;
}): UnavailableModelReplacement | null {
  const rows = input.codexOnly
    ? input.rows.filter((row) => row.catalog.source === "codex")
    : input.rows;
  const models = input.codexOnly
    ? input.models.filter((model) => model.source === "codex")
    : input.models;
  const next = composerFallbackModel({
    models,
    rows,
    defaultSelection: input.defaultSelection,
  });
  if (!next) return null;
  const row = findPickerRow([...rows], next.id);
  if (!row?.selectable) return null;
  const latencyRunnable =
    input.latencyMode === "standard" ||
    runnableLatencyModesForModel(row.catalog).includes(input.latencyMode);
  return {
    model: row.id,
    label: row.label,
    reasoningEffort: next.effort,
    latencyMode: latencyRunnable ? null : "standard",
  };
}
