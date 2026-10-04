import { expect, test } from "bun:test";
import {
  configuredBundledSkillNames,
  loadConfiguredBundledSkills,
} from "../src/activities/agent-turn/skill-selection";
import { formatSkillCatalog } from "@opengeni/runtime";
import { readSkillFiles } from "@opengeni/runtime/skill-library";

test("bundled selection uses configured names, not prepared schemas or optional export tools", () => {
  const context = {
    firstPartyTools: ["editable_artifact_list", "editable_artifact_get"],
    videoGenerationEnabled: false,
    get attemptToolCatalog(): never {
      throw new Error("must not inspect lazy catalog");
    },
    get sandboxBackend(): never {
      throw new Error("must not select by compute backend");
    },
  };
  expect(configuredBundledSkillNames(context)).toEqual([
    "opengeni-help",
    "opengeni-client",
    "opengeni-visualize",
    "document-parsing",
    "opengeni-skills",
    "opengeni-projects",
    "opengeni-documents",
    "opengeni-spreadsheets",
    "opengeni-presentations",
  ]);
  expect(loadConfiguredBundledSkills(context).map((entry) => entry.id)).toContain(
    "builtin:opengeni-documents",
  );
});

test("Sites, video and artifact defaults have independent inclusion conditions", () => {
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: false }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "opengeni-visualize",
    "document-parsing",
    "opengeni-skills",
    "opengeni-projects",
  ]);
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: true }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "opengeni-visualize",
    "document-parsing",
    "opengeni-skills",
    "opengeni-projects",
    "opengeni-video-generation",
  ]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["artifacts_create", "artifacts_publish"],
      videoGenerationEnabled: false,
    }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "opengeni-visualize",
    "document-parsing",
    "opengeni-skills",
    "opengeni-projects",
    "opengeni-sites",
  ]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["editable_artifact_get"],
      videoGenerationEnabled: false,
    }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "opengeni-visualize",
    "document-parsing",
    "opengeni-skills",
    "opengeni-projects",
  ]);
});

test("host selection narrows every bundled source without forcing unavailable workflows", () => {
  const context = {
    firstPartyTools: [
      "editable_artifact_list",
      "editable_artifact_get",
      "artifacts_create",
      "artifacts_publish",
    ],
    videoGenerationEnabled: true,
  };
  expect(loadConfiguredBundledSkills({ ...context, bundledSkillIds: [] })).toEqual([]);
  const selected = loadConfiguredBundledSkills({
    ...context,
    bundledSkillIds: ["builtin:opengeni-documents"],
  });
  expect(selected.map((entry) => entry.id)).toEqual(["builtin:opengeni-documents"]);
  expect(selected[0]!.artifact.files.some((file) => file.path === "SKILL.md")).toBe(true);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: [],
      videoGenerationEnabled: false,
      bundledSkillIds: [
        "builtin:opengeni-documents",
        "builtin:opengeni-sites",
        "builtin:opengeni-video-generation",
      ],
    }),
  ).toEqual([]);
});

test("schedule creation discovers readable guidance without optional dependencies or lazy setup", () => {
  const context = {
    firstPartyTools: ["scheduled_tasks_create"],
    videoGenerationEnabled: false,
    get attemptToolCatalog(): never {
      throw new Error("must not inspect lazy catalog");
    },
    get sandboxBackend(): never {
      throw new Error("must not establish compute");
    },
  };
  const skills = loadConfiguredBundledSkills(context);
  const selected = skills.find((entry) => entry.id === "builtin:opengeni-schedules")!;
  expect(selected).toBeDefined();
  const catalog = formatSkillCatalog(
    skills.map(({ id, artifact }) => ({
      id,
      name: artifact.name,
      description: artifact.description!,
    })),
  );
  expect(catalog).toContain("builtin:opengeni-schedules");
  expect(catalog).not.toContain("## Discover what the task needs");
  const content = readSkillFiles(selected.artifact.files).files[0]!.content;
  for (const tool of [
    "scheduled_tasks_list",
    "github_repositories_list",
    "variable_set_list",
    "capability_catalog_search",
    "scheduled_tasks_create",
  ])
    expect(content).toContain(tool);
});

test("schedule guidance respects the configured workflow and host exclusions", () => {
  const context = { firstPartyTools: ["scheduled_tasks_create"], videoGenerationEnabled: false };
  for (const configuration of [
    { ...context, bundledSkillIds: [] },
    { ...context, bundledSkillIds: ["builtin:opengeni-help" as const] },
    { ...context, firstPartyTools: ["scheduled_tasks_list"] },
    { ...context, firstPartyTools: [], bundledSkillIds: ["builtin:opengeni-schedules" as const] },
  ]) {
    expect(configuredBundledSkillNames(configuration)).not.toContain("opengeni-schedules");
    expect(loadConfiguredBundledSkills(configuration).map((entry) => entry.id)).not.toContain(
      "builtin:opengeni-schedules",
    );
  }
  expect(
    loadConfiguredBundledSkills({
      ...context,
      bundledSkillIds: ["builtin:opengeni-schedules"],
    }).map((entry) => entry.id),
  ).toEqual(["builtin:opengeni-schedules"]);
});
