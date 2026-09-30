import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  OpenGeniApiError,
  type AgentTopologyPageResponse,
  type AgentTopologySession,
} from "@opengeni/sdk";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { apiErrorAdvice } from "@/lib/api-error";
import { createRoot } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function agent(
  id: string,
  options: Partial<
    Pick<AgentTopologySession, "status" | "parentSessionId" | "title" | "updatedAt">
  > & { children?: Partial<AgentTopologySession["children"]>; paused?: boolean } = {},
): AgentTopologySession {
  const parentSessionId = options.parentSessionId ?? null;
  return {
    id,
    title: options.title ?? id,
    titleTruncated: false,
    parentSessionId,
    rootSessionId: parentSessionId ?? id,
    nestedAgentDepth: parentSessionId ? 1 : 0,
    ancestorPath: [],
    status: options.status ?? "idle",
    goal: null,
    pause: options.paused
      ? {
          state: "paused",
          additionalBlockerCount: 0,
          source: { kind: "workspace", displayName: "Workspace", displayNameTruncated: false },
        }
      : { state: "active", additionalBlockerCount: 0, source: null },
    children: {
      directChildren: 0,
      totalDescendants: 0,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
      ...options.children,
    },
    relatedWork: {
      claims: [],
      claimsTruncated: false,
      match: null,
      possibleOverlap: false,
      advisoryOnly: true,
      noAdditionalAccess: true,
    },
    createdAt: options.updatedAt ?? ago(60),
    updatedAt: options.updatedAt ?? ago(60),
  };
}

type ListOptions = {
  parentSessionId?: string | null;
  statuses?: string[];
  recentHours?: number;
  search?: string;
};

let roots: AgentTopologySession[] = [];
/** Workstreams only the live or recently-failed reads return (older than the first page). */
let olderLive: AgentTopologySession[] = [];
let children = new Map<string, AgentTopologySession[]>();
let failure: Error | null = null;
/** Fails only the reads it returns an error for. */
let failWhen: (options: ListOptions) => Error | null = () => null;
let advisories = true;
const calls: ListOptions[] = [];

function page(sessions: AgentTopologySession[]): AgentTopologyPageResponse {
  return {
    sessions,
    total: sessions.length,
    hasMore: false,
    nextCursor: null,
    humanAdvisoriesEnabled: advisories,
  };
}

const listAgentTopology = mock(async (_workspaceId: string, options: ListOptions) => {
  calls.push(options);
  if (failure) throw failure;
  const failed = failWhen(options);
  if (failed) throw failed;
  if (options.parentSessionId) return page(children.get(options.parentSessionId) ?? []);
  if (options.statuses?.includes("failed")) {
    return page(
      [...roots, ...olderLive].filter(
        (session) =>
          session.status === "failed" &&
          now - Date.parse(session.updatedAt) <= (options.recentHours ?? 24) * 3_600_000,
      ),
    );
  }
  if (options.statuses) {
    return page(
      [...roots, ...olderLive].filter((session) => options.statuses!.includes(session.status)),
    );
  }
  return page(roots);
});

// One stable context, like the app's provider: a new client per render would
// restart the page's reads on every render.
const context = { client: { listAgentTopology } };
mock.module("@/context", () => ({ useAppContext: () => context }));

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => GlobalRegistrator.unregister());

beforeEach(() => {
  failure = null;
  failWhen = () => null;
  advisories = true;
  calls.length = 0;
  olderLive = [];
  children = new Map();
  roots = [
    agent("merge", {
      title: "Merge the state split",
      status: "requires_action",
      updatedAt: ago(5),
    }),
    agent("refactor", {
      title: "Refactor auth",
      status: "running",
      updatedAt: ago(2),
      children: {
        directChildren: 2,
        totalDescendants: 2,
        attentionDescendants: 1,
        runningDescendants: 1,
      },
    }),
    agent("deploy", { title: "Deploy preview", status: "failed", updatedAt: ago(120) }),
    agent("stale-failure", { title: "Old failure", status: "failed", updatedAt: ago(60 * 72) }),
    agent("audit", {
      title: "Audit IAM roles",
      updatedAt: ago(600),
      children: { directChildren: 1, totalDescendants: 1 },
    }),
    agent("held", { title: "Held by pause", status: "running", paused: true }),
  ];
  children.set("refactor", [
    agent("refactor-tests", {
      title: "Write the tests",
      parentSessionId: "refactor",
      status: "requires_action",
      updatedAt: ago(3),
    }),
    agent("refactor-docs", {
      title: "Update the docs",
      parentSessionId: "refactor",
      status: "running",
      updatedAt: ago(4),
    }),
  ]);
  children.set("audit", [
    agent("audit-prod", { title: "Audit production", parentSessionId: "audit" }),
  ]);
});

async function renderPage() {
  const { AgentsRoute } = await import("./agents");
  let switchTo: (id: string) => void = () => {};
  function Page() {
    const [id, setId] = useState(workspaceId);
    switchTo = setId;
    return <AgentsRoute workspaceId={id} />;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  await settle();
  return {
    container,
    async switchWorkspace(id: string) {
      await act(async () => switchTo(id));
      await settle();
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function rowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-agent-row] a")).map(
    (link) => link.firstChild?.textContent ?? "",
  );
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("missing element");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("missing input");
  await act(async () => {
    input.value = value;
    // happy-dom doesn't drive React's change tracking; call the handler as React would.
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    (input as unknown as Record<string, { onChange: (event: { target: unknown }) => void }>)[
      propsKey
    ]!.onChange({ target: input });
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await settle();
}

function button(container: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((candidate) =>
    name.test(candidate.textContent ?? ""),
  );
}

test("the header carries at most three numbers, the ones someone acts on", async () => {
  const view = await renderPage();
  const summary = view.container.querySelector("[data-agent-summary]");
  // The paused agent counts nowhere; the three-day-old failure is not recent.
  expect(summary?.textContent).toBe("2 need you·2 running·1 failed in the last day");
  // No stat cards: the retired counters appear nowhere above the list.
  const header = view.container.querySelector("[data-slot=page-header]")?.textContent ?? "";
  for (const retired of ["Active", "Starting", "Paused", "0 "]) {
    expect(header).not.toContain(retired);
  }
  for (const systemWords of ["Depth", "loaded agents", "roots", "Updates every"]) {
    expect(view.container.textContent).not.toContain(systemWords);
  }
  await view.unmount();
});

test("a workstream older than the first page still counts when it needs you", async () => {
  olderLive = [agent("old-approval", { title: "Old approval", status: "requires_action" })];
  const view = await renderPage();
  expect(view.container.querySelector("[data-agent-summary]")?.textContent).toContain("3 need you");
  expect(rowTitles(view.container)).toContain("Old approval");
  expect(calls.some((call) => call.statuses?.includes("requires_action"))).toBe(true);
  expect(calls.some((call) => call.statuses?.includes("failed") && call.recentHours === 24)).toBe(
    true,
  );
  await view.unmount();
});

test("rows show one status only when there is one, and spawned agents sit nested", async () => {
  const view = await renderPage();
  const rows = Array.from(view.container.querySelectorAll<HTMLElement>("[data-agent-row]"));
  const byId = new Map(rows.map((row) => [row.dataset.agentRow, row]));

  // Live branches open by themselves; quiet ones stay folded.
  expect(byId.get("refactor-tests")?.getAttribute("aria-level")).toBe("2");
  expect(byId.get("refactor-tests")?.textContent).toContain("spawned by Refactor auth");
  expect(byId.has("audit-prod")).toBe(false);

  const statuses = (id: string) =>
    Array.from(byId.get(id)?.querySelectorAll("[data-slot=status-badge]") ?? []).map(
      (badge) => badge.textContent,
    );
  // One status, rendered for narrow and wide lists (only one is visible at a time).
  expect(new Set(statuses("merge"))).toEqual(new Set(["Needs you"]));
  expect(new Set(statuses("refactor"))).toEqual(new Set(["Running"]));
  expect(new Set(statuses("held"))).toEqual(new Set(["Paused"]));
  expect(statuses("audit")).toEqual([]);

  await click(button(view.container, /1 spawned agent/));
  expect(view.container.querySelector('[data-agent-row="audit-prod"]')).not.toBeNull();
  const toggle = button(view.container, /1 spawned agent/);
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  await view.unmount();
});

test("each number opens its view, and a second press returns to all", async () => {
  const view = await renderPage();
  await click(button(view.container, /need you/));
  expect(rowTitles(view.container)).toEqual([
    "Merge the state split",
    "Refactor auth",
    "Write the tests",
  ]);

  await click(button(view.container, /failed in the last day/));
  expect(rowTitles(view.container)).toEqual(["Deploy preview"]);

  await click(button(view.container, /failed in the last day/));
  expect(rowTitles(view.container)).toContain("Old failure");
  await view.unmount();
});

test("an empty workspace shows one way to start, and no toolbar", async () => {
  roots = [];
  const view = await renderPage();
  expect(view.container.textContent).toContain("No agents yet");
  const start = Array.from(view.container.querySelectorAll("a")).find(
    (link) => link.textContent === "Start a session",
  );
  expect(start?.getAttribute("href")).toBe(`/workspaces/${workspaceId}/sessions`);
  expect(view.container.querySelector("[data-slot=toolbar]")).toBeNull();
  expect(view.container.querySelector("[data-agent-summary]")).toBeNull();
  await view.unmount();
});

test("a view with nothing in it says so and offers the way back", async () => {
  roots = [agent("quiet", { title: "Quiet" })];
  children = new Map();
  const view = await renderPage();
  expect(view.container.querySelector("[data-agent-summary]")?.textContent).toBe(
    "Nothing needs you",
  );
  const radios = Array.from(view.container.querySelectorAll<HTMLElement>("[role=radio]"));
  await click(radios.find((radio) => radio.textContent === "Running"));
  expect(view.container.textContent).toContain("No agents are running.");
  await click(button(view.container, /^Show all$/));
  expect(rowTitles(view.container)).toEqual(["Quiet"]);
  await view.unmount();
});

test("a failed first load explains itself without a raw API string", async () => {
  failure = new Error("OpenGeni API 503: upstream unavailable Reference: abc123.");
  const view = await renderPage();
  expect(view.container.textContent).toContain("Couldn't load agents");
  expect(view.container.textContent).not.toContain("OpenGeni API 503");
  expect(button(view.container, /^Try again$/)).toBeDefined();
  await view.unmount();
});

test("related-work evidence opens under its row, never as a box in every row", async () => {
  const overlapping = agent("overlap", { title: "Review the network boundary" });
  overlapping.relatedWork = {
    ...overlapping.relatedWork,
    possibleOverlap: true,
    claims: [
      {
        id: "00000000-0000-4000-8000-000000000201",
        sessionId: "overlap",
        subject: {
          namespace: "github",
          type: "pull_request",
          canonicalKey: "acme/infra#12",
          displayLabel: "Network boundary review",
        },
        role: "reviewing",
        state: "active",
        revision: 1,
        provenance: "explicit_agent",
        version: null,
        observedAt: ago(10),
        updatedAt: ago(10),
        settledAt: null,
      },
    ],
  };
  roots = [overlapping];
  const view = await renderPage();
  expect(view.container.textContent).not.toContain("does not reserve work");
  const toggle = button(view.container, /Possible related work/);
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(view.container.textContent).toContain("Network boundary review");
  expect(view.container.textContent).toContain("does not reserve work");
  await view.unmount();

  advisories = false;
  const hidden = await renderPage();
  expect(button(hidden.container, /Possible related work/)).toBeUndefined();
  await hidden.unmount();
});

test("a first load the viewer isn't allowed says who can help, and offers no Try again", async () => {
  failure = new OpenGeniApiError(403, "missing permission: sessions:read");
  const view = await renderPage();
  expect(view.container.textContent).toContain("Couldn't load agents");
  expect(view.container.textContent).toContain(apiErrorAdvice(failure));
  expect(view.container.textContent).not.toContain("Check your connection");
  expect(button(view.container, /^Try again$/)).toBeUndefined();
  await view.unmount();
});

test("a failed first load gives the advice for that failure and a way to try again", async () => {
  failure = new OpenGeniApiError(503, "upstream unavailable");
  const view = await renderPage();
  expect(view.container.textContent).toContain(apiErrorAdvice(failure));
  expect(view.container.textContent).not.toContain("Check your connection");
  failure = null;
  await click(button(view.container, /^Try again$/));
  expect(rowTitles(view.container)).toContain("Merge the state split");
  await view.unmount();
});

test("the page shows when only the live or recently failed read fails", async () => {
  olderLive = [agent("old-approval", { title: "Old approval", status: "requires_action" })];
  failWhen = (options) =>
    options.statuses?.includes("failed") ? new Error("recent failures unavailable") : null;
  const view = await renderPage();
  expect(view.container.textContent).not.toContain("Couldn't load agents");
  expect(view.container.textContent).not.toContain("Couldn't refresh agents");
  expect(view.container.textContent).toContain("Couldn't load every agent.");
  expect(view.container.querySelector("[data-agent-summary]")).toBeNull();
  // The first page and the live read that did answer both show.
  expect(rowTitles(view.container)).toContain("Merge the state split");
  expect(rowTitles(view.container)).toContain("Old approval");
  await view.unmount();
});

for (const supplemental of ["live", "failed"] as const) {
  test(`a failed ${supplemental} read keeps rows but never claims complete activity or an empty filter`, async () => {
    roots = [agent("quiet", { title: "Quiet workstream" })];
    children = new Map();
    olderLive = [
      agent("older-approval", { title: "Older approval", status: "requires_action" }),
      agent("older-failure", { title: "Older failure", status: "failed" }),
    ];
    failWhen = (options) =>
      options.statuses?.includes(supplemental === "live" ? "requires_action" : "failed")
        ? new Error(`${supplemental} activity unavailable`)
        : null;
    const view = await renderPage();
    expect(rowTitles(view.container)).toContain("Quiet workstream");
    expect(rowTitles(view.container)).toContain(
      supplemental === "live" ? "Older failure" : "Older approval",
    );
    expect(view.container.querySelector("[data-agent-summary]")).toBeNull();
    expect(view.container.textContent).toContain("Couldn't load every agent.");
    expect(view.container.textContent).not.toContain("Nothing needs you");
    const radios = Array.from(view.container.querySelectorAll<HTMLElement>("[role=radio]"));
    await click(
      radios.find(
        (radio) => radio.textContent === (supplemental === "live" ? "Needs you" : "Failed"),
      ),
    );
    expect(rowTitles(view.container)).toEqual([]);
    expect(view.container.textContent).not.toContain("Nothing needs you right now.");
    expect(view.container.textContent).not.toContain("No workstreams failed in the last day.");

    failWhen = () => null;
    await click(button(view.container, /^Try again$/));
    expect(view.container.textContent).not.toContain("Couldn't load every agent.");
    expect(rowTitles(view.container)).toContain(
      supplemental === "live" ? "Older approval" : "Older failure",
    );
    expect(view.container.querySelector("[data-agent-summary]")?.textContent).toBe(
      "1 needs you·1 failed in the last day",
    );
    await view.unmount();
  });

  test(`an empty first page with a failed ${supplemental} read is not an empty workspace`, async () => {
    roots = [];
    children = new Map();
    failWhen = (options) =>
      options.statuses?.includes(supplemental === "live" ? "requires_action" : "failed")
        ? new Error(`${supplemental} activity unavailable`)
        : null;
    const view = await renderPage();
    expect(view.container.textContent).toContain("Couldn't load every agent.");
    expect(view.container.textContent).not.toContain("No agents yet");
    expect(view.container.textContent).not.toContain("Nothing needs you");
    expect(view.container.textContent).not.toContain("No agents to show.");
    expect(view.container.querySelector("[data-agent-summary]")).toBeNull();

    failWhen = () => null;
    await click(button(view.container, /^Try again$/));
    expect(view.container.textContent).toContain("No agents yet");
    expect(view.container.textContent).not.toContain("Couldn't load every agent.");
    await view.unmount();
  });
}

test("in the tree, a branch that failed to load says so and can try again", async () => {
  failWhen = (options) =>
    options.parentSessionId === "refactor" ? new Error("branch unavailable") : null;
  const view = await renderPage();
  await click(view.container.querySelector('[role=radio][aria-label="Tree"]'));
  const footer = () => view.container.querySelector('[data-agent-branch-footer="refactor"]');
  expect(footer()?.textContent).toContain("Couldn't load these agents.");
  expect(view.container.querySelector('[data-agent-node="refactor-tests"]')).toBeNull();

  failWhen = () => null;
  await click(button(footer() as HTMLElement, /^Try again$/));
  expect(view.container.querySelector('[data-agent-node="refactor-tests"]')).not.toBeNull();
  expect(footer()).toBeNull();
  await view.unmount();
});

test("switching workspace during a search starts that workspace unsearched", async () => {
  const view = await renderPage();
  await type(view.container.querySelector<HTMLInputElement>("input[type=search]"), "refactor");
  await wait(300);
  expect(calls.some((call) => call.search === "refactor")).toBe(true);

  await view.switchWorkspace("22222222-2222-4222-8222-222222222222");
  expect(view.container.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("");
  // The header numbers come back instead of loading for good.
  expect(view.container.querySelector("[data-agent-summary]")?.textContent).toBe(
    "2 need you·2 running·1 failed in the last day",
  );
  await view.unmount();
});
