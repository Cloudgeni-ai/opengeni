import { describe, expect, test } from "bun:test";

import { connectorActionBlockedMessage } from "../src/index";

describe("connectorActionBlockedMessage", () => {
  test("names the agent and rule that blocked the call", () => {
    expect(
      connectorActionBlockedMessage({
        agentId: "agent-1",
        agentName: "Reviewer",
        connector: "github.com",
        tool: "*",
        permission: "block",
      }),
    ).toBe(
      'Connector action was not executed: blocked by the agent "Reviewer" (its Can use rule blocks all tools of github.com)',
    );
  });

  test("keeps the plain refusal otherwise", () => {
    expect(connectorActionBlockedMessage()).toBe("Connector action was not executed: blocked");
  });
});
