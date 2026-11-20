import { describe, expect, test } from "bun:test";
import {
  agentCanUseDecision,
  agentCanUseFor,
  withAgentCanUse,
} from "../src/activities/agent-turn/agent-can-use";

const call = {
  serverId: "route-gmail-1",
  toolName: "send_email",
  connectionId: "connection-1",
} as Parameters<typeof withAgentCanUse>[1];

describe("agent Can use", () => {
  test("no rules means no floor", () => {
    expect(agentCanUseFor({ rules: [], bindings: [], servers: [] })).toBeNull();
    expect(withAgentCanUse(null, call)).toBe(call);
  });

  test("a gateway route resolves to its provider domain", () => {
    const canUse = agentCanUseFor({
      rules: [{ connector: "gmail.com", tool: "send_email", permission: "ask" }],
      bindings: [
        {
          serverId: "route-gmail-1",
          canonicalServerId: "gmail",
          providerDomain: "gmail.com",
        },
      ],
      servers: [],
    })!;
    expect(agentCanUseDecision(canUse, call)).toBe("ask");
    expect(withAgentCanUse(canUse, call).minimumDecision).toBe("ask");
  });

  test("a configured server's domain comes from its connection", () => {
    const canUse = agentCanUseFor({
      rules: [{ connector: "linear.app", tool: "*", permission: "block" }],
      bindings: null,
      servers: [{ id: "linear", connectionRef: { providerDomain: "linear.app" } }],
    })!;
    expect(
      agentCanUseDecision(canUse, {
        serverId: "linear",
        toolName: "create_issue",
      }),
    ).toBe("block");
  });

  test("Allow follows the connection and Block is never weakened", () => {
    const allow = agentCanUseFor({
      rules: [{ connector: "*", tool: "*", permission: "allow" }],
      bindings: [],
      servers: [],
    })!;
    expect(withAgentCanUse(allow, call)).toBe(call);
    const ask = agentCanUseFor({
      rules: [{ connector: "*", tool: "*", permission: "ask" }],
      bindings: [],
      servers: [],
    })!;
    expect(withAgentCanUse(ask, { ...call, minimumDecision: "block" }).minimumDecision).toBe(
      "block",
    );
  });

  test("a call without a connection gets one to record the decision on", () => {
    const canUse = agentCanUseFor({
      rules: [{ connector: "*", tool: "*", permission: "block" }],
      bindings: [],
      servers: [],
    })!;
    const result = withAgentCanUse(canUse, {
      ...call,
      connectionId: undefined,
    });
    expect(result.connectionId).toBe("agent-can-use:route-gmail-1");
    expect(result.minimumDecision).toBe("block");
  });
});
