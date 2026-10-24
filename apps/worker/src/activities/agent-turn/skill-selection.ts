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
    { name: "opengeni-help", include: () => true },
    { name: "opengeni-client", include: () => true },
    { name: "visualize", include: () => true },
    { name: "document-parsing", include: () => true },
    { name: "skill-management", include: () => true },
    { name: "projects", include: () => true },
    { name: "schedules", include: () => tools.has("scheduled_tasks_create") },
    {
      name: "event-triggers",
      include: () => tools.has("scheduled_tasks_create") && tools.has("event_sources_list"),
    },
    { name: "documents", include: artifacts },
    { name: "spreadsheets", include: artifacts },
    { name: "presentations", include: artifacts },
    {
      name: "sites",
      include: () => tools.has("artifacts_create") && tools.has("artifacts_publish"),
    },
    { name: "secrets", include: () => tools.has("secret_search") },
    { name: "video-generation", include: () => context.videoGenerationEnabled },
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
  if (names.size === 0) return [];
  const artifacts = loadNativeToolSkillArtifacts({
    projects: names.has("projects"),
    schedules: names.has("schedules") || names.has("event-triggers"),
    editableArtifacts: ["documents", "spreadsheets", "presentations"].some((name) =>
      names.has(name),
    ),
    sites: names.has("sites"),
    secrets: names.has("secrets"),
    videoGeneration: names.has("video-generation"),
  });
  return [...artifacts, ...(names.has("skill-management") ? [loadSkillManagementSkill()] : [])]
    .filter((artifact) => names.has(artifact.name))
    .map((artifact) => ({ id: `builtin:${artifact.name}`, artifact }));
}
