import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodexAccount, OrganizationCodexAccountsResponse } from "@opengeni/sdk";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const activeAccountId = "22222222-2222-4222-8222-222222222222";
const inactiveAccountId = "33333333-3333-4333-8333-333333333333";

function account(id: string, label: string, active: boolean): CodexAccount {
  return {
    id,
    label,
    status: "active",
    active,
    allocatorEnabled: true,
    allocatorVersion: 1,
    appsDesignated: false,
    canEnableApps: false,
  };
}

const response: OrganizationCodexAccountsResponse = {
  accounts: [
    account(activeAccountId, "Primary subscription", true),
    account(inactiveAccountId, "Backup subscription", false),
  ],
  activeAccountId,
  settings: {
    rotationEnabled: false,
    rotationStrategy: "sharded",
    activeCredentialId: activeAccountId,
  },
};
let usageNeedsReconnect = false;

const requestJson = mock(async (method: string, path: string, _body?: unknown) => {
  if (method === "GET" && path.endsWith("/usage")) {
    if (usageNeedsReconnect) {
      response.accounts[1] = { ...response.accounts[1]!, status: "needs_relogin" };
      return {
        status: "error",
        usage: {
          status: "error",
          reason: "needs_relogin",
          planType: null,
          fiveHour: null,
          weekly: null,
          limitReached: false,
          fetchedAt: new Date().toISOString(),
        },
      };
    }
    return {
      status: "ok",
      usage: {
        status: "ok",
        planType: "pro",
        fiveHour: null,
        weekly: null,
        limitReached: false,
        fetchedAt: new Date().toISOString(),
        credits: {
          balance: "120.50",
          hasCredits: true,
          unlimited: false,
          overageLimitReached: false,
        },
      },
    };
  }
  if (method === "GET" && path === `/v1/organizations/${organizationId}/codex/accounts`) {
    return structuredClone(response);
  }
  if (
    method === "PATCH" &&
    path === `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/allocator`
  ) {
    const enabled = (_body as { enabled: boolean }).enabled;
    response.accounts[1] = {
      ...response.accounts[1]!,
      allocatorEnabled: enabled,
      allocatorVersion: 2,
    };
    return { changed: true, allocatorEnabled: enabled, allocatorVersion: 2 };
  }
  if (method === "PATCH" && path.endsWith("/extra-credits")) {
    const enabled = (_body as { enabled: boolean }).enabled;
    response.accounts[1] = {
      ...response.accounts[1]!,
      extraCreditsEnabled: enabled,
      extraCreditsVersion: 2,
    };
    return { changed: true, extraCreditsEnabled: enabled, extraCreditsVersion: 2 };
  }
  if (
    method === "POST" &&
    path === `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/activate`
  ) {
    return undefined;
  }
  if (
    method === "DELETE" &&
    path === `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}`
  ) {
    return undefined;
  }
  throw new Error(`Unexpected request: ${method} ${path}`);
});
const access = {
  policy: {
    allowedModels: null,
    allowedWorkspaces: null,
    allowPersonalWorkspaces: true,
    version: 1,
  },
  models: [],
  workspaces: [],
  personalWorkspacesSupported: true,
};
const context = {
  clientConfig: { claudeSubscriptionEnabled: false },
  client: {
    requestJson,
    organizationCodexAccountUsage: (orgId: string, id: string) =>
      requestJson("GET", `/v1/organizations/${orgId}/codex/accounts/${id}/usage`),
    getModelConnectionAccess: mock(async () => access),
    listOrganizationSuperGrokAccounts: mock(async () => ({
      accounts: [],
      activeAccountId: null,
      settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
    })),
    getOrganizationModelProviderConnection: mock(async () => null),
    listOrganizationProviderCustomModels: mock(async () => ({ models: [] })),
  },
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({
  toast: { error: mock(() => undefined), success: mock(() => undefined) },
}));
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/destructive-confirm", () => ({
  DestructiveConfirm: ({
    open,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    onConfirm?: () => unknown;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button
        type="button"
        data-confirm=""
        onClick={() =>
          void (async () => {
            await onConfirm?.();
            onOpenChange(false);
          })()
        }
      >
        Confirm
      </button>
    ) : null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { OrgCodexAccountPage, reachesWorkspace } =
  await import("./models/organization-codex-models");
const { useOrganizationCodexSubscriptions } = await import("./organization-codex-subscriptions");
const { modelsScopeLabels } = await import("./models/models-ui");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

let backToList = mock(() => undefined);
let refreshNow: () => Promise<void> = async () => undefined;

/** An organization account's page on the one Models page, with the real data hook. */
function Harness({ accountId }: { accountId: string }) {
  const codex = useOrganizationCodexSubscriptions({
    client: context.client as never,
    organizationId,
  });
  refreshNow = codex.refresh;
  const [open] = useState(accountId);
  return (
    <OrgCodexAccountPage
      codex={codex}
      accountId={open}
      places={{
        organizationName: "Acme",
        scope: modelsScopeLabels("Acme", false),
        openAccount: () => undefined,
        openConnect: () => undefined,
        openAccess: () => undefined,
        backToList,
      }}
    />
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, text: string | RegExp) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    typeof text === "string"
      ? candidate.textContent?.trim() === text
      : text.test(candidate.textContent ?? ""),
  );
}

describe("organization Codex subscriptions", () => {
  test("usage sign-in failure refreshes account health and offers reconnection", async () => {
    usageNeedsReconnect = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      expect(button(container, "Sign in again")).toBeDefined();
      expect(container.textContent).toContain("Sign in to ChatGPT again to check usage.");
      expect(container.textContent).toContain("Not reported");
      expect(container.textContent).not.toContain("Try again in a moment");
    } finally {
      usageNeedsReconnect = false;
      response.accounts[1] = account(inactiveAccountId, "Backup subscription", false);
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("a paused account shows live credits without workspace assignment or consent changes", async () => {
    response.accounts[1] = { ...response.accounts[1]!, allocatorEnabled: false };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const before = requestJson.mock.calls.length;
    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      expect(container.textContent).toContain("Extra credits");
      expect(container.textContent).toContain("120.50");
      expect(container.textContent).toContain("Paused");
      expect(requestJson.mock.calls.slice(before).every(([method]) => method === "GET")).toBe(true);
      expect(
        container
          .querySelector('[aria-label="Use extra credits on Backup subscription"]')
          ?.getAttribute("aria-checked"),
      ).toBe("false");
    } finally {
      response.accounts[1] = account(inactiveAccountId, "Backup subscription", false);
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("a conflicting pause refreshes the account before the next change", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      requestJson.mockImplementationOnce(async () => {
        response.accounts[1] = {
          ...response.accounts[1]!,
          allocatorEnabled: false,
          allocatorVersion: 7,
        };
        throw new Error("Account changed; refresh and try again");
      });
      const selector =
        '[role="switch"][aria-label="Backup subscription is available for new chats"]';
      await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
      await flush();
      expect(container.textContent).toContain("Paused");
      await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
      await flush();
      expect(requestJson.mock.calls).toContainEqual([
        "PATCH",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/allocator`,
        { enabled: true, expectedVersion: 7 },
      ]);
    } finally {
      response.accounts[1] = account(inactiveAccountId, "Backup subscription", false);
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("credit consent is off by default and sends its own version without changing availability", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      const toggle = container.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="Use extra credits on Backup subscription"]',
      )!;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      await act(async () => toggle.click());
      await flush();
      expect(requestJson.mock.calls).toContainEqual([
        "PATCH",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/extra-credits`,
        { enabled: true, expectedVersion: 1 },
      ]);
      expect(response.accounts[1]!.allocatorEnabled).toBe(true);
      expect(access.policy.allowedWorkspaces).toBeNull();
    } finally {
      response.accounts[1] = account(inactiveAccountId, "Backup subscription", false);
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("pause changes only organization allocation and preserves workspace access", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      const toggle = container.querySelector<HTMLButtonElement>(
        '[role="switch"][aria-label="Backup subscription is available for new chats"]',
      );
      expect(toggle).not.toBeNull();
      await act(async () => toggle!.click());
      await flush();
      expect(requestJson.mock.calls).toContainEqual([
        "PATCH",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/allocator`,
        { enabled: false, expectedVersion: 1 },
      ]);
      expect(container.textContent).toContain("Paused");
      expect(container.textContent).toContain("Everyone in Acme");
      expect(access.policy.allowedWorkspaces).toBeNull();
    } finally {
      response.accounts[1] = account(inactiveAccountId, "Backup subscription", false);
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("an account's page sends explicit JSON bodies for activate and disconnect", async () => {
    backToList = mock(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<Harness accountId={inactiveAccountId} />));
      await flush();
      expect(container.querySelector("h1")?.textContent).toBe("Backup subscription");
      expect(container.textContent).toContain("Everyone in Acme");
      expect(container.textContent).toContain("Available in");

      await act(async () => button(container, "Make primary")!.click());
      await flush();
      expect(requestJson.mock.calls).toContainEqual([
        "POST",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}/activate`,
        {},
      ]);

      await act(async () => button(container, /Disconnect/)!.click());
      expect(requestJson.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
      await act(async () => container.querySelector<HTMLButtonElement>("[data-confirm]")!.click());
      await flush();
      expect(requestJson.mock.calls).toContainEqual([
        "DELETE",
        `/v1/organizations/${organizationId}/codex/accounts/${inactiveAccountId}`,
        {},
      ]);
      expect(backToList).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("a failed read recovers on refresh", async () => {
    requestJson.mockImplementationOnce(async () => {
      throw new Error("organization read failed");
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness accountId={activeAccountId} />));
      await flush();
      expect(container.textContent).toContain("This account isn't connected");
      await act(async () => refreshNow());
      await flush();
      expect(container.querySelector("h1")?.textContent).toBe("Primary subscription");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("whether an organization account reaches a workspace follows Available in", () => {
    const shared = { id: "workspace-a", personal: false };
    const personal = { id: "personal-a", personal: true };
    expect(reachesWorkspace(null, shared)).toBeNull();
    expect(reachesWorkspace(access, shared)).toBe(true);
    expect(reachesWorkspace(access, personal)).toBe(true);
    const limited = {
      ...access,
      policy: {
        ...access.policy,
        allowedWorkspaces: ["workspace-b"],
        allowPersonalWorkspaces: false,
      },
    };
    expect(reachesWorkspace(limited, shared)).toBe(false);
    expect(reachesWorkspace(limited, personal)).toBe(false);
    // Organization API keys never serve Personal workspaces.
    expect(reachesWorkspace({ ...access, personalWorkspacesSupported: false }, personal)).toBe(
      false,
    );
  });
});
