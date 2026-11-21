import { describe, expect, test } from "bun:test";
import {
  agentGatewayFloor,
  strictestGatewayPolicy,
  withAgentGatewayFloor,
  type GatewayDecisionInput,
} from "../src/routes/personal-github-gateway-policy";

const mergeAction: GatewayDecisionInput["action"] = {
  kind: "write",
  tools: ["pull_request_merge"],
  sensitive: false,
  unscoped: false,
} as GatewayDecisionInput["action"];

const allowAll = async () => "allow" as const;

describe("agent Can use on the personal GitHub gateway", () => {
  test("a github.com Block on the merge tool refuses gh pr merge", async () => {
    const floored = withAgentGatewayFloor(
      [[{ connector: "github.com", tool: "pull_request_merge", permission: "block" }]],
      allowAll,
    );
    const result = await strictestGatewayPolicy(mergeAction, floored.lookup);
    expect(result.decision).toBe("block");
    expect(floored.agentBlocked()).toBe(true);
  });

  test("the strictest agent up the chain wins, and Allow never loosens", async () => {
    const ruleSets = [
      [{ connector: "github_personal", tool: "*", permission: "allow" as const }],
      [{ connector: "*", tool: "*", permission: "ask" as const }],
    ];
    expect(agentGatewayFloor(ruleSets, "pull_request_merge")).toBe("ask");
    const floored = withAgentGatewayFloor(ruleSets, async () => "block");
    expect((await strictestGatewayPolicy(mergeAction, floored.lookup)).decision).toBe("block");
    expect(floored.agentBlocked()).toBe(false);
  });

  test("no agent rules leave the person's decision", async () => {
    expect(agentGatewayFloor([], "pull_request_merge")).toBeNull();
    const floored = withAgentGatewayFloor(
      [[{ connector: "linear.app", tool: "*", permission: "block" }]],
      allowAll,
    );
    expect((await strictestGatewayPolicy(mergeAction, floored.lookup)).decision).toBe("allow");
  });
});
