import type {
  DefaultModelSelection,
  LatencyMode,
  ReasoningEffort,
  SessionEvent,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";

import { modelDisplayName } from "@opengeni/sdk/model-display";
import {
  defaultEffortForModel,
  findPickerRow,
  runnableLatencyModesForModel,
  type PickerModelRow,
} from "./model-policy";

/**
 * Connection- and subscription-owned product ids: workspace/organization
 * Gateway, OpenRouter, Opper, Claude and direct-provider models, Codex and SuperGrok.
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
 * A readable name for a model the catalog no longer describes: the shared
 * display name, never the routing id (`openrouter/vendor/name:free` becomes
 * `Name`, `codex/gpt-6.1-sol` becomes `GPT-6.1 Sol`).
 */
export function unavailableModelName(modelId: string): string {
  return modelDisplayName(modelId);
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
 * service, else the first selectable model in picker order. Applies only to
 * the next message; accepted turns and history keep their frozen model.
 */
export function unavailableModelReplacement(input: {
  rows: readonly PickerModelRow[];
  defaultSelection: DefaultModelSelection | null;
  latencyMode: LatencyMode;
}): UnavailableModelReplacement | null {
  const selectable = input.rows.filter((row) => row.selectable);
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

/**
 * The model a chat offers to continue with when its ChatGPT/Codex plan is out
 * of usage: the server-resolved default when it is another provider's model,
 * else a connected service, else the first other model that can run. Null
 * when no other model can run. The chat switches in place; a Codex
 * remote-compaction chat rebuilds its context for the new model.
 */
export function modelAfterCodexUsageLimit(input: {
  rows: readonly PickerModelRow[];
  defaultSelection: DefaultModelSelection | null;
}): { model: string; label: string; reasoningEffort: ReasoningEffort } | null {
  const others = input.rows.filter(
    (row) => row.selectable && row.catalog.source !== "codex" && !row.id.startsWith("codex/"),
  );
  const resolved = input.defaultSelection
    ? findPickerRow(others, input.defaultSelection.model)
    : undefined;
  const row =
    resolved ??
    others.find((candidate) => CONNECTED_BILLING_CLASSES.has(candidate.billingClass)) ??
    others[0];
  if (!row) return null;
  return {
    model: row.id,
    label: row.label,
    reasoningEffort:
      resolved && input.defaultSelection
        ? input.defaultSelection.reasoningEffort
        : defaultEffortForModel(row.catalog),
  };
}

/**
 * Failure codes for a ChatGPT/Codex plan that has run out of usage, and for a
 * subscription capacity wait that ended without capacity.
 */
const CODEX_USAGE_LIMIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "codex_usage_limit_reached",
  "codex_included_usage_exhausted",
  "subscription_capacity_unavailable",
]);

export function isCodexUsageLimitFailure(failureCode: string | null | undefined): boolean {
  return failureCode !== null && failureCode !== undefined
    ? CODEX_USAGE_LIMIT_FAILURE_CODES.has(failureCode)
    : false;
}

/** Turn lifecycle events after which an earlier usage-limit failure is no longer current. */
const TURN_PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  "user.message",
  "turn.started",
  "turn.completed",
  "turn.cancelled",
  "turn.superseded",
]);

/**
 * The chat's latest turn ended on a usage limit (the chat itself stays idle
 * and takes new messages). Any later message or turn makes it stale.
 */
export function latestTurnFailedOnUsageLimit(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "turn.failed") {
      const code = (event.payload as Record<string, unknown> | null)?.code;
      return isCodexUsageLimitFailure(typeof code === "string" ? code : null);
    }
    if (TURN_PROGRESS_EVENTS.has(event.type)) return false;
  }
  return false;
}
