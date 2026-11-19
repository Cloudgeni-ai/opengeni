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
let workspaceGrants: unknown[] = [];
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
    workspaceGrants,
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
const { consoleDestinationFullOnly, consoleNavSections } = await import("./shell");
const { ConsoleAgentsRoute } = await import("./agents");
const { ConsoleAgentRoute } = await import("./agent-detail");
const { PublishDialog } = await import("./agent-versions");
const { AgentSessions } = await import("./agent-sessions");
const { ConsoleToolServersRoute, parseHeaderLines, toolServerChanges } =
  await import("./tool-servers");
const { ManagedInConsoleAgents } = await import("@/components/agents/managed-in-console-agents");
const { orgAgentsApi, computeMenuOptions, computeOptionFor, runsOnForChoice, runsOnMenuOptions } =
  await import("@/lib/organization-agents");
const { RunsOnField } = await import("./agent-editor");
const { appendEvents, loadTestChat } = await import("./agent-test-chat");

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

const buildBox = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sandboxId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Build box",
  worksInManagedWorkspaces: true,
};
const designMac = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sandboxId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Design Mac",
  worksInManagedWorkspaces: false,
};
const compute = {
  machines: [buildBox, designMac],
  environments: [
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "Python 3.13",
      worksInManagedWorkspaces: true,
    },
  ],
};

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

const requestJson = mock(
  async (method: string, path: string, _body?: unknown, query?: Record<string, string>) => {
    const base = `/v1/organizations/${organizationId}`;
    if (!path.startsWith("/v1/workspaces/") && !flagOn) {
      throw Object.assign(new Error("Agent not found."), { status: 404 });
    }
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
    if (method === "GET" && path === `${base}/agents/compute`) return compute;
    if (method === "GET" && path === `${base}/agents/tool-servers`)
      return { toolServers: [toolServer] };
    if (method === "GET" && path === `${base}/agents/tool-servers/billing/tools`) {
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
    // Test chats: only through the agent's test-chats routes, never the app's session routes.
    if (method === "GET" && path === `${base}/agents/${agentId}/test-chats/${chatId}`) {
      return {
        workspaceId,
        sessionId: chatId,
        agentId,
        version: 3,
        status: "running",
        paused: false,
      };
    }
    if (method === "GET" && path === `${base}/agents/${agentId}/test-chats/${chatId}/events`) {
      // One event at sequence 1: nothing new after it.
      const after = Number(query?.after ?? 0);
      return after >= 1
        ? { events: [], hasMore: false, nextAfter: after }
        : {
            events: [
              {
                id: "13131313-1313-4131-8131-131313131313",
                sessionId: chatId,
                sequence: 1,
                type: "user.message",
                payload: { text: "Refund invoice 1042" },
                createdAt: at,
              },
            ],
            hasMore: false,
            nextAfter: 1,
          };
    }
    if (method === "POST" && path === `${base}/agents/${agentId}/test-chats/${chatId}/messages`) {
      return { id: "14141414-1414-4141-8141-141414141414" };
    }
    if (
      method === "POST" &&
      path === `${base}/agents/${agentId}/test-chats/${chatId}/approvals/call_refund`
    ) {
      return { id: "15151515-1515-4151-8151-151515151515" };
    }
    if (method === "POST" && path === `${base}/agents/${agentId}/test-chats/${chatId}/control`) {
      return { paused: (_body as { action?: string }).action === "pause" };
    }
    if (method === "GET" && path === `/v1/workspaces/${workspaceId}/organization-agents`) {
      // The server lists only published agents, and none while the flag is off.
      return {
        agents: flagOn
          ? [
              {
                id: agentId,
                key: "support-desk",
                name: "Support desk",
                description: "Answers billing questions",
                managedBy: "console",
                publishedVersion: 2,
              },
            ]
          : [],
      };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  },
);

const client = {
  requestJson,
  listConsoleWorkspaces: mock(async () => ({
    range: "30d",
    since: at,
    until: at,
    workspaces: [{ id: workspaceId, name: "Analysts", kind: "team" }],
  })),
  getWorkspaceModelCatalog: mock(async () => ({ models: [] })),
  createSession: mock(async (_workspaceId: string, _request: unknown) => ({ id: chatId })),
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

let consoleAccess: "viewer" | "editor" | "full" = "full";

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
            // A fresh client object per render: the flag read is shared per client.
            client: { ...client } as never,
            organizationId,
            organizationLabel: "Kontali",
            search: { org: organizationId },
            appWorkspaceId: workspaceId,
            access: consoleAccess,
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
  consoleAccess = "full";
  document.body.innerHTML = "";
  navigate.mockClear();
  requestJson.mockClear();
  role = "owner";
  flagOn = true;
  workspaceGrants = [];
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

  test("Viewers and Editors see Overview, Sessions, Agents, Tool servers and Workspaces only", () => {
    for (const access of ["viewer", "editor"] as const) {
      const labels = consoleNavSections(true, access).flatMap((section) =>
        section.items.map((item) => item.label),
      );
      expect(labels).toEqual(["Overview", "Sessions", "Agents", "Tool servers", "Workspaces"]);
    }
    const full = consoleNavSections(true, "full").flatMap((section) =>
      section.items.map((item) => item.label),
    );
    expect(full).toEqual(
      expect.arrayContaining([
        "API keys",
        "Members",
        "Settings",
        "Workspaces",
        "Usage and billing",
      ]),
    );
  });

  test("knows the pages for owners and admins only", () => {
    expect(consoleDestinationFullOnly("/console/members")).toBe(true);
    expect(consoleDestinationFullOnly("/console/api-keys")).toBe(true);
    expect(consoleDestinationFullOnly("/console/settings")).toBe(true);
    expect(consoleDestinationFullOnly("/console/workspaces")).toBe(false);
    expect(consoleDestinationFullOnly("/console/usage")).toBe(true);
    expect(consoleDestinationFullOnly("/console/agents")).toBe(false);
    expect(consoleDestinationFullOnly("/console/tool-servers")).toBe(false);
    expect(consoleDestinationFullOnly("/console/sessions")).toBe(false);
  });
});

describe("Console roles", () => {
  test("a Viewer reads agents without New agent, Save draft, Publish or Test", async () => {
    consoleAccess = "viewer";
    await render(createElement(ConsoleAgentsRoute));
    expect(text()).toContain("Support desk");
    expect(text()).not.toContain("New agent");
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    await render(createElement(ConsoleAgentRoute));
    const page = text();
    expect(page).toContain("Be brief. (v3)");
    expect(page).not.toContain("Publish v3");
    expect(page).not.toContain("Save draft");
    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).not.toContain(
      "Test",
    );
    const fields = [...document.querySelectorAll("textarea, input:not([role=switch])")];
    expect(fields.length).toBeGreaterThan(0);
    expect(
      fields.filter(
        (element) =>
          !(element as HTMLInputElement).readOnly && !(element as HTMLInputElement).disabled,
      ),
    ).toEqual([]);
  });

  test("an Editor edits, tests and publishes a Console agent", async () => {
    consoleAccess = "editor";
    await render(createElement(ConsoleAgentRoute));
    const page = text();
    expect(page).toContain("Publish v3");
    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toContain("Test");
    const textarea = [...document.querySelectorAll("textarea")];
    expect(textarea.length).toBeGreaterThan(0);
    expect(textarea.some((element) => element.readOnly || element.disabled)).toBe(false);
  });

  test("an Editor sees tool servers without Add tool server", async () => {
    consoleAccess = "editor";
    await render(createElement(ConsoleToolServersRoute));
    expect(text()).toContain("Billing");
    expect(text()).not.toContain("Add tool server");
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

  test("without the flag, says agents are coming and lists nothing", async () => {
    flagOn = false;
    await render(createElement(ConsoleAgentsRoute));
    expect(text()).toContain("Organization agents are coming");
    expect(text()).not.toContain("New agent");
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

describe("Runs on", () => {
  test("an agent on an organization machine names it and warns that chats share it", async () => {
    agentRecord = agent({
      draft: version(3, {
        config: {
          ...version(3).config,
          runsOn: { kind: "machine", machine: buildBox.id },
        },
      }),
    });
    await render(createElement(ConsoleAgentRoute));
    const page = text();
    expect(page).toContain("Runs on");
    expect(page).toContain("Organization machine");
    expect(page).toContain("Build box");
    expect(page).toContain(
      "Every end customer's chats share this machine. Use it only when that is intended.",
    );
  });

  test("omitted is the workspace default, and the suggestion follows the built-in tools", async () => {
    await render(
      createElement(RunsOnField, {
        runsOn: undefined,
        suggested: "none",
        compute: { data: compute as never, error: null },
        disabled: false,
        onChange: () => undefined,
      }),
    );
    expect(text()).toContain("Workspace default");
    expect(text()).not.toContain("Machine");
    const menu = runsOnMenuOptions("none");
    expect(menu.map((option) => option.label)).toEqual([
      "Workspace default",
      "No computer",
      "Cloud sandbox",
      "Organization machine",
    ]);
    expect(
      menu.filter((option) => option.meta === "Suggested").map((option) => option.value),
    ).toEqual(["none"]);
    expect(runsOnMenuOptions("sandbox").find((option) => option.meta)?.value).toBe("sandbox");
  });

  test("offers only machines that work in product-managed workspaces", async () => {
    await render(
      createElement(RunsOnField, {
        runsOn: { kind: "machine" },
        suggested: "sandbox",
        compute: { data: compute as never, error: null },
        disabled: false,
        onChange: () => undefined,
      }),
    );
    expect(text()).toContain("Choose a machine");
    expect(text()).toContain("Every end customer's chats share this machine.");
    expect(computeMenuOptions(compute.machines, undefined)).toEqual([
      { value: buildBox.id, label: "Build box" },
      {
        value: designMac.id,
        label: "Design Mac",
        disabled: true,
        disabledReason: "Not available in product-managed workspaces. Change where it can be used.",
      },
    ]);
    // A name from code that matches nothing here still shows, and says so.
    expect(computeMenuOptions(compute.machines, "Gone box").at(-1)).toEqual({
      value: "Gone box",
      label: "Gone box",
      disabled: true,
      disabledReason: "Not found in this organization.",
    });
    expect(computeMenuOptions(compute.machines, "build box")).toHaveLength(2);
  });

  test("a cloud sandbox can use a Sandbox Environment named in code", async () => {
    await render(
      createElement(RunsOnField, {
        runsOn: { kind: "sandbox", environment: "python 3.13" },
        suggested: "sandbox",
        compute: { data: compute as never, error: null },
        disabled: true,
        onChange: () => undefined,
      }),
    );
    expect(text()).toContain("Cloud sandbox");
    expect(text()).toContain("Python 3.13");
    expect(text()).not.toContain("share this machine");
  });

  test("references match by id, sandbox id or one name", () => {
    expect(computeOptionFor(compute.machines, buildBox.sandboxId)).toEqual(buildBox);
    expect(computeOptionFor(compute.machines, " build BOX ")).toEqual(buildBox);
    expect(computeOptionFor(compute.machines, "Nope")).toBeNull();
    expect(computeOptionFor([buildBox, { ...designMac, name: "Build box" }], "Build box")).toBe(
      null,
    );
    expect(runsOnForChoice("default")).toBeUndefined();
    expect(runsOnForChoice("none")).toEqual({ kind: "none" });
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

describe("Test chat", () => {
  test("reads and continues your own test chat through its test-chats routes", async () => {
    const api = orgAgentsApi(client as never, organizationId);
    requestJson.mockClear();
    const loaded = await loadTestChat(api, agentId, { workspaceId, sessionId: chatId });
    expect([loaded.status, loaded.paused, loaded.nextAfter]).toEqual(["running", false, 1]);
    expect(loaded.events.map((event) => event.type)).toEqual(["user.message"]);
    await api.sendTestChatMessage(agentId, chatId, { message: "And invoice 1043?" });
    await api.decideTestChatApproval(agentId, chatId, "call_refund", { decision: "approve" });
    expect(
      await api.controlTestChat(agentId, chatId, { action: "pause", clientEventId: "stop-1" }),
    ).toEqual({ paused: true });
    const paths = requestJson.mock.calls.map(([method, path]) => `${method} ${path}`);
    const testChat = `/v1/organizations/${organizationId}/agents/${agentId}/test-chats/${chatId}`;
    expect(paths.sort()).toEqual(
      [
        `GET ${testChat}`,
        `GET ${testChat}/events`,
        `POST ${testChat}/messages`,
        `POST ${testChat}/approvals/call_refund`,
        `POST ${testChat}/control`,
      ].sort(),
    );
    // Nobody is a member of the test workspace: no app session route is used.
    expect(paths.some((path) => path.includes("/v1/workspaces/"))).toBe(false);
  });

  test("polls only what is new and appends it", async () => {
    const api = orgAgentsApi(client as never, organizationId);
    const first = await loadTestChat(api, agentId, { workspaceId, sessionId: chatId });
    requestJson.mockClear();
    const next = await loadTestChat(
      api,
      agentId,
      { workspaceId, sessionId: chatId },
      { after: first.nextAfter },
    );
    const events = requestJson.mock.calls.find(([, path]) => path.endsWith("/events"));
    expect(events?.[3]).toEqual({ after: "1", limit: "500" });
    expect([next.events, next.nextAfter, next.hasMore]).toEqual([[], 1, false]);
    // Each event once, in order.
    const [event] = first.events;
    const more = { ...event!, id: "16161616-1616-4161-8161-161616161616", sequence: 2 };
    expect(appendEvents(first.events, [event!, more]).map((item) => item.sequence)).toEqual([1, 2]);
    expect(appendEvents(first.events, [])).toBe(first.events);
  });
});

describe("Managed in Console (app)", () => {
  test("lists the workspace's published organization agents, read-only", async () => {
    await render(createElement(ManagedInConsoleAgents, { workspaceId }));
    const page = text();
    expect(page).toContain("Managed in Console");
    expect(page).toContain("Support desk");
    expect(page).toContain("Open Console");
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  test("Chat starts a chat with the agent, by key, in this workspace", async () => {
    workspaceGrants = [
      { workspaceId, subjectId: "user:mira", role: "member", permissions: ["sessions:create"] },
    ];
    client.createSession.mockClear();
    await render(createElement(ManagedInConsoleAgents, { workspaceId }));
    const chat = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Chat",
    );
    expect(chat).toBeDefined();
    await act(async () => chat!.click());
    await settle();
    expect(client.createSession).toHaveBeenCalledTimes(1);
    const [calledWorkspace, request] = client.createSession.mock.calls[0]!;
    expect(calledWorkspace).toBe(workspaceId);
    expect((request as { agent: unknown }).agent).toBe("support-desk");
    expect(navigate).toHaveBeenCalledWith({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId: chatId },
    });
  });

  test("shows nothing without the flag", async () => {
    flagOn = false;
    await render(createElement(ManagedInConsoleAgents, { workspaceId }));
    expect(text()).toBe("");
  });
});
