import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { sessionAuthRecommendation } from "./session-auth-recommendation";

import { CapabilityCatalogItem } from "@opengeni/contracts";
import { buildTimeline, type AuthNeededItem } from "@opengeni/react";

const catalogItem = CapabilityCatalogItem.parse({
  id: "example",
  kind: "mcp",
  source: "manual",
  name: "Example",
  providerDomain: "api.example.com",
  mcpUrl: "https://api.example.com/mcp",
  authKind: "api_key",
  runtime: { available: true, mcpServerId: "example" },
  tools: [{ kind: "mcp", id: "example" }],
});
let personal = false;
let liveCatalogItem = catalogItem;
let enabled = false;
let connections: unknown[] = [];
const row = {
  id: "connection",
  providerDomain: "api.example.com",
  kind: "api_key",
  subjectId: null,
  status: "active",
};
const createConnection = mock(async () => {
  connections.push(row);
  return row;
});
const updateConnection = mock(async () => row);
const enableCapability = mock(async () => {
  enabled = true;
});
const issueUserResourceGrant = mock(async (..._args: unknown[]) => ({}));
const context = {
  client: {
    listCapabilities: async () => ({
      items: [
        {
          ...liveCatalogItem,
          enabled,
          ...(personal
            ? {
                connectionRef: {
                  subjectScope: "subject",
                  providerDomain: "api.example.com",
                  kind: "api_key",
                },
              }
            : {}),
        },
      ],
    }),
    listConnections: async () => connections,
    listSocialConnections: async () => [],
    listSlackInstallationBindings: async () => [],
    listIntegrationDefinitions: async () => ({ definitions: [] }),
    listApiIntegrations: async () => ({ integrations: [] }),
    catalogAssetUrl: (path: string) => path,
    listUserResourceAuthorities: async () => ({ authorities: [] }),
    issueUserResourceGrant,
    createConnection,
    updateConnection,
    enableCapability,
    getSession: async () => ({
      id: "session",
      workspaceId: "workspace",
      tenancy: { visibility: "workspace", authorityEpoch: 4 },
      tools: [{ kind: "mcp", id: "example" }],
      toolPolicy: { mode: "explicit" },
      firstPartyMcpTools: [],
      toolPolicyVersion: 1,
    }),
  },
  workspaceCapabilityCatalog: [catalogItem],
  refreshWorkspaceMcpServers: async () => {},
  accessContext: { workspaceGrants: [] },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionCapabilityCard } = await import("./session-capability-card");
const item = {
  id: "notice",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "api.example.com",
  reason: "missing_connection",
  capability: {
    id: "example",
    name: "Example",
    kind: "mcp",
    action: "add_credentials",
    rationale: "Use Example for your report.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
async function render(
  personalAccount = false,
  currentCatalogItem = catalogItem,
  cachedCatalogItem = catalogItem,
  missingGrant = false,
) {
  personal = personalAccount;
  liveCatalogItem = currentCatalogItem;
  context.workspaceCapabilityCatalog = [cachedCatalogItem];
  enabled = personalAccount;
  connections = personalAccount ? [{ ...row, subjectId: "owner", authorityId: "authority" }] : [];
  issueUserResourceGrant.mockClear();
  updateConnection.mockClear();
  createConnection.mockClear();
  enableCapability.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let notice = item;
  if (missingGrant) {
    const startupEvents = [
      {
        id: "startup-auth",
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        turnAttemptId: "attempt",
        sequence: 1,
        type: "tool.auth_needed",
        occurredAt: "2026-09-11T00:00:00.000Z",
        payload: {
          serverId: "example",
          providerDomain: "api.example.com",
          reason: "personal_authority_unavailable",
        },
      },
    ];
    expect(buildTimeline(startupEvents)).toEqual([]);
    const requested = buildTimeline([
      ...startupEvents,
      {
        ...startupEvents[0]!,
        id: "requested-auth",
        sequence: 2,
        payload: {
          serverId: "example",
          toolName: "capability_authorization_request",
          providerDomain: "api.example.com",
          reason: "missing_connection",
          capability: {
            id: "example",
            name: "Example",
            kind: "mcp",
            source: "manual",
            action: "connect",
            rationale: "Review permission to use your personal account for this request.",
            requiredVariables: [],
          },
        },
      },
    ]);
    const auth = requested.find((entry) => entry.kind === "auth-needed");
    expect(auth).toBeDefined();
    if (!auth) throw new Error("Requested authorization event was lost from the timeline");
    const recommendation = sessionAuthRecommendation(
      auth,
      (await context.client.listCapabilities()).items as CapabilityCatalogItem[],
    );
    expect(recommendation).toBeDefined();
    if (!recommendation) throw new Error("Requested authorization did not resolve to consent");
    notice = recommendation;
  }
  await act(async () =>
    root.render(
      <SessionCapabilityCard item={notice} workspaceId="workspace" sessionId="session" />,
    ),
  );
  return {
    container,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  );
  if (!result) throw new Error(`Missing ${label}: ${container.textContent}`);
  return result;
}

describe("conversation connection card", () => {
  test("OAuth CTA retains the live provider name after renamed setup is opened and cancelled", async () => {
    const cached = { ...catalogItem, authKind: "oauth2" as const };
    const h = await render(false, { ...cached, name: "Current Example" }, cached);
    try {
      expect(button(h.container, "Connect Example").textContent).toBe("Connect Example");
      await act(async () => button(h.container, "Connect Example").click());
      expect(h.container.querySelector("h3")?.textContent).toBe("Current Example");
      await act(async () => button(h.container, "Cancel").click());
      expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
      expect(h.container.querySelector("h3")?.textContent).toBe("Current Example");
      expect(button(h.container, "Connect Current Example").textContent).toBe(
        "Connect Current Example",
      );
      expect(createConnection).not.toHaveBeenCalled();
      expect(updateConnection).not.toHaveBeenCalled();
      expect(enableCapability).not.toHaveBeenCalled();
      expect(issueUserResourceGrant).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
  test("expanded header reflects the live provider identity rather than stale recommendation copy", async () => {
    const h = await render(false, {
      ...catalogItem,
      name: "Current Example",
      providerDomain: "current.example.com",
    });
    await act(async () => button(h.container, "Add API key").click());
    expect(h.container.querySelector("h3")?.textContent).toBe("Current Example");
    expect(h.container.textContent).toContain("current.example.com");
    expect(h.container.textContent).not.toContain("api.example.com");
    expect(h.container.querySelectorAll("h3")).toHaveLength(1);
    await h.close();
  });
  test("opens the actual credential form inline and cancellation writes nothing", async () => {
    const h = await render();
    expect(h.container.textContent).toContain("You choose what to authorize");
    expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
    await act(async () => button(h.container, "Add API key").click());
    expect(h.container.querySelector('input[type="password"]')).not.toBeNull();
    expect(h.container.querySelectorAll("h3")).toHaveLength(1);
    expect(h.container.textContent).toContain("Verify & connect");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button(h.container, "Cancel").click());
    expect(h.container.querySelector("form")).toBeNull();
    expect(createConnection).not.toHaveBeenCalled();
    await h.close();
  });
  test("credentials go only to the connection API and success follows enable", async () => {
    const h = await render();
    await act(async () => button(h.container, "Add API key").click());
    const input = h.container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "secret-for-provider-only");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      h.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(enableCapability).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).toContain("Connected · Available in this conversation");
    expect(h.container.querySelector('[data-state="complete"]')).not.toBeNull();
    expect(h.container.querySelector("button")).toBeNull();
    expect(h.container.textContent).not.toContain("secret-for-provider-only");
    await h.close();
  });
  test("a personal account requires explicit shared-results consent before completion", async () => {
    const h = await render(true, catalogItem, catalogItem, true);
    expect(h.container.textContent).toContain("Review permission to use your personal account");
    expect(issueUserResourceGrant).not.toHaveBeenCalled();
    await act(async () => button(h.container, "Add API key").click());
    const use = button(h.container, "Use in this");
    expect(use.disabled).toBe(true);
    expect(issueUserResourceGrant).not.toHaveBeenCalled();
    expect(h.container.querySelector('[data-state="complete"]')).toBeNull();
    await act(async () =>
      (h.container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    expect(use.disabled).toBe(false);
    await act(async () => use.click());
    expect(issueUserResourceGrant).toHaveBeenCalledTimes(1);
    expect(issueUserResourceGrant.mock.calls[0]?.[2]).toMatchObject({
      mode: "session",
      sessionId: "session",
      expectedAuthorityEpoch: 4,
      workspaceSharedAcknowledged: true,
    });
    expect(h.container.textContent).toContain("Connected · Available in this conversation");
    await h.close();
  });
  test("retry after a partial save reuses the persisted Connection", async () => {
    const h = await render();
    enableCapability.mockImplementationOnce(async () => {
      throw new Error("Enable failed");
    });
    await act(async () => button(h.container, "Add API key").click());
    const input = h.container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "fixture-credential",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = async () => {
      await act(async () => {
        h.container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    };
    await submit();
    expect(h.container.textContent).toContain("Enable failed");
    expect(h.container.querySelector('[data-state="complete"]')).toBeNull();
    await submit();
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(updateConnection).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).toContain("Connected · Available in this conversation");
    await h.close();
  });
});
