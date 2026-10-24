import { describe, expect, test } from "bun:test";
import { agentProfileCreateDefaults } from "../src/domain/agent-profiles";

describe("agentProfileCreateDefaults", () => {
  const config = {
    agent: {
      capabilities: { from: "all" as const, browser: false },
      instructions: "Review pull requests.",
      renderer: "opengeni" as const,
    },
    model: "gpt-test",
    reasoningEffort: "high" as const,
    installedSkillIds: ["00000000-0000-4000-8000-000000000001"],
    tools: [{ kind: "mcp" as const, id: "github" }],
  };

  test("fills every field the request leaves unset", () => {
    expect(agentProfileCreateDefaults({ initialMessage: "hi" }, config)).toEqual({
      agent: config.agent,
      model: "gpt-test",
      reasoningEffort: "high",
      installedSkillIds: config.installedSkillIds,
      tools: config.tools,
    });
  });

  test("explicit request fields always win", () => {
    const defaults = agentProfileCreateDefaults(
      {
        agent: { renderer: "markdown" },
        model: "other-model",
        tools: [],
        installedSkillIds: [],
      },
      config,
    );
    expect(defaults).toEqual({});
  });

  test("an effort is only carried together with the profile's model", () => {
    expect(agentProfileCreateDefaults({ model: "other-model" }, config)).not.toHaveProperty(
      "reasoningEffort",
    );
    expect(
      agentProfileCreateDefaults({ reasoningEffort: "low" }, config)["reasoningEffort"],
    ).toBeUndefined();
  });

  test("a request-level instructions field keeps precedence over the profile alias", () => {
    const defaults = agentProfileCreateDefaults({ instructions: "Mine." }, config);
    expect(defaults["agent"]).toEqual({
      capabilities: config.agent.capabilities,
      renderer: "opengeni",
    });
  });

  test("an empty profile contributes nothing", () => {
    expect(agentProfileCreateDefaults({}, {})).toEqual({});
  });
});
