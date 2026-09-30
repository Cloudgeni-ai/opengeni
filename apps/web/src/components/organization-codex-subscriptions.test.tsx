import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodexAccount, OrganizationCodexAccountsResponse } from "@opengeni/sdk";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { ModelsView } from "@/lib/models-route";

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

let navigateTo: (search: { account?: string; view?: ModelsView }) => void = () => {};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({
  toast: { error: mock(() => undefined), success: mock(() => undefined) },
}));
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => (options: { search: { account?: string; view?: ModelsView } }) =>
    navigateTo(options.search),
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

const { OrganizationModelsPage } = await import("./models/organization-models-page");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function Harness() {
  const [search, setSearch] = useState<{ account?: string; view?: ModelsView }>({});
  navigateTo = setSearch;
  return (
    <OrganizationModelsPage
      workspaceId="workspace-a"
      organizationId={organizationId}
      organizationName="Acme"
      account={search.account}
      view={search.view}
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
  test("sends explicit JSON bodies for activate and disconnect mutations", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(container.textContent).toContain("Available in all shared workspaces + Personal");

      const row = [...container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find(
        (candidate) => candidate.textContent?.includes("Backup subscription"),
      )!;
      await act(async () => row.querySelector<HTMLElement>("[data-row-action]")!.click());
      await flush();
      expect(container.querySelector("h1")?.textContent).toBe("Backup subscription");

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
      expect(container.textContent).toContain("Shared with the organization's workspaces.");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("a failed read shows an alert with Try again", async () => {
    requestJson.mockImplementationOnce(async () => {
      throw new Error("organization read failed");
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await flush();
      expect(container.textContent).toContain("Couldn't load the organization's Codex accounts.");
      await act(async () => button(container, "Try again")!.click());
      await flush();
      expect(container.textContent).toContain("Primary subscription");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
