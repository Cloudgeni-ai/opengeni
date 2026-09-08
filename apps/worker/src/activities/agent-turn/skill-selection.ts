import { loadNativeToolSkillArtifacts } from "@opengeni/runtime";
import { loadSkillManagementSkill } from "@opengeni/runtime/skill-library";

export type BundledSkillConfiguration = {
  /** Already resolved names, not discovered schemas or an attempt catalog. */
  firstPartyTools: readonly string[];
  videoGenerationEnabled: boolean;
};

/** Individual ordinary-code defaults, evaluated without async tool preparation. */
export function configuredBundledSkillNames(context: BundledSkillConfiguration): string[] {
  const tools = new Set(context.firstPartyTools);
  const artifacts = () => tools.has("editable_artifact_list") && tools.has("editable_artifact_get");
  const definitions = [
    { name: "opengeni-skills", include: () => true },
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
    .filter((definition) => definition.include())
    .map((definition) => definition.name);
}

export function loadConfiguredBundledSkills(context: BundledSkillConfiguration) {
  const names = new Set(configuredBundledSkillNames(context));
  const artifacts = loadNativeToolSkillArtifacts({
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
