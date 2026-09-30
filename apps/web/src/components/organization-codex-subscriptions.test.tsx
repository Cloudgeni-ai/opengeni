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

const requestJson = mock(async (method: string, path: string, _body?: unknown) => {
  if (method === "GET" && path === `/v1/organizations/${organizationId}/codex/accounts`) {
    return response;
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
        scopeLabel: "Everyone in Acme",
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
