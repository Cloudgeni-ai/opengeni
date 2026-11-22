import { describe, expect, test } from "bun:test";
import { GITHUB_REST_READ_TOOL_NAMES } from "@opengeni/contracts";
import {
  agentGatewayFloor,
  agentsBlockEveryGitHubRead,
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

  test("gh reads are refused only when the agents block every built-in GitHub read", () => {
    expect(agentsBlockEveryGitHubRead([])).toBe(false);
    expect(
      agentsBlockEveryGitHubRead([[{ connector: "github.com", tool: "*", permission: "block" }]]),
    ).toBe(true);
    expect(agentsBlockEveryGitHubRead([[{ connector: "*", tool: "*", permission: "block" }]])).toBe(
      true,
    );
    // Ask first doesn't apply to reads, and writes-only blocks leave reads alone.
    expect(
      agentsBlockEveryGitHubRead([[{ connector: "github.com", tool: "*", permission: "ask" }]]),
    ).toBe(false);
    expect(
      agentsBlockEveryGitHubRead([
        [{ connector: "github.com", tool: "pull_request_merge", permission: "block" }],
      ]),
    ).toBe(false);
    // One read tool allowed through an exact rule keeps reads open.
    expect(
      agentsBlockEveryGitHubRead([
        [
          { connector: "github.com", tool: "*", permission: "block" },
          { connector: "github.com", tool: "file_get", permission: "allow" },
        ],
      ]),
    ).toBe(false);
    // Rules spread over the chain still cover every read.
    const half = Math.floor(GITHUB_REST_READ_TOOL_NAMES.length / 2);
    const rules = (tools: readonly string[]) =>
      tools.map((tool) => ({ connector: "github_personal", tool, permission: "block" as const }));
    expect(
      agentsBlockEveryGitHubRead([
        rules(GITHUB_REST_READ_TOOL_NAMES.slice(0, half)),
        rules(GITHUB_REST_READ_TOOL_NAMES.slice(half)),
      ]),
    ).toBe(true);
  });
});
