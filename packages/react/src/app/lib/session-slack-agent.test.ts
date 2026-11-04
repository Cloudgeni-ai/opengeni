import { expect, test } from "bun:test";
import { sessionSlackAgent } from "@opengeni/contracts";

import { sessionSlackAgentInfo } from "./session-slack-agent";

const ID = "11111111-1111-4111-8111-111111111111";

test("reads the same Slack agent as the contracts parser", () => {
  const cases: (Record<string, unknown> | null | undefined)[] = [
    undefined,
    null,
    {},
    { slackAgent: null },
    { slackAgent: "Data team" },
    { slackAgent: [] },
    { slackAgent: { id: ID } },
    { slackAgent: { id: "not-a-uuid", name: "Data team" } },
    { slackAgent: { id: ID, name: "" } },
    { slackAgent: { id: ID, name: 7 } },
    { slackAgent: { id: ID, name: "Data team" } },
    { slackAgent: { id: ID, name: "Data team", extra: true } },
  ];
  for (const metadata of cases) {
    expect(sessionSlackAgentInfo(metadata)).toEqual(sessionSlackAgent(metadata));
  }
  expect(sessionSlackAgentInfo({ slackAgent: { id: ID, name: "Data team" } })).toEqual({
    id: ID,
    name: "Data team",
  });
});
