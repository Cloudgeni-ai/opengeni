import type {
  DefaultModelSelection,
  LatencyMode,
  ReasoningEffort,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";

import { displayModel } from "@/lib/format";
import {
  defaultEffortForModel,
  findPickerRow,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "@/lib/model-policy";

/**
 * Connection- and subscription-owned product ids: workspace/organization
 * Gateway, OpenRouter, Claude and direct-provider models, Codex and SuperGrok.
 * An existing session may keep running a retained definition the catalog no
 * longer lists, so only the API's refusal can say these are unavailable.
 */
const CONNECTION_OWNED_MODEL_ID = /^(?:codex|supergrok|(?:workspace|organization)-[a-z0-9-]+)\//;

/**
 * Is this deployment-catalog model absent from the loaded workspace catalog?
 * The catalog lists every deployment model a new message may use, so absence
 * means it was retired or removed and the API refuses it with
 * `details.code: "model_unavailable"`. Connection-owned ids are left to that
 * refusal. Unknown until the catalog has loaded; a refresh judges against the
 * previous list.
 */
export function sessionModelMissingFromCatalog(input: {
  model: string;
  models: readonly WorkspaceModelCatalogModel[];
  error: string | null;
}): boolean {
  if (input.error !== null || input.models.length === 0) return false;
  if (CONNECTION_OWNED_MODEL_ID.test(input.model)) return false;
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

/** Services the person or workspace connected rank ahead of other fallbacks. */
const CONNECTED_BILLING_CLASSES = new Set([
  "codex_subscription",
  "supergrok_subscription",
  "byok",
  "external",
]);

/**
 * The composer selection offered in place of an unavailable session model:
 * the server-resolved default when selectable, else a selectable connected
 * service, else the first selectable model in picker order. A
 * remote-compaction session stays on Codex models. Applies only to the next
 * message; accepted turns and history keep their frozen model.
 */
export function unavailableModelReplacement(input: {
  rows: readonly PickerModelRow[];
  defaultSelection: DefaultModelSelection | null;
  latencyMode: LatencyMode;
  codexOnly: boolean;
}): UnavailableModelReplacement | null {
  const selectable = input.rows.filter(
    (row) => row.selectable && (!input.codexOnly || row.catalog.source === "codex"),
  );
  const resolved = input.defaultSelection
    ? findPickerRow(selectable, input.defaultSelection.model)
    : undefined;
  const row =
    resolved ??
    selectable.find((candidate) => CONNECTED_BILLING_CLASSES.has(candidate.billingClass)) ??
    selectable[0];
  if (!row) return null;
  const latencyRunnable =
    input.latencyMode === "standard" ||
    runnableLatencyModesForModel(row.catalog).includes(input.latencyMode);
  return {
    model: row.id,
    label: row.label,
    reasoningEffort:
      resolved && input.defaultSelection
        ? input.defaultSelection.reasoningEffort
        : defaultEffortForModel(row.catalog),
    latencyMode: latencyRunnable ? null : "standard",
  };
}
