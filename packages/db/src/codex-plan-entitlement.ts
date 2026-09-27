// Per-credential, per-model ChatGPT plan entitlement state.
//
// When a re-checked plan proves that the serving ChatGPT account no longer
// includes a model, the credential stays connected and healthy for every other
// model; only that (plan, model) pair leaves allocation. The exclusion is bound
// to the plan it was observed under, so any later plan observation (usage
// read, token refresh, reconnect) that reports a different plan retires it.
//
// An exclusion also expires: after CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS the
// account may serve that model again, so one request re-probes it (the plan
// may have gained the model, or the original refusal was unrelated). The
// expired entry stays as evidence: if the same plan refuses the same model
// again, the re-check treats that as proven and excludes it again.

import { codexPlanKey } from "@opengeni/codex";

export const CODEX_PLAN_ENTITLEMENT_MAX_MODELS = 64;

/** How long one proven refusal keeps an account out of allocation for a model. */
export const CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS = 24 * 60 * 60 * 1000;

export type CodexPlanEntitlementExcludedModel = {
  /** Product model id (`codex/<slug>`). */
  modelId: string;
  /** When the refusal for this model was last proven under `planType`. */
  excludedAt: Date;
};

export type CodexPlanEntitlementExclusion = {
  /** Normalized plan key the refusals were observed under. */
  planType: string;
  models: CodexPlanEntitlementExcludedModel[];
};

type ExclusionAccount = {
  planType: string | null;
  planEntitlementExclusion?: CodexPlanEntitlementExclusion | null | undefined;
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
  if (!Array.isArray(record.models)) return null;
  const byModel = new Map<string, Date>();
  for (const entry of record.models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { modelId, excludedAt } = entry as Record<string, unknown>;
    if (typeof modelId !== "string" || modelId.length === 0) continue;
    if (typeof excludedAt !== "string") continue;
    const at = new Date(excludedAt);
    if (Number.isNaN(at.getTime())) continue;
    const existing = byModel.get(modelId);
    if (!existing || existing.getTime() < at.getTime()) byModel.set(modelId, at);
  }
  const models = [...byModel]
    .map(([modelId, excludedAt]) => ({ modelId, excludedAt }))
    .slice(0, CODEX_PLAN_ENTITLEMENT_MAX_MODELS);
  if (models.length === 0) return null;
  return { planType: record.planType, models };
}

/** jsonb value for storage (ISO timestamps, stable model order). */
export function serializeCodexPlanEntitlementExclusion(exclusion: CodexPlanEntitlementExclusion): {
  planType: string;
  models: { modelId: string; excludedAt: string }[];
} {
  return {
    planType: exclusion.planType,
    models: [...exclusion.models]
      .sort((left, right) => left.modelId.localeCompare(right.modelId))
      .map((entry) => ({ modelId: entry.modelId, excludedAt: entry.excludedAt.toISOString() })),
  };
}

function exclusionEntry(
  account: ExclusionAccount,
  modelId: string | null | undefined,
): CodexPlanEntitlementExcludedModel | null {
  const exclusion = account.planEntitlementExclusion;
  if (!exclusion || !modelId) return null;
  if (exclusion.planType !== codexPlanKey(account.planType)) return null;
  return exclusion.models.find((entry) => entry.modelId === modelId) ?? null;
}

/** When one excluded model becomes eligible again for a single probe request. */
export function codexPlanExclusionExpiresAt(entry: CodexPlanEntitlementExcludedModel): Date {
  return new Date(entry.excludedAt.getTime() + CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS);
}

/**
 * True when the credential's CURRENT plan is the plan a model refusal was
 * observed under, that refusal covered `modelId`, and it has not expired.
 */
export function codexPlanExcludesModel(
  account: ExclusionAccount,
  modelId: string | null | undefined,
  now: Date,
): boolean {
  const entry = exclusionEntry(account, modelId);
  return entry !== null && codexPlanExclusionExpiresAt(entry).getTime() > now.getTime();
}

/**
 * True when the current plan refused `modelId` before, expired or not. Used
 * only as evidence when the same plan answers the same model with an
 * ambiguous (empty) rejection again.
 */
export function codexPlanPreviouslyExcludedModel(
  account: ExclusionAccount,
  modelId: string | null | undefined,
): boolean {
  return exclusionEntry(account, modelId) !== null;
}

/** Models the current plan excludes right now, for account projections. */
export function activeCodexPlanExclusions(
  account: ExclusionAccount,
  now: Date,
): { modelId: string; excludedAt: Date; expiresAt: Date }[] {
  const exclusion = account.planEntitlementExclusion;
  if (!exclusion || exclusion.planType !== codexPlanKey(account.planType)) return [];
  return exclusion.models
    .map((entry) => ({ ...entry, expiresAt: codexPlanExclusionExpiresAt(entry) }))
    .filter((entry) => entry.expiresAt.getTime() > now.getTime())
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}

/**
 * Record one proven refusal of `modelId` under `planType` at `now`, replacing
 * any exclusion for another plan. The oldest entries fall off past the bound.
 */
export function mergeCodexPlanEntitlementExclusion(
  existing: CodexPlanEntitlementExclusion | null,
  planType: string | null,
  modelId: string,
  now: Date,
): CodexPlanEntitlementExclusion {
  const key = codexPlanKey(planType);
  const retained = existing && existing.planType === key ? existing.models : [];
  const models = [
    { modelId, excludedAt: now },
    ...retained
      .filter((entry) => entry.modelId !== modelId)
      .sort((left, right) => right.excludedAt.getTime() - left.excludedAt.getTime()),
  ].slice(0, CODEX_PLAN_ENTITLEMENT_MAX_MODELS);
  models.sort((left, right) => left.modelId.localeCompare(right.modelId));
  return { planType: key, models };
}
