import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  CodexAccount,
  CodexAccountsResponse,
  CodexOverviewResponse,
  ConnectionMetadata,
  WorkspaceCodexSubscriptionSource,
} from "@opengeni/sdk";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ModelsView } from "@/lib/models-route";
import type { ModelsWorkspace } from "./organization-models-list";

/* ----------------------------------------------------------------------------
   Settings > Models in a workspace: rows, the account page, and the source,
   pick and per-account controls, against a mocked client. Navigation is the
   URL (account/view search params), driven here by a fake navigate.
   -------------------------------------------------------------------------- */

const source: WorkspaceCodexSubscriptionSource = {
  accountId: "organization-a",
  workspaceId: "workspace-a",
  workspaceKind: "shared",
  mode: "automatic",
  effectiveSource: "workspace",
  workspaceAvailable: true,
  organizationAvailable: true,
};

function codexAccount(overrides: Partial<CodexAccount> = {}): CodexAccount {
  return {
    id: "acct-1",
    source: "workspace",
    label: "Team plan",
    email: "team@example.com",
    plan: "pro",
    status: "active",
    active: true,
    allocatorEnabled: true,
    allocatorVersion: 3,
    appsDesignated: false,
    canEnableApps: false,
    ...overrides,
  };
}

const cachedWindow = {
  used: 90,
  limit: 100,
  remaining: 10,
  percent: 90,
  resetAt: null,
  resetAfterSeconds: null,
  limitWindowSeconds: 604800,
};

function overviewFor(id: string, remaining: number | null): CodexOverviewResponse {
  return {
    accounts: {
      [id]: {
        accountId: id,
        usage: {
          source: "provider",
          fetchedAt: new Date().toISOString(),
          stale: false,
          error: null,
          value:
            remaining === null
              ? null
              : {
                  status: "ok",
                  planType: null,
                  fiveHour: null,
                  weekly: {
                    ...cachedWindow,
                    remaining,
                    used: 100 - remaining,
                    percent: 100 - remaining,
                  },
                  limitReached: false,
                  fetchedAt: new Date().toISOString(),
                },
        },
        resetCredits: {
          source: "none",
          fetchedAt: null,
          stale: false,
          error: null,
          detailState: "unknown",
          detailsComplete: false,
          availableCount: null,
          credits: [],
        },
        canRedeem: false,
        canResumeRedemption: false,
        redemptions: [],
        redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
      },
    },
  };
}

let accounts: CodexAccountsResponse = {
  accounts: [codexAccount({ weekly: cachedWindow })],
  activeAccountId: "acct-1",
  source,
  settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: "acct-1" },
};

const client = {
  listCodexAccounts: mock(async (_workspaceId: string) => accounts),
  codexOverview: mock(async (_workspaceId: string) => overviewFor("acct-1", 75)),
  codexConnectStart: mock(async (_workspaceId: string) => {
    throw new Error("Device authorization unavailable in fixture");
  }),
  setCodexAccountAllocator: mock(async () => ({})),
  setCodexRotationSettings: mock(async () => ({})),
  disconnectCodexAccount: mock(async () => ({})),
  requestJson: mock(
    async (_method: string, _path: string, _body?: unknown): Promise<unknown> => ({}),
  ),
  getModelConnectionAccess: mock(async (): Promise<unknown> => {
    throw new Error("must not read access for this account");
  }),
  listSuperGrokAccounts: mock(
    async (): Promise<unknown> => ({
      accounts: [],
      activeAccountId: null,
      settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
    }),
  ),
  listConnections: mock(async (): Promise<ConnectionMetadata[]> => []),
  listClaudeSubscriptionAccounts: mock(
    async (): Promise<unknown> => ({
      accounts: [],
      activeAccountId: null,
      source: "workspace",
      settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: null },
    }),
  ),
  listOrganizationClaudeSubscriptionAccounts: mock(
    async (): Promise<unknown> => ({
      accounts: [],
      activeAccountId: null,
      source: "organization",
      settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: null },
    }),
  ),
  getClaudeSubscriptionAccountUsage: mock(async () => ({
    connected: true,
    credentialVersion: 1,
    windows: [],
    observedAt: null,
    source: null,
    refreshStatus: "not_checked",
    refreshCheckedAt: null,
  })),
  getWorkspaceClaudeSubscriptionUsage: mock(async () => ({
    connected: true,
    credentialVersion: 1,
    windows: [],
    observedAt: null,
    source: null,
    refreshStatus: "not_checked",
    refreshCheckedAt: null,
  })),
  listWorkspaceGatewayCustomModels: mock(async () => ({ models: [] })),
  listWorkspaceOpenRouterCustomModels: mock(async () => ({ models: [] })),
  listWorkspaceOpperCustomModels: mock(async () => ({ models: [] })),
  listWorkspaceClaudeCustomModels: mock(async () => ({ models: [] })),
  getWorkspaceModelCatalog: mock(async () => ({ models: [] })),
  getWorkspaceModelAccessPolicy: mock(async () => ({
    allowedProviders: null,
    allowedModels: null,
  })),
  getOrganizationModelProviderConnection: mock(async (): Promise<unknown> => null),
  upsertOrganizationModelProviderConnection: mock(
    async (): Promise<unknown> => ({ id: "org-key", status: "active", version: 1 }),
  ),
  getOrganizationAdministrationOverview: mock(async () => ({
    organization: { id: "organization-a", name: "Acme" },
    roles: [],
    workspaces: [
      { id: "workspace-a", name: "Design preview" },
      { id: "workspace-b", name: "Platform" },
    ],
  })),
  updateModelConnectionAccess: mock(async (_target: unknown, policy: unknown) => policy),
  listOrganizationProviderCustomModels: mock(async () => ({ models: [] })),
  listOrganizationSuperGrokAccounts: mock(
    async (): Promise<unknown> => ({
      accounts: [],
      activeAccountId: null,
      settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
    }),
  ),
  getBilling: mock(
    async (_request: { accountId: string }): Promise<unknown> => ({
      mode: "stripe",
      balance: { balanceMicros: 12_500_000, currency: "usd" },
    }),
  ),
};

const CREDITS_MODEL = { id: "gpt-credits", label: "GPT credits", cost: "credits" };
const context: {
  client: typeof client;
  clientConfig: {
    billingMode: "disabled" | "stripe";
    models: unknown[];
    claudeSubscriptionEnabled?: boolean;
  };
  accessContext: { accountGrants: { accountId: string; permissions: string[] }[] } | null;
  [key: string]: unknown;
} = {
  client,
  clientConfig: { billingMode: "disabled", models: [] },
  accessContext: null,
  workspaces: [],
  captureWorkspaceInvocation: () => null,
  ownsWorkspaceInvocation: () => false,
  updateWorkspaceSettings: async () => null,
};

let navigateTo: (search: {
  account?: string;
  view?: ModelsView;
  workspace?: string;
}) => void = () => {};
let lastNavigation: { to?: string; search: Record<string, unknown> } | null = null;

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({
  toast: { success: mock(() => undefined), error: mock(() => undefined) },
}));
mock.module("@tanstack/react-router", () => ({
  useNavigate:
    () => (options: { to?: string; search: { account?: string; view?: ModelsView } }) => {
      lastNavigation = options;
      navigateTo(options.search);
    },
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("@/components/default-session-model", () => ({
  DefaultSessionModelPreferenceRow: ({
    describePayer,
  }: {
    describePayer?: (model: Record<string, unknown>) => string;
  }) => (
    <div data-testid="default-model-row">
      Default model{" "}
      {describePayer?.({
        id: "codex/gpt-6-astra",
        label: "GPT-6 Astra",
        provider: "codex",
        providerLabel: "Codex",
        source: "codex",
        cost: "subscription",
        billing: { upstreamPayer: "connected_subscription", metering: "external" },
      })}
    </div>
  ),
}));
// Menus and confirms as plain buttons: the real ones are Radix portals.
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" data-menu-item="" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/destructive-confirm", () => ({
  DestructiveConfirm: ({
    open,
    title,
    consequences,
    confirmLabel,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: ReactNode;
    consequences?: ReactNode[];
    confirmLabel?: string;
    onConfirm?: () => unknown;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="confirm">
        <p>{title}</p>
        <ul>
          {consequences?.map((item, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- fixed list
            <li key={index}>{item}</li>
          ))}
        </ul>
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
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { WorkspaceModelsPage } = await import("./workspace-models-page");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test.each([false, true])(
  "Claude freezes its audience during setup completion (selected=%s)",
  async (selectedBefore) => {
    asOrganizationAdmin();
    context.clientConfig.claudeSubscriptionEnabled = true;
    let finish!: (value: {
      accountId: string;
      connected: boolean;
      credentialVersion: number;
    }) => void;
    const deferred = new Promise<{
      accountId: string;
      connected: boolean;
      credentialVersion: number;
    }>((resolve) => {
      finish = resolve;
    });
    const save = mock(async () => deferred);
    Object.assign(client, { connectOrganizationClaudeSubscriptionSetupToken: save });
    client.getModelConnectionAccess.mockImplementation(async () => ({ policy: openPolicy }));
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect-org:claude_subscription" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect Claude subscription");
      await act(async () => button(view.container, /Use a setup token/)!.click());
      await flush();
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Claude subscription setup token"]',
      )!;
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "sk-ant-oat01-synthetic-fixture",
        );
        const propKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
        (input as any)[propKey].onChange({ target: input });
      });
      if (selectedBefore) {
        const selected = [
          ...view.container.querySelectorAll<HTMLElement>('[data-slot="choice-card"]'),
        ].find((card) => card.textContent?.includes("Only selected workspaces"))!;
        await act(async () => selected.click());
        await flush();
      }
      const form = input.closest("form")!;
      await act(async () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(save).toHaveBeenCalledTimes(1);
      const selected = [
        ...view.container.querySelectorAll<HTMLElement>('[data-slot="choice-card"]'),
      ].find((card) => card.textContent?.includes("Only selected workspaces"))!;
      expect(selected).not.toBeNull();
      await act(async () => selected.click());
      await flush();
      expect(selected.getAttribute("data-state")).toBe(selectedBefore ? "checked" : "unchecked");
      expect(selected.getAttribute("disabled")).not.toBeNull();
      await act(async () => {
        finish({
          accountId: "10000000-0000-4000-8000-000000000003",
          connected: true,
          credentialVersion: 1,
        });
        await Promise.resolve();
      });
      await flush();
      expect(client.updateModelConnectionAccess).toHaveBeenCalledTimes(selectedBefore ? 1 : 0);
      if (selectedBefore)
        expect(client.updateModelConnectionAccess).toHaveBeenCalledWith(
          {
            scope: "organizations",
            scopeId: "organization-a",
            kind: "claude_subscription",
            connectionId: "10000000-0000-4000-8000-000000000003",
          },
          { ...openPolicy, allowedWorkspaces: ["workspace-a"], allowPersonalWorkspaces: false },
        );
      expect(lastNavigation?.search.account).toBe(
        "org:claude:10000000-0000-4000-8000-000000000003",
      );
    } finally {
      await cleanup(view);
    }
  },
);

beforeAll(() => undefined);

beforeEach(() => {
  organizationAdmin = false;
  organizationList = false;
  organizationWorkspaces = [];
  personalWorkspace = false;
  workspaceSettingsAdmin = undefined;
  for (const fn of Object.values(client)) fn.mockClear();
  accounts = {
    accounts: [codexAccount({ weekly: cachedWindow })],
    activeAccountId: "acct-1",
    source,
    settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: "acct-1" },
  };
  client.listCodexAccounts.mockImplementation(async () => accounts);
  client.codexOverview.mockImplementation(async () => overviewFor("acct-1", 75));
  client.listSuperGrokAccounts.mockImplementation(async () => ({
    accounts: [],
    activeAccountId: null,
    settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
  }));
  client.listOrganizationSuperGrokAccounts.mockImplementation(async () => ({
    accounts: [],
    activeAccountId: null,
    settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
  }));
  client.requestJson.mockImplementation(async () => ({}));
  client.listConnections.mockImplementation(async () => []);
  client.listClaudeSubscriptionAccounts.mockImplementation(async () => ({
    accounts: [],
    activeAccountId: null,
    source: "workspace",
    settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: null },
  }));
  context.clientConfig.claudeSubscriptionEnabled = false;
});

const ACCOUNTS_SECTION = "Subscriptions, API keys and credits that pay for models here.";

let organizationAdmin = false;

/** An organization owner or admin whose organization shares no Codex accounts yet. */
function asOrganizationAdmin(): void {
  organizationAdmin = true;
  client.requestJson.mockImplementation(async (method: string, path: string) =>
    method === "GET" && path === "/v1/organizations/organization-a/codex/accounts"
      ? {
          accounts: [],
          activeAccountId: null,
          settings: {
            rotationEnabled: false,
            rotationStrategy: "sharded",
            activeCredentialId: null,
          },
        }
      : {},
  );
}
let personalWorkspace = false;
let organizationWorkspaces: ModelsWorkspace[] = [];

let organizationList = false;
/** Whether the person administers this workspace; defaults to `canManage`. */
let workspaceSettingsAdmin: boolean | undefined;

function Harness({ canManage, organizationId }: { canManage: boolean; organizationId?: string }) {
  const [search, setSearch] = useState<{ account?: string; view?: ModelsView; workspace?: string }>(
    organizationList ? {} : { workspace: "workspace-a" },
  );
  // Tests open pages of this workspace's model page unless they start on the organization's list.
  navigateTo = (next) =>
    setSearch(
      organizationList || "workspace" in next ? next : { ...next, workspace: "workspace-a" },
    );
  return (
    <WorkspaceModelsPage
      anchorWorkspaceId="workspace-a"
      workspacePage={Boolean(search.workspace)}
      workspaces={organizationWorkspaces}
      workspaceId="workspace-a"
      workspaceName="Design preview"
      personal={personalWorkspace}
      organizationId={organizationId ?? (organizationAdmin ? "organization-a" : undefined)}
      organizationName="Acme"
      canManageSettings={workspaceSettingsAdmin ?? canManage}
      canManageConnections={canManage}
      canManageOrganizationModels={organizationAdmin}
      account={search.account}
      view={search.view}
      onConnectionChange={() => undefined}
    />
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(
  canManage = true,
  organizationId?: string,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Harness canManage={canManage} organizationId={organizationId} />),
  );
  await flush();
  await flush();
  return { container, root };
}

async function cleanup({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

function button(container: HTMLElement, text: string | RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    typeof text === "string"
      ? candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text
      : text.test(candidate.textContent ?? ""),
  );
}

test("workspace Models exposes a reloadable compaction page to admins and readers", async () => {
  for (const canManage of [true, false]) {
    const view = await render(canManage);
    try {
      const open = button(view.container, /Context & compaction/);
      expect(open).toBeDefined();
      await act(async () => open!.click());
      await flush();
      expect(lastNavigation?.search.view).toBe("compaction");
      expect(view.container.textContent).toContain(
        "Connect a subscription or API key to set limits for its models.",
      );
    } finally {
      await cleanup(view);
    }
  }
});

describe("Codex rows", () => {
  for (const outcome of ["weekly", "empty", "error"] as const) {
    test(`waits for the live overview without flashing cached limits: ${outcome}`, async () => {
      let resolve!: (value: CodexOverviewResponse) => void;
      let reject!: (error: Error) => void;
      client.codexOverview.mockImplementation(
        () =>
          new Promise<CodexOverviewResponse>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const view = await render();
      try {
        expect(view.container.textContent).toContain("Team plan");
        expect(view.container.textContent).not.toContain("10% left");
        await act(async () => {
          if (outcome === "error") reject(new Error("Provider unavailable"));
          else resolve(overviewFor("acct-1", outcome === "empty" ? null : 75));
        });
        await flush();
        expect(view.container.textContent).not.toContain("10% left");
        if (outcome === "weekly") expect(view.container.textContent).toContain("75% left");
        else
          expect(view.container.textContent).toContain(
            outcome === "error" ? "Usage unavailable" : "No usage yet",
          );
      } finally {
        await cleanup(view);
      }
    });
  }

  test("a failed read is not an empty list, and Try again reloads", async () => {
    let failed = true;
    client.listCodexAccounts.mockImplementation(async () => {
      if (failed) throw new Error("Connection request failed");
      return { ...accounts, accounts: [], source: { ...source, organizationAvailable: false } };
    });
    const view = await render();
    try {
      expect(view.container.textContent).toContain("Couldn't load Codex accounts.");
      expect(view.container.textContent).not.toContain("No accounts connected");
      failed = false;
      await act(async () => button(view.container, "Try again")!.click());
      await flush();
      expect(client.listCodexAccounts).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).not.toContain("Couldn't load Codex accounts.");
      expect(view.container.textContent).toContain("No accounts connected");
      // A workspace admin adds accounts for this workspace.
      expect(button(view.container, /Connect account/)).toBeDefined();
    } finally {
      await cleanup(view);
    }
  });

  test("hides SuperGrok when the deployment has it turned off", async () => {
    const { OpenGeniApiError } = await import("@opengeni/sdk/browser");
    client.listSuperGrokAccounts.mockImplementation(async () => {
      throw new OpenGeniApiError(
        404,
        JSON.stringify({ error: "SuperGrok subscriptions are not enabled" }),
      );
    });
    const view = await render();
    try {
      expect(view.container.textContent).not.toContain("SuperGrok");
      expect(view.container.textContent).not.toContain("not enabled");
    } finally {
      await cleanup(view);
    }
  });

  test("a SuperGrok read failure shows an error with Try again", async () => {
    client.listSuperGrokAccounts.mockImplementation(async () => {
      throw new Error("xAI unavailable");
    });
    const view = await render();
    try {
      expect(view.container.textContent).toContain("Couldn't load SuperGrok accounts.");
    } finally {
      await cleanup(view);
    }
  });
});

describe("Models list", () => {
  test("no summary line under the title: the Default model row says who pays, first", async () => {
    const view = await render();
    try {
      expect(view.container.querySelector('[data-testid="models-default-line"]')).toBeNull();
      expect(view.container.textContent).not.toContain("New chats here start with");
      const row = view.container.querySelector('[data-testid="default-model-row"]');
      expect(row?.textContent).toContain("paid by this workspace's Codex subscription");
      // Defaults come before Accounts.
      const headings = [...view.container.querySelectorAll("h2")].map((h) => h.textContent);
      expect(headings.indexOf("Defaults")).toBeLessThan(headings.indexOf("Accounts"));
    } finally {
      await cleanup(view);
    }
  });

  test("one flat Accounts list: no provider group headers, no unconnected providers", async () => {
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Defaults");
      expect(text).toContain(ACCOUNTS_SECTION);
      // Unconnected API-key providers are choices on Connect account, not rows.
      expect(text).not.toContain("OpenRouter");
      expect(text).not.toContain("Opper");
      expect(text).not.toContain("Vercel AI Gateway");
      expect(text).not.toContain("ChatGPT plan");
      expect(button(view.container, "More actions for Codex")).toBeUndefined();
      expect(button(view.container, "Edit")).toBeUndefined();
      // This workspace's account, then the organization's pool, muted.
      expect(view.container.querySelectorAll("[data-slot=list-row]")).toHaveLength(2);
      expect(text).toContain("Not in use");
      // Every account says who it is for. Without organization rights the
      // organization's "Available in" can't be read, so it says who shares it.
      expect(text).toContain("Design preview only");
      expect(text).toContain("Shared by Acme");
    } finally {
      await cleanup(view);
    }
  });

  test("Allowed models is a row that opens its page, with its value", async () => {
    const view = await render();
    try {
      const row = view.container.querySelector<HTMLButtonElement>(
        "[data-slot=setting-nav-row] button",
      )!;
      expect(row.textContent).toContain("Allowed models");
      expect(row.textContent).toContain("All models");
      await act(async () => row.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Allowed models");
      const everything = view.container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
      expect(everything.getAttribute("aria-checked")).toBe("true");
      // Nothing to save yet: no footer.
      expect(
        view.container.querySelector("footer")?.closest("[data-slot=form-frame]")?.className,
      ).toContain("[&>form>footer]:hidden");
      await act(async () => button(view.container, "Design preview")!.click());
      await flush();
      expect(view.container.textContent).toContain(ACCOUNTS_SECTION);
    } finally {
      await cleanup(view);
    }
  });

  test("the portability switch explains itself without On:/Off: copy", async () => {
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Keep Codex chats portable");
      expect(text).not.toMatch(/\bOn: |\bOff: /);
    } finally {
      await cleanup(view);
    }
  });

  test("Turn off Codex asks first", async () => {
    const view = await render();
    try {
      await act(async () => button(view.container, "Turn off Codex")!.click());
      expect(view.container.textContent).toContain("Turn off Codex in Design preview?");
      expect(client.requestJson).not.toHaveBeenCalled();
    } finally {
      await cleanup(view);
    }
  });

  test("Connect account shows SuperGrok disabled when this server has it off", async () => {
    const { OpenGeniApiError } = await import("@opengeni/sdk/browser");
    const off = async () => {
      throw new OpenGeniApiError(
        404,
        JSON.stringify({ error: "SuperGrok subscriptions are not enabled" }),
      );
    };
    client.listSuperGrokAccounts.mockImplementation(off);
    client.listOrganizationSuperGrokAccounts.mockImplementation(off);
    asOrganizationAdmin();
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect" }));
      await flush();
      const row = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find(
        (candidate) => candidate.textContent?.includes("SuperGrok"),
      )!;
      expect(row.textContent).toContain("Not enabled on this server");
      expect(row.querySelector("[data-row-action]")).toBeNull();
    } finally {
      await cleanup(view);
    }
  });

  test("Connect account lists providers as rows that open their own step", async () => {
    asOrganizationAdmin();
    const view = await render();
    try {
      await act(async () => button(view.container, /Connect account/)!.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect account");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Pay with your ChatGPT plan");
      expect(text).toContain("Pay per token through OpenRouter");
      expect(text).toContain("Pay per token through Opper");
      const codexRow = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")]
        .find((row) => row.textContent?.includes("Codex"))!
        .querySelector<HTMLElement>("[data-row-action]")!;
      await act(async () => codexRow.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect Codex");
    } finally {
      await cleanup(view);
    }
  });
});

test("Claude workspace reauthentication returns Back and Cancel to its account", async () => {
  context.clientConfig.claudeSubscriptionEnabled = true;
  client.listClaudeSubscriptionAccounts.mockImplementation(async () => ({
    accounts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        scope: "workspace",
        subject: "fixture-account",
        email: "claude@example.test",
        label: "Claude subscription",
        plan: "claude_max",
        status: "needs_relogin",
        active: true,
        allocatorEnabled: true,
        allocatorVersion: 1,
        version: 1,
        expiresAt: null,
        lastRefreshAt: null,
        lastError: "Sign in to Claude again.",
      },
    ],
    activeAccountId: "11111111-1111-4111-8111-111111111111",
    source: "workspace",
    settings: {
      rotationEnabled: true,
      rotationStrategy: "sharded",
      activeCredentialId: "11111111-1111-4111-8111-111111111111",
    },
  }));
  const view = await render();
  try {
    await act(async () => navigateTo({ account: "gateway:claude_subscription" }));
    await flush();
    for (const label of ["Claude subscription", "Cancel"]) {
      await act(async () => button(view.container, "Sign in again")!.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Reconnect Claude subscription");
      await act(async () => button(view.container, label)!.click());
      await flush();
      expect(lastNavigation?.search.account).toBe("claude:11111111-1111-4111-8111-111111111111");
      expect(view.container.querySelector("h1")?.textContent).toBe("Claude subscription");
    }
  } finally {
    await cleanup(view);
  }
});

describe("Codex pool controls", () => {
  test("says which pool new work uses, with no source control while automatic", async () => {
    const view = await render();
    try {
      expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(view.container.textContent).toContain(
        "New work uses this workspace's Codex account. The organization's accounts are set aside while it's connected.",
      );
      expect(button(view.container, "Use automatically")).toBeUndefined();
    } finally {
      await cleanup(view);
    }
  });

  test("an explicit source shows truthfully and goes back to automatic", async () => {
    accounts = { ...accounts, accounts: [], source: { ...source, mode: "workspace" } };
    const view = await render();
    try {
      expect(view.container.textContent).toContain(
        "New Codex work can't start. This workspace is set to use only its own accounts, and none are connected.",
      );
      await act(async () => button(view.container, "Use automatically")!.click());
      await flush();
      expect(client.requestJson).toHaveBeenCalledWith(
        "PATCH",
        "/v1/workspaces/workspace-a/codex/source",
        { mode: "automatic" },
      );
    } finally {
      await cleanup(view);
    }
  });

  test("an organization row can keep new work on the organization's accounts", async () => {
    accounts = {
      ...accounts,
      source: { ...source, effectiveSource: "organization", workspaceAvailable: false },
      accounts: [codexAccount({ source: "organization" })],
    };
    const view = await render();
    try {
      expect(view.container.textContent).toContain(
        "New work uses the organization's Codex account. Connect an account here to use your own instead.",
      );
      await act(async () =>
        button(view.container, "Always use the organization's accounts")!.click(),
      );
      await flush();
      expect(client.requestJson).toHaveBeenCalledWith(
        "PATCH",
        "/v1/workspaces/workspace-a/codex/source",
        { mode: "organization" },
      );
    } finally {
      await cleanup(view);
    }
  });

  test("no pool line when the organization shares nothing, and no action for members", async () => {
    accounts = { ...accounts, source: { ...source, organizationAvailable: false } };
    let view = await render();
    try {
      expect(view.container.textContent).not.toContain("New work uses");
      expect(view.container.textContent).not.toContain("Not in use");
    } finally {
      await cleanup(view);
    }
    accounts = { ...accounts, source: { ...source, mode: "workspace" } };
    view = await render(false);
    try {
      expect(view.container.textContent).toContain("New work uses this workspace's Codex account.");
      expect(button(view.container, "Use automatically")).toBeUndefined();
      expect(button(view.container, "Connect account")).toBeUndefined();
    } finally {
      await cleanup(view);
    }
  });

  test("Pick maps to rotationEnabled and only shows with two accounts", async () => {
    let view = await render();
    try {
      expect(view.container.textContent).not.toContain("Spread work");
    } finally {
      await cleanup(view);
    }
    accounts = {
      ...accounts,
      accounts: [
        codexAccount(),
        codexAccount({ id: "acct-2", label: "Backup plan", active: false }),
      ],
    };
    view = await render();
    try {
      expect(view.container.textContent).toContain("Primary");
      await act(async () => button(view.container, "Spread work")!.click());
      await flush();
      expect(client.setCodexRotationSettings).toHaveBeenCalledWith("workspace-a", {
        rotationEnabled: true,
      });
    } finally {
      await cleanup(view);
    }
  });
});

describe("Codex account page", () => {
  test("opens from the row, maps Use for new work to the allocator, and goes back", async () => {
    const view = await render();
    try {
      const row = view.container.querySelector<HTMLElement>("[data-row-action]")!;
      await act(async () => row.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Team plan");
      const toggle = view.container.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="Use Team plan for new work"]',
      )!;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle.click());
      await flush();
      expect(client.setCodexAccountAllocator).toHaveBeenCalledWith("workspace-a", "acct-1", {
        enabled: false,
        expectedVersion: 3,
      });
      await act(async () => button(view.container, "Design preview")!.click());
      await flush();
      expect(view.container.textContent).toContain(ACCOUNTS_SECTION);
    } finally {
      await cleanup(view);
    }
  });

  test("⋯ holds Rename, Copy account ID and Disconnect; no aside or Technical details", async () => {
    accounts = {
      ...accounts,
      accounts: [codexAccount({ chatgptAccountId: "chatgpt-123" })],
    };
    const view = await render();
    try {
      await act(async () =>
        view.container.querySelector<HTMLElement>("[data-row-action]")!.click(),
      );
      await flush();
      const items = [...view.container.querySelectorAll("[data-menu-item]")].map((item) =>
        item.textContent?.trim(),
      );
      expect(items).toEqual(["Rename", "Copy account ID", "Disconnect"]);
      const text = view.container.textContent ?? "";
      expect(text).toContain("ChatGPT Pro·team@example.com·Design preview only");
      expect(text).not.toContain("Technical details");
      expect(text).not.toContain("Belongs to");
      expect(text).not.toContain("Connected");
    } finally {
      await cleanup(view);
    }
  });

  test("Disconnect asks first, then disconnects and returns to the list", async () => {
    const view = await render();
    try {
      await act(async () =>
        view.container.querySelector<HTMLElement>("[data-row-action]")!.click(),
      );
      await flush();
      await act(async () => button(view.container, /Disconnect/)!.click());
      expect(client.disconnectCodexAccount).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Disconnect Team plan?");
      expect(view.container.textContent).toContain(
        "Team plan stops paying for new work in Design preview.",
      );
      await act(async () =>
        view.container.querySelector<HTMLButtonElement>("[data-confirm]")!.click(),
      );
      await flush();
      expect(client.disconnectCodexAccount).toHaveBeenCalledWith("workspace-a", "acct-1");
      expect(view.container.textContent).toContain(ACCOUNTS_SECTION);
    } finally {
      await cleanup(view);
    }
  });

  test("an organization account is read-only and never reads workspace access", async () => {
    accounts = {
      ...accounts,
      source: { ...source, effectiveSource: "organization", workspaceAvailable: false },
      accounts: [codexAccount({ source: "organization" })],
    };
    const view = await render();
    try {
      expect(view.container.textContent).toContain("Shared by Acme");
      await act(async () =>
        view.container.querySelector<HTMLElement>("[data-row-action]")!.click(),
      );
      await flush();
      const text = view.container.textContent ?? "";
      expect(text).toContain("Shared by Acme");
      expect(text).toContain("Managed by the owners and admins of Acme.");
      // No green "Connected", no "Organization" chip, no aside repeating the header.
      expect(text).not.toContain("Connected");
      expect(text).not.toContain("Belongs to");
      expect(text).not.toContain("Use for new work");
      expect(view.container.querySelector('button[role="switch"]')).toBeNull();
      expect(button(view.container, /Disconnect/)).toBeUndefined();
      expect(button(view.container, /Rename/)).toBeUndefined();
      expect(client.getModelConnectionAccess).not.toHaveBeenCalled();
    } finally {
      await cleanup(view);
    }
  });

  test("own accounts are set aside only when the server says some aren't in use", async () => {
    const SET_ASIDE = "This workspace's Codex accounts";
    // Its own account, also given to it by the organization, is in use here.
    const own = codexAccount({ id: "acct-own", label: "Team plan", source: "workspace" });
    const setAside = async (workspaceSetAside: boolean | undefined) => {
      accounts = {
        ...accounts,
        accounts: [own],
        source: {
          ...source,
          mode: "organization",
          effectiveSource: "organization",
          workspaceAvailable: true,
          ...(workspaceSetAside === undefined ? {} : { workspaceSetAside }),
        },
      };
      const view = await render();
      try {
        const rows = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].map(
          (row) => row.textContent ?? "",
        );
        expect(rows.filter((row) => row.includes("Team plan"))).toHaveLength(1);
        return rows.some((row) => row.includes(SET_ASIDE));
      } finally {
        await cleanup(view);
      }
    };
    expect(await setAside(false)).toBe(false);
    expect(await setAside(true)).toBe(true);
    // An older server without the field follows the pool, as before.
    expect(await setAside(undefined)).toBe(true);
  });

  test("the pool notice counts only the workspace's own accounts", async () => {
    accounts = {
      ...accounts,
      accounts: [
        codexAccount({ id: "acct-own", label: "Team plan", source: "workspace" }),
        codexAccount({ id: "acct-org", label: "Acme Pro", source: "organization" }),
      ],
      source: { ...source, mode: "automatic", effectiveSource: "workspace" },
    };
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("New work uses this workspace's Codex account.");
      expect(text).toContain("while it's connected");
    } finally {
      await cleanup(view);
    }
  });
});

describe("Connect Codex", () => {
  for (const mode of ["automatic", "organization"] as const) {
    test(`asks which subscriptions to use while the organization's are in use (${mode})`, async () => {
      accounts = {
        ...accounts,
        accounts: [],
        source: { ...source, mode, effectiveSource: "organization", workspaceAvailable: false },
      };
      // An account owned by this workspace is connected by an owner or admin, in context.
      asOrganizationAdmin();
      const view = await render();
      try {
        await act(async () => navigateTo({ view: "connect:codex" }));
        await flush();
        expect(view.container.textContent).toContain(
          "Use this account instead of the organization's subscriptions?",
        );
        const submit = button(view.container, "Sign in with ChatGPT")!;
        await act(async () => submit.click());
        await flush();
        expect(client.codexConnectStart).not.toHaveBeenCalled();
        expect(view.container.textContent).toContain(
          "Choose which subscriptions new work should use.",
        );
        const keep = [...view.container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
          (radio) => radio.textContent?.includes("Keep the organization's subscriptions"),
        )!;
        await act(async () => keep.click());
        await act(async () => button(view.container, "Sign in with ChatGPT")!.click());
        await flush();
        expect(client.codexConnectStart).toHaveBeenCalledWith("workspace-a");
        // Keeping the organization's pins an automatic source first; an explicit one stays.
        const patches = client.requestJson.mock.calls.filter(([method]) => method === "PATCH");
        expect(patches).toEqual(
          mode === "automatic"
            ? [["PATCH", "/v1/workspaces/workspace-a/codex/source", { mode: "organization" }]]
            : [],
        );
      } finally {
        await cleanup(view);
      }
    });
  }
});

describe("Opengeni credits", () => {
  const noAccounts = () => {
    accounts = { ...accounts, accounts: [], activeAccountId: null };
  };
  const creditsDeployment = (permissions: string[]) => {
    context.clientConfig = { billingMode: "stripe", models: [CREDITS_MODEL] };
    context.accessContext = { accountGrants: [{ accountId: "organization-a", permissions }] };
  };

  beforeEach(() => {
    lastNavigation = null;
    context.clientConfig = { billingMode: "disabled", models: [] };
    context.accessContext = null;
    client.getBilling.mockImplementation(async () => ({
      mode: "stripe",
      balance: { balanceMicros: 12_500_000, currency: "usd" },
    }));
  });

  test("leads the Accounts list and counts as a payer, opening Billing for billing admins", async () => {
    noAccounts();
    creditsDeployment(["billing:manage"]);
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
      "http://localhost/workspaces/workspace-a/settings?section=models",
    );
    const view = await render(true, "organization-a");
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("No accounts connected");
    const row = button(view.container, "Opengeni credits");
    expect(row).toBeDefined();
    expect(text).toContain("Pay as you go");
    expect(text).toContain("$12.50 left");
    expect(client.getBilling).toHaveBeenCalledWith({ accountId: "organization-a" });
    await act(async () => row!.click());
    expect(lastNavigation?.to).toBe("/workspaces/$workspaceId/organization");
    expect(lastNavigation?.search.section).toBe("billing");
    expect(lastNavigation?.search.fromLabel).toBe("Design preview · Models");
    expect(lastNavigation?.search.from).toBe("/workspaces/workspace-a/settings?section=models");
    await cleanup(view);
  });

  test("is a plain row without the balance for people who can't read billing", async () => {
    creditsDeployment([]);
    const view = await render(false, "organization-a");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Opengeni credits");
    expect(text).toContain("Pay as you go");
    expect(text).not.toContain("$12.50");
    expect(button(view.container, "Opengeni credits")).toBeUndefined();
    expect(client.getBilling).not.toHaveBeenCalled();
    await cleanup(view);
  });

  test("shows the balance to billing readers without opening Billing", async () => {
    creditsDeployment(["billing:read"]);
    const view = await render(false, "organization-a");
    expect(view.container.textContent).toContain("$12.50 left");
    expect(button(view.container, "Opengeni credits")).toBeUndefined();
    await cleanup(view);
  });

  test("is hidden on deployments without credits", async () => {
    noAccounts();
    context.clientConfig = { billingMode: "disabled", models: [CREDITS_MODEL] };
    context.accessContext = {
      accountGrants: [{ accountId: "organization-a", permissions: ["billing:manage"] }],
    };
    const view = await render(true, "organization-a");
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Opengeni credits");
    expect(client.getBilling).not.toHaveBeenCalled();
    await cleanup(view);
  });
});

const openPolicy = {
  allowedModels: null,
  allowedWorkspaces: null,
  allowPersonalWorkspaces: true,
  version: 2,
};

describe("One Models page for the organization and the workspace", () => {
  const orgAccounts = {
    accounts: [codexAccount({ id: "org-1", label: "Company plan", source: "organization" })],
    activeAccountId: "org-1",
    settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: "org-1" },
  };
  const routeOrganizationReads = () =>
    client.requestJson.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
        return orgAccounts;
      }
      if (method === "GET") throw new Error(`unexpected read ${path}`);
      return {};
    });

  test("owners and admins see the organization's accounts, set aside here, and open their page", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    client.getModelConnectionAccess.mockImplementation(async () => ({
      policy: openPolicy,
      workspaces: [],
      models: [],
      personalWorkspacesSupported: true,
    }));
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      // This workspace's account is in use; the organization's is named and set aside.
      expect(text).toContain("Company plan");
      expect(
        [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find((row) =>
          row.textContent?.includes("Company plan"),
        )?.textContent,
      ).toContain("Set aside");
      expect(text).not.toContain("Shared Codex accounts");
      const orgRow = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")]
        .find((row) => row.textContent?.includes("Company plan"))!
        .querySelector<HTMLElement>("[data-row-action]")!;
      await act(async () => orgRow.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Company plan");
      expect(view.container.textContent).toContain("Everyone in Acme");
    } finally {
      await cleanup(view);
    }
  });

  test("a shared SuperGrok account not in use here gives its reason right after its tag", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    const grok = (id: string, label: string, scope: "workspace" | "organization") => ({
      id,
      label,
      scope,
      subject: id,
      plan: "SuperGrok Heavy",
      status: "active" as const,
      active: false,
      allocatorEnabled: true,
      allocatorVersion: 1,
    });
    const settings = {
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: null,
    };
    client.listSuperGrokAccounts.mockImplementation(async () => ({
      accounts: [grok("grok-own", "Design grok", "workspace")],
      activeAccountId: null,
      settings,
    }));
    client.listOrganizationSuperGrokAccounts.mockImplementation(async () => ({
      accounts: [
        grok("grok-org", "Company grok", "organization"),
        grok("grok-far", "Research grok", "organization"),
      ],
      activeAccountId: null,
      settings,
    }));
    client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) => ({
      policy:
        (args[0] as { connectionId: string }).connectionId === "grok-far"
          ? { ...openPolicy, allowedWorkspaces: ["workspace-b"] }
          : openPolicy,
      workspaces: [
        { id: "workspace-a", name: "Design preview" },
        { id: "workspace-b", name: "Research" },
      ],
      models: [],
      personalWorkspacesSupported: true,
    }));
    const view = await render();
    try {
      await flush();
      const row = (name: string) =>
        [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find(
          (candidate) => candidate.textContent?.includes(name),
        )!.textContent ?? "";
      // The reason comes before the plan, so a phone doesn't cut it off.
      expect(row("Company grok")).toMatch(/Set aside[^]*SuperGrok Heavy/);
      expect(row("Research grok")).toMatch(/Not available here[^]*SuperGrok Heavy/);
    } finally {
      await cleanup(view);
    }
  });

  test("an administrator's own organization account: the notice counts the others, its tag waits for its reach, and an access save re-reads both lists", async () => {
    organizationAdmin = true;
    const ownAccount = codexAccount({ id: "own-1", label: "Team plan", source: "workspace" });
    client.requestJson.mockImplementation(async (method: string, path: string) =>
      method === "GET" && path === "/v1/organizations/organization-a/codex/accounts"
        ? {
            ...orgAccounts,
            accounts: [
              { ...orgAccounts.accounts[0], ownInWorkspaceIds: [] },
              { ...ownAccount, source: "organization", ownInWorkspaceIds: ["workspace-a"] },
            ],
          }
        : {},
    );
    accounts = {
      ...accounts,
      accounts: [ownAccount],
      source: { ...source, mode: "automatic", effectiveSource: "workspace" },
    };
    let resolveAccess: (value: unknown) => void = () => undefined;
    client.getModelConnectionAccess.mockImplementation(
      () => new Promise((resolve) => (resolveAccess = resolve)),
    );
    const view = await render();
    try {
      const text = () => view.container.textContent ?? "";
      // One organization account besides its own: "account is", "it's".
      expect(text()).toContain(
        "New work uses this workspace's Codex account. The organization's account is set aside while it's connected.",
      );
      const ownRow = () =>
        [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find((row) =>
          row.textContent?.includes("Team plan"),
        )!;
      // No "<workspace> only" tag while its reach loads: it may be shared wider.
      expect(ownRow().textContent).not.toContain("Design preview only");
      expect(ownRow().textContent).not.toContain("Everyone in Acme");
      await act(async () =>
        resolveAccess({
          policy: openPolicy,
          workspaces: [{ id: "workspace-a", name: "Design preview" }],
          models: [],
          personalWorkspacesSupported: true,
          localWorkspaceIds: ["workspace-a"],
        }),
      );
      await flush();
      expect(ownRow().textContent).toContain("Everyone in Acme");

      // An access save elsewhere re-reads this workspace's and the organization's lists.
      const workspaceReads = client.listCodexAccounts.mock.calls.length;
      const organizationReads = () =>
        client.requestJson.mock.calls.filter(
          ([method, path]) =>
            method === "GET" && path === "/v1/organizations/organization-a/codex/accounts",
        ).length;
      const before = organizationReads();
      await act(async () => {
        window.dispatchEvent(new Event("model-connections-changed"));
      });
      await flush();
      expect(client.listCodexAccounts.mock.calls.length).toBeGreaterThan(workspaceReads);
      expect(organizationReads()).toBeGreaterThan(before);
    } finally {
      await cleanup(view);
    }
  });

  test("an organization account's page lists its usage limit resets and redeems them in the browser", async () => {
    organizationAdmin = true;
    const resetAccount = codexAccount({
      id: "org-1",
      label: "Company plan",
      source: "organization",
      resetCreditAvailableCount: 2,
    });
    const credit = (id: string, title: string) => ({
      id,
      resetType: "codexRateLimits" as const,
      status: "available" as const,
      grantedAt: 1_700_000_000,
      expiresAt: null,
      title,
      description: null,
      actionable: true,
    });
    const overviewPath = "/v1/organizations/organization-a/codex/accounts/org-1/overview";
    const orgOverview = {
      ...overviewFor("org-1", 40).accounts["org-1"]!,
      resetCredits: {
        source: "provider",
        fetchedAt: new Date().toISOString(),
        stale: false,
        error: null,
        detailState: "detailed",
        detailsComplete: true,
        availableCount: 2,
        credits: [credit("credit-a", "Weekly reset"), credit("credit-b", "Bonus reset")],
      },
      canRedeem: true,
      canResumeRedemption: true,
      redemptionAccess: { ownership: "current_human", canClaimUnownedViaReconnect: false },
    };
    client.requestJson.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
        return { ...orgAccounts, accounts: [resetAccount] };
      }
      if (method === "GET" && path === overviewPath) return orgOverview;
      if (method === "GET") throw new Error(`unexpected read ${path}`);
      return {};
    });
    const sent: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({ url, init });
      return new Response(
        JSON.stringify({
          attemptId: JSON.parse(String(init.body)).attemptId,
          confirmationToken: "signed",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          resumable: false,
          recoveryStatus: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const view = await render();
    try {
      // The row says how many are waiting, though no workspace has to use it.
      const orgRow = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].find(
        (row) => row.textContent?.includes("Company plan"),
      )!;
      expect(orgRow.textContent).toContain("2 usage limit resets");
      await act(async () => orgRow.querySelector<HTMLElement>("[data-row-action]")!.click());
      await flush();
      await flush();
      const text = view.container.textContent ?? "";
      expect(text).toContain("Usage limit resets (2)");
      expect(text).toContain("Owners and admins of the organization can redeem them here.");
      expect(text).not.toContain("Connect for this workspace");
      expect(client.requestJson).toHaveBeenCalledWith("GET", overviewPath);
      await act(async () => button(view.container, "Redeem Weekly reset")!.click());
      await flush();
      // Prepared on the organization's route with the browser cookie only.
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toContain(
        "/v1/organizations/organization-a/codex/accounts/org-1/reset-credits/prepare",
      );
      expect(sent[0]!.init.credentials).toBe("include");
      expect(new Headers(sent[0]!.init.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ creditId: "credit-a" });
      expect(document.body.textContent).toContain("Redeem this usage limit reset?");
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup(view);
    }
  });

  test("Connect account connects for the organization, every workspace by default", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    const view = await render();
    try {
      await act(async () => button(view.container, /Connect account/)!.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect account");
      expect(view.container.textContent).toContain(
        "Connect it once for Acme, then choose which workspaces can use it.",
      );
      // No peer "this workspace only" choice on the picker any more.
      expect(view.container.textContent).not.toContain("Connect for Design preview only");
      const codexRow = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")]
        .find((row) => row.textContent?.includes("Codex"))!
        .querySelector<HTMLElement>("[data-row-action]")!;
      await act(async () => codexRow.click());
      await flush();
      const text = view.container.textContent ?? "";
      // The organization's Connect Codex, every workspace chosen.
      expect(text).toContain(
        "Sign in with the ChatGPT account whose plan pays for work across Acme.",
      );
      expect(text).toContain("Which workspaces can use it");
      expect(text).toContain("All workspaces in Acme");
      expect(text).toContain("including new ones and everyone's Personal workspace");
      expect(
        view.container.querySelector<HTMLElement>('[data-slot=choice-card][data-state="checked"]')
          ?.textContent,
      ).toContain("All workspaces in Acme");
      // Owning it by this workspace is not a choice here: it would read the
      // same as "Only selected workspaces" with this one ticked.
      expect(text).not.toContain("Advanced");
      expect(text).not.toContain("Connect for Design preview only");
    } finally {
      await cleanup(view);
    }
  });

  test("Only selected workspaces lists the organization's workspaces and Personal workspaces as one choice", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect-org:codex" }));
      await flush();
      const selected = [
        ...view.container.querySelectorAll<HTMLElement>("[data-slot=choice-card]"),
      ].find((card) => card.textContent?.includes("Only selected workspaces"))!;
      await act(async () => selected.click());
      await flush();
      const text = view.container.textContent ?? "";
      expect(text).toContain("Design preview (this workspace)");
      expect(text).toContain("Platform");
      expect(text).toContain("Personal workspaces");
      // The label says it; no description restating it.
      expect(text).not.toContain("It's all of them or none.");
      // Admins only ever see shared workspaces here, never someone's Personal one.
      expect(client.getOrganizationAdministrationOverview).toHaveBeenCalledWith("organization-a");
    } finally {
      await cleanup(view);
    }
  });

  test("an organization key can't be offered to Personal workspaces, and its choice is saved after connecting", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    client.getModelConnectionAccess.mockImplementation(async () => ({
      policy: openPolicy,
      workspaces: [],
      models: [],
      personalWorkspacesSupported: false,
    }));
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect-org:openrouter" }));
      await flush();
      expect(view.container.textContent).toContain(
        "Organization API keys can't be used in Personal workspaces.",
      );
      const selected = [
        ...view.container.querySelectorAll<HTMLElement>("[data-slot=choice-card]"),
      ].find((card) => card.textContent?.includes("Only selected workspaces"))!;
      await act(async () => selected.click());
      await flush();
      const personal = [
        ...view.container.querySelectorAll<HTMLElement>("[role=checkbox], input[type=checkbox]"),
      ].find((box) => box.closest("div")?.textContent?.includes("Personal workspaces"));
      expect(
        personal?.hasAttribute("disabled") || personal?.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="OpenRouter API key"], input[aria-label*="OpenRouter"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "sk-or-test",
        );
        const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
        const props = (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey ?? ""];
        props?.onChange?.({ target: input });
      });
      await act(async () => button(view.container, "Connect OpenRouter")!.click());
      await flush();
      await flush();
      expect(client.upsertOrganizationModelProviderConnection).toHaveBeenCalled();
      expect(client.updateModelConnectionAccess).toHaveBeenCalledWith(
        {
          scope: "organizations",
          scopeId: "organization-a",
          kind: "openrouter",
          connectionId: "current",
        },
        { ...openPolicy, allowedWorkspaces: ["workspace-a"], allowPersonalWorkspaces: false },
      );
    } finally {
      await cleanup(view);
    }
  });

  test("an organization Opper key connects through the generic provider rail with its workspace choice", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    client.getModelConnectionAccess.mockImplementation(async () => ({
      policy: openPolicy,
      workspaces: [],
      models: [],
      personalWorkspacesSupported: false,
    }));
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect-org:opper" }));
      await flush();
      expect(view.container.textContent).toContain(
        "Organization API keys can't be used in Personal workspaces.",
      );
      const selected = [
        ...view.container.querySelectorAll<HTMLElement>("[data-slot=choice-card]"),
      ].find((card) => card.textContent?.includes("Only selected workspaces"))!;
      await act(async () => selected.click());
      await flush();
      const personal = [
        ...view.container.querySelectorAll<HTMLElement>("[role=checkbox], input[type=checkbox]"),
      ].find((box) => box.closest("div")?.textContent?.includes("Personal workspaces"));
      expect(
        personal?.hasAttribute("disabled") || personal?.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Organization Opper API key"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "op-test",
        );
        const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
        const props = (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey ?? ""];
        props?.onChange?.({ target: input });
      });
      await act(async () => button(view.container, "Connect Opper")!.click());
      await flush();
      await flush();
      expect(client.upsertOrganizationModelProviderConnection).toHaveBeenCalledWith(
        "organization-a",
        "opper",
        expect.objectContaining({ apiKey: "op-test" }),
      );
      expect(client.updateModelConnectionAccess).toHaveBeenCalledWith(
        {
          scope: "organizations",
          scopeId: "organization-a",
          kind: "opper",
          connectionId: "current",
        },
        { ...openPolicy, allowedWorkspaces: ["workspace-a"], allowPersonalWorkspaces: false },
      );
    } finally {
      await cleanup(view);
    }
  });

  test("a member connects their own account in their Personal workspace", async () => {
    personalWorkspace = true;
    const view = await render();
    try {
      expect(button(view.container, /Connect account/)).toBeDefined();
      expect(view.container.textContent).not.toContain("can add accounts");
      await act(async () => navigateTo({ view: "connect" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect account");
      expect(view.container.textContent).toContain(
        "It pays for models in your Personal workspace, so only you use it.",
      );
      // A Personal workspace can't hold its own SuperGrok account.
      expect(view.container.textContent).not.toContain("SuperGrok");
      await act(async () => navigateTo({ view: "connect:codex" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect Codex");
      // Organization pages still refuse.
      await act(async () => navigateTo({ view: "connect-org:codex" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).not.toBe("Connect Codex");
    } finally {
      await cleanup(view);
    }
  });

  test("a shared workspace's member who isn't its admin connects for themselves only", async () => {
    workspaceSettingsAdmin = false;
    context.clientConfig.claudeSubscriptionEnabled = true;
    const view = await render();
    try {
      await act(async () => button(view.container, /Connect account/)!.click());
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect your own subscription");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Only work you start in Design preview uses it.");
      // No keys for the whole workspace, and Codex only in a Personal workspace.
      expect(text).not.toContain("OpenRouter");
      await act(async () => navigateTo({ view: "connect:claude_subscription" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect Claude subscription");
      expect(view.container.textContent).toContain(
        "Only work you start in Design preview uses it. Nobody else here can.",
      );
    } finally {
      await cleanup(view);
    }
  });

  test("someone who can't change connections still can't add accounts", async () => {
    const view = await render(false);
    try {
      expect(button(view.container, /Connect account/)).toBeUndefined();
      await act(async () => navigateTo({ view: "connect" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("You can't add accounts here");
    } finally {
      await cleanup(view);
    }
  });

  test("a workspace admin can still sign this workspace's account in again", async () => {
    accounts = {
      ...accounts,
      accounts: [codexAccount({ status: "needs_relogin" })],
    };
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect:codex" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect Codex");
    } finally {
      await cleanup(view);
    }
  });

  test("people who can't connect see the list read-only and who can add to it", async () => {
    const view = await render(false);
    try {
      const text = view.container.textContent ?? "";
      expect(button(view.container, "Connect account")).toBeUndefined();
      expect(text).toContain("Only admins of this workspace or Acme can add accounts.");
      expect(client.requestJson).not.toHaveBeenCalledWith(
        "GET",
        "/v1/organizations/organization-a/codex/accounts",
      );
      expect(client.listOrganizationSuperGrokAccounts).not.toHaveBeenCalled();
      expect(client.getOrganizationModelProviderConnection).not.toHaveBeenCalled();
    } finally {
      await cleanup(view);
    }
  });

  test("an organization URL opened by someone else says who can open it", async () => {
    const view = await render(true);
    try {
      await act(async () => navigateTo({ account: "org:codex:org-1" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe(
        "Only organization owners and admins can open this",
      );
    } finally {
      await cleanup(view);
    }
  });

  test("owners and admins never get a separate connect-for-this-workspace page", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    const view = await render();
    try {
      // An old link to the workspace-only picker opens Connect account.
      await act(async () => navigateTo({ view: "connect-workspace" }));
      await flush();
      expect(view.container.querySelector("h1")?.textContent).toBe("Connect account");
      expect(view.container.textContent).toContain(
        "Connect it once for Acme, then choose which workspaces can use it.",
      );
      // Reached in context (Codex Apps, resets), the workspace's own Connect
      // Codex says what the account will be.
      await act(async () => navigateTo({ view: "connect:codex" }));
      await flush();
      const text = view.container.textContent ?? "";
      expect(text).toContain("This account will belong to Design preview only.");
      expect(text).toContain("Codex Apps");
      expect(text).not.toContain("Which workspaces can use it");
    } finally {
      await cleanup(view);
    }
  });

  test("Codex Apps says it needs an account owned by this workspace, with the way to connect one", async () => {
    organizationAdmin = true;
    routeOrganizationReads();
    accounts = {
      ...accounts,
      accounts: [codexAccount({ id: "org-1", label: "Company plan", source: "organization" })],
      activeAccountId: "org-1",
      source: { ...source, effectiveSource: "organization", workspaceAvailable: false },
      apps: {
        available: true,
        credentialId: null,
        version: 1,
        designatedAt: null,
        canDisable: true,
      },
    };
    const view = await render();
    try {
      expect(view.container.textContent).toContain(
        "Codex Apps need a ChatGPT account owned by this workspace.",
      );
      await act(async () => button(view.container, "Connect for this workspace")!.click());
      await flush();
      expect(lastNavigation?.search).toMatchObject({ view: "connect:codex" });
    } finally {
      await cleanup(view);
    }
  });

  test("in a Personal workspace an organization key step points to a key for that workspace", async () => {
    organizationAdmin = true;
    personalWorkspace = true;
    routeOrganizationReads();
    const view = await render();
    try {
      await act(async () => navigateTo({ view: "connect-org:openrouter" }));
      await flush();
      expect(view.container.textContent).toContain("To use a key in your Personal workspace,");
      await act(async () =>
        button(view.container, "connect it for your Personal workspace")!.click(),
      );
      await flush();
      expect(lastNavigation?.search).toMatchObject({ view: "connect:openrouter" });
      expect(view.container.textContent).toContain(
        "This key will belong to your Personal workspace, so only you use it.",
      );
    } finally {
      await cleanup(view);
    }
  });

  test("Organization > Models lists the accounts and every workspace, each opening its page", async () => {
    organizationAdmin = true;
    organizationList = true;
    routeOrganizationReads();
    client.getModelConnectionAccess.mockImplementation(async () => ({
      policy: openPolicy,
      workspaces: [],
      models: [],
      personalWorkspacesSupported: true,
    }));
    organizationWorkspaces = [
      {
        id: "workspace-a",
        name: "Design preview",
        personal: false,
        canManage: true,
        savedDefaultModel: null,
      },
      {
        id: "workspace-b",
        name: "Finance ops",
        personal: false,
        canManage: false,
        savedDefaultModel: null,
      },
      {
        id: "workspace-me",
        name: "Personal workspace",
        personal: true,
        canManage: true,
        savedDefaultModel: null,
      },
    ];
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      // The organization's account, tagged by where it's available, and each
      // workspace's own account, tagged with its workspace.
      expect(text).toContain("Company plan");
      expect(text).toContain("Everyone in Acme");
      expect(text).toContain("Team plan");
      expect(text).toContain("Design preview only");
      expect(button(view.container, /Connect account/)).toBeDefined();
      // Every workspace, with its rules; one this person can't change says who can.
      expect(text).toContain("Workspaces");
      expect(text).toContain("Finance ops");
      expect(text).toContain("Only its workspace admins can change its models.");
      expect(text).toContain("Your Personal workspace");
      const workspaceRow = [
        ...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]"),
      ].find((row) => row.querySelector("[data-row-action]")?.textContent === "Design preview")!;
      await act(async () => workspaceRow.querySelector<HTMLElement>("[data-row-action]")!.click());
      expect(lastNavigation?.to).toBe("/workspaces/$workspaceId/organization");
      expect(lastNavigation?.search).toEqual({ section: "models", workspace: "workspace-a" });
    } finally {
      await cleanup(view);
    }
  });

  // Design 5.4: an account a shared workspace connected is also an organization account.
  describe("a workspace's own account is an organization account", () => {
    const workspaceOwn = {
      ...codexAccount({ id: "acct-1", label: "Team plan", source: "organization" }),
      ownInWorkspaceIds: ["workspace-a"],
    };
    const rowsNamed = (container: HTMLElement, name: string) =>
      [...container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].filter(
        (row) => row.querySelector("[data-row-action]")?.textContent?.includes(name) ?? false,
      );
    const routeBoth = () =>
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return { ...orgAccounts, accounts: [...orgAccounts.accounts, workspaceOwn] };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
    const managedAccess = (id: string) => ({
      policy:
        id === "acct-1"
          ? { ...openPolicy, allowedWorkspaces: [], allowPersonalWorkspaces: false }
          : openPolicy,
      workspaces: [{ id: "workspace-a", name: "Design preview" }],
      models: [],
      personalWorkspacesSupported: true,
      localWorkspaceIds: id === "acct-1" ? ["workspace-a"] : [],
      managedByWorkspaceId: id === "acct-1" ? "workspace-a" : null,
    });

    test("the organization's list shows it once, tagged with its workspace, without a Primary row", async () => {
      organizationAdmin = true;
      organizationList = true;
      routeBoth();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      organizationWorkspaces = [
        {
          id: "workspace-a",
          name: "Design preview",
          personal: false,
          canManage: true,
          savedDefaultModel: null,
        },
      ];
      const view = await render();
      try {
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).toContain(
          "Design preview only",
        );
        // Its page is the organization's; the organization primary isn't offered for it.
        await act(async () =>
          rowsNamed(view.container, "Team plan")[0]!
            .querySelector<HTMLElement>("[data-row-action]")!
            .click(),
        );
        await flush();
        expect(view.container.querySelector("h1")?.textContent).toBe("Team plan");
        expect(view.container.textContent).toContain("Available in");
        expect(view.container.textContent).not.toContain("Primary account");
      } finally {
        await cleanup(view);
      }
    });

    test("its workspace's page lists it once, as the workspace's own", async () => {
      organizationAdmin = true;
      routeBoth();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      const view = await render();
      try {
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Company plan")).toHaveLength(1);
        expect(view.container.textContent).not.toMatch(/Team plan[^]*Set aside/);
      } finally {
        await cleanup(view);
      }
    });

    test("while its workspace uses the organization's accounts, it isn't listed as one of them", async () => {
      organizationAdmin = true;
      accounts = {
        ...accounts,
        accounts: [codexAccount({ id: "org-1", label: "Company plan", source: "organization" })],
        activeAccountId: "org-1",
        source: {
          ...source,
          mode: "organization",
          effectiveSource: "organization",
          workspaceAvailable: true,
        },
      };
      routeBoth();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      const view = await render();
      try {
        await flush();
        // Its own accounts are in their "set aside" row, this one included.
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(0);
        expect(rowsNamed(view.container, "Company plan")).toHaveLength(1);
        expect(view.container.textContent).toContain("Set aside");
      } finally {
        await cleanup(view);
      }
    });

    test("shared with everyone while its workspace uses the organization's accounts: one row, in use, with its real reach", async () => {
      organizationAdmin = true;
      accounts = {
        ...accounts,
        accounts: [
          codexAccount({ id: "org-1", label: "Company plan", source: "organization" }),
          codexAccount({ id: "acct-1", label: "Team plan", source: "workspace" }),
        ],
        activeAccountId: "org-1",
        source: {
          ...source,
          mode: "organization",
          effectiveSource: "organization",
          workspaceAvailable: true,
          // Its only own account is in use through the organization's pool.
          workspaceSetAside: false,
        },
      };
      routeBoth();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) => {
        const access = managedAccess((args[0] as { connectionId: string }).connectionId);
        return { ...access, policy: openPolicy };
      });
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).toContain("Everyone in");
        // It is in use through the organization's pool: nothing of its own is set aside.
        expect(view.container.textContent).not.toContain("This workspace's Codex accounts");
      } finally {
        await cleanup(view);
      }
    });

    test("limited to chosen people, its workspace no longer lists it as its own, so it shows as the organization's", async () => {
      organizationAdmin = true;
      accounts = {
        ...accounts,
        accounts: [codexAccount({ id: "org-1", label: "Company plan", source: "organization" })],
        activeAccountId: "org-1",
      };
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [...orgAccounts.accounts, { ...workspaceOwn, ownInWorkspaceIds: [] }],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) => {
        const access = managedAccess((args[0] as { connectionId: string }).connectionId);
        return (args[0] as { connectionId: string }).connectionId === "acct-1"
          ? {
              ...access,
              policy: { ...access.policy, allowedPeople: ["person-a"] },
              managedByWorkspaceId: null,
            }
          : access;
      });
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        const row = rowsNamed(view.container, "Team plan")[0]!;
        expect(row.textContent).toContain("Selected people");
        // Chosen people's sessions here use it unless the workspace uses only its own.
        expect(row.textContent).not.toContain("Set aside");
        expect(row.textContent).not.toContain("Not in use");
        expect(row.querySelector('[aria-label^="More actions"]')).toBeNull();
      } finally {
        await cleanup(view);
      }
      // Set to use only its own accounts: nobody's sessions here use it.
      accounts = {
        ...accounts,
        accounts: [codexAccount({ id: "acct-2", label: "Other plan", source: "workspace" })],
        activeAccountId: "acct-2",
        source: { ...source, mode: "workspace", effectiveSource: "workspace" },
      };
      const workspaceOnly = await render();
      try {
        await flush();
        const row = rowsNamed(workspaceOnly.container, "Team plan")[0]!;
        expect(row.textContent).toContain("Set aside");
        expect(row.textContent).toContain("Not in use");
        expect(row.querySelector('[aria-label^="More actions"]')).not.toBeNull();
      } finally {
        await cleanup(workspaceOnly);
      }
    });

    test("an account no workspace manages keeps the organization Primary row", async () => {
      organizationAdmin = true;
      organizationList = true;
      routeBoth();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      organizationWorkspaces = [
        {
          id: "workspace-a",
          name: "Design preview",
          personal: false,
          canManage: true,
          savedDefaultModel: null,
        },
      ];
      const view = await render();
      try {
        await act(async () =>
          rowsNamed(view.container, "Company plan")[0]!
            .querySelector<HTMLElement>("[data-row-action]")!
            .click(),
        );
        await flush();
        expect(view.container.querySelector("h1")?.textContent).toBe("Company plan");
        expect(view.container.textContent).toContain("Primary account");
      } finally {
        await cleanup(view);
      }
    });

    const failOrganizationRead = () =>
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          throw new Error("organization list unavailable");
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });

    test("while the organization's list can't be read, its workspace page tags it with no reach", async () => {
      organizationAdmin = true;
      failOrganizationRead();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      const view = await render();
      try {
        await flush();
        expect(view.container.textContent).toContain(
          "Couldn't load the organization's Codex accounts.",
        );
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        // It may be shared wider: "<workspace> only" may not be true.
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).not.toContain(
          "Design preview only",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("while the organization's list can't be read, the organization's list tags it with no reach", async () => {
      organizationAdmin = true;
      organizationList = true;
      failOrganizationRead();
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      organizationWorkspaces = [
        {
          id: "workspace-a",
          name: "Design preview",
          personal: false,
          canManage: true,
          savedDefaultModel: null,
        },
      ];
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).not.toContain(
          "Design preview only",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("while the organization's list loads, the organization's list tags it with no reach", async () => {
      organizationAdmin = true;
      organizationList = true;
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return new Promise(() => undefined);
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      organizationWorkspaces = [
        {
          id: "workspace-a",
          name: "Design preview",
          personal: false,
          canManage: true,
          savedDefaultModel: null,
        },
      ];
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).not.toContain(
          "Design preview only",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("a Personal workspace's own account keeps its tag on the organization's list while that list can't be read", async () => {
      organizationAdmin = true;
      organizationList = true;
      failOrganizationRead();
      organizationWorkspaces = [
        {
          id: "workspace-a",
          name: "Personal",
          personal: true,
          canManage: true,
          savedDefaultModel: null,
        },
      ];
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).toContain(
          "Personal workspace only",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("a Personal workspace's own account keeps its tag on its page while the organization's list can't be read", async () => {
      organizationAdmin = true;
      personalWorkspace = true;
      failOrganizationRead();
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Team plan")).toHaveLength(1);
        expect(rowsNamed(view.container, "Team plan")[0]!.textContent).toContain(
          "Personal workspace only",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("another workspace's own account isn't available here and sets nothing aside", async () => {
      organizationAdmin = true;
      const research = {
        ...codexAccount({ id: "acct-r", label: "Research plan", source: "organization" }),
        ownInWorkspaceIds: ["workspace-b"],
      };
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [{ ...orgAccounts.accounts[0], ownInWorkspaceIds: [] }, research],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        (args[0] as { connectionId: string }).connectionId === "acct-r"
          ? {
              ...managedAccess("acct-r"),
              policy: { ...openPolicy, allowedWorkspaces: [], allowPersonalWorkspaces: false },
              localWorkspaceIds: ["workspace-b"],
              managedByWorkspaceId: "workspace-b",
            }
          : managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      const view = await render();
      try {
        await flush();
        const row = rowsNamed(view.container, "Research plan")[0]!;
        expect(row.textContent).toContain("Not available here");
        // The reason comes before the plan, so a phone doesn't cut it off.
        expect(row.textContent).toMatch(/Not available here[^]*ChatGPT/);
        expect(row.textContent).not.toContain("Set aside");
        expect(row.querySelector('[aria-label^="More actions"]')).toBeNull();
        // The organization's account that does reach here is still set aside, with its way back.
        const company = rowsNamed(view.container, "Company plan")[0]!;
        expect(company.textContent).toContain("Set aside");
        expect(company.querySelector('[aria-label^="More actions"]')).not.toBeNull();
        // The notice counts only the organization's account known to reach here.
        expect(view.container.textContent).toContain(
          "The organization's account is set aside while it's connected.",
        );
      } finally {
        await cleanup(view);
      }
    });

    test("an account limited to no one isn't available here and keeps its Not in use cell", async () => {
      organizationAdmin = true;
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [{ ...orgAccounts.accounts[0], ownInWorkspaceIds: [] }],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async () => ({
        ...managedAccess("org-1"),
        policy: { ...openPolicy, allowedPeople: [] },
      }));
      const view = await render();
      try {
        await flush();
        const row = rowsNamed(view.container, "Company plan")[0]!;
        expect(row.textContent).toContain("No one");
        expect(row.textContent).toContain("Not available here");
        expect(row.textContent).toContain("Not in use");
        expect(row.querySelector('[aria-label^="More actions"]')).toBeNull();
      } finally {
        await cleanup(view);
      }
    });

    test("no set-aside reason while an organization account's reach loads", async () => {
      organizationAdmin = true;
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [{ ...orgAccounts.accounts[0], ownInWorkspaceIds: [] }],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      let resolveAccess: (value: unknown) => void = () => undefined;
      client.getModelConnectionAccess.mockImplementation(
        () => new Promise((resolve) => (resolveAccess = resolve)),
      );
      const view = await render();
      try {
        await flush();
        expect(rowsNamed(view.container, "Company plan")[0]!.textContent).not.toContain(
          "Set aside",
        );
        await act(async () => resolveAccess(managedAccess("org-1")));
        await flush();
        expect(rowsNamed(view.container, "Company plan")[0]!.textContent).toContain("Set aside");
      } finally {
        await cleanup(view);
      }
    });

    test("set to its own accounts with none connected, the organization's are set aside without claiming it has its own", async () => {
      organizationAdmin = true;
      accounts = {
        ...accounts,
        accounts: [],
        activeAccountId: null,
        source: {
          ...source,
          mode: "workspace",
          effectiveSource: "workspace",
          workspaceAvailable: false,
        },
      };
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [{ ...orgAccounts.accounts[0], ownInWorkspaceIds: [] }],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async () => managedAccess("org-1"));
      const view = await render();
      try {
        await flush();
        expect(view.container.textContent).toContain("none are connected");
        const row = rowsNamed(view.container, "Company plan")[0]!;
        expect(row.textContent).toContain("Set aside");
        expect(row.textContent).not.toContain("while this workspace has its own");
      } finally {
        await cleanup(view);
      }
    });

    test("the pool notice counts what the server reports, and an older server's count includes another workspace's account this workspace lists", async () => {
      organizationAdmin = true;
      const research = {
        ...codexAccount({ id: "acct-r", label: "Research plan", source: "organization" }),
        ownInWorkspaceIds: ["workspace-b"],
      };
      client.requestJson.mockImplementation(async (method: string, path: string) => {
        if (method === "GET" && path === "/v1/organizations/organization-a/codex/accounts") {
          return {
            ...orgAccounts,
            accounts: [{ ...orgAccounts.accounts[0], ownInWorkspaceIds: [] }, research],
          };
        }
        if (method === "GET") throw new Error(`unexpected read ${path}`);
        return {};
      });
      client.getModelConnectionAccess.mockImplementation(async (...args: unknown[]) =>
        managedAccess((args[0] as { connectionId: string }).connectionId),
      );
      // Older server, automatic source: Research's account is in this workspace's pool.
      accounts = {
        ...accounts,
        accounts: [...accounts.accounts, { ...research, ownInWorkspaceIds: undefined }],
      };
      const older = await render();
      try {
        await flush();
        expect(older.container.textContent).toContain(
          "The organization's accounts are set aside while it's connected.",
        );
      } finally {
        await cleanup(older);
      }
      // The server's count wins: here it says one.
      accounts = { ...accounts, source: { ...source, organizationCount: 1 } };
      const current = await render();
      try {
        await flush();
        expect(current.container.textContent).toContain(
          "The organization's account is set aside while it's connected.",
        );
      } finally {
        await cleanup(current);
      }
    });
  });

  test("a workspace admin sees their workspaces and what they use, read-only", async () => {
    organizationList = true;
    context.clientConfig.claudeSubscriptionEnabled = true;
    client.listClaudeSubscriptionAccounts.mockImplementation(async () => ({
      accounts: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          scope: "organization",
          subject: "fixture-account",
          email: "team@example.test",
          label: "Claude subscription",
          plan: "claude_max",
          status: "active",
          active: true,
          allocatorEnabled: true,
          allocatorVersion: 1,
          version: 1,
          expiresAt: null,
          lastRefreshAt: null,
          lastError: null,
          usage: {
            connected: true,
            credentialVersion: 1,
            windows: [
              {
                id: "seven_day",
                usedPercent: 30,
                resetsAt: "2099-10-03T22:00:00Z",
                status: "allowed",
                observedAt: "2026-09-30T14:00:00Z",
              },
            ],
            observedAt: "2026-09-30T14:00:00Z",
            source: "response_headers",
            refreshStatus: "not_checked",
            refreshCheckedAt: null,
          },
        },
      ],
      activeAccountId: "22222222-2222-4222-8222-222222222222",
      source: "organization",
      settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: null },
    }));
    organizationWorkspaces = [
      {
        id: "workspace-a",
        name: "Design preview",
        personal: false,
        canManage: true,
        savedDefaultModel: null,
      },
    ];
    const view = await render();
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Team plan");
      // The organization's Claude account shows its usage, like its Codex one.
      const claudeRow = [
        ...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]"),
      ].find((row) => row.textContent?.includes("team@example.test"))!;
      expect(claudeRow.textContent).toContain("70%");
      expect(text).toContain(
        "To connect your own account, open one of your workspaces. Only organization owners and admins add accounts for everyone.",
      );
      expect(button(view.container, /Connect account/)).toBeUndefined();
      // The organization's own accounts are never read for them.
      expect(client.requestJson).not.toHaveBeenCalledWith(
        "GET",
        "/v1/organizations/organization-a/codex/accounts",
      );
    } finally {
      await cleanup(view);
    }
  });

  test("a workspace admin sees their own account once after the organization shares it", async () => {
    organizationList = true;
    // Design connected it; the organization also gave it to Research.
    client.listCodexAccounts.mockImplementation(async (workspaceId: string) => ({
      ...accounts,
      accounts: [
        codexAccount({
          id: "acct-1",
          label: "Team plan",
          source: workspaceId === "workspace-a" ? "workspace" : "organization",
        }),
      ],
      source: {
        ...source,
        workspaceId,
        effectiveSource: workspaceId === "workspace-a" ? "workspace" : "organization",
      },
    }));
    organizationWorkspaces = [
      {
        id: "workspace-a",
        name: "Design preview",
        personal: false,
        canManage: true,
        savedDefaultModel: null,
      },
      {
        id: "workspace-b",
        name: "Research",
        personal: false,
        canManage: true,
        savedDefaultModel: null,
      },
    ];
    const view = await render();
    try {
      const rows = [...view.container.querySelectorAll<HTMLElement>("[data-slot=list-row]")].filter(
        (row) => row.textContent?.includes("Team plan"),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("Used in Design preview, Research");
    } finally {
      await cleanup(view);
    }
  });

  test("sharing a workspace's own account with the organization makes up no organization accounts on its page", async () => {
    const own = codexAccount({ id: "acct-1", label: "Team plan", source: "workspace" });
    // Its own account now also has an organization copy here, so the server
    // reports the organization pool as available, with no other account.
    accounts = {
      ...accounts,
      accounts: [own],
      source: { ...source, organizationAvailable: true, organizationCount: 0 },
    };
    const automatic = await render();
    try {
      const text = automatic.container.textContent ?? "";
      expect(text).not.toContain("Shared Codex accounts");
      expect(text).not.toContain("The organization's");
    } finally {
      await cleanup(automatic);
    }
    accounts = {
      ...accounts,
      source: {
        ...source,
        mode: "workspace",
        organizationAvailable: true,
        organizationCount: 0,
      },
    };
    const workspaceOnly = await render();
    try {
      const text = workspaceOnly.container.textContent ?? "";
      expect(text).toContain(
        "New work uses only this workspace's Codex account, never the organization's.",
      );
      expect(text).not.toContain("Shared Codex accounts");
    } finally {
      await cleanup(workspaceOnly);
    }
    // An older server doesn't report the count: the pool's availability decides.
    accounts = { ...accounts, source: { ...source, organizationAvailable: true } };
    const older = await render();
    try {
      expect(older.container.textContent).toContain("Shared Codex accounts");
    } finally {
      await cleanup(older);
    }
  });

  test("a workspace's model page goes back to the organization's list", async () => {
    const view = await render();
    try {
      expect(view.container.querySelector("h1")?.textContent).toBe("Design preview");
      await act(async () => button(view.container, "Models")!.click());
      expect(lastNavigation?.search).toEqual({ section: "models" });
    } finally {
      await cleanup(view);
    }
  });
});
