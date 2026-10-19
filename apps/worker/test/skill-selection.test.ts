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
    "visualize",
    "document-parsing",
    "skill-management",
    "projects",
    "documents",
    "spreadsheets",
    "presentations",
  ]);
  expect(loadConfiguredBundledSkills(context).map((entry) => entry.id)).toContain(
    "builtin:documents",
  );
});

test("Sites, video and artifact defaults have independent inclusion conditions", () => {
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: false }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "visualize",
    "document-parsing",
    "skill-management",
    "projects",
  ]);
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: true }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "visualize",
    "document-parsing",
    "skill-management",
    "projects",
    "video-generation",
  ]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["artifacts_create", "artifacts_publish"],
      videoGenerationEnabled: false,
    }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "visualize",
    "document-parsing",
    "skill-management",
    "projects",
    "sites",
  ]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["editable_artifact_get"],
      videoGenerationEnabled: false,
    }),
  ).toEqual([
    "opengeni-help",
    "opengeni-client",
    "visualize",
    "document-parsing",
    "skill-management",
    "projects",
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
    bundledSkillIds: ["builtin:documents"],
  });
  expect(selected.map((entry) => entry.id)).toEqual(["builtin:documents"]);
  expect(selected[0]!.artifact.files.some((file) => file.path === "SKILL.md")).toBe(true);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: [],
      videoGenerationEnabled: false,
      bundledSkillIds: [
        "builtin:documents",
        "builtin:sites",
        "builtin:video-generation",
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
  const selected = skills.find((entry) => entry.id === "builtin:schedules")!;
  expect(selected).toBeDefined();
  const catalog = formatSkillCatalog(
    skills.map(({ id, artifact }) => ({
      id,
      name: artifact.name,
      description: artifact.description!,
    })),
  );
  expect(catalog).toContain("builtin:schedules");
  expect(catalog).not.toContain("## Discover what the task needs");
  const content = readSkillFiles(selected.artifact.files).files[0]!.content;
  for (const tool of [
    "scheduled_tasks_list",
    "github_repositories_list",
    "secret_search",
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
    { ...context, firstPartyTools: [], bundledSkillIds: ["builtin:schedules" as const] },
  ]) {
    expect(configuredBundledSkillNames(configuration)).not.toContain("schedules");
    expect(loadConfiguredBundledSkills(configuration).map((entry) => entry.id)).not.toContain(
      "builtin:schedules",
    );
  }
  expect(
    loadConfiguredBundledSkills({
      ...context,
      bundledSkillIds: ["builtin:schedules"],
    }).map((entry) => entry.id),
  ).toEqual(["builtin:schedules"]);
});

test("secrets guidance follows the selected secret_search tool and host selection", () => {
  const context = { firstPartyTools: ["secret_search"], videoGenerationEnabled: false };
  expect(configuredBundledSkillNames(context)).toContain("secrets");
  const selected = loadConfiguredBundledSkills(context).find(
    (entry) => entry.id === "builtin:secrets",
  )!;
  expect(selected).toBeDefined();
  const paths = selected.artifact.files.map((file) => file.path).sort();
  expect(paths).toEqual([
    "SKILL.md",
    "references/2fa-enrollment.md",
    "references/account-creation.md",
    "references/api-keys.md",
    "references/ask-card.md",
    "references/codemode-and-scripts.md",
    "references/login-playbook.md",
    "references/troubleshooting.md",
  ]);
  // Capability off: the capability gate removes every secret_* tool first.
  for (const configuration of [
    { ...context, firstPartyTools: [] },
    { ...context, firstPartyTools: ["secret_save", "secret_get"] },
    { ...context, bundledSkillIds: [] },
    { ...context, bundledSkillIds: ["builtin:opengeni-help" as const] },
  ]) {
    expect(configuredBundledSkillNames(configuration)).not.toContain("secrets");
    expect(loadConfiguredBundledSkills(configuration).map((entry) => entry.id)).not.toContain(
      "builtin:secrets",
    );
  }
  expect(
    loadConfiguredBundledSkills({
      ...context,
      bundledSkillIds: ["builtin:secrets"],
    }).map((entry) => entry.id),
  ).toEqual(["builtin:secrets"]);
});
