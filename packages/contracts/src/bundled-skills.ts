import { z } from "zod";

export const BundledSkillId = z.enum([
  "builtin:opengeni-skills",
  "builtin:opengeni-documents",
  "builtin:opengeni-spreadsheets",
  "builtin:opengeni-presentations",
  "builtin:opengeni-sites",
  "builtin:opengeni-video-generation",
]);
export type BundledSkillId = z.infer<typeof BundledSkillId>;
export const BundledSkillSelection = z
  .array(BundledSkillId)
  .max(BundledSkillId.options.length)
  .refine((ids) => new Set(ids).size === ids.length, "bundled Skill ids must be unique")
  .transform((ids) => [...ids].sort());

/** Undefined is defaults/inheritance; an explicit empty list disables bundles. */
export function resolveBundledSkillSelection(
  requested: readonly BundledSkillId[] | undefined,
  parent: readonly BundledSkillId[] | undefined,
): BundledSkillId[] | undefined {
  const selected = requested === undefined ? parent : requested;
  if (parent !== undefined && selected?.some((id) => !parent.includes(id)))
    throw new Error("A child cannot widen its parent's bundled Skill selection");
  return selected === undefined ? undefined : BundledSkillSelection.parse(selected);
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
export function bundledSkillSelectionFromMetadata(
  metadata: Record<string, unknown>,
): BundledSkillId[] | undefined {
  const value = metadata[BUNDLED_SKILL_SELECTION_KEY];
  return value === undefined ? undefined : BundledSkillSelection.parse(value);
}
