import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  effectiveSkillSelectionsForAgent,
  persistentAgentInstructionInspectionFor,
} from "../src/index";
import { builtinSkillLoader, composeRuntimeSkills } from "../src/runtime-skills";

test("every compute backend indexes and loads the project skill without a sandbox session", async () => {
  const markdown = await Bun.file(
    new URL("../src/bundled_project_skills/opengeni-projects/SKILL.md", import.meta.url),
  ).text();
  for (const sandboxBackend of ["none", "local", "docker", "modal", "selfhosted"] as const) {
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend, webSearchEnabled: false }),
      [],
      {
        activeSandboxBackend: sandboxBackend,
        ...(sandboxBackend === "selfhosted" ? { sandboxWorkspaceRoot: "/srv/project" } : {}),
      },
    );
    const instructions = persistentAgentInstructionInspectionFor(agent).composed;
    expect(instructions).toContain("opengeni-projects");
    expect(instructions).toContain("load_builtin_skill");
    expect(instructions).not.toContain("Projects are named, workspace-shared groups of sessions.");
    expect(effectiveSkillSelectionsForAgent(agent).map((s) => s.name)).toContain(
      "opengeni-projects",
    );
    const loader = agent.tools.find(
      (t) => t.type === "function" && t.name === "load_builtin_skill",
    );
    if (!loader || loader.type !== "function") throw new Error("Missing built-in skill loader");
    expect(
      await loader.invoke(new RunContext(), JSON.stringify({ skill_name: "opengeni-projects" })),
    ).toBe(markdown);
  }
});

test("built-in skills stay outside sandbox materialization and reject arbitrary names", async () => {
  const composition = composeRuntimeSkills([]);
  expect(composition.nativeToolNames).toContain("opengeni-projects");
  expect(
    composition.lazySource.getIndex!({ extraPathGrants: [] } as never, ".agents").map(
      (s) => s.name,
    ),
  ).not.toContain("opengeni-projects");
  const loader = builtinSkillLoader();
  const result = await loader.invoke(
    new RunContext(),
    JSON.stringify({ skill_name: "../../secrets" }),
  );
  expect(result).not.toContain("Projects are named, workspace-shared groups of sessions.");
});
