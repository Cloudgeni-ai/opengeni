import { expect, test } from "bun:test";
import { StrictMode } from "react";
import type { OpenGeniClient, CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { matchingActiveMcpConnections } from "../src/mcp-connection-status";
import { actRun, registerDom, renderComponent } from "./render-hook";
registerDom();
const { McpConnectionCard } = await import("../src/components/session-mcp-capability-card");

const item = {
  id: "service",
  kind: "mcp",
  authKind: "oauth2",
  name: "Example service",
  enabled: true,
  mcpUrl: "https://service.example/mcp",
  providerDomain: "service.example",
  connectionRef: { connectionId: "account", kind: "oauth2", subjectScope: "workspace" },
} as CapabilityCatalogItem;
const connection: ConnectionMetadata = {
  id: "account",
  accountId: "organization",
  workspaceId: "workspace",
  providerDomain: "service.example",
  kind: "oauth2",
  status: "active",
  subjectId: null,
  metadata: { mcpUrl: item.mcpUrl },
  grantedScopes: [],
  expiresAt: null,
  lastRefreshAt: null,
  lastUsedAt: null,
  lastError: null,
  version: 1,
  createdBySubjectId: null,
  updatedBySubjectId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("connection-only details finish without reading or mutating a session", async () => {
  const unexpected: string[] = [];
  const client = new Proxy(
    {
      listCapabilities: async () => ({ items: [item] }),
      listConnections: async () => [connection],
      connectTransport: () => ({}),
    },
    {
      get(target, key) {
        if (key in target) return Reflect.get(target, key);
        return () => {
          unexpected.push(String(key));
          throw new Error(`Unexpected ${String(key)}`);
        };
      },
    },
  ) as unknown as OpenGeniClient;
  let closed = false;
  const view = await renderComponent(
    <StrictMode>
      <McpConnectionCard
        client={client}
        workspaceId="workspace"
        capabilityId="service"
        name="Example service"
        returnUrl="https://host.example/"
        dialogOnly
        onClose={() => {
          closed = true;
        }}
      />
    </StrictMode>,
  );
  try {
    const done = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === "Done",
    );
    expect({ text: document.body.textContent, unexpected, found: Boolean(done) }).toMatchObject({
      found: true,
    });
    await actRun(() => done!.click());
    expect(closed).toBe(true);
    expect(unexpected).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("connection status retains exact workspace account ownership and endpoint", () => {
  expect(matchingActiveMcpConnections(item, [connection])).toHaveLength(1);
  expect(
    matchingActiveMcpConnections(item, [{ ...connection, subjectId: "another-user" }]),
  ).toHaveLength(0);
  expect(
    matchingActiveMcpConnections(item, [{ ...connection, id: "another-account" }]),
  ).toHaveLength(0);
  expect(
    matchingActiveMcpConnections(item, [
      { ...connection, metadata: { mcpUrl: "https://other.example/mcp" } },
    ]),
  ).toHaveLength(0);
  expect(matchingActiveMcpConnections(item, [{ ...connection, status: "revoked" }])).toHaveLength(
    0,
  );
});
