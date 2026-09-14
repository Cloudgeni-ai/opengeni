import { describe, expect, test } from "bun:test";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import { changedConnectorExclusions, composerConnectorOptions } from "./composer-connectors";

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
