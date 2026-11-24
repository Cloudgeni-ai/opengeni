import { expect, test } from "bun:test";
import { commonAgentTriggers } from "@opengeni/contracts";
import { loadNativeToolSkillArtifacts } from "../src/runtime-skills";

function agentsSkill(): string {
  const artifact = loadNativeToolSkillArtifacts({
    defaults: false,
    agents: true,
    editableArtifacts: false,
    videoGeneration: false,
  }).find((entry) => entry.name === "agents");
  if (!artifact) throw new Error("Missing agents artifact");
  return artifact.files.find((entry) => entry.path === "SKILL.md")!.content;
}

test("the agents Skill lists the same common triggers as the agent page", () => {
  const text = agentsSkill().replace(/\s+/gu, " ");
  for (const common of commonAgentTriggers()) {
    expect(text).toContain(`**${common.trigger.name}**`);
    expect(text).toContain(common.trigger.instructions.replace(/\s+/gu, " "));
    for (const trigger of common.trigger.triggers) {
      for (const eventType of trigger.eventTypes) expect(text).toContain(`\`${eventType}\``);
    }
  }
});

test("the agents Skill saves through the existing agent and automation tools", () => {
  const text = agentsSkill();
  for (const tool of ["request_human_input", "bot_template_save", "scheduled_tasks_create"]) {
    expect(text).toContain(`\`${tool}\``);
  }
});
