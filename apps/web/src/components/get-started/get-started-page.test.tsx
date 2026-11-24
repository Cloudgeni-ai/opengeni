import "@/app-host";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/* ----------------------------------------------------------------------------
   Get started: the setups list, and one setup's three steps against a mocked
   client. Each step reads the workspace, so the test drives it by changing
   what the client returns.
   -------------------------------------------------------------------------- */

const template = {
  key: "pr-reviewer",
  name: "PR reviewer",
  description: "Reviews pull requests.",
  suggestedTriggers: [{ name: "When a pull request opens" }],
};
let agents: unknown[] = [];
let tasks: unknown[] = [];
let catalogFails = false;
let agentsFail = false;
let tasksFail = false;
const client = {
  resumeScheduledTask: mock(async () => ({})),
  listAgents: mock(async () => {
    if (agentsFail) throw new Error("offline");
    return agents;
  }),
  listCapabilities: mock(async () => {
    if (catalogFails) throw new Error("offline");
    return { items: [] };
  }),
  listScheduledTasks: mock(async () => {
    if (tasksFail) throw new Error("offline");
    return tasks;
  }),
  listAgentTemplates: mock(async () => [template]),
  getAgent: mock(async (_workspaceId: string, id: string) => ({
    id,
    name: "PR reviewer",
    viewer: { canEdit: true },
  })),
  createAgentFromTemplate: mock(async () => {
    agents = [
      { id: "agent-1", name: "PR reviewer", templateKey: "pr-reviewer", viewer: { canEdit: true } },
    ];
    return { id: "agent-1", name: "PR reviewer", viewer: { canEdit: true } };
  }),
};
const context: Record<string, unknown> = {
  client,
  githubStatus: { status: "bound" },
  accessContext: {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions: ["sessions:create"] }],
  },
};
const navigations: unknown[] = [];

mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("@opengeni/react/app/lib/navigation", () => ({
  useNavigate: () => (options: unknown) => navigations.push(options),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("@opengeni/react/app/components/agents/agent-trigger-dialog", () => ({
  addAgentSuggestedTrigger: mock(async () => ({ kind: "needs_setup" })),
  agentTriggerSaveError: () => "error",
  AgentTriggerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="trigger-dialog" /> : null,
}));
mock.module("sonner", () => ({
  toast: { success: mock(() => undefined), error: mock(() => undefined) },
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { GetStartedPage } = await import("./get-started-page");

afterAll(() => {
  mock.restore();
  // Let React's scheduled passive effects run before the DOM goes away.
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      GlobalRegistrator.unregister();
      resolve();
    }, 50),
  );
});

beforeEach(() => {
  agents = [];
  tasks = [];
  catalogFails = false;
  agentsFail = false;
  tasksFail = false;
  context.githubStatus = { status: "bound" };
  context.accessContext = {
    workspaceGrants: [{ workspaceId: "workspace-a", permissions: ["sessions:create"] }],
  };
  navigations.length = 0;
  document.body.innerHTML = "";
});

async function render(setupKey?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<GetStartedPage workspaceId="workspace-a" setupKey={setupKey} />);
  });
  await settle();
  return { container, root };
}

async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function step(container: HTMLElement, name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-guided-step="${name}"]`);
  if (!element) throw new Error(`no ${name} step`);
  return element;
}

test("lists the setups and opens one", async () => {
  const { container, root } = await render();
  const rows = container.querySelectorAll<HTMLElement>("[data-slot=list-row]");
  expect([...rows].map((row) => row.textContent)).toEqual([
    expect.stringContaining("Review pull requests"),
    expect.stringContaining("Triage issues"),
    expect.stringContaining("Track product analytics"),
  ]);
  await act(async () => {
    (rows[0]?.querySelector<HTMLElement>("button, a") ?? rows[0])?.click();
  });
  expect(navigations.at(-1)).toMatchObject({ search: { setup: "pr-reviews" } });
  root.unmount();
});

test("walks a setup: connected, add the agent, then turn on its trigger", async () => {
  const { container, root } = await render("pr-reviews");
  expect(step(container, "connect").textContent).toContain("Connected");
  const add = step(container, "agent").querySelector("button");
  expect(add?.textContent).toBe("Add");
  await act(async () => {
    add?.click();
  });
  await settle();
  expect(client.createAgentFromTemplate).toHaveBeenCalledWith("workspace-a", "pr-reviewer", {
    editAccess: "everyone",
  });
  expect(step(container, "agent").querySelector("button")?.textContent).toBe("Open");
  const turnOn = step(container, "trigger").querySelector("button");
  expect(turnOn?.disabled).toBe(false);
  await act(async () => {
    turnOn?.click();
  });
  expect(container.ownerDocument.querySelector('[data-testid="trigger-dialog"]')).not.toBeNull();
  root.unmount();
});

test("shows ready once the agent's trigger is on", async () => {
  agents = [
    { id: "agent-1", name: "PR reviewer", templateKey: "pr-reviewer", viewer: { canEdit: true } },
  ];
  tasks = [
    {
      name: "PR reviewer: When a pull request opens",
      status: "active",
      agentConfig: { agentId: "agent-1" },
    },
  ];
  const { container, root } = await render("pr-reviews");
  expect(step(container, "trigger").textContent).toContain("On");
  expect(container.textContent).toContain("PR reviewer reviews each new pull request.");
  root.unmount();
});

test("connect still goes to Capabilities when the connector list can't be read", async () => {
  catalogFails = true;
  const { container, root } = await render("issue-triage");
  const connect = step(container, "connect").querySelector("button");
  expect(connect?.textContent).toBe("Connect");
  await act(async () => {
    connect?.click();
  });
  expect(navigations.at(-1)).toEqual({ href: "/workspaces/workspace-a/plugins" });
  root.unmount();
});

test("says when GitHub isn't offered, and offers no Add without permission", async () => {
  context.githubStatus = { status: "disabled" };
  context.accessContext = { workspaceGrants: [] };
  const { container, root } = await render("pr-reviews");
  expect(step(container, "connect").textContent).toContain("GitHub isn't offered here.");
  expect(step(container, "connect").querySelector("button")).toBeNull();
  expect(step(container, "agent").textContent).toContain("Ask a workspace admin to add it.");
  expect(step(container, "agent").querySelector("button")).toBeNull();
  root.unmount();
});

test("a failed agent list offers Retry, not Add", async () => {
  agentsFail = true;
  const { container, root } = await render("pr-reviews");
  expect(step(container, "agent").querySelector("button")?.textContent).toBe("Retry");
  root.unmount();
});

test("a paused trigger is turned back on, and a failed trigger read offers Retry", async () => {
  agents = [
    { id: "agent-1", name: "PR reviewer", templateKey: "pr-reviewer", viewer: { canEdit: true } },
  ];
  tasks = [
    {
      id: "task-1",
      name: "PR reviewer: When a pull request opens",
      status: "paused",
      agentConfig: { agentId: "agent-1" },
    },
  ];
  const paused = await render("pr-reviews");
  const turnOn = step(paused.container, "trigger").querySelector("button");
  expect(turnOn?.textContent).toBe("Turn on");
  await act(async () => {
    turnOn?.click();
  });
  expect(client.resumeScheduledTask).toHaveBeenCalledWith("workspace-a", "task-1");
  paused.root.unmount();

  tasksFail = true;
  const failed = await render("pr-reviews");
  expect(step(failed.container, "trigger").querySelector("button")?.textContent).toBe("Retry");
  expect(step(failed.container, "trigger").textContent).toContain("Couldn't check its triggers.");
  failed.root.unmount();
});
