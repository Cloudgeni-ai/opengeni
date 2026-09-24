// Run explicitly through session-capability-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import { CapabilityCatalogItem } from "@opengeni/contracts";
import type { AuthNeededItem } from "@opengeni/react";

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
const getGitHubApp = mock(async () => ({
  status: "unbound",
  configured: true,
  linkUrl: "https://api.example.test/github/connect",
}));
const refreshGitHub = mock(async () => {});
const context = {
  client: {
    connectTransport: () => ({}),
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
    getGitHubApp,
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
  githubStatus: null as { status: string } | null,
  refreshGitHub,
  refreshWorkspaceMcpServers: async () => {},
  accessContext: {
    workspaceGrants: [{ workspaceId: "workspace", permissions: ["connections:read"] }],
  },
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
GlobalRegistrator.register();
const { sessionAuthRecommendation } = await import("./session-auth-recommendation");
const { buildTimeline } = await import("@opengeni/react");
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
  visibility: "private" | "workspace" = "workspace",
  noticeOverride: AuthNeededItem = item,
) {
  personal = personalAccount;
  liveCatalogItem = currentCatalogItem;
  context.workspaceCapabilityCatalog = [cachedCatalogItem];
  enabled = personalAccount;
  connections = personalAccount ? [{ ...row, subjectId: "owner", authorityId: "authority" }] : [];
  updateConnection.mockClear();
  createConnection.mockClear();
  enableCapability.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let notice = noticeOverride;
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
      <SessionCapabilityCard
        item={notice}
        workspaceId="workspace"
        sessionId="session"
        visibility={visibility}
      />,
    ),
  );
  return {
    container: document.body,
    host: container,
    rerender: async (workspaceId: string) => {
      await act(async () =>
        root.render(
          <SessionCapabilityCard item={notice} workspaceId={workspaceId} sessionId="session" />,
        ),
      );
    },
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
  const githubItem = {
    ...catalogItem,
    id: "api:github-app",
    kind: "api" as const,
    name: "GitHub App",
    providerDomain: "github.com",
  };
  const githubNotice = {
    ...item,
    capability: {
      ...item.capability!,
      id: "api:github-app",
      kind: "api" as const,
      name: "GitHub App",
    },
  } as AuthNeededItem;

  test("GitHub's bundled logo and verified binding persist in the conversation card", async () => {
    context.githubStatus = { status: "bound" };
    const h = await render(false, githubItem, githubItem, false, "workspace", githubNotice);
    try {
      // Happy DOM cannot serve static assets; the source path is checked in
      // capability-logo-source.test.ts, while this verifies the live card state.
      expect(h.container.querySelector('[data-state="complete"]')).not.toBeNull();
      expect(h.container.textContent).toContain("Connected to this workspace");
      expect(h.container.textContent).not.toContain("Available in this conversation");
      expect(h.container.textContent).not.toContain("Connect GitHub App");
    } finally {
      await h.close();
      context.githubStatus = null;
    }
  });

  test("a returning GitHub binding refreshes the existing card, including later disconnection", async () => {
    context.githubStatus = { status: "unbound" };
    const h = await render(false, githubItem, githubItem, false, "workspace", githubNotice);
    try {
      expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
      context.githubStatus = { status: "bound" };
      await h.rerender("workspace");
      expect(h.container.querySelector('[data-state="complete"]')).not.toBeNull();
      context.githubStatus = { status: "unbound" };
      await h.rerender("workspace");
      expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
    } finally {
      await h.close();
      context.githubStatus = null;
    }
  });

  test("GitHub starts on one click, visibly waits, ignores a second click, and confirms a binding", async () => {
    context.githubStatus = null;
    getGitHubApp.mockClear();
    refreshGitHub.mockClear();
    let resolveStatus!: (value: Awaited<ReturnType<typeof getGitHubApp>>) => void;
    getGitHubApp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const h = await render(false, githubItem, githubItem, false, "workspace", githubNotice);
    try {
      await act(async () => button(h.container, "Connect GitHub App").click());
      const waiting = button(h.container, "Opening GitHub…");
      expect(waiting.disabled).toBe(true);
      expect(getGitHubApp).toHaveBeenCalledTimes(1);
      await act(async () => waiting.click());
      expect(getGitHubApp).toHaveBeenCalledTimes(1);
      expect(getGitHubApp).toHaveBeenCalledWith("workspace", {
        returnPath: "/workspaces/workspace/sessions/session",
      });
      await act(async () => {
        resolveStatus({ status: "bound", configured: true, linkUrl: "" });
      });
      expect(h.container.querySelector('[data-state="complete"]')).not.toBeNull();
      expect(h.container.textContent).toContain("Connected to this workspace");
      expect(refreshGitHub).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  test("a BFCache return unlocks GitHub and ignores an old pending status response", async () => {
    context.githubStatus = null;
    refreshGitHub.mockClear();
    let resolveOldStatus!: (value: Awaited<ReturnType<typeof getGitHubApp>>) => void;
    getGitHubApp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldStatus = resolve;
        }),
    );
    const h = await render(false, githubItem, githubItem, false, "workspace", githubNotice);
    try {
      await act(async () => button(h.container, "Connect GitHub App").click());
      expect(button(h.container, "Opening GitHub…").disabled).toBe(true);
      await act(async () => {
        const restored = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(restored, "persisted", { value: true });
        window.dispatchEvent(restored);
      });
      expect(button(h.container, "Connect GitHub App").disabled).toBe(false);
      expect(refreshGitHub).toHaveBeenCalledWith("workspace");
      await act(async () => resolveOldStatus({ status: "bound", configured: true, linkUrl: "" }));
      expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
      getGitHubApp.mockImplementationOnce(async () => ({
        status: "bound",
        configured: true,
        linkUrl: "",
      }));
      await act(async () => button(h.container, "Connect GitHub App").click());
      expect(h.container.querySelector('[data-state="complete"]')).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  test("GitHub's failed start offers a retry in the existing dialog", async () => {
    getGitHubApp.mockImplementationOnce(async () => {
      throw new Error("Temporary status failure");
    });
    const h = await render(false, githubItem, githubItem, false, "workspace", githubNotice);
    try {
      await act(async () => button(h.container, "Connect GitHub App").click());
      expect(h.container.textContent).toContain("Temporary status failure");
      expect(button(h.container, "Try again")).toBeDefined();
    } finally {
      await h.close();
    }
  });

  test("OAuth CTA retains the live provider name after renamed setup is opened and cancelled", async () => {
    const cached = { ...catalogItem, authKind: "oauth2" as const };
    const h = await render(false, { ...cached, name: "Current Example" }, cached);
    try {
      expect(button(h.container, "Connect Current Example").textContent).toBe(
        "Connect Current Example",
      );
      await act(async () => button(h.container, "Connect Current Example").click());
      expect(h.container.querySelector("h3")?.textContent).toBe("Current Example");
      await act(async () =>
        h.container
          .querySelector<HTMLButtonElement>('[aria-label="Close connection setup"]')!
          .click(),
      );
      expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
      expect(h.container.querySelector("h3")?.textContent).toBe("Current Example");
      expect(button(h.container, "Connect Current Example").textContent).toBe(
        "Connect Current Example",
      );
      expect(createConnection).not.toHaveBeenCalled();
      expect(updateConnection).not.toHaveBeenCalled();
      expect(enableCapability).not.toHaveBeenCalled();
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
  test("first Connect opens the shared centered dialog and cancellation writes nothing", async () => {
    const h = await render();
    expect(h.container.textContent).toContain("You choose what to authorize");
    expect(h.container.querySelector('[data-state="suggested"]')).not.toBeNull();
    await act(async () => button(h.container, "Add API key").click());
    expect(h.container.querySelector('input[type="password"]')).not.toBeNull();
    expect(h.container.querySelectorAll("h3")).toHaveLength(1);
    expect(h.container.textContent).toContain("Connect for workspace");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain("og-session-capability-dialog");
    expect(h.host.querySelector("form")).toBeNull();
    await act(async () => button(h.container, "Cancel").click());
    expect(h.container.querySelector("form")).toBeNull();
    expect(createConnection).not.toHaveBeenCalled();
    expect(enableCapability).not.toHaveBeenCalled();
    await h.close();
  });
  test("switching workspace discards the open dialog and its credential draft", async () => {
    const h = await render();
    try {
      await act(async () => button(h.container, "Add API key").click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await h.rerender("other-workspace");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(h.container.querySelector('input[type="password"]')).toBeNull();
      expect(createConnection).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
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
  test.each(["workspace", "private"] as const)(
    "a personal account attaches tools without a conversation grant (%s)",
    async (visibility) => {
      const h = await render(true, catalogItem, catalogItem, true, visibility);
      try {
        await act(async () => button(h.container, "Add API key").click());
        const dialog = document.querySelector("[role=dialog]");
        expect(dialog?.textContent).toContain(
          "Your messages and personal schedules can use this account.",
        );
        expect(dialog?.querySelector("input[type=checkbox]")).toBeNull();
        const add = button(h.container, "Add tools");
        expect(add.disabled).toBe(false);
        await act(async () => add.click());
        expect(createConnection).not.toHaveBeenCalled();
        expect(h.container.textContent).toContain("Connected · Available in this conversation");
      } finally {
        await h.close();
      }
    },
  );
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
