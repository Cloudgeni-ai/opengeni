import { expect, test } from "bun:test";
import { buildOpenGeniAgent, persistentAgentInstructionInspectionFor } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { loadConfiguredBundledSkills } from "../src/activities/agent-turn/skill-selection";

test("ordinary integration guidance is discoverable on every compute shape without loading its body", () => {
  for (const sandboxBackend of ["none", "local", "docker", "modal", "selfhosted"] as const) {
    for (const bundledSkillIds of [undefined, []] as const) {
      const selected = loadConfiguredBundledSkills({
        firstPartyTools: [],
        videoGenerationEnabled: false,
        bundledSkillIds,
      });
      const agent = buildOpenGeniAgent(
        testSettings({ sandboxBackend, webSearchEnabled: false }),
        [],
        {
          activeSandboxBackend: sandboxBackend,
          ...(sandboxBackend === "selfhosted" ? { sandboxWorkspaceRoot: "/srv/product" } : {}),
          skillCatalog: selected.map(({ id, artifact }) => ({
            id,
            name: artifact.name,
            description: artifact.description!,
          })),
        },
      );
      const instructions = persistentAgentInstructionInspectionFor(agent).composed;
      expect(instructions.includes('"id":"builtin:opengeni-client"')).toBe(
        bundledSkillIds === undefined,
      );
      expect(instructions).not.toContain("## Choose the product experience before the transport");
    }
  }
});
