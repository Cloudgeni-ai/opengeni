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
  }
});

test("the agents Skill saves through the existing agent and automation tools", () => {
  const text = agentsSkill();
  for (const tool of ["request_human_input", "bot_template_save", "scheduled_tasks_create"]) {
    expect(text).toContain(`\`${tool}\``);
  }
});

test("the agents Skill's trigger JSON is the agent page's, named for the agent", () => {
  const blocks = [...agentsSkill().matchAll(/```json\n([\s\S]*?)```/gu)].map(
    (match) => JSON.parse(match[1]!) as Record<string, unknown>,
  );
  const events = blocks
    .filter((block) => Array.isArray(block.triggers))
    .map((block) =>
      (block.triggers as Record<string, unknown>[]).map(({ sourceId: _source, ...rest }) => rest),
    );
  const expected = commonAgentTriggers({ agentName: "<agent name>" })
    .filter((common) => common.trigger.triggers.length > 0)
    .map((common) =>
      common.trigger.triggers.map((trigger) => ({
        eventTypes: trigger.eventTypes,
        conditions: trigger.conditions,
      })),
    );
  expect(events).toEqual(expected);
  const schedule = blocks.find((block) => block.type === "calendar");
  const weekday = commonAgentTriggers().find((common) => common.key === "weekday_morning")!;
  expect({ ...schedule, timeZone: undefined }).toEqual({
    ...weekday.trigger.schedule,
    timeZone: undefined,
  });
});
