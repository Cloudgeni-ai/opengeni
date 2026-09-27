// Per-credential, per-model ChatGPT plan entitlement state.
//
// When a re-checked plan proves that the serving ChatGPT account no longer
// includes a model, the credential stays connected and healthy for every other
// model; only that (plan, model) pair is excluded from allocation. The
// exclusion is bound to the plan it was observed under, so any later plan
// observation (usage poll, token refresh, reconnect) that reports a different
// plan makes it inert without a separate cleanup step.

import { codexPlanKey } from "@opengeni/codex";

export const CODEX_PLAN_ENTITLEMENT_MAX_MODELS = 64;

export type CodexPlanEntitlementExclusion = {
  /** Normalized plan key the refusal was observed under. */
  planType: string;
  /** Product model ids (`codex/<slug>`) that plan does not include. */
  modelIds: string[];
};

/** Strict reader for the stored jsonb value; malformed state is ignored. */
export function readCodexPlanEntitlementExclusion(
  value: unknown,
): CodexPlanEntitlementExclusion | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.planType !== "string" || record.planType.length === 0) return null;
  if (!Array.isArray(record.modelIds)) return null;
  const modelIds = [
    ...new Set(
      record.modelIds.filter(
        (modelId): modelId is string => typeof modelId === "string" && modelId.length > 0,
      ),
    ),
  ].slice(0, CODEX_PLAN_ENTITLEMENT_MAX_MODELS);
  if (modelIds.length === 0) return null;
  return { planType: record.planType, modelIds };
}

/**
 * True when the credential's CURRENT plan is the plan a model refusal was
 * observed under and that refusal covered `modelId`.
 */
export function codexPlanExcludesModel(
  account: {
    planType: string | null;
    planEntitlementExclusion?: CodexPlanEntitlementExclusion | null | undefined;
  },
  modelId: string | null | undefined,
): boolean {
  const exclusion = account.planEntitlementExclusion;
  if (!exclusion || !modelId) return false;
  return (
    exclusion.planType === codexPlanKey(account.planType) && exclusion.modelIds.includes(modelId)
  );
}

/** Add one refused model under `planType`, replacing an exclusion for any other plan. */
export function mergeCodexPlanEntitlementExclusion(
  existing: CodexPlanEntitlementExclusion | null,
  planType: string | null,
  modelId: string,
): CodexPlanEntitlementExclusion {
  const key = codexPlanKey(planType);
  const retained = existing && existing.planType === key ? existing.modelIds : [];
  const modelIds = [modelId, ...retained.filter((candidate) => candidate !== modelId)].slice(
    0,
    CODEX_PLAN_ENTITLEMENT_MAX_MODELS,
  );
  return { planType: key, modelIds: modelIds.sort() };
}
