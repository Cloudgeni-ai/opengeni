import { expect, test } from "bun:test";
import { StrictMode } from "react";
import type { OpenGeniClient, CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { matchingActiveMcpConnections } from "../src/mcp-connection-status";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
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

test("stopping sign-in restores the dialog's close control without a refresh", async () => {
  const disconnected = {
    ...item,
    id: "service-cancel",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  const authorize = {
    id: "attempt-cancel",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "workspace" as const,
    revision: 2,
    state: "requires_user_action" as const,
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection" as const,
    nextAction: { type: "authorize" as const, url: "https://service.example/authorize" },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async () => ({
        ...authorize,
        revision: 1,
        state: "credential_input" as const,
        nextAction: { type: "credentials" as const, fields: [] },
      }),
      advance: async () => authorize,
      get: async () => authorize,
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  let popupClosed = false;
  window.open = (() => ({
    opener: null,
    get closed() {
      return popupClosed;
    },
    location: { replace() {} },
    close() {
      popupClosed = true;
    },
  })) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-cancel"
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    const continueButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to Example service",
    );
    expect(continueButton).toBeDefined();
    await actRun(() => continueButton!.click());
    await flush();
    expect(document.body.textContent).toContain("Finish signing in with Example service");
    expect(document.querySelector('button[aria-label="Close connection setup"]')).toBeNull();
    const stop = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop waiting",
    );
    await actRun(() => stop!.click());
    await flush();
    expect(document.body.textContent).toContain("Sign-in window closed");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Sign-in window closed",
    );
    expect(document.querySelector('button[aria-label="Close connection setup"]')).not.toBeNull();
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("personal setup reads sender accounts without conversation grants or consent", async () => {
  const unexpected: string[] = [];
  const personal = {
    ...item,
    connectionRef: { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" },
  };
  const client = new Proxy(
    {
      listCapabilities: async () => ({ items: [personal] }),
      listOwnConnectionAccounts: async () => [{ ...connection, subjectId: "owner" }],
      getSession: async () => ({ tools: [], toolPolicy: { mode: "explicit" } }),
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
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      sessionId="session"
      capabilityId="service"
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    expect(document.body.textContent).toContain("Your account is connected.");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(unexpected).toEqual([]);
  } finally {
    await view.unmount();
  }
});
