import { newSessionDraftToolPolicy } from "./session-tools";
import { describe, expect, test } from "bun:test";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import {
  addsConnectorOutsideDefaults,
  connectorSelectionUpdate,
  changedConnectorExclusions,
  composerConnectorOptions,
  followWorkspaceConnectorPolicy,
  newSessionConnectorCustomizeState,
} from "./composer-connectors";

function item(id: string, overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: `mcp:${id}`,
    kind: "mcp",
    source: "manual",
    name: "Slack",
    enabled: true,
    runtime: { available: true, mcpServerId: id },
    lifecycle: { status: "ready", readiness: "ready", detail: null, managedBy: "workspace" },
    connectionRef: null,
    logoAssetPath: `logos/${id}.svg`,
    ...overrides,
  } as CapabilityCatalogItem;
}
function connection(status: ConnectionMetadata["status"]): ConnectionMetadata {
  return {
    id: "connection-1",
    providerDomain: "slack.com",
    subjectId: null,
    kind: "oauth2",
    status,
  } as ConnectionMetadata;
}
const asset = (path: string | null) => (path ? `/v1/catalog-assets/${path}` : null);

describe("composer connector inventory", () => {
  test("joins by server identity, preserves instances, and omits unconnected catalog rows", () => {
    const result = composerConnectorOptions(
      [
        { id: "prod", name: "Grafana Production" },
        { id: "staging", name: "Grafana Staging" },
      ],
      [
        item("prod", { name: "Grafana Production" }),
        item("staging", { name: "Grafana Staging" }),
        item("missing", { enabled: false }),
      ],
      [],
      asset,
    );
    expect(result.map((row) => row.id)).toEqual(["prod", "staging"]);
    expect(result[0]?.logoSrc).toBe("/v1/catalog-assets/logos/prod.svg");
  });
  test("retains an enabled connection missing from executable registry and offers reconnection", () => {
    const entry = item("slack", {
      connectionRef: { connectionId: "connection-1", providerDomain: "slack.com", kind: "oauth2" },
    });
    expect(
      composerConnectorOptions([], [entry], [connection("needs_reauth")], asset)[0]
        ?.connectionStatus,
    ).toBe("reconnect");
    expect(composerConnectorOptions([], [entry], null, asset)[0]?.connectionStatus).toBe("unknown");
    expect(
      composerConnectorOptions([], [entry], [connection("active")], asset)[0]?.connectionStatus,
    ).toBe("ready");
  });
  test("preserves disconnected exclusions and only changes the toggled choice", () => {
    expect(
      changedConnectorExclusions(
        ["offline"],
        new Set(["files", "docs", "slack"]),
        new Set(["files", "docs"]),
      ),
    ).toEqual(["offline", "slack"]);
    expect(
      changedConnectorExclusions(
        ["offline", "slack"],
        new Set(["files"]),
        new Set(["files", "slack"]),
      ),
    ).toEqual(["offline"]);
  });
});

describe("connector selection policy", () => {
  test("enabling outside defaults preserves effective and hidden choices without re-enabling exclusions", () => {
    const session = {
      toolPolicy: {
        mode: "workspace_default" as const,
        inheritedFromSessionId: null,
        excludedMcpServerIds: ["excluded-hidden", "linear"],
      },
      tools: [
        { kind: "mcp" as const, id: "opengeni" },
        { kind: "mcp" as const, id: "files" },
        { kind: "mcp" as const, id: "hidden", optional: true },
        { kind: "mcp" as const, id: "excluded-hidden", optional: true },
        { kind: "mcp" as const, id: "linear", optional: true },
      ],
      firstPartyMcpTools: ["set_session_title" as const],
      toolPolicyVersion: 7,
    };
    const updated = connectorSelectionUpdate(
      session,
      new Set(["files", "docs"]),
      new Set(["files", "docs", "slack"]),
      ["files", "docs", "linear"],
    );
    expect(updated).toEqual({
      mode: "explicit",
      tools: [
        { kind: "mcp", id: "files" },
        { kind: "mcp", id: "hidden", optional: true },
        { kind: "mcp", id: "docs" },
        { kind: "mcp", id: "slack" },
      ],
      firstPartyMcpTools: ["set_session_title"],
      expectedVersion: 7,
    });
  });

  test("ordinary default toggles retain live defaults and disconnected exclusions", () => {
    const session = {
      toolPolicy: {
        mode: "workspace_default" as const,
        inheritedFromSessionId: null,
        excludedMcpServerIds: ["slack", "offline"],
      },
      tools: [],
      firstPartyMcpTools: [],
      toolPolicyVersion: 3,
    };
    expect(
      connectorSelectionUpdate(session, new Set(["files"]), new Set(["files", "slack"]), [
        "files",
        "slack",
      ]),
    ).toEqual({ mode: "workspace_default", excludedMcpServerIds: ["offline"], expectedVersion: 3 });
  });

  test("new-session outside-default selection becomes a durable explicit draft", () => {
    const before = new Set(["files"]);
    const after = new Set(["files", "slack"]);
    const explicit = addsConnectorOutsideDefaults(before, after, ["files"]);
    expect(explicit).toBe(true);
    const policy = newSessionDraftToolPolicy({
      selectedMcpServerIds: after,
      workspaceDefaultMcpServerIds: ["files"],
      catalogReady: true,
      explicit,
    });
    expect(policy).toEqual({
      tools: [
        { kind: "mcp", id: "files" },
        { kind: "mcp", id: "slack" },
      ],
      toolsProvided: true,
    });
    expect(addsConnectorOutsideDefaults(after, before, ["files"])).toBe(false);
    expect(addsConnectorOutsideDefaults(before, after, ["files", "slack"])).toBe(false);
  });

  test("customize without a pin keeps live defaults and remembers the switch", () => {
    expect(
      newSessionDraftToolPolicy({
        selectedMcpServerIds: ["files"],
        workspaceDefaultMcpServerIds: ["files", "slack"],
        catalogReady: true,
        customizing: false,
        explicit: false,
      }),
    ).toEqual({ tools: [], toolsProvided: false });
    expect(
      newSessionDraftToolPolicy({
        selectedMcpServerIds: ["files"],
        workspaceDefaultMcpServerIds: ["files", "slack"],
        catalogReady: true,
        customizing: true,
        explicit: false,
        excludedMcpServerIds: ["slack"],
      }),
    ).toEqual({
      tools: [],
      toolsProvided: true,
      excludedMcpServerIds: ["slack"],
    });
    expect(
      newSessionConnectorCustomizeState({
        toolsProvided: true,
        tools: [],
        excludedMcpServerIds: [],
      }),
    ).toEqual({ customizing: true, explicit: false });
    expect(
      followWorkspaceConnectorPolicy({ toolPolicyVersion: 4 }),
    ).toEqual({
      mode: "workspace_default",
      expectedVersion: 4,
    });
  });
});
