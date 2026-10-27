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

function conversationClient(options: { failAttach?: boolean } = {}) {
  const calls: string[] = [];
  const continuations: unknown[][] = [];
  const attached = {
    ...item,
    tools: [{ kind: "mcp", id: "service" }],
    metadata: {},
  } as unknown as CapabilityCatalogItem;
  const client = {
    listCapabilities: async () => ({ items: [attached] }),
    listConnections: async () => [connection],
    getSession: async () => ({
      tools: [],
      firstPartyMcpTools: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      toolPolicyVersion: 3,
      effectiveToolPolicy: { effectiveIds: [], mandatoryIds: [], idsTruncated: false },
    }),
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
  expect(await render("library")).toEqual({ badge: null, provider: true });
  expect(await render("manual")).toEqual({ badge: "MCP server", provider: true });
});
