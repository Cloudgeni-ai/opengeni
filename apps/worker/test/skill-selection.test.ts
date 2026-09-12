import { expect, test } from "bun:test";
import {
  configuredBundledSkillNames,
  loadConfiguredBundledSkills,
} from "../src/activities/agent-turn/skill-selection";

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
  ).toEqual(["opengeni-visualize", "document-parsing", "opengeni-skills", "opengeni-projects"]);
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: true }),
  ).toEqual([
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
  ).toEqual(["opengeni-visualize", "document-parsing", "opengeni-skills", "opengeni-projects"]);
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
