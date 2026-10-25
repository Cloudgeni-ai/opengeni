import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Ids are permanent. The product-named ids on the left were renamed to
 * neutral ones so embedding products never show another product's name to
 * their agents. They stay accepted in requests and stored selections, and
 * every selection resolves them to the current id.
 */
export const LEGACY_BUNDLED_SKILL_IDS = {
  "builtin:opengeni-visualize": "builtin:visualize",
  "builtin:opengeni-skills": "builtin:skill-management",
  "builtin:opengeni-projects": "builtin:projects",
  "builtin:opengeni-schedules": "builtin:schedules",
  "builtin:opengeni-documents": "builtin:documents",
  "builtin:opengeni-spreadsheets": "builtin:spreadsheets",
  "builtin:opengeni-presentations": "builtin:presentations",
  "builtin:opengeni-sites": "builtin:sites",
  "builtin:opengeni-video-generation": "builtin:video-generation",
  "builtin:opengeni-secrets": "builtin:secrets",
} as const;
const CURRENT_BUNDLED_SKILL_IDS = [
  "builtin:opengeni-help",
  "builtin:opengeni-client",
  "builtin:visualize",
  "builtin:document-parsing",
  "builtin:skill-management",
  "builtin:projects",
  "builtin:schedules",
  "builtin:event-triggers",
  "builtin:documents",
  "builtin:spreadsheets",
  "builtin:presentations",
  "builtin:sites",
  "builtin:video-generation",
  "builtin:secrets",
] as const;
type LegacyBundledSkillId = keyof typeof LEGACY_BUNDLED_SKILL_IDS;

/** Every accepted id: the current ids, then the legacy ids they replaced. */
export const BundledSkillId = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    ...CURRENT_BUNDLED_SKILL_IDS,
    ...(Object.keys(LEGACY_BUNDLED_SKILL_IDS) as LegacyBundledSkillId[]),
  ]),
);
export type BundledSkillId = z.infer<typeof BundledSkillId>;

/** The current id for a bundled Skill id; a legacy id maps to its rename. */
export function canonicalBundledSkillId<T extends string>(id: T): T | BundledSkillId {
  return (LEGACY_BUNDLED_SKILL_IDS as Record<string, BundledSkillId>)[id] ?? id;
}

export const BundledSkillSelection = /* @__PURE__ */ defineSchema(() =>
  z
    .array(BundledSkillId)
    .max(BundledSkillId.options.length)
    .transform((ids) => ids.map((id) => canonicalBundledSkillId(id)))
    .refine((ids) => new Set(ids).size === ids.length, "bundled Skill ids must be unique")
    .transform((ids) => [...ids].sort()),
);

/** Undefined is defaults/inheritance; an explicit empty list disables bundles. */
export function resolveBundledSkillSelection(
  requested: readonly BundledSkillId[] | undefined,
  parent: readonly BundledSkillId[] | undefined,
): BundledSkillId[] | undefined {
  const selected = (requested === undefined ? parent : requested)?.map((id) =>
    canonicalBundledSkillId(id),
  );
  const allowed = parent?.map((id) => canonicalBundledSkillId(id));
  if (allowed !== undefined && selected?.some((id) => !allowed.includes(id)))
    throw new Error("A child cannot widen its parent's bundled Skill selection");
  return selected === undefined ? undefined : BundledSkillSelection.parse(selected);
}

/**
 * Freeze the defaults a session's agent configuration implies. An agent that
 * starts from `capabilities: "none"` carries no bundled Opengeni guides unless
 * the request lists them; an explicit list (including `[]`) is kept exactly,
 * and `"all"` or legacy (null) configurations keep the bundled defaults.
 */
export function bundledSkillSelectionForAgentConfig(
  selection: BundledSkillId[] | undefined,
  agentConfig: { from: "all" | "none" } | null | undefined,
): BundledSkillId[] | undefined {
  return selection === undefined && agentConfig?.from === "none" ? [] : selection;
}

// Immutable session configuration, following the existing create-identity
// metadata convention. Callers cannot set this through arbitrary metadata.
const BUNDLED_SKILL_SELECTION_KEY = "_opengeni_bundled_skill_ids_v1";
export function withBundledSkillSelectionMetadata(
  metadata: Record<string, unknown>,
  ids: readonly BundledSkillId[] | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next[BUNDLED_SKILL_SELECTION_KEY];
  if (ids !== undefined) next[BUNDLED_SKILL_SELECTION_KEY] = BundledSkillSelection.parse(ids);
  return next;
}
/**
 * Stored-data read. Ids are permanent, but a row written by a newer (or
 * rolled-back-from) release can hold an id this build lacks. Such ids are
 * dropped rather than failing the session read; dropping only narrows the
 * stored selection and never turns it back into defaults. Input stays strict,
 * and a value that is not a list of id strings still fails.
 */
const StoredBundledSkillSelection = /* @__PURE__ */ defineSchema(() => z.array(z.string()));
const knownBundledSkillIds: ReadonlySet<string> = new Set(CURRENT_BUNDLED_SKILL_IDS);
/**
 * Exact stored selection for keyed create replay identity. Unlike the
 * tolerant read, it keeps ids this build does not know: a retry must match
 * what was stored, not the narrowed projection of it.
 */
export function storedBundledSkillSelectionIdentity(metadata: Record<string, unknown>): unknown {
  return metadata[BUNDLED_SKILL_SELECTION_KEY];
}
export function bundledSkillSelectionFromMetadata(
  metadata: Record<string, unknown>,
): BundledSkillId[] | undefined {
  const value = metadata[BUNDLED_SKILL_SELECTION_KEY];
  if (value === undefined) return undefined;
  const known = StoredBundledSkillSelection.parse(value)
    .map((id) => canonicalBundledSkillId(id))
    .filter((id): id is BundledSkillId => knownBundledSkillIds.has(id));
  return [...new Set(known)].sort();
}
