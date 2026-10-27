import { expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { reconnectablePersonalMcpConnections } from "../src/mcp-connection-status";

const GMAIL = "https://gmailmcp.googleapis.com/mcp/v1";

function connection(id: string, overrides: Partial<ConnectionMetadata> = {}) {
  return {
    id,
    kind: "oauth2",
    status: "active",
    subjectId: "user-1",
    metadata: { mcpUrl: GMAIL },
    ...overrides,
  } as ConnectionMetadata;
}

test("removed personal connections do not make a reconnect ambiguous", () => {
  const connections = [
    connection("removed-1", { status: "revoked" }),
    connection("removed-2", { status: "revoked" }),
  ];
  expect(reconnectablePersonalMcpConnections(connections, GMAIL)).toEqual([]);
});

test("a single live personal connection is still reauthorized in place", () => {
  const live = connection("live");
  const connections = [connection("removed", { status: "revoked" }), live];
  expect(reconnectablePersonalMcpConnections(connections, GMAIL)).toEqual([live]);
});

test("workspace connections and other endpoints are not personal reconnect candidates", () => {
  const connections = [
    connection("workspace", { subjectId: null }),
    connection("drive", { metadata: { mcpUrl: "https://drivemcp.googleapis.com/mcp/v1" } }),
    connection("live-a"),
    connection("live-b"),
  ];
  expect(
    reconnectablePersonalMcpConnections(connections, GMAIL).map((entry) => entry.id),
  ).toEqual(["live-a", "live-b"]);
});
