import { describe, expect, test } from "bun:test";
import {
  resolveConnectorActionPolicy,
  projectConnectorToolPermission,
  requireApprovalWithFloor,
  type ConnectorActionPolicySnapshotEntry,
} from "../src/index";

function policy(
  overrides: Partial<ConnectorActionPolicySnapshotEntry> = {},
): ConnectorActionPolicySnapshotEntry {
  return {
    id: crypto.randomUUID(),
    connectionId: "connection-1",
    serverId: "docs",
    toolName: "perform_action",
    actionName: "*",
    policy: "ask",
    version: 1,
    ...overrides,
  };
}

describe("connector action policy resolution", () => {
  test("uses the most-specific exact-over-wildcard policy", () => {
    const wildcard = policy({ serverId: "*", toolName: "*", policy: "block" });
    const exact = policy({ actionName: "read", policy: "allow" });
    expect(
      resolveConnectorActionPolicy([wildcard, exact], {
        connectionId: "connection-1",
        serverId: "docs",
        toolName: "perform_action",
        actionName: "read",
      }),
    ).toEqual({ managed: true, source: "explicit", entry: exact });
  });

  test("fails closed when overlapping policies have equal specificity", () => {
    const serverExact = policy({ toolName: "*", actionName: "read", policy: "allow" });
    const toolExact = policy({ serverId: "*", actionName: "read", policy: "ask" });
    expect(
      resolveConnectorActionPolicy([serverExact, toolExact], {
        connectionId: "connection-1",
        serverId: "docs",
        toolName: "perform_action",
        actionName: "read",
      }),
    ).toEqual({ managed: true, source: "ambiguous", entry: null, decision: "block" });
  });

  test("preserves the historical unmanaged default when no policy matches", () => {
    expect(
      resolveConnectorActionPolicy([policy()], {
        connectionId: "another-connection",
        serverId: "docs",
        toolName: "perform_action",
        actionName: "read",
      }),
    ).toEqual({ managed: false });
  });

  test("explicit choices override both Allow and Ask recommendations", () => {
    for (const decision of ["allow", "ask", "block"] as const) {
      for (const defaultDecision of ["allow", "ask"] as const) {
        const entry = policy({ policy: decision });
        expect(
          resolveConnectorActionPolicy([entry], {
            connectionId: entry.connectionId,
            serverId: entry.serverId,
            toolName: entry.toolName,
            actionName: entry.toolName,
            defaultDecision,
          }),
        ).toEqual({ managed: true, source: "explicit", entry });
      }
    }
  });

  test("uses the recommendation only when no explicit choice matches", () => {
    expect(
      resolveConnectorActionPolicy([], {
        connectionId: "connection-1",
        serverId: "mail",
        toolName: "send",
        actionName: "send",
        defaultDecision: "ask",
      }),
    ).toEqual({
      managed: true,
      source: "default",
      entry: null,
      decision: "ask",
      actionName: "send",
    });
    expect(requireApprovalWithFloor(false, true, true)).toBe(false);
    expect(requireApprovalWithFloor(["delete"], ["send"], true)).toEqual(["delete"]);
    expect(requireApprovalWithFloor(undefined, ["send"], true)).toEqual(["send"]);
  });

  test("projects effective defaults and action-specific differences truthfully", () => {
    const input = {
      connectionId: "connection-1",
      serverId: "docs",
      toolName: "perform_action",
      defaultDecision: "ask" as const,
    };
    expect(projectConnectorToolPermission([], input)).toMatchObject({
      permission: "ask",
      inherited: true,
      source: "recommended",
      conditional: false,
      approvalRequired: true,
    });
    const all = policy({ policy: "allow" });
    const specific = policy({ actionName: "delete", policy: "ask" });
    expect(projectConnectorToolPermission([all, specific], input)).toMatchObject({
      permission: "allow",
      inherited: false,
      source: "tool",
      conditional: true,
      approvalRequired: true,
      actionPermissions: [{ actionName: "delete", permission: "ask" }],
    });
    expect(projectConnectorToolPermission([all], input)).toMatchObject({
      permission: "allow",
      inherited: false,
      source: "tool",
      conditional: false,
      approvalRequired: false,
    });
  });

  test("tool-named action rules appear in the same settings projection as execution", () => {
    const entry = policy({ actionName: "perform_action", policy: "block" });
    expect(
      projectConnectorToolPermission([entry], {
        connectionId: entry.connectionId,
        serverId: entry.serverId,
        toolName: entry.toolName,
        defaultDecision: "allow",
      }),
    ).toMatchObject({ permission: "block", source: "action", inherited: false });
  });
});
