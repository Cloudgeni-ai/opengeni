import "@/app-host";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { SetupConnectionState, SetupReadiness } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Enable against a mocked client: what it shows with nothing, some and
   everything connected, for someone who can't connect, and Turn on through
   to the first message and the suggested first job.
   -------------------------------------------------------------------------- */

const template = {
  key: "dependency-updater",
  name: "Dependency updater",
  description: "Opens one upgrade pull request a week.",
  suggestedTriggers: [{ name: "Every Monday morning", oneClick: true }],
  setup: {
    connections: [],
    repository: "required",
    worksWellWith: "pr-reviewer",
    wontDoWithoutAsking: [
      {
        text: "Merge a pull request",
        permission: "block",
        connector: "github.com",
        tools: ["merge_pull_request"],
      },
    ],
    firstMessage: "Say hello.",
    firstJob: "Open this week's upgrade pull request now.",
  },
};
const partner = { key: "pr-reviewer", name: "PR reviewer", suggestedTriggers: [] };

function connection(overrides: Partial<SetupConnectionState>): SetupConnectionState {
  return {
    provider: "github.com",
    name: "GitHub",
    mcpUrl: null,
    required: true,
    why: "Reads the repository.",
    connected: false,
    canConnect: true,
    catalogItemId: "github",
    ...overrides,
  };
}

function readinessOf(connections: SetupConnectionState[]): SetupReadiness {
  const required = connections.filter((entry) => entry.required);
  const missing = required.filter((entry) => !entry.connected);
  return {
    ready: missing.length === 0,
    reason: missing[0]
      ? missing[0].canConnect
        ? `Connect ${missing[0].name} to turn this on.`
        : `Ask an admin to connect ${missing[0].name}.`
      : null,
    connections,
    missing: missing.map((entry) => ({
      kind: "connection" as const,
      provider: entry.provider,
      name: entry.name,
      reason: "",
    })),
    requiredConnected: required.length - missing.length,
    requiredTotal: required.length,
  };
}

let readiness: SetupReadiness = readinessOf([]);
let agents: unknown[] = [];
let tasks: unknown[] = [];
const agent = {
  id: "agent-1",
  name: "Dependency updater",
  visibility: "workspace",
  viewer: { canEdit: true },
};
const client = {
  listAgentTemplates: mock(async () => [template, partner]),
  getAgentTemplateReadiness: mock(async () => readiness),
  listAgents: mock(async () => agents),
  getAgent: mock(async () => agent),
  listScheduledTasks: mock(async () => tasks),
  resumeScheduledTask: mock(async () => ({})),
  createAgentFromTemplate: mock(async () => agent),
  createSession: mock(async () => ({ id: "session-1" })),
  getGitHubApp: mock(async () => ({ status: "unbound", configured: true, linkUrl: null })),
};
const context: Record<string, unknown> = {
  client,
  workspaces: [{ id: "workspace-a", kind: "shared" }],
  githubStatus: { status: "bound" },
  accessContext: {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions: ["sessions:create"] }],
  },
};
const navigations: unknown[] = [];
const addTrigger = mock(async () => ({ kind: "created", task: { name: "x" } }));

mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("@opengeni/react/app/lib/navigation", () => ({
  useNavigate: () => (options: unknown) => navigations.push(options),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("@opengeni/react/app/components/agents/agent-trigger-dialog", () => ({
  addAgentSuggestedTrigger: addTrigger,
  agentTriggerSaveError: () => "error",
  agentTriggerRunsAs: () => "Runs as you",
  AgentTriggerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="trigger-dialog" /> : null,
}));
mock.module("sonner", () => ({
  toast: Object.assign(() => undefined, {
    success: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warning: mock(() => undefined),
  }),
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { EnablePage } = await import("./enable-page");

afterAll(() => {
  mock.restore();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      GlobalRegistrator.unregister();
      resolve();
    }, 50),
  );
});

beforeEach(() => {
  readiness = readinessOf([]);
  agents = [];
  tasks = [];
  navigations.length = 0;
  client.createSession.mockClear();
  client.createAgentFromTemplate.mockClear();
  addTrigger.mockClear();
  document.body.innerHTML = "";
});

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <EnablePage
        workspaceId="workspace-a"
        subject={{ kind: "agent", templateKey: "dependency-updater" }}
      />,
    );
  });
  await settle();
  return { container, root };
}

function turnOnButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("[data-enable-turn-on]");
  if (!button) throw new Error("no Turn on");
  return button;
}

function row(container: HTMLElement, provider: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-enable-connection="${provider}"]`);
  if (!element) throw new Error(`no ${provider} row`);
  return element;
}

test("nothing connected: every required connection up front, Turn on off with the reason", async () => {
  readiness = readinessOf([
    connection({}),
    connection({ provider: "slack.com", name: "Slack", required: false, catalogItemId: "slack" }),
  ]);
  const { container, root } = await render();
  expect(container.textContent).toContain("0 of 1 required connected");
  expect(row(container, "github.com").textContent).toContain("Required");
  expect(row(container, "slack.com").textContent).toContain("Optional");
  expect(row(container, "github.com").querySelector("button")?.textContent).toBe("Connect");
  expect(container.querySelector("[data-enable-repository]")?.textContent).toContain("Required");
  expect(turnOnButton(container).disabled).toBe(true);
  expect(container.textContent).toContain("Connect GitHub to turn this on.");
  expect(container.textContent).toContain("Merge a pull request");
  expect(container.textContent).toContain("Works well with PR reviewer");
  root.unmount();
});

test("Connect returns to the same step: GitHub gets this page's Connect address", async () => {
  readiness = readinessOf([connection({})]);
  const { container, root } = await render();
  await act(async () => {
    row(container, "github.com").querySelector("button")?.click();
  });
  expect(client.getGitHubApp).toHaveBeenCalledWith("workspace-a", {
    returnPath: "/workspaces/workspace-a/enable?agent=dependency-updater&step=connect",
  });
  root.unmount();
});

test("a catalog connector opens its Connect page with the way back", async () => {
  readiness = readinessOf([
    connection({ provider: "posthog.com", name: "PostHog", catalogItemId: "item-9" }),
  ]);
  const { container, root } = await render();
  await act(async () => {
    row(container, "posthog.com").querySelector("button")?.click();
  });
  const href = (navigations.at(-1) as { href: string }).href;
  expect(href).toStartWith("/workspaces/workspace-a/plugins?open=item%3Aitem-9&from=");
  expect(decodeURIComponent(href)).toContain("enable?agent=dependency-updater&step=connect");
  root.unmount();
});

test("partly connected: counts what is connected and shows it Connected", async () => {
  readiness = readinessOf([
    connection({ connected: true }),
    connection({ provider: "linear.app", name: "Linear", catalogItemId: "linear" }),
  ]);
  const { container, root } = await render();
  expect(container.textContent).toContain("1 of 2 required connected");
  expect(row(container, "github.com").textContent).toContain("Connected");
  expect(container.textContent).toContain("Connect Linear to turn this on.");
  expect(turnOnButton(container).disabled).toBe(true);
  root.unmount();
});

test("can't connect: Ask an admin, then it shows the request went out", async () => {
  readiness = readinessOf([connection({ canConnect: false })]);
  const writeText = mock(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { container, root } = await render();
  expect(container.textContent).toContain("Ask an admin to connect GitHub.");
  const ask = row(container, "github.com").querySelector("button");
  expect(ask?.textContent).toBe("Ask an admin");
  await act(async () => {
    ask?.click();
  });
  await settle();
  expect(writeText).toHaveBeenCalledWith(
    expect.stringContaining("/workspaces/workspace-a/enable?agent=dependency-updater&step=connect"),
  );
  expect(row(container, "github.com").textContent).toContain("Link copied");
  root.unmount();
});

test("ready: Turn on adds it, turns on its trigger, says hello and suggests a first job", async () => {
  readiness = readinessOf([connection({ connected: true })]);
  const { container, root } = await render();
  expect(container.textContent).toContain("1 of 1 required connected");
  expect(turnOnButton(container).disabled).toBe(false);
  await act(async () => {
    turnOnButton(container).click();
  });
  await settle();
  expect(client.createAgentFromTemplate).toHaveBeenCalledWith("workspace-a", "dependency-updater", {
    editAccess: "everyone",
  });
  expect(addTrigger).toHaveBeenCalledTimes(1);
  expect(client.createSession).toHaveBeenCalledWith("workspace-a", {
    agentId: "agent-1",
    initialMessage: "Say hello.",
  });
  expect(container.textContent).toContain("Dependency updater is on.");
  const firstJob = container.querySelector<HTMLElement>("[data-enable-first-job]");
  expect(firstJob?.textContent).toContain("Open this week's upgrade pull request now.");
  await act(async () => {
    firstJob?.querySelector("button")?.click();
  });
  await settle();
  expect(client.createSession).toHaveBeenLastCalledWith("workspace-a", {
    agentId: "agent-1",
    initialMessage: "Open this week's upgrade pull request now.",
  });
  expect(navigations.at(-1)).toMatchObject({ params: { sessionId: "session-1" } });
  root.unmount();
});

test("a paused trigger is resumed rather than added again", async () => {
  agents = [{ ...agent, templateKey: "dependency-updater" }];
  tasks = [
    {
      id: "task-1",
      name: "Dependency updater: Every Monday morning",
      status: "paused",
      agentConfig: { agentId: "agent-1" },
    },
  ];
  const { container, root } = await render();
  await act(async () => {
    turnOnButton(container).click();
  });
  await settle();
  expect(client.resumeScheduledTask).toHaveBeenCalledWith("workspace-a", "task-1");
  expect(addTrigger).not.toHaveBeenCalled();
  // Turning a paused one back on doesn't say hello again.
  expect(client.createSession).not.toHaveBeenCalled();
  root.unmount();
});

test("its triggers can't be read: Turn on stays off so it can't add a second one", async () => {
  agents = [{ ...agent, templateKey: "dependency-updater" }];
  client.listScheduledTasks.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  const { container, root } = await render();
  expect(turnOnButton(container).disabled).toBe(true);
  expect(container.textContent).toContain("Couldn't check its triggers.");
  root.unmount();
});

test("in a Personal workspace there is no admin to ask", async () => {
  context.workspaces = [{ id: "workspace-a", kind: "personal" }];
  readiness = readinessOf([connection({ canConnect: false })]);
  const { container, root } = await render();
  expect(row(container, "github.com").querySelector("button")).toBeNull();
  expect(row(container, "github.com").textContent).toContain("GitHub isn't offered here.");
  context.workspaces = [{ id: "workspace-a", kind: "shared" }];
  root.unmount();
});

test("Finish later adds it, leaves it off and opens it", async () => {
  const { container, root } = await render();
  const later = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Finish later",
  );
  await act(async () => {
    later?.click();
  });
  await settle();
  expect(client.createAgentFromTemplate).toHaveBeenCalledTimes(1);
  expect(addTrigger).not.toHaveBeenCalled();
  expect(navigations.at(-1)).toMatchObject({ params: { agentId: "agent-1" } });
  root.unmount();
});

test("someone who can't add agents sees why Turn on is off", async () => {
  context.accessContext = { workspaceGrants: [] };
  const { container, root } = await render();
  expect(turnOnButton(container).disabled).toBe(true);
  expect(container.textContent).toContain("Ask an admin to add Dependency updater.");
  context.accessContext = {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions: ["sessions:create"] }],
  };
  root.unmount();
});
