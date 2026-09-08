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
  ).toEqual([]);
  expect(
    configuredBundledSkillNames({ firstPartyTools: [], videoGenerationEnabled: true }),
  ).toEqual(["opengeni-video-generation"]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["artifacts_create", "artifacts_publish"],
      videoGenerationEnabled: false,
    }),
  ).toEqual(["opengeni-sites"]);
  expect(
    configuredBundledSkillNames({
      firstPartyTools: ["editable_artifact_get"],
      videoGenerationEnabled: false,
    }),
  ).toEqual([]);
});
