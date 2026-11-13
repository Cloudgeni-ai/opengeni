import { expect, test } from "bun:test";
import { StrictMode } from "react";
import type { OpenGeniClient, CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { AppHost } from "../src/app/lib/app-host";
import { matchingActiveMcpConnections } from "../src/mcp-connection-status";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
registerDom();
const { McpConnectionCard } = await import("../src/components/session-mcp-capability-card");
const { AppHostProvider } = await import("../src/app/lib/app-host");

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

test("a blocked sign-in window shows the card's own line, not the browser helper's", async () => {
  const disconnected = {
    ...item,
    id: "service-blocked",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  let begun = 0;
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async () => {
        begun += 1;
        throw new Error("must not begin without a window");
      },
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  window.open = (() => null) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-blocked"
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
    const text = document.body.textContent ?? "";
    expect(text).toContain("Your browser blocked the sign-in window.");
    expect(text).not.toContain("Allow popups to connect your account");
    expect(text).not.toContain("Connect popup");
    expect(begun).toBe(0);
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("custom MCP setup retains discovery failures and can retry into sign-in", async () => {
  let inspections = 0;
  const custom = { ...item, enabled: false, authKind: null, connectionRef: null };
  const client = {
    listCapabilities: async () => ({ items: [custom] }),
    inspectMcpAuthentication: async () => {
      inspections += 1;
      return inspections === 1
        ? {
            kind: "unknown",
            message: "The provider returned HTTP 403 while checking how to sign in.",
          }
        : { kind: "oauth2" };
    },
    connectTransport: () => ({}),
  } as unknown as OpenGeniClient;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId={item.id}
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    // The provider's raw response stays out of the card.
    const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("Could not determine how to sign in. Try again.");
    expect(alert).not.toContain("HTTP 403");
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    await flush();
    expect(inspections).toBe(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Continue to Example service",
      ),
    ).toBe(true);
  } finally {
    await view.unmount();
  }
});

test("custom MCP setup discovers missing auth from its live endpoint", async () => {
  const inspected: string[] = [];
  const custom = {
    ...item,
    id: "custom-oauth",
    enabled: false,
    authKind: null,
    connectionRef: null,
  };
  const client = {
    listCapabilities: async () => ({ items: [custom] }),
    inspectMcpAuthentication: async (_workspace: string, endpoint: string) => {
      inspected.push(endpoint);
      return { kind: "oauth2" };
    },
    connectTransport: () => ({}),
  } as unknown as OpenGeniClient;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="custom-oauth"
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    expect(inspected).toEqual(["https://service.example/mcp"]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Continue to Example service",
      ),
    ).toBe(true);
  } finally {
    await view.unmount();
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
  const popupFinishes: unknown[] = [];
  let recoveries = 0;
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async (
        _workspace: string,
        input: { idempotencyKey: string; finishInPopup?: true },
      ) => {
        begins.push(input.idempotencyKey);
        popupFinishes.push(input.finishInPopup);
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
    // Sign-in runs in the card's popup, which ends on a closing page.
    expect(popupFinishes).toEqual([true, true]);
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

test("changing ownership after reopening an authorization starts a new attempt", async () => {
  const disconnected = {
    ...item,
    id: "service-recovered-ownership",
    enabled: false,
    connectionRef: null,
  } as CapabilityCatalogItem;
  const begins: { ownership: string; key: string }[] = [];
  let reads = 0;
  let popups = 0;
  const authorize = (id: string, ownership: "workspace" | "personal") => ({
    id,
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership,
    revision: 2,
    state: "requires_user_action" as const,
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection" as const,
    nextAction: { type: "authorize" as const, url: "https://service.example/authorize" },
    expiresAt: "2030-01-01T00:00:00Z",
  });
  const client = {
    listCapabilities: async () => ({ items: [disconnected] }),
    connectTransport: () => ({
      begin: async (
        _workspace: string,
        input: { ownership: "workspace" | "personal"; idempotencyKey: string },
      ) => {
        begins.push({ ownership: input.ownership, key: input.idempotencyKey });
        return {
          ...authorize(`attempt-${begins.length}`, input.ownership),
          revision: 1,
          state: "credential_input" as const,
          nextAction: { type: "credentials" as const, fields: [] },
        };
      },
      advance: async (_workspace: string, id: string) =>
        authorize(id, id === "attempt-1" ? "workspace" : "personal"),
      get: async (_workspace: string, id: string) => {
        reads++;
        if (reads === 1) return await new Promise<never>(() => {});
        if (reads === 2) return authorize(id, "workspace");
        return {
          ...authorize(id, "personal"),
          revision: 3,
          state: "failed" as const,
          nextAction: { type: "none" as const },
        };
      },
    }),
  } as unknown as OpenGeniClient;
  const previousOpen = window.open;
  window.open = (() => {
    popups++;
    return {
      opener: null,
      closed: false,
      location: { replace() {} },
      close() {},
    };
  }) as unknown as typeof window.open;
  const view = await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="service-recovered-ownership"
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
    expect(reads).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Finish signing in with Example service");
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close connection setup"]',
    );
    await actRun(() => close!.click());
    await actRun(() => opener!.click());
    await flush();
    expect(reads).toBeGreaterThan(1);
    const personal = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (input) => input.parentElement?.textContent?.includes("Only me"),
    );
    await actRun(() => personal!.click());
    expect(personal!.checked).toBe(true);
    const continueAgain = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue to Example service",
    );
    await actRun(() => continueAgain!.click());
    await flush();
    expect(begins.map(({ ownership }) => ownership)).toEqual(["workspace", "personal"]);
    expect(begins[1]!.key).not.toBe(begins[0]!.key);
    expect(popups).toBe(2);
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

test("Drive card connects through its dedicated provider and enables only the completed personal account", async () => {
  sessionStorage.clear();
  const driveUrl = "https://drivemcp.googleapis.com/mcp/v1";
  let enabled = false;
  let committed = false;
  const begins: unknown[] = [];
  const advances: unknown[] = [];
  const enabledRefs: unknown[] = [];
  const drive = {
    ...item,
    id: "drive-dedicated",
    name: "Google Drive",
    enabled: false,
    mcpUrl: driveUrl,
    providerDomain: "drivemcp.googleapis.com",
    connectionRef: null,
  } as CapabilityCatalogItem;
  const account = {
    ...connection,
    id: "drive-account",
    subjectId: "user:drive",
    providerDomain: "drivemcp.googleapis.com",
    metadata: { mcpUrl: driveUrl },
  };
  const attempt = {
    id: "drive-attempt",
    workspaceId: "workspace",
    providerId: "google-drive",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({
      items: [
        {
          ...drive,
          enabled,
          connectionRef: enabled
            ? { providerDomain: account.providerDomain, kind: "oauth2", subjectScope: "subject" }
            : null,
        },
      ],
    }),
    listConnections: async () => (committed ? [account] : []),
    listOwnConnectionAccounts: async () => (committed ? [account] : []),
    enableCapability: async (_workspaceId: string, _capabilityId: string, input: unknown) => {
      enabledRefs.push(input);
      enabled = true;
    },
    connectTransport: () => ({
      begin: async (_workspaceId: string, input: unknown) => {
        begins.push(input);
        return attempt;
      },
      advance: async (...input: unknown[]) => {
        advances.push(input);
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: account.id,
            providerId: "google-drive",
            ownership: "personal",
            status: "connected",
            label: "Google Drive",
            version: 1,
          },
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
      capabilityId={drive.id}
      name="Google Drive"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue to Google Drive",
    );
    expect(button).toBeDefined();
    await actRun(() => button!.click());
    await flush();
    expect(begins).toEqual([
      expect.objectContaining({ providerId: "google-drive", ownership: "personal" }),
    ]);
    expect(JSON.stringify(advances)).toContain('"values":{}');
    expect(enabledRefs).toEqual([
      {
        connectionRef: {
          providerDomain: "drivemcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "subject",
        },
      },
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("a card for an account that stopped working reconnects that exact account", async () => {
  sessionStorage.clear();
  const personal = {
    ...item,
    id: "mail-personal",
    name: "Mail",
    connectionRef: { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" },
  } as CapabilityCatalogItem;
  // The person has two accounts for it; one stopped working.
  const lapsed = {
    ...connection,
    id: "lapsed-account",
    subjectId: "user:ada",
    status: "needs_reauth",
  } as ConnectionMetadata;
  const working = { ...connection, id: "working-account", subjectId: "user:ada" };
  const begins: Array<Record<string, unknown>> = [];
  const client = {
    listCapabilities: async () => ({ items: [personal] }),
    listConnections: async () => [lapsed, working],
    listOwnConnectionAccounts: async () => [lapsed, working],
    connectTransport: () => ({
      begin: async (_workspaceId: string, input: Record<string, unknown>) => {
        begins.push(input);
        return {
          id: "reconnect-attempt",
          workspaceId: "workspace",
          providerId: "mcp-oauth",
          ownership: "personal",
          revision: 1,
          state: "requires_user_action",
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "integration",
          nextAction: { type: "none" },
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
      capabilityId={personal.id}
      name="Mail"
      returnUrl="https://host.example/"
      reconnectConnectionId={lapsed.id}
      dialogOnly
    />,
  );
  try {
    await flush();
    expect(document.body.textContent).toContain(
      "Signs in again to the same account. Its settings stay as they were.",
    );
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue to Mail",
    );
    await actRun(() => button!.click());
    await flush();
    // Two personal accounts would otherwise refuse to guess; the card names one.
    expect(begins).toEqual([
      expect.objectContaining({
        providerId: "mcp-oauth",
        ownership: "personal",
        reconnectAccountId: lapsed.id,
      }),
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("connecting your own account to a capability enabled for personal accounts changes no installation", async () => {
  sessionStorage.clear();
  let committed = false;
  const enables: unknown[] = [];
  const personal = {
    ...item,
    id: "personal-service",
    connectionRef: { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" },
  } as CapabilityCatalogItem;
  const account = { ...connection, id: "own-account", subjectId: "user:own" };
  const attempt = {
    id: "own-attempt",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const begins: unknown[] = [];
  const client = {
    listCapabilities: async () => ({ items: [personal] }),
    listConnections: async () => (committed ? [account] : []),
    listOwnConnectionAccounts: async () => (committed ? [account] : []),
    enableCapability: async (...input: unknown[]) => {
      enables.push(input);
    },
    connectTransport: () => ({
      begin: async (_workspaceId: string, input: unknown) => {
        begins.push(input);
        return attempt;
      },
      advance: async () => {
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: account.id,
            providerId: "mcp-oauth",
            ownership: "personal",
            status: "connected",
            label: "Example service",
            version: 1,
          },
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
      capabilityId={personal.id}
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue to Example service",
    );
    expect(button).toBeDefined();
    await actRun(() => button!.click());
    await flush();
    expect(begins).toEqual([
      expect.objectContaining({ providerId: "mcp-oauth", ownership: "personal" }),
    ]);
    expect(enables).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("an integration only an admin can turn on says so after sign-in, not a generic failure", async () => {
  sessionStorage.clear();
  let committed = false;
  const off = {
    ...item,
    id: "custom-service",
    name: "Team tools",
    enabled: false,
    connectionRef: null,
  } as unknown as CapabilityCatalogItem;
  const account = { ...connection, id: "own-account", subjectId: "user:own" };
  const attempt = {
    id: "own-attempt",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({ items: [off] }),
    listConnections: async () => (committed ? [account] : []),
    listOwnConnectionAccounts: async () => (committed ? [account] : []),
    enableCapability: async () => {
      throw new OpenGeniApiError(
        403,
        JSON.stringify({ error: { message: "Only an admin can turn on this integration" } }),
        { mutation: true },
      );
    },
    connectTransport: () => ({
      begin: async () => attempt,
      advance: async () => {
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: account.id,
            providerId: "mcp-oauth",
            ownership: "personal",
            status: "connected",
            label: "Team tools",
            version: 1,
          },
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
      capabilityId={off.id}
      name="Team tools"
      returnUrl="https://host.example/"
      dialogOnly
      personalOnly
    />,
  );
  try {
    await flush();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue to Team tools",
    );
    expect(button).toBeDefined();
    await actRun(() => button!.click());
    await flush();
    expect(document.body.textContent).toContain(
      "Only an admin can turn on Team tools. Ask an admin to turn it on, then connect your account.",
    );
    expect(document.body.textContent).not.toContain("Connection setup could not finish");
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

test("an admin asked to confirm with a passkey is told so, not that only an admin can turn it on", async () => {
  sessionStorage.clear();
  let committed = false;
  const off = {
    ...item,
    id: "custom-service",
    name: "Team tools",
    enabled: false,
    connectionRef: null,
  } as unknown as CapabilityCatalogItem;
  const account = { ...connection, id: "own-account", subjectId: "user:own" };
  const attempt = {
    id: "own-attempt",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({ items: [off] }),
    listConnections: async () => (committed ? [account] : []),
    listOwnConnectionAccounts: async () => (committed ? [account] : []),
    enableCapability: async () => {
      throw new OpenGeniApiError(
        403,
        JSON.stringify({
          error: {
            message: "Add a passkey to your account to change who has access.",
            details: { code: "ADMIN_PASSKEY_STEP_UP_REQUIRED", passkeyRegistered: false },
          },
        }),
        { mutation: true },
      );
    },
    connectTransport: () => ({
      begin: async () => attempt,
      advance: async () => {
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: account.id,
            providerId: "mcp-oauth",
            ownership: "personal",
            status: "connected",
            label: "Team tools",
            version: 1,
          },
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
      capabilityId={off.id}
      name="Team tools"
      returnUrl="https://host.example/"
      dialogOnly
      personalOnly
    />,
  );
  try {
    await flush();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue to Team tools",
    );
    expect(button).toBeDefined();
    await actRun(() => button!.click());
    await flush();
    expect(document.body.textContent).toContain(
      "Add a passkey to your account to turn on Team tools, then connect again.",
    );
    expect(document.body.textContent).not.toContain("Only an admin can turn on");
    expect(document.body.textContent).not.toContain("Connection setup could not finish");
  } finally {
    await view.unmount();
    window.open = previousOpen;
  }
});

function conversationClient(
  options: {
    failAttach?: boolean;
    session?: Record<string, unknown>;
    connections?: readonly ConnectionMetadata[];
  } = {},
) {
  const calls: string[] = [];
  const continuations: unknown[][] = [];
  const attached = {
    ...item,
    tools: [{ kind: "mcp", id: "service" }],
    metadata: {},
  } as unknown as CapabilityCatalogItem;
  const client = {
    listCapabilities: async () => ({ items: [attached] }),
    listConnections: async () => options.connections ?? [connection],
    getSession: async () =>
      options.session ?? {
        tools: [],
        firstPartyMcpTools: [],
        toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
        toolPolicyVersion: 3,
        effectiveToolPolicy: { effectiveIds: [], mandatoryIds: [], idsTruncated: false },
      },
    updateSessionToolPolicy: async () => {
      calls.push("updateSessionToolPolicy");
      if (options.failAttach) throw new Error("Version conflict");
      return {};
    },
    continueAfterCapabilitySetup: async (...input: unknown[]) => {
      calls.push("continueAfterCapabilitySetup");
      continuations.push(input);
      return { outcome: "queued", updateId: "update" };
    },
    connectTransport: () => ({}),
  } as unknown as OpenGeniClient;
  return { client, calls, continuations };
}

test("using a connection in the conversation lets the agent continue its request once", async () => {
  const h = conversationClient();
  const view = await renderComponent(
    <McpConnectionCard
      client={h.client}
      workspaceId="workspace"
      sessionId="session"
      capabilityId="service"
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    const use = [...document.querySelectorAll("button.og-session-capability-primary")].find(
      (node) => node.textContent === "Use in this conversation",
    ) as HTMLButtonElement | undefined;
    expect(use).toBeDefined();
    await actRun(() => use!.click());
    await flush();
    // Only after the conversation's tools were updated, and exactly once.
    expect(h.calls).toEqual(["updateSessionToolPolicy", "continueAfterCapabilitySetup"]);
    expect(h.continuations).toEqual([["workspace", "session", { capabilityId: "service" }]]);
  } finally {
    await view.unmount();
  }
});

test("a failed conversation attach never continues the agent's request", async () => {
  const h = conversationClient({ failAttach: true });
  const view = await renderComponent(
    <McpConnectionCard
      client={h.client}
      workspaceId="workspace"
      sessionId="session"
      capabilityId="service"
      name="Example service"
      returnUrl="https://host.example/"
      dialogOnly
    />,
  );
  try {
    await flush();
    const use = [...document.querySelectorAll("button.og-session-capability-primary")].find(
      (node) => node.textContent === "Use in this conversation",
    ) as HTMLButtonElement | undefined;
    await actRun(() => use!.click());
    await flush();
    expect(h.calls).toEqual(["updateSessionToolPolicy"]);
    // The server's text stays out of the card; the person gets its plain line.
    const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("Connection setup could not finish. Try again.");
    expect(alert).not.toContain("Version conflict");
  } finally {
    await view.unmount();
  }
});

test("a network or API failure on first load shows only the card's plain line", async () => {
  const failures: Array<[string, () => Promise<never>]> = [
    ["Network request failed", async () => Promise.reject(new Error("Network request failed"))],
    [
      "upstream 502 from capability service",
      async () =>
        Promise.reject(
          Object.assign(new TypeError("upstream 502 from capability service"), { status: 502 }),
        ),
    ],
  ];
  for (const [raw, listCapabilities] of failures) {
    const client = {
      listCapabilities,
      getSession: async () => ({ toolPolicy: { mode: "explicit" }, tools: [] }),
      connectTransport: () => ({}),
    } as unknown as OpenGeniClient;
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
      await flush();
      const text = document.body.textContent ?? "";
      expect(text).toContain("Couldn't load connection details.");
      expect(text).not.toContain(raw);
    } finally {
      await view.unmount();
    }
  }
});

test("a server's sign-in inspection message stays out of the card", async () => {
  const custom = {
    ...item,
    enabled: false,
    authKind: null,
    connectionRef: null,
  } as unknown as CapabilityCatalogItem;
  const client = {
    listCapabilities: async () => ({ items: [custom] }),
    getSession: async () => ({ toolPolicy: { mode: "explicit" }, tools: [] }),
    inspectMcpAuthentication: async () => ({
      kind: "unknown",
      message: "probe of internal endpoint returned 418",
    }),
    connectTransport: () => ({}),
  } as unknown as OpenGeniClient;
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
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Could not determine how to sign in. Try again.");
    expect(text).not.toContain("probe of internal endpoint");
  } finally {
    await view.unmount();
  }
});

test("a reviewed service's card speaks its catalog copy and keeps the technical detail under Details", async () => {
  const presentation = {
    providerName: "Example Co",
    icon: "calendar",
    introduction: "Let agents work with the calendar you choose.",
    capabilities: [
      { title: "See what's coming up", description: "Read events in a time range." },
      { title: "Plan and change events", description: "Create, move or cancel events." },
    ],
    permissionSummary: "Example Co asks for access to the calendar you approve.",
  };
  const render = async (input: {
    source: CapabilityCatalogItem["source"];
    name: string;
    metadata: Record<string, unknown>;
    mcpUrl?: string;
  }) => {
    const shown = {
      ...item,
      id: `service-${input.source}-${input.name}`,
      name: input.name,
      source: input.source,
      description: "Events, calendars and free/busy through the reviewed Example REST bridge.",
      metadata: input.metadata,
      ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
      enabled: false,
      connectionRef: null,
    } as CapabilityCatalogItem;
    const client = new Proxy(
      {
        listCapabilities: async () => ({ items: [shown] }),
        listConnections: async () => [],
        listOwnConnectionAccounts: async () => [],
        connectTransport: () => ({}),
      },
      { get: (target, key) => (key in target ? Reflect.get(target, key) : async () => ({})) },
    ) as unknown as OpenGeniClient;
    const images: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          for (const image of node instanceof Element
            ? [node, ...node.querySelectorAll("img")].filter((el) => el.tagName === "IMG")
            : [])
            images.push(image.getAttribute("src") ?? "");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const view = await renderComponent(
      <McpConnectionCard
        client={client}
        workspaceId="workspace"
        capabilityId={shown.id}
        name={input.name}
        returnUrl="https://host.example/"
        personalOnly
        dialogOnly
      />,
    );
    await flush();
    const dialog = document.querySelector(".og-session-capability-dialog");
    const details = dialog?.querySelector("details.og-session-capability-details");
    const result = {
      header: dialog?.querySelector(".og-session-capability-dialog-header")?.textContent ?? null,
      mark: dialog?.querySelector(".og-session-capability-logo")?.getAttribute("data-mark") ?? null,
      markText: dialog?.querySelector(".og-session-capability-logo")?.textContent ?? null,
      lead: dialog?.querySelector(".og-session-capability-setup > p")?.textContent ?? null,
      abilities: [...(dialog?.querySelectorAll(".og-session-capability-abilities li") ?? [])].map(
        (node) => node.textContent,
      ),
      buttons: [...(dialog?.querySelectorAll(".og-session-capability-primary") ?? [])].map(
        (node) => node.textContent,
      ),
      detailsOpen: details ? (details as HTMLDetailsElement).open : null,
      detailsText: details?.textContent ?? null,
      images,
    };
    observer.disconnect();
    await view.unmount();
    return result;
  };

  const reviewed = await render({
    source: "built_in",
    name: "Example Calendar",
    metadata: { presentation },
  });
  // The service and its provider, in words, and the agent's abilities as a short list.
  expect(reviewed.header).toContain("Example Calendar");
  expect(reviewed.header).toContain("Example Co");
  expect(reviewed.header).not.toContain("service.example");
  expect(reviewed.mark).toBe("icon");
  expect(reviewed.lead).toBe(presentation.introduction);
  expect(reviewed.abilities).toEqual(["See what's coming up", "Plan and change events"]);
  // One clear action.
  expect(reviewed.buttons).toEqual(["Continue to Example Calendar"]);
  // The host, type, catalog description and access summary are one click away.
  expect(reviewed.detailsOpen).toBe(false);
  expect(reviewed.detailsText).toContain("Details");
  expect(reviewed.detailsText).toContain("https://service.example/mcp");
  expect(reviewed.detailsText).toContain("MCP server");
  expect(reviewed.detailsText).toContain("reviewed Example REST bridge");
  expect(reviewed.detailsText).toContain(presentation.permissionSummary);

  // Without curated copy or a logo, a two-word name reads as its initials.
  const plain = await render({ source: "built_in", name: "Example Calendar", metadata: {} });
  expect({ mark: plain.mark, markText: plain.markText, abilities: plain.abilities }).toEqual({
    mark: "initials",
    markText: "EC",
    abilities: [],
  });
  expect(plain.lead).toContain("reviewed Example REST bridge");

  // Gmail's reviewed mark ships with the package. This DOM cannot load it,
  // and a logo that fails falls back to the service's icon, not two letters.
  const gmail = await render({
    source: "built_in",
    name: "Gmail",
    metadata: { presentation: { ...presentation, icon: "mail" } },
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
  });
  expect(gmail.images.some((src) => src.endsWith("gmail.ico"))).toBe(true);
  expect(gmail.mark).toBe("icon");
  expect(reviewed.images).toEqual([]);

  // A hand-added server keeps its host in the header for the person checking it.
  const manual = await render({ source: "manual", name: "Example Calendar", metadata: {} });
  expect(manual.header).toContain("service.example");
});

test("a reviewed catalog service reads as the service; a hand-added server keeps its MCP label", async () => {
  const render = async (source: CapabilityCatalogItem["source"]) => {
    const shown = { ...item, source, enabled: false, connectionRef: null } as CapabilityCatalogItem;
    const client = new Proxy(
      {
        listCapabilities: async () => ({ items: [shown] }),
        listConnections: async () => [],
        connectTransport: () => ({}),
      },
      { get: (target, key) => (key in target ? Reflect.get(target, key) : async () => ({})) },
    ) as unknown as OpenGeniClient;
    const view = await renderComponent(
      <McpConnectionCard
        client={client}
        workspaceId="workspace"
        sessionId="session"
        capabilityId="service"
        name="Example service"
        returnUrl="https://host.example/"
      />,
    );
    await flush();
    const header = document.querySelector(".og-session-capability-header");
    const result = {
      badge: header?.querySelector(".og-session-capability-type")?.textContent ?? null,
      provider: header?.textContent?.includes("service.example") ?? false,
    };
    await view.unmount();
    return result;
  };
  // A reviewed service shows no host on the card; a hand-added one keeps it.
  expect(await render("library")).toEqual({ badge: null, provider: false });
  expect(await render("manual")).toEqual({ badge: "MCP server", provider: true });
});

test("the card asks who can use a connection only when someone else could", async () => {
  const render = async (input: {
    people: string[];
    mcpUrl?: string;
  }): Promise<{ asked: boolean; scope: string | null }> => {
    const shown = {
      ...item,
      id: "service-sharing",
      enabled: false,
      connectionRef: null,
      ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
    } as CapabilityCatalogItem;
    const client = new Proxy(
      {
        listCapabilities: async () => ({ items: [shown] }),
        listWorkspaceMembers: async () => input.people.map((subjectId) => ({ subjectId })),
        getAccessContext: async () => ({ subjectId: "user:me" }),
        listOwnConnectionAccounts: async () => [],
        connectTransport: () => ({}),
      },
      { get: (target, key) => (key in target ? Reflect.get(target, key) : async () => ({})) },
    ) as unknown as OpenGeniClient;
    const view = await renderComponent(
      <McpConnectionCard
        client={client}
        workspaceId={`workspace-${input.people.join("-")}-${input.mcpUrl ?? ""}`}
        capabilityId="service-sharing"
        name="Example service"
        returnUrl="https://host.example/"
        dialogOnly
      />,
    );
    await flush();
    const result = {
      asked: document.body.textContent?.includes("Who can use this connection?") ?? false,
      scope: document.querySelector(".og-session-capability-scope")?.textContent ?? null,
    };
    await view.unmount();
    return result;
  };
  // Alone in a shared workspace: the person's own account, no question.
  expect(await render({ people: ["user:me", "api_key:ci"] })).toEqual({
    asked: false,
    scope: "Connects your own account. Only work you start can use it.",
  });
  // Someone else is here: the person decides, and sharing stays the default.
  expect(await render({ people: ["user:me", "user:anna"] })).toMatchObject({ asked: true });
  // Google's connectors only connect a person's own account, whoever else is here.
  for (const mcpUrl of [
    "https://gmailmcp.googleapis.com/mcp/v1",
    "https://calendarmcp.googleapis.com/mcp/v1",
  ])
    expect(await render({ people: ["user:me", "user:anna"], mcpUrl })).toMatchObject({
      asked: false,
    });
  // Microsoft Dynamics is personal by default but can be shared, so the card asks.
  expect(
    await render({
      people: ["user:me", "user:anna"],
      mcpUrl: "https://contoso.crm4.dynamics.com/api/mcp",
    }),
  ).toMatchObject({ asked: true });
});

/**
 * A capability not yet set up in this shared workspace, and the person's own
 * login for it that lives in another workspace. Signing in again reuses that
 * login (D-54), so it is only ever listed with their accounts.
 */
function ownLoginElsewhereClient(options: {
  /** Already listed before signing in (the card can offer "Use it here"). */
  listedBeforeSignIn: boolean;
  /** Whether the server turned the reused login on here. */
  turnedOnBySignIn: boolean;
  /** Turning the capability on here is an admin's step. */
  enableRefused?: boolean;
  /** Turning it on waits for an admin passkey step-up while `required` is set. */
  stepUp?: { required: boolean };
}) {
  let committed = false;
  let enabled = false;
  let turnedOn = false;
  const calls: string[] = [];
  const enables: unknown[] = [];
  const grants: unknown[] = [];
  const begins: unknown[] = [];
  const capability = () =>
    ({
      ...item,
      id: "reused-service",
      enabled,
      connectionRef: enabled
        ? { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" }
        : null,
    }) as unknown as CapabilityCatalogItem;
  const login = () =>
    ({
      ...connection,
      id: "own-login-elsewhere",
      workspaceId: "other-workspace",
      subjectId: "user:own",
      authorityId: "authority-own",
      turnedOnHere: turnedOn || (committed && options.turnedOnBySignIn),
    }) as ConnectionMetadata;
  const attempt = {
    id: "reuse-attempt",
    workspaceId: "workspace",
    providerId: "mcp-oauth",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "credentials", fields: [] },
    expiresAt: "2030-01-01T00:00:00Z",
  };
  const client = {
    listCapabilities: async () => ({ items: [capability()] }),
    listWorkspaceMembers: async () => [{ subjectId: "user:own" }, { subjectId: "user:anna" }],
    getAccessContext: async () => ({ subjectId: "user:own" }),
    // This workspace stores no connection of its own for it.
    listConnections: async () => [],
    listOwnConnectionAccounts: async () =>
      committed || options.listedBeforeSignIn ? [login()] : [],
    issueUserResourceGrant: async (...input: unknown[]) => {
      calls.push("issueUserResourceGrant");
      grants.push(input);
      turnedOn = true;
      return { grant: { grantId: "grant" } };
    },
    enableCapability: async (...input: unknown[]) => {
      calls.push("enableCapability");
      enables.push(input);
      if (options.enableRefused)
        throw new OpenGeniApiError(
          403,
          JSON.stringify({ error: { message: "Only an admin can turn on this integration" } }),
          { mutation: true },
        );
      if (options.stepUp?.required)
        throw new OpenGeniApiError(
          403,
          JSON.stringify({
            error: {
              message: "Confirm it's you to change who has access.",
              details: { code: "ADMIN_PASSKEY_STEP_UP_REQUIRED", passkeyRegistered: true },
            },
          }),
          { mutation: true },
        );
      enabled = true;
    },
    connectTransport: () => ({
      begin: async (_workspaceId: string, input: unknown) => {
        begins.push(input);
        return attempt;
      },
      advance: async () => {
        committed = true;
        return {
          ...attempt,
          revision: 2,
          state: "complete",
          credentialsCommitted: true,
          nextAction: { type: "none" },
          account: {
            id: "own-login-elsewhere",
            providerId: "mcp-oauth",
            ownership: "personal",
            status: "connected",
            label: "Example service",
            version: 1,
          },
        };
      },
    }),
  } as unknown as OpenGeniClient;
  return { client, calls, enables, grants, begins };
}

const personalEnable = [
  "workspace",
  "reused-service",
  {
    connectionRef: { providerDomain: "service.example", kind: "oauth2", subjectScope: "subject" },
  },
];

async function renderOwnLoginElsewhereCard(
  client: OpenGeniClient,
  onConfigured: () => void,
  personalOnly = true,
) {
  return await renderComponent(
    <McpConnectionCard
      client={client}
      workspaceId="workspace"
      capabilityId="reused-service"
      name="Example service"
      returnUrl="https://host.example/"
      onConfigured={onConfigured}
      dialogOnly
      personalOnly={personalOnly}
    />,
  );
}

for (const turnedOnBySignIn of [true, false])
  test(`signing in with your own login from another workspace turns the capability on here (${turnedOnBySignIn ? "turned on by the server" : "turned on by the card"})`, async () => {
    sessionStorage.clear();
    const h = ownLoginElsewhereClient({ listedBeforeSignIn: false, turnedOnBySignIn });
    let configured = 0;
    const previousOpen = window.open;
    window.open = (() => ({
      opener: null,
      closed: false,
      location: { replace() {} },
      close() {},
    })) as unknown as typeof window.open;
    const view = await renderOwnLoginElsewhereCard(h.client, () => {
      configured += 1;
    });
    try {
      await flush();
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Continue to Example service",
      );
      expect(button).toBeDefined();
      await actRun(() => button!.click());
      await flush();
      expect(h.begins).toEqual([expect.objectContaining({ ownership: "personal" })]);
      expect(document.body.textContent).not.toContain(
        "The authorized account does not match this integration",
      );
      expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
      expect(h.calls).toEqual(
        turnedOnBySignIn ? ["enableCapability"] : ["issueUserResourceGrant", "enableCapability"],
      );
      if (!turnedOnBySignIn)
        expect(h.grants).toEqual([
          ["workspace", "authority-own", expect.objectContaining({ resourceKind: "connection" })],
        ]);
      expect(h.enables).toEqual([personalEnable]);
      expect(configured).toBe(1);
    } finally {
      await view.unmount();
      window.open = previousOpen;
    }
  });

test("a capability not set up here offers your own login from another workspace instead of a new sign-in", async () => {
  sessionStorage.clear();
  const h = ownLoginElsewhereClient({ listedBeforeSignIn: true, turnedOnBySignIn: false });
  let configured = 0;
  const view = await renderOwnLoginElsewhereCard(h.client, () => {
    configured += 1;
  });
  try {
    await flush();
    const use = [...document.querySelectorAll("button.og-session-capability-primary")].find(
      (node) => node.textContent === "Use it here",
    ) as HTMLButtonElement | undefined;
    expect(use).toBeDefined();
    await actRun(() => use!.click());
    await flush();
    expect(h.begins).toEqual([]);
    expect(h.calls).toEqual(["enableCapability", "issueUserResourceGrant"]);
    expect(h.enables).toEqual([personalEnable]);
    expect(document.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
    expect(configured).toBe(1);
  } finally {
    await view.unmount();
  }
});

test("a shareable capability with others in the workspace asks who can use it before offering your own login", async () => {
  sessionStorage.clear();
  const h = ownLoginElsewhereClient({ listedBeforeSignIn: true, turnedOnBySignIn: false });
  const view = await renderOwnLoginElsewhereCard(h.client, () => {}, false);
  try {
    await flush();
    expect(document.body.textContent).toContain("Who can use this connection?");
    expect(
      [...document.querySelectorAll("button")].some((node) => node.textContent === "Use it here"),
    ).toBe(false);
    expect(h.calls).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("using your own login here when only an admin can turn the capability on leaves the login as it was", async () => {
  sessionStorage.clear();
  const h = ownLoginElsewhereClient({
    listedBeforeSignIn: true,
    turnedOnBySignIn: false,
    enableRefused: true,
  });
  let configured = 0;
  const view = await renderOwnLoginElsewhereCard(h.client, () => {
    configured += 1;
  });
  try {
    await flush();
    const use = [...document.querySelectorAll("button.og-session-capability-primary")].find(
      (node) => node.textContent === "Use it here",
    ) as HTMLButtonElement | undefined;
    expect(use).toBeDefined();
    await actRun(() => use!.click());
    await flush();
    expect(h.calls).toEqual(["enableCapability"]);
    expect(h.grants).toEqual([]);
    expect(document.body.textContent).toContain("Only an admin can turn on Example service.");
    expect(configured).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("after a reload a chat that already uses the connection shows it as done", async () => {
  // A default-policy chat lists the workspace's servers in its effective
  // selection, not as explicit additions.
  const h = conversationClient({
    session: {
      tools: [{ kind: "mcp", id: "service" }],
      firstPartyMcpTools: [],
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
      toolPolicyVersion: 3,
      effectiveToolPolicy: {
        selectedIds: [],
        effectiveIds: ["service"],
        mandatoryIds: [],
        idsTruncated: false,
      },
    },
  });
  const view = await renderComponent(
    <McpConnectionCard
      client={h.client}
      workspaceId="workspace"
      sessionId="session"
      capabilityId="service"
      name="Example service"
      returnUrl="https://host.example/"
    />,
  );
  try {
    await flush();
    expect(document.querySelector('[data-state="complete"]')).not.toBeNull();
    expect(
      [...document.querySelectorAll("button")].some(
        (node) => node.textContent === "Use in this conversation",
      ),
    ).toBe(false);
    expect(h.calls).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test("using your own login here that waits for a passkey step-up offers it, then uses the login", async () => {
  sessionStorage.clear();
  const stepUp = { required: true };
  const h = ownLoginElsewhereClient({ listedBeforeSignIn: true, turnedOnBySignIn: false, stepUp });
  let asked = 0;
  let configured = 0;
  const view = await renderComponent(
    <AppHostProvider
      host={
        {
          adminStepUp: async () => {
            asked += 1;
            stepUp.required = false;
            return true;
          },
        } as unknown as AppHost
      }
    >
      <McpConnectionCard
        client={h.client}
        workspaceId="workspace"
        capabilityId="reused-service"
        name="Example service"
        returnUrl="https://host.example/"
        onConfigured={() => {
          configured += 1;
        }}
        dialogOnly
        personalOnly
      />
    </AppHostProvider>,
  );
  try {
    await flush();
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((node) => node.textContent === label);
    await actRun(() => button("Use it here")!.click());
    await flush();
    expect(document.body.textContent).toContain(
      "Confirm it's you with your passkey to turn on Example service.",
    );
    expect(h.grants).toEqual([]);
    await actRun(() => button("Confirm it's you")!.click());
    await flush();
    expect(asked).toBe(1);
    expect(h.calls).toEqual(["enableCapability", "enableCapability", "issueUserResourceGrant"]);
    expect(configured).toBe(1);
  } finally {
    await view.unmount();
  }
});

function defaultPolicySession(effectiveIds: string[]) {
  return {
    tools: effectiveIds.map((id) => ({ kind: "mcp", id })),
    firstPartyMcpTools: [],
    toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    toolPolicyVersion: 3,
    effectiveToolPolicy: { selectedIds: [], effectiveIds, mandatoryIds: [], idsTruncated: false },
  };
}

for (const [name, options] of [
  ["a server removed from the chat", { session: defaultPolicySession([]) }],
  [
    "a server the chat includes without a usable account",
    { session: defaultPolicySession(["service"]), connections: [] },
  ],
] as const)
  test(`after a reload ${name} is not shown as done`, async () => {
    const h = conversationClient(options);
    const view = await renderComponent(
      <McpConnectionCard
        client={h.client}
        workspaceId="workspace"
        sessionId="session"
        capabilityId="service"
        name="Example service"
        returnUrl="https://host.example/"
      />,
    );
    try {
      await flush();
      expect(document.querySelector('[data-state="complete"]')).toBeNull();
      expect(h.calls).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
