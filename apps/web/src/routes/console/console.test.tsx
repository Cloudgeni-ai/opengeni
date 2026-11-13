import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const organizationId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";

const navigate = mock(async (_options: unknown) => undefined);
const RouterPackage = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...RouterPackage,
  useNavigate: () => navigate,
  useSearch: () => ({}),
  useParams: () => ({ workspaceId, sessionId: "44444444-4444-4444-8444-444444444444" }),
  Link: ({ children }: { children?: ReactNode }) => createElement("a", { href: "#" }, children),
}));

// Console runs inside the app's own context: the signed-in owner of the organization.
const appContext = {
  accessKeyVersion: 1,
  accessContext: {
    subjectId: "user:mira",
    subjectLabel: "Mira Holt",
    accountGrants: [
      {
        accountId: organizationId,
        subjectId: "user:mira",
        role: "owner",
        permissions: ["billing:read", "billing:manage", "api_keys:manage", "account:admin"],
      },
    ],
    workspaceGrants: [],
  },
  clientConfig: {
    auth: { mode: "managedSession" },
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
  },
  workspaces: [{ id: workspaceId, accountId: organizationId, name: "Analysts" }],
  authSession: { user: { name: "Mira Holt", email: "mira@kontali.test" } },
  revalidatePrincipalAccess: mock(async () => undefined),
  handleManagedSignOut: mock(async () => undefined),
};
const AppContextModule = await import("@opengeni/react/app/app-context");
mock.module("@opengeni/react/app/app-context", () => ({
  ...AppContextModule,
  useAppContext: () => ({ ...appContext, client }),
}));

const { ConsoleContext } = await import("./console-shared");
const { ConsoleSessionsRoute } = await import("./sessions");
const { ConsoleSettingsRoute } = await import("./settings");
const { ConsoleNewApiKeyRoute } = await import("./api-keys");
const { ConsoleApiKeysRoute } = await import("./api-keys");
const { ConsoleMembersRoute } = await import("./organization-pages");

function session(index: number, reviewLevel: "full" | "metadata") {
  return {
    id: `5555555${index}-5555-4555-8555-555555555555`,
    workspaceId,
    workspaceName: "Northwind",
    title: reviewLevel === "full" ? `Refund question ${index}` : null,
    firstMessage: reviewLevel === "full" ? "I was charged twice" : null,
    visibility: "private",
    endUser: { subjectId: "external_user:abc", externalId: `user-${index}`, source: "kontali" },
    status: "idle",
    feedback: { positive: 1, negative: 0 },
    turns: 3,
    costMicros: 90_000,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:05:00.000Z",
  };
}

let reviewLevel: "full" | "metadata" = "full";
const client = {
  listConsoleSessions: mock(async () => ({
    reviewLevel,
    sessions: [session(1, reviewLevel), session(2, reviewLevel)],
    nextCursor: null,
  })),
  listConsoleWorkspaces: mock(async () => ({
    range: "30d",
    since: "2026-10-13T00:00:00.000Z",
    until: "2026-11-12T00:00:00.000Z",
    workspaces: [{ id: workspaceId, name: "Analysts", kind: "team" }],
  })),
  listOrganizationApiKeys: mock(async () => [
    apiKey("key-org", "Production server", "og_live_live", "2026-11-12T09:00:00.000Z"),
  ]),
  listApiKeys: mock(async () => [
    apiKey("key-ws", "Production server", "og_live_old1", "2026-03-01T09:00:00.000Z", workspaceId),
  ]),
  getConsoleApiKeyUsage: mock(async () => ({ apiKeys: [] })),
  listOrganizationAdministrationMembers: mock(async () => ({
    members: [
      member("m1", "user:mira", "Mira Holt", "owner"),
      member("m2", "external_user:kontali:anna", "anna", "member"),
      member("m3", "external_user:kontali:lars", "lars", "member"),
    ],
  })),
  getOrganizationAdministrationOverview: mock(async () => ({
    organization: {
      id: organizationId,
      name: "Tech",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    roles: [],
    workspaces: [],
  })),
  listOrganizationInvitationsForOrganization: mock(async () => ({
    invitations: [],
    nextCursor: null,
  })),
  listOrganizationMemberNames: mock(async () => ({ available: false, members: [] })),
  getConsoleSettings: mock(async () => ({
    organizationId,
    reviewLevel: "full",
    updatedAt: null,
    updatedBySubjectId: null,
  })),
  updateConsoleSettings: mock(async (_org: string, request: { reviewLevel: string }) => ({
    organizationId,
    reviewLevel: request.reviewLevel,
    updatedAt: "2026-11-12T11:00:00.000Z",
    updatedBySubjectId: "user:owner",
  })),
  listConsoleAuditLog: mock(async () => ({ events: [], nextCursor: null })),
  createOrganizationApiKey: mock(async () => ({
    apiKey: { id: "key", name: "Production server", prefix: "og_live_ab12" },
    token: "og_live_ab12_secret_token_value",
  })),
};

function apiKey(
  id: string,
  name: string,
  prefix: string,
  lastUsedAt: string,
  keyWorkspaceId: string | null = null,
) {
  return {
    id,
    accountId: organizationId,
    workspaceId: keyWorkspaceId,
    name,
    description: null,
    prefix,
    permissions: [],
    ...(keyWorkspaceId ? {} : { access: "full", workspaceScope: { kind: "all" } }),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function member(id: string, subjectId: string, name: string, role: string) {
  return {
    id,
    organizationId,
    subjectId,
    name,
    email: null,
    role,
    status: "active",
    authorizationRevision: 1,
    sharedWorkspaceAccess: [],
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        ConsoleContext.Provider,
        {
          value: {
            client: client as never,
            organizationId,
            organizationLabel: "Kontali",
            search: { org: organizationId },
            appWorkspaceId: workspaceId,
          },
        },
        node,
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  navigate.mockClear();
  for (const fn of Object.values(client)) fn.mockClear();
});

describe("Console sessions", () => {
  test("lists sessions with their end user, and searches full transcripts", async () => {
    reviewLevel = "full";
    await render(createElement(ConsoleSessionsRoute));
    expect(container.textContent).toContain("Refund question 1");
    expect(container.textContent).toContain("Refund question 2");
    expect(container.textContent).toContain("user-1");
    expect(container.textContent).toContain("$0.09");
    expect(container.querySelector('input[aria-label="Search sessions"]')).not.toBeNull();
  });

  test("hides search when only metadata is shown", async () => {
    reviewLevel = "metadata";
    await render(createElement(ConsoleSessionsRoute));
    expect(container.textContent).toContain("Content hidden");
    expect(container.textContent).toContain("user-2");
    expect(container.querySelector('input[aria-label="Search sessions"]')).toBeNull();
  });
});

describe("Console members", () => {
  test("leaves the product's end users out of members", async () => {
    await render(createElement(ConsoleMembersRoute));
    expect(container.textContent).toContain("Mira Holt");
    expect(container.textContent).not.toContain("anna");
    expect(container.textContent).not.toContain("lars");
    // Invite people is right here, not in the app.
    expect(container.textContent).toContain("Invite people");
  });
});

describe("Console settings", () => {
  test("changes the review level", async () => {
    await render(createElement(ConsoleSettingsRoute));
    const metadata = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (element) => element.textContent?.includes("Metadata only"),
    );
    expect(metadata).toBeDefined();
    await act(async () => {
      metadata!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.updateConsoleSettings).toHaveBeenCalledTimes(1);
    expect(client.updateConsoleSettings.mock.calls[0]).toEqual([
      organizationId,
      { reviewLevel: "metadata" },
    ]);
    expect(metadata!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Console API keys", () => {
  test("tells an organization key from a workspace key with the same name", async () => {
    await render(createElement(ConsoleApiKeysRoute));
    const rows = [...container.querySelectorAll('[role="row"]')].filter((row) =>
      row.textContent?.includes("Production server"),
    );
    expect(rows).toHaveLength(2);
    // The key in daily use comes first.
    expect(rows[0]!.textContent).toContain("og_live_live");
    expect(rows[0]!.textContent).toContain("Organization");
    expect(rows[0]!.textContent).toContain("All workspaces");
    expect(rows[1]!.textContent).toContain("Workspace");
    expect(rows[1]!.textContent).toContain("Analysts");
  });

  test("creates a key and shows its token once", async () => {
    await render(createElement(ConsoleNewApiKeyRoute));
    expect(container.textContent).not.toContain("og_live_ab12_secret_token_value");
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.requestSubmit();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.createOrganizationApiKey).toHaveBeenCalledTimes(1);
    expect(client.createOrganizationApiKey.mock.calls[0]).toEqual([
      organizationId,
      { name: "Production server", access: "full" },
    ] as never);
    const html = container.innerHTML;
    expect(html.split("og_live_ab12_secret_token_value").length - 1).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("You won't be able to see it again");
  });
});
