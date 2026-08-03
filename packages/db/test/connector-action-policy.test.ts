import { describe, expect, test } from "bun:test";
import {
  resolveConnectorActionPolicy,
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
});
