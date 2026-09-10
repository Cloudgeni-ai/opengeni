import { loadNativeToolSkillArtifacts } from "@opengeni/runtime";
import { loadSkillManagementSkill } from "@opengeni/runtime/skill-library";
import type { BundledSkillId } from "@opengeni/contracts";

export type BundledSkillConfiguration = {
  /** Already resolved names, not discovered schemas or an attempt catalog. */
  firstPartyTools: readonly string[];
  videoGenerationEnabled: boolean;
  bundledSkillIds?: readonly BundledSkillId[] | undefined;
};

/** Individual ordinary-code defaults, evaluated without async tool preparation. */
export function configuredBundledSkillNames(context: BundledSkillConfiguration): string[] {
  const tools = new Set(context.firstPartyTools);
  const artifacts = () => tools.has("editable_artifact_list") && tools.has("editable_artifact_get");
  const definitions = [
    { name: "opengeni-skills", include: () => true },
    { name: "opengeni-projects", include: () => true },
    { name: "opengeni-documents", include: artifacts },
    { name: "opengeni-spreadsheets", include: artifacts },
    { name: "opengeni-presentations", include: artifacts },
    {
      name: "opengeni-sites",
      include: () => tools.has("artifacts_create") && tools.has("artifacts_publish"),
    },
    { name: "opengeni-video-generation", include: () => context.videoGenerationEnabled },
  ];
  return definitions
    .filter(
      (definition) =>
        definition.include() &&
        (context.bundledSkillIds === undefined ||
          context.bundledSkillIds.includes(`builtin:${definition.name}` as BundledSkillId)),
    )
    .map((definition) => definition.name);
}

export function loadConfiguredBundledSkills(context: BundledSkillConfiguration) {
  const names = new Set(configuredBundledSkillNames(context));
  const artifacts = loadNativeToolSkillArtifacts({
    projects: names.has("opengeni-projects"),
    editableArtifacts: [
      "opengeni-documents",
      "opengeni-spreadsheets",
      "opengeni-presentations",
    ].some((name) => names.has(name)),
    sites: names.has("opengeni-sites"),
    videoGeneration: names.has("opengeni-video-generation"),
  });
  return [...artifacts, ...(names.has("opengeni-skills") ? [loadSkillManagementSkill()] : [])]
    .filter((artifact) => names.has(artifact.name))
    .map((artifact) => ({ id: `builtin:${artifact.name}`, artifact }));
}
