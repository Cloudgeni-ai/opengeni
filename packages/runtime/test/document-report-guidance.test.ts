import { expect, test } from "bun:test";
import { loadNativeToolSkillArtifacts } from "../src/runtime-skills";

test("packaged Documents Skill carries the direct and secondary report delivery gate", async () => {
  const source = await Bun.file(
    new URL("../src/bundled_artifact_skills/opengeni-documents/SKILL.md", import.meta.url),
  ).text();
  const artifact = loadNativeToolSkillArtifacts({
    projects: false,
    editableArtifacts: true,
    videoGeneration: false,
  }).find((entry) => entry.name === "opengeni-documents");
  expect(artifact).toBeDefined();
  expect(artifact?.files.find((file) => file.path === "SKILL.md")?.content).toBe(source);
  expect(source).toContain("a report is a secondary output of another task");
  expect(source).toContain("a Knowledge cleanup audit");
  expect(source).toContain("before authoring");
  expect(source).toContain(
    "append the report\nrequirement without replacing the standing objective",
  );
  expect(source).toContain("server-verified artifact delivery");
  expect(source).toContain(
    "Relevant structure and review annotations were inspected after the final edit",
  );
  expect(source).toContain("Include the returned artifact reference in the handoff");
  expect(source).toContain("unfinished requirement and state the concrete blocker");
  expect(source).toContain("internal worker findings");
  expect(source).toContain("explicitly requested local-file");
});
