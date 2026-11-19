import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const organizationId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "66666666-6666-4666-8666-666666666666";
const chatId = "77777777-7777-4777-8777-777777777777";

let params: Record<string, string> = { agentId };
const navigate = mock(async (_options: unknown) => undefined);
const RouterPackage = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...RouterPackage,
  useNavigate: () => navigate,
  useSearch: () => ({}),
  useParams: () => params,
  useRouterState: () => "/console/agents",
  Link: ({ children }: { children?: ReactNode }) => createElement("a", { href: "#" }, children),
}));

let role = "owner";
let flagOn = true;
const appContext = () => ({
  accessKeyVersion: 1,
  accessContext: {
    subjectId: "user:mira",
    subjectLabel: "Mira Holt",
    accountGrants: [
      {
        accountId: organizationId,
        subjectId: "user:mira",
        role,
        permissions: ["account:admin", "agents:read", "agents:manage"],
      },
    ],
    workspaceGrants: [],
  },
  clientConfig: {
    auth: { mode: "managedSession" },
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    orgAgentsAccountIds: flagOn ? [organizationId] : [],
  },
  workspaces: [{ id: workspaceId, accountId: organizationId, name: "Analysts" }],
  authSession: { user: { name: "Mira Holt", email: "mira@kontali.test" } },
  revalidatePrincipalAccess: mock(async () => undefined),
  handleManagedSignOut: mock(async () => undefined),
});
// The Radix dialog is a portal; this inline stand-in keeps its contract.
const ConfirmDialogModule = await import("@opengeni/react/ui/confirm-dialog");
mock.module("@opengeni/react/ui/confirm-dialog", () => ({
  ...ConfirmDialogModule,
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    children,
  }: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    children?: ReactNode;
  }) =>
    open
      ? createElement(
          "div",
          { role: "dialog" },
          createElement("h2", null, title),
          createElement("p", null, description),
          children,
          createElement("button", { type: "button" }, confirmLabel),
        )
      : null,
}));
const AppContextModule = await import("@opengeni/react/app/app-context");
mock.module("@opengeni/react/app/app-context", () => ({
  ...AppContextModule,
  useAppContext: () => ({ ...appContext(), client }),
}));

const { ConsoleContext } = await import("./console-shared");
const { consoleNavSections } = await import("./shell");
const { ConsoleAgentsRoute } = await import("./agents");
const { ConsoleAgentRoute } = await import("./agent-detail");
const { PublishDialog } = await import("./agent-versions");
const { AgentSessions } = await import("./agent-sessions");
const { ConsoleToolServersRoute, parseHeaderLines, toolServerChanges } = await import(
  "./tool-servers"
);
const { ManagedInConsoleAgents } = await import("@/components/agents/managed-in-console-agents");
const { orgAgentsApi } = await import("@/lib/organization-agents");

const at = "2026-11-18T10:00:00.000Z";

function version(number: number, overrides: Record<string, unknown> = {}) {
  return {
    version: number,
    name: "Support desk",
    description: "Answers billing questions",
    instructions: `Be brief. (v${number})`,
    config: {
      model: "azure-sol/gpt-6.1-sol",
      toolServers: [
        {
          server: "billing",
          tools: { mode: "selected", enabled: ["lookup_invoice", "refund"] },
          approval: { ask: ["refund"] },
          eager: [],
          newTools: "off",
        },
      ],
      workers: { shareInstructions: false },
    },
    toolCatalog: { billing: [{ name: "lookup_invoice" }, { name: "refund" }] },
    source: "console",
    configHash: `sha256:${String(number).repeat(64)}`,
    createdBySubjectId: "user:mira",
    createdAt: at,
    publishedAt: number === 2 ? at : null,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: agentId,
    key: "support-desk",
    name: "Support desk",
    description: "Answers billing questions",
    managedBy: "console",
    publishedVersion: 2,
    latestVersion: 3,
    rowVersion: 5,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

let agentRecord: Record<string, unknown> = {};
function agent(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(overrides),
    published: version(2, overrides.managedBy === "code" ? { source: "deploy" } : {}),
    draft: version(3),
    workspaceIds: [],
    ...overrides,
  };
}

const toolServer = {
  id: "88888888-8888-4888-8888-888888888888",
  key: "billing",
  name: "Billing",
  url: "https://billing.example.com/mcp",
  authMode: "per_user",
  hasSharedKey: false,
  sharedHeaderNames: [],
  oauthRefresh: null,
  rowVersion: 1,
  createdAt: at,
  updatedAt: at,
};

const requestJson = mock(async (method: string, path: string, _body?: unknown) => {
  const base = `/v1/organizations/${organizationId}`;
  if (method === "GET" && path === `${base}/agents`) {
    return {
      agents: [
        summary(),
        summary({
          id: "99999999-9999-4999-8999-999999999999",
          key: "triage",
          name: "Triage",
          managedBy: "code",
          publishedVersion: 4,
          latestVersion: 4,
        }),
      ],
    };
  }
  if (method === "GET" && path === `${base}/agents/${agentId}`) return { agent: agentRecord };
  if (method === "GET" && path === `${base}/tool-servers`) return { toolServers: [toolServer] };
  if (method === "GET" && path === `${base}/tool-servers/billing/tools`) {
    return {
      tools: [{ name: "lookup_invoice" }, { name: "refund" }, { name: "void_invoice" }],
      error: null,
    };
  }
  if (method === "GET" && path === `${base}/agents/${agentId}/movable-chats`) return { count: 7 };
  if (method === "GET" && path === `${base}/agents/${agentId}/sessions`) {
    return {
      sessions: [
        {
          id: chatId,
          workspaceId,
          title: "Refund for invoice 1042",
          status: "idle",
          agentVersion: 2,
          overrides: {
            model: { agent: "azure-sol/gpt-6.1-sol", chat: "anthropic/claude-opus-5.5" },
            instructions: { agent: "Be brief.", chat: "Be brief.\n\nAnswer in Norwegian." },
          },
          createdAt: at,
          updatedAt: at,
        },
        {
          id: "12121212-1212-4121-8121-121212121212",
          workspaceId,
          title: "Where is my order",
          status: "idle",
          agentVersion: 2,
          overrides: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
      nextCursor: null,
    };
  }
  if (method === "GET" && path === `/v1/workspaces/${workspaceId}/organization-agents`) {
    return {
      agents: [
        summary(),
        summary({ id: "13131313-1313-4131-8131-131313131313", name: "Unpublished", publishedVersion: null }),
      ],
    };
  }
  throw new Error(`Unexpected ${method} ${path}`);
});

const client = {
  requestJson,
  listConsoleWorkspaces: mock(async () => ({
    range: "30d",
    since: at,
    until: at,
    workspaces: [{ id: workspaceId, name: "Analysts", kind: "team" }],
  })),
  getWorkspaceModelCatalog: mock(async () => ({ models: [] })),
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

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
  await settle();
}

function text() {
  return document.body.textContent ?? "";
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
  requestJson.mockClear();
  role = "owner";
  flagOn = true;
  params = { agentId };
  agentRecord = agent();
});

describe("Console nav", () => {
  test("shows Agents and Tool servers only with the organization flag", () => {
    const labels = (on: boolean) =>
      consoleNavSections(on).flatMap((section) => section.items.map((item) => item.label));
    expect(labels(true)).toContain("Agents");
    expect(labels(true)).toContain("Tool servers");
    expect(labels(false)).not.toContain("Agents");
    expect(labels(false)).not.toContain("Tool servers");
    expect(labels(false)).toContain("Sessions");
  });
});

describe("Console agents list", () => {
  test("lists agents with who manages them, the published version and a waiting draft", async () => {
    await render(createElement(ConsoleAgentsRoute));
    const page = text();
    expect(page).toContain("Support desk");
    expect(page).toContain("support-desk");
    expect(page).toContain("Managed by code");
    expect(page).toContain("Draft v3");
    expect(page).toContain("New agent");
  });

  test("without the flag, makes no calls", async () => {
    flagOn = false;
    await render(createElement(ConsoleAgentsRoute));
    expect(requestJson).not.toHaveBeenCalled();
  });
});

describe("Console agent editor", () => {
  test("lists the server's live tools with on, ask first and new tools", async () => {
    await render(createElement(ConsoleAgentRoute));
    const page = text();
    expect(page).toContain("Be brief. (v3)");
    expect(page).toContain("lookup_invoice");
    expect(page).toContain("void_invoice");
    expect(page).toContain("Ask first");
    expect(page).toContain("On, ask first");
    expect(page).toContain("Share instructions with workers");
    expect(page).toContain("Publish v3");
    const textarea = [...document.querySelectorAll("textarea")];
    expect(textarea.some((element) => element.readOnly || element.disabled)).toBe(false);
  });

  test("a code-managed agent opens read-only; owners can move it to Console", async () => {
    agentRecord = agent({ managedBy: "code", publishedVersion: 3 });
    await render(createElement(ConsoleAgentRoute));
    expect(text()).toContain("Managed by code");
    expect(text()).toContain("Manage in Console");
    expect(text()).not.toContain("Save draft");
    expect(text()).not.toContain("Publish v3");
    const fields = [...document.querySelectorAll("textarea, input:not([role=switch])")];
    expect(fields.length).toBeGreaterThan(0);
    const editable = fields.filter(
      (element) =>
        !(element as HTMLInputElement).readOnly && !(element as HTMLInputElement).disabled,
    );
    expect(editable).toEqual([]);
  });

  test("members who don't own the organization don't get the switch", async () => {
    role = "admin";
    agentRecord = agent({ managedBy: "code", publishedVersion: 3 });
    await render(createElement(ConsoleAgentRoute));
    expect(text()).toContain("Managed by code");
    expect(text()).not.toContain("Manage in Console");
  });
});

describe("Publish", () => {
  test("defaults to new chats only and shows how many running chats would move", async () => {
    const api = orgAgentsApi(client as never, organizationId);
    await render(
      createElement(PublishDialog, {
        agent: agent() as never,
        api,
        version: 3,
        onOpenChange: () => {},
        onPublished: () => {},
      }),
    );
    const page = text();
    expect(page).toContain("New chats only");
    expect(page).toContain("Also move running chats");
    expect(page).toContain("7 running chats move to v3");
    expect(page).toContain("Moving breaks the prompt cache and can raise cost slightly.");
    const checked = document.querySelector(
      "[role=radio][aria-checked=true], [role=radio][data-state=checked], input[type=radio]:checked",
    );
    expect(checked).not.toBeNull();
    const card = checked?.closest("label") ?? checked;
    expect(card?.textContent ?? checked?.parentElement?.textContent ?? "").toContain(
      "New chats only",
    );
  });
});

describe("Agent sessions", () => {
  test("marks chats that changed the agent and shows each change", async () => {
    const api = orgAgentsApi(client as never, organizationId);
    const props = { agent: agent() as never, api, onSelect: () => {} };
    await render(createElement(AgentSessions, { ...props, selected: undefined }));
    expect(text()).toContain("Refund for invoice 1042");
    expect(text().match(/Changed by this chat/gu)?.length).toBe(1);
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    await render(createElement(AgentSessions, { ...props, selected: chatId }));
    const page = text();
    expect(page).toContain("Model");
    expect(page).toContain("anthropic/claude-opus-5.5");
    expect(page).toContain("Answer in Norwegian.");
    expect(page).toContain("Open session");
  });
});

describe("Tool servers", () => {
  test("lists servers with their login", async () => {
    await render(createElement(ConsoleToolServersRoute));
    expect(text()).toContain("Billing");
    expect(text()).toContain("https://billing.example.com/mcp");
    expect(text()).toContain("Each user's login");
  });

  test("reads shared key headers as Name: value lines", () => {
    expect(parseHeaderLines("Authorization: Bearer a:b\n\nX-Team: 7")).toEqual({
      Authorization: "Bearer a:b",
      "X-Team": "7",
    });
    expect("error" in parseHeaderLines("nope")).toBe(true);
  });

  test("checks the form: https URLs, and a shared key needs its header once", () => {
    const form = {
      name: "Billing",
      key: "billing",
      url: "https://billing.example.com/mcp",
      authMode: "per_user" as const,
      headers: "",
      tokenUrl: "",
      clientId: "",
      clientSecret: "",
    };
    expect(toolServerChanges(form, toolServer as never)).toEqual({
      errors: {},
      sharedHeaders: undefined,
      oauth: null,
    });
    expect(toolServerChanges({ ...form, url: "http://x" }, null).errors.url).toBeDefined();
    const shared = { ...form, authMode: "shared_key" as const };
    expect(toolServerChanges(shared, null).errors.headers).toBeDefined();
    expect(
      toolServerChanges(shared, { ...toolServer, hasSharedKey: true } as never).errors,
    ).toEqual({});
    expect(
      toolServerChanges({ ...shared, headers: "Authorization: Bearer k" }, null).sharedHeaders,
    ).toEqual({ Authorization: "Bearer k" });
  });
});

describe("Managed in Console (app)", () => {
  test("lists the workspace's published organization agents, read-only", async () => {
    await render(createElement(ManagedInConsoleAgents, { workspaceId }));
    const page = text();
    expect(page).toContain("Managed in Console");
    expect(page).toContain("Support desk");
    expect(page).not.toContain("Unpublished");
    expect(page).toContain("Open Console");
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  test("shows nothing without the flag", async () => {
    flagOn = false;
    await render(createElement(ManagedInConsoleAgents, { workspaceId }));
    expect(text()).toBe("");
    expect(requestJson).not.toHaveBeenCalled();
  });
});
