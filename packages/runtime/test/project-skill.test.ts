import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  effectiveSkillSelectionsForAgent,
  persistentAgentInstructionInspectionFor,
} from "../src/index";
import { composeRuntimeSkills, loadNativeToolSkillArtifacts } from "../src/runtime-skills";

test("Projects guidance is a canonical packaged artifact, not sandbox materialization", async () => {
  const markdown = await Bun.file(
    new URL("../src/bundled_project_skills/opengeni-projects/SKILL.md", import.meta.url),
  ).text();
  const artifacts = loadNativeToolSkillArtifacts({
    projects: true,
    editableArtifacts: false,
    videoGeneration: false,
  });
  expect(artifacts.map((artifact) => artifact.name)).toEqual([
    "document-parsing",
    "opengeni-visualize",
    "opengeni-projects",
  ]);
  const artifact = artifacts.find((entry) => entry.name === "opengeni-projects");
  expect(artifact?.name).toBe("opengeni-projects");
  expect(artifact?.files).toEqual([{ path: "SKILL.md", content: markdown }]);
  const composition = composeRuntimeSkills([]);
  expect(composition.nativeToolNames).not.toContain("opengeni-projects");
  expect(composition.selections.map((selection) => selection.name)).toEqual([
    "document-parsing",
    "opengeni-visualize",
  ]);
  expect(composition.index.map((entry) => entry.name)).toEqual([
    "document-parsing",
    "opengeni-visualize",
  ]);
});

test("every compute backend inspects only selected Project descriptors with no eager loader", () => {
  const artifact = loadNativeToolSkillArtifacts({
    projects: true,
    editableArtifacts: false,
    videoGeneration: false,
  }).find((entry) => entry.name === "opengeni-projects");
  if (!artifact) throw new Error("Missing Projects artifact");
  for (const sandboxBackend of ["none", "local", "docker", "modal", "selfhosted"] as const) {
    for (const selected of [false, true]) {
      const agent = buildOpenGeniAgent(
        testSettings({ sandboxBackend, webSearchEnabled: false }),
        [],
        {
          activeSandboxBackend: sandboxBackend,
          ...(sandboxBackend === "selfhosted" ? { sandboxWorkspaceRoot: "/srv/project" } : {}),
          skillCatalog: selected
            ? [
                {
                  id: "builtin:opengeni-projects",
                  name: artifact.name,
                  description: artifact.description!,
                },
              ]
            : [],
        },
      );
      const inspection = persistentAgentInstructionInspectionFor(agent);
      expect(inspection.composed.includes("opengeni-projects")).toBe(selected);
      expect(inspection.layers.some((layer) => layer.id === "builtin_skills")).toBe(false);
      expect(inspection.layers.find((layer) => layer.id === "skill_catalog")?.content).toContain(
        "skill_read",
      );
      expect(inspection.composed).not.toContain(
        "Projects are named, workspace-shared groups of sessions.",
      );
      expect(inspection.composed).not.toContain("load_builtin_skill");
      expect(
        agent.tools.some((tool) => tool.type === "function" && tool.name === "load_builtin_skill"),
      ).toBe(false);
      expect(effectiveSkillSelectionsForAgent(agent).map((skill) => skill.id)).not.toContain(
        "native-tool:opengeni-projects",
      );
    }
  }
});
