import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("deployment instructions are explicit operator text, absent by default", () => {
  expect(getSettings({}).deploymentAgentInstructions).toBeUndefined();
  expect(
    getSettings({ OPENGENI_DEPLOYMENT_AGENT_INSTRUCTIONS: "Read /operator/AGENTS.md." })
      .deploymentAgentInstructions,
  ).toBe("Read /operator/AGENTS.md.");
});
