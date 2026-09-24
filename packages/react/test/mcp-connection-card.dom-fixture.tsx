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

test("stopping sign-in restores retry without waiting for an unresponsive backend", async () => {
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
      // Simulate a backend read that ignores abort and never responds. The
      // poller's abort wrapper must still return the dialog to a usable state.
      get: async () => await new Promise<never>(() => {}),
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
    expect(document.querySelector('button[aria-label="Close connection setup"]')).not.toBeNull();
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

test("a stalled connection reconciliation can close and reopen the inline card", async () => {
  const disconnected = {
    ...item,
    id: "service-reconcile",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  const authorized = {
    id: "attempt-reconcile",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "workspace" as const,
    revision: 2,
    state: "complete" as const,
    credentialsCommitted: true,
    integrationInstalled: false,
    completionRequirement: "connection" as const,
    nextAction: { type: "none" as const },
    expiresAt: "2030-01-01T00:00:00Z",
    account: {
      id: "account",
      providerId: "mcp-oauth",
      label: "Example service",
      ownership: "workspace" as const,
      status: "connected" as const,
    },
  };
  let loads = 0;
  let recoveries = 0;
  const client = {
    listCapabilities: async () => {
      loads++;
      return { items: [disconnected] };
    },
    listConnections: async () => await new Promise<never>(() => {}),
    connectTransport: () => ({
      begin: async () => ({
        ...authorized,
        revision: 1,
        state: "credential_input" as const,
        credentialsCommitted: false,
        nextAction: { type: "credentials" as const, fields: [] },
      }),
      advance: async () => ({
        ...authorized,
        state: "requires_user_action" as const,
        credentialsCommitted: false,
        nextAction: { type: "authorize" as const, url: "https://service.example/authorize" },
      }),
      get: async () => {
        recoveries++;
        return authorized;
      },
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  window.open = (() => ({
    opener: null,
    closed: false,
    location: { replace() {} },
    close() {},
  })) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-reconcile"
      name="Example service"
      returnUrl="https://host.example/"
    />,
  );
  try {
    await flush();
    const cardButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Example service",
    );
    await actRun(() => cardButton!.click());
    await flush();
    const continueButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to Example service",
    );
    await actRun(() => continueButton!.click());
    await flush();
    expect(document.body.textContent).toContain("Finishing your connection…");
    expect(document.body.textContent).not.toContain("Stop waiting");
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close connection setup"]',
    );
    expect(close).not.toBeNull();
    await actRun(() => close!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const beforeReopen = loads;
    await actRun(() => cardButton!.click());
    await flush();
    expect(loads).toBeGreaterThan(beforeReopen);
    expect(recoveries).toBeGreaterThan(1);
    expect(document.body.textContent).toContain("Finishing your connection…");
    expect(document.querySelector('button[aria-label="Close connection setup"]')).not.toBeNull();
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("a failed authorization retries with a fresh attempt", async () => {
  const disconnected = {
    ...item,
    id: "service-failed-auth",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  const begins: string[] = [];
  let recoveries = 0;
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async (_workspace: string, input: { idempotencyKey: string }) => {
        begins.push(input.idempotencyKey);
        return {
          id: `attempt-${begins.length}`,
          workspaceId: "workspace",
          providerId: "mcp-oauth",
          ownership: "workspace" as const,
          revision: 1,
          state: "credential_input" as const,
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "connection" as const,
          nextAction: { type: "credentials" as const, fields: [] },
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
      advance: async (_workspace: string, id: string) => ({
        id,
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
      }),
      get: async (_workspace: string, id: string) => {
        recoveries++;
        return {
          id,
          workspaceId: "workspace",
          providerId: "mcp-oauth",
          ownership: "workspace" as const,
          revision: 3,
          state: "failed" as const,
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "connection" as const,
          nextAction: { type: "none" as const },
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  window.open = (() => ({
    opener: null,
    closed: false,
    location: { replace() {} },
    close() {},
  })) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-failed-auth"
      name="Example service"
      returnUrl="https://host.example/"
    />,
  );
  try {
    await flush();
    const click = async (label: string) => {
      const button = [...document.querySelectorAll("button")].find(
        (node) => node.textContent === label,
      );
      expect(button).toBeDefined();
      await actRun(() => button!.click());
      await flush();
    };
    await click("Connect Example service");
    await click("Continue to Example service");
    expect(document.body.textContent).toContain("Sign-in did not finish");
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close connection setup"]',
    );
    await actRun(() => close!.click());
    await click("Connect Example service");
    expect(recoveries).toBeGreaterThan(1);
    await click("Try signing in again");
    expect(begins).toHaveLength(2);
    expect(begins[1]).not.toBe(begins[0]);
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("changing ownership after closing a pending start uses a new idempotency key", async () => {
  const disconnected = {
    ...item,
    id: "service-ownership-retry",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  const begins: { ownership: string; key: string }[] = [];
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async (_workspace: string, input: { ownership: string; idempotencyKey: string }) => {
        if (
          begins.some(
            (entry) => entry.key === input.idempotencyKey && entry.ownership !== input.ownership,
          )
        )
          throw new Error("Connect idempotency key was reused with different input");
        begins.push({ ownership: input.ownership, key: input.idempotencyKey });
        if (begins.length === 1) return await new Promise<never>(() => {});
        return {
          id: "attempt-personal",
          workspaceId: "workspace",
          providerId: "mcp-oauth",
          ownership: "personal" as const,
          revision: 1,
          state: "credential_input" as const,
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "connection" as const,
          nextAction: { type: "credentials" as const, fields: [] },
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
      advance: async (_workspace: string, id: string) => ({
        id,
        workspaceId: "workspace",
        providerId: "mcp-oauth",
        ownership: "personal" as const,
        revision: 2,
        state: "requires_user_action" as const,
        credentialsCommitted: false,
        integrationInstalled: false,
        completionRequirement: "connection" as const,
        nextAction: { type: "authorize" as const, url: "https://service.example/authorize" },
        expiresAt: "2030-01-01T00:00:00Z",
      }),
      get: async (_workspace: string, id: string) => ({
        id,
        workspaceId: "workspace",
        providerId: "mcp-oauth",
        ownership: "personal" as const,
        revision: 3,
        state: "failed" as const,
        credentialsCommitted: false,
        integrationInstalled: false,
        completionRequirement: "connection" as const,
        nextAction: { type: "none" as const },
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  window.open = (() => ({
    opener: null,
    closed: false,
    location: { replace() {} },
    close() {},
  })) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-ownership-retry"
      name="Example service"
      returnUrl="https://host.example/"
    />,
  );
  try {
    await flush();
    const opener = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Example service",
    );
    await actRun(() => opener!.click());
    await flush();
    const continueButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to Example service",
    );
    await actRun(() => continueButton!.click());
    await flush();
    expect(begins).toHaveLength(1);
    expect(document.body.textContent).toContain("Preparing your connection…");
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close connection setup"]',
    );
    await actRun(() => close!.click());
    await actRun(() => opener!.click());
    await flush();
    const personal = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (input) => input.parentElement?.textContent?.includes("Only me"),
    );
    expect(personal).toBeDefined();
    await actRun(() => personal!.click());
    const continueAgain = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to Example service",
    );
    await actRun(() => continueAgain!.click());
    await flush();
    expect(begins).toHaveLength(2);
    expect(begins.map(({ ownership }) => ownership)).toEqual(["workspace", "personal"]);
    expect(begins[1]!.key).not.toBe(begins[0]!.key);
    expect(document.body.textContent).not.toContain("idempotency key was reused");
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
