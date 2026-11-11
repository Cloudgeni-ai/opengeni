import { describe, expect, test } from "bun:test";
import {
  resolveConnectorActionPolicy,
  type ConnectorActionPolicySnapshotEntry,
} from "@opengeni/db";
import { GITHUB_SENSITIVE_REQUEST_POLICY_NAME } from "@opengeni/core";
import {
  PERSONAL_GITHUB_POLICY_SERVER_ID,
  strictestGatewayPolicy,
  type GatewayDecisionInput,
  type GatewayPolicyLookup,
} from "../src/routes/personal-github-gateway-policy";

const connectionId = "personal-github-connection";

function policy(
  toolName: string,
  decision: "allow" | "ask" | "block",
): ConnectorActionPolicySnapshotEntry {
  return {
    id: crypto.randomUUID(),
    connectionId,
    serverId: PERSONAL_GITHUB_POLICY_SERVER_ID,
    toolName,
    actionName: toolName === "*" ? "*" : toolName,
    policy: decision,
    version: 1,
  };
}

/** Resolves like `resolveAttemptConnectorToolDecision` over a frozen snapshot. */
function lookupIn(snapshot: ConnectorActionPolicySnapshotEntry[]): GatewayPolicyLookup {
  return async ({ toolName, defaultDecision, decide }) => {
    const resolved = resolveConnectorActionPolicy(snapshot, {
      connectionId,
      serverId: PERSONAL_GITHUB_POLICY_SERVER_ID,
      toolName,
      actionName: toolName,
      defaultDecision,
    });
    if (decide) return decide(resolved);
    return resolved.managed ? (resolved.entry?.policy ?? resolved.decision) : defaultDecision;
  };
}

const environmentSecret: GatewayDecisionInput["action"] = {
  kind: "write",
  tools: [],
  sensitive: true,
  title: "Change repository environments",
};
const tagDeletion: GatewayDecisionInput["action"] = {
  kind: "write",
  tools: ["ref_create"],
  sensitive: true,
  title: "Delete branch or tag",
};

describe("Settings and deletions in the gateway's decision", () => {
  test("asks without a choice, even when every other GitHub action is allowed", async () => {
    const snapshot = [policy("ref_create", "allow"), policy("issue_create", "allow")];
    expect(await strictestGatewayPolicy(environmentSecret, lookupIn(snapshot))).toEqual({
      decision: "ask",
      toolName: GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
    });
    expect((await strictestGatewayPolicy(tagDeletion, lookupIn(snapshot))).decision).toBe("ask");
  });

  test("runs without asking once the person allows it", async () => {
    const snapshot = [
      policy("ref_create", "allow"),
      policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "allow"),
    ];
    expect((await strictestGatewayPolicy(environmentSecret, lookupIn(snapshot))).decision).toBe(
      "allow",
    );
    expect((await strictestGatewayPolicy(tagDeletion, lookupIn(snapshot))).decision).toBe("allow");
  });

  test("the strictest of the matching action and Settings and deletions wins", async () => {
    const askFirst = [
      policy("ref_create", "ask"),
      policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "allow"),
    ];
    expect(await strictestGatewayPolicy(tagDeletion, lookupIn(askFirst))).toEqual({
      decision: "ask",
      // Not the deciding action: an approval must still match after a policy change.
      toolName: GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
    });
    const blocked = [
      policy("ref_create", "allow"),
      policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "block"),
    ];
    expect((await strictestGatewayPolicy(tagDeletion, lookupIn(blocked))).decision).toBe("block");
    // A request that isn't sensitive never reads it.
    expect(
      (
        await strictestGatewayPolicy(
          { ...tagDeletion, sensitive: false, title: "Delete branch" },
          lookupIn(blocked),
        )
      ).decision,
    ).toBe("allow");
  });

  test("a connection-wide Allow doesn't cover it, but a connection-wide Block does", async () => {
    expect(
      (await strictestGatewayPolicy(environmentSecret, lookupIn([policy("*", "allow")]))).decision,
    ).toBe("ask");
    expect(
      (await strictestGatewayPolicy(environmentSecret, lookupIn([policy("*", "block")]))).decision,
    ).toBe("block");
    expect(
      (
        await strictestGatewayPolicy(
          environmentSecret,
          lookupIn([policy("*", "allow"), policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "allow")]),
        )
      ).decision,
    ).toBe("allow");
  });

  test("a write whose repositories can't be confirmed asks even when everything is allowed", async () => {
    const unscoped: GatewayDecisionInput["action"] = {
      ...environmentSecret,
      unscoped: true,
      title: "Unrecognised GitHub GraphQL request",
    };
    const allowAll = [policy("*", "allow"), policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "allow")];
    expect(await strictestGatewayPolicy(unscoped, lookupIn(allowAll))).toEqual({
      decision: "ask",
      toolName: GITHUB_SENSITIVE_REQUEST_POLICY_NAME,
    });
    expect(
      (
        await strictestGatewayPolicy(
          unscoped,
          lookupIn([policy(GITHUB_SENSITIVE_REQUEST_POLICY_NAME, "block")]),
        )
      ).decision,
    ).toBe("block");
  });

  test("records the same action whatever the decisions", async () => {
    const routine: GatewayDecisionInput["action"] = {
      kind: "write",
      tools: ["issue_create", "ref_create"],
      sensitive: false,
      title: "Create issue",
    };
    expect(
      (await strictestGatewayPolicy(routine, lookupIn([policy("ref_create", "ask")]))).toolName,
    ).toBe("issue_create");
  });
});
