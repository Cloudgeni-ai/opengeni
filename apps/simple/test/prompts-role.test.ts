import { expect, test } from "bun:test";
import { composeInstructions, customInstructionsFrom } from "../server/prompts";

test("an agent's own role comes back out of its composed instructions", () => {
  const role = "You keep an eye on my repos.\n\n## Extra\nCheck CI daily.";
  expect(
    customInstructionsFrom(composeInstructions({ role: "agent", customInstructions: role })),
  ).toBe(role);
});

test("instructions without a role give nothing back", () => {
  expect(customInstructionsFrom(composeInstructions({ role: "main" }))).toBeNull();
  expect(customInstructionsFrom(composeInstructions({ role: "agent", blank: true }))).toBeNull();
  expect(customInstructionsFrom(null)).toBeNull();
});
