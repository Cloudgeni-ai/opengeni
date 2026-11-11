import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentType, RefObject } from "react";
import type { Root } from "react-dom/client";
import type { Recording } from "@opengeni/contracts";
import type { ActionEnv } from "../../lib/actions/registry";
import { meetingDateRange } from "../../lib/actions/meeting-search";

// Register the DOM before React DOM and Radix load: Radix picks a no-op layout
// effect when it is imported without a document, and the dialog never mounts.
GlobalRegistrator.register({ url: "https://app.test/" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const workspaceId = "11111111-1111-4111-8111-111111111111";
const subjectId = `reader-${crypto.randomUUID()}`;
const sites = {
  usage: "22222222-2222-4222-8222-222222222221",
  pricing: "22222222-2222-4222-8222-222222222222",
  roadmap: "22222222-2222-4222-8222-222222222223",
  status: "22222222-2222-4222-8222-222222222224",
  launch: "22222222-2222-4222-8222-222222222225",
};

type CatalogCall = { workspaceId: string; options: Record<string, unknown> };
const catalogCalls: CatalogCall[] = [];
let catalog: (options: Record<string, unknown>) => Promise<unknown> = async () => ({
  items: [],
  nextCursor: null,
});

type SearchOptions = {
  search?: string;
  archiveStatus?: string;
  limit?: number;
  parentSessionId?: string | null;
  signal?: AbortSignal;
};
const sessionCalls: Array<{ projection: string; workspaceId: string; options: SearchOptions }> = [];
const searchPage = (_workspaceId: string, options: SearchOptions) => ({
  pinned: [],
  sessions: options.search?.toLowerCase().includes("usage")
    ? [
        {
          id: "33333333-3333-4333-8333-333333333333",
          workspaceId,
          parentSessionId: null,
          title: "Usage report follow-up",
          titleSource: "user",
          avatar: { kind: "emoji", emoji: "📈", hue: 150 },
          status: "idle",
          pinned: false,
          archived: false,
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-20T10:00:00.000Z",
        },
      ]
    : [],
  nextCursor: null,
});
type SearchPage = Omit<ReturnType<typeof searchPage>, "pinned"> & {
  pinned: ReturnType<typeof searchPage>["sessions"];
};
let summarySearch: (id: string, options: SearchOptions) => Promise<SearchPage> = async (
  id,
  options,
) => searchPage(id, options);
const listSessionSummaryPage = async function (this: unknown, id: string, options: SearchOptions) {
  expect(this).toBe(client);
  sessionCalls.push({ projection: "summary", workspaceId: id, options });
  return summarySearch(id, options);
};
const client = {
  listSessionPage: async (id: string, options: SearchOptions) => {
    sessionCalls.push({ projection: "full", workspaceId: id, options });
    return searchPage(id, options);
  },
  listSessionSummaryPage: listSessionSummaryPage as typeof listSessionSummaryPage | undefined,
  getSession: async () => {
    throw new Error("not needed");
  },
  listArtifactCatalog: (id: string, options: Record<string, unknown>) => {
    catalogCalls.push({ workspaceId: id, options });
    return catalog(options);
  },
};

const opened: string[] = [];
const newTabs: string[] = [];
const closes: boolean[] = [];

function env(overrides: Partial<ActionEnv> = {}): ActionEnv {
  const noop = () => {};
  return {
    workspaceId,
    subjectId,
    surface: "web",
    platform: "mac",
    currentChat: null,
    currentSiteId: null,
    ops: {
      linkTo: (chat) => `https://app.test/workspaces/${chat.workspaceId}/sessions/${chat.id}`,
      copyLink: async () => {},
      setPinned: async () => {},
      setArchived: async () => {},
      setUnread: async () => {},
    },
    chatList: true,
    workspacePanel: true,
    workspaces: [{ id: workspaceId, name: "Product", organization: "Acme", personal: false }],
    canForkCurrentChat: false,
    meetings: null,
    meetingPages: null,
    newChat: noop,
    openChat: noop,
    openSite: (siteId) => opened.push(siteId),
    siteLink: (siteId) => `https://app.test/workspaces/${workspaceId}/sites/${siteId}`,
    openWorkspace: noop,
    openWorkspacePicker: noop,
    openInbox: noop,
    toggleSidebar: noop,
    toggleWorkspacePanel: noop,
    findInChat: noop,
    searchMessages: noop,
    renameCurrentChat: noop,
    forkCurrentChat: noop,
    openCommandMenu: noop,
    openShortcutSheet: noop,
    switchToRecentChat: noop,
    sidebarOrder: () => [],
    pinnedOrder: () => [],
    ...overrides,
  };
}

let currentEnv = env();
let CommandMenu: ComponentType<{
  open: boolean;
  pickWorkspace: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
}>;
let rememberSidebarSites: typeof import("../../lib/actions/site-directory").rememberSidebarSites;
let rememberChats: typeof import("../../lib/actions/chat-directory").rememberChats;
let recordChatVisit: typeof import("../../lib/actions/chat-directory").recordChatVisit;
let setSidebarOrder: typeof import("../../lib/actions/chat-directory").setSidebarOrder;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  mock.module("../../app-context", () => ({ useAppContext: () => ({ client }) }));
  mock.module("../../lib/actions/actions-provider", () => ({
    useAppActions: () => ({
      env: currentEnv,
      run: () => {},
      chordsFor: () => [],
    }),
  }));
  CommandMenu = (await import("./command-menu")).default;
  ({ rememberSidebarSites } = await import("../../lib/actions/site-directory"));
  ({ rememberChats, recordChatVisit, setSidebarOrder } =
    await import("../../lib/actions/chat-directory"));
  // The sidebar has loaded these Site rows, most recent activity first.
  rememberSidebarSites(subjectId, workspaceId, [
    { siteId: sites.usage, title: "Usage dashboard", updatedAt: "2026-10-23T09:00:00.000Z" },
    { siteId: sites.pricing, title: "Pricing calculator", updatedAt: "2026-10-22T09:00:00.000Z" },
    { siteId: sites.roadmap, title: "Roadmap", updatedAt: "2026-10-21T09:00:00.000Z" },
    { siteId: sites.status, title: "Status page", updatedAt: "2026-10-20T09:00:00.000Z" },
  ]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  catalogCalls.length = 0;
  sessionCalls.length = 0;
  client.listSessionSummaryPage = listSessionSummaryPage;
  summarySearch = async (id, options) => searchPage(id, options);
  opened.length = 0;
  newTabs.length = 0;
  closes.length = 0;
  catalog = async () => ({ items: [], nextCursor: null });
  currentEnv = env();
});

afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

async function openMenu() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const returnFocus = { current: null };
  await act(async () => {
    root!.render(
      <CommandMenu
        open
        pickWorkspace={false}
        onOpenChange={(open) => closes.push(open)}
        returnFocus={returnFocus}
      />,
    );
  });
}

function input(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[data-og-command-menu] input[role="combobox"]')!;
}

async function type(value: string) {
  await act(async () => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The server searches wait for typing to pause.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

function groups(): Array<{ label: string; options: string[] }> {
  return [...document.querySelectorAll('[data-og-command-menu] [role="group"]')].map((group) => ({
    label: group.getAttribute("aria-label") ?? "",
    options: [...group.querySelectorAll('[role="option"]')].map(
      (element) => element.querySelector("span.truncate")?.textContent ?? "",
    ),
  }));
}

function option(title: string): HTMLElement {
  const match = [
    ...document.querySelectorAll<HTMLElement>('[data-og-command-menu] [role="option"]'),
  ].find((element) => element.querySelector("span.truncate")?.textContent === title);
  if (!match) throw new Error(`No option ${title}`);
  return match;
}

test("the field says Sites are searched too", async () => {
  await openMenu();
  expect(input().getAttribute("aria-label")).toBe("Search chats, Sites and actions");
  expect(input().placeholder).toBe("Search chats and Sites, or run an action…");
});

test("chat title search uses summaries without requesting full session configuration", async () => {
  const chats: string[] = [];
  currentEnv = env({ openChat: (id) => chats.push(id) });
  await openMenu();
  await type("usage");
  // Top-level chats, then a small search of every chat here for sub-agent ones.
  expect(sessionCalls).toEqual([
    {
      projection: "summary",
      workspaceId,
      options: {
        search: "usage",
        archiveStatus: "all",
        limit: 20,
        parentSessionId: null,
        signal: expect.objectContaining({ aborted: false }),
      },
    },
    {
      projection: "summary",
      workspaceId,
      options: {
        search: "usage",
        archiveStatus: "all",
        limit: 10,
        signal: expect.objectContaining({ aborted: false }),
      },
    },
  ]);
  await act(async () => {
    option("Usage report follow-up").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(chats).toEqual(["33333333-3333-4333-8333-333333333333"]);
  expect(closes).toEqual([false]);
});

test("older clients without the optional summary method retain full-page title search", async () => {
  client.listSessionSummaryPage = undefined;
  await openMenu();
  await type("usage");
  expect(sessionCalls.map((call) => call.projection)).toEqual(["full", "full"]);
  expect(option("Usage report follow-up")).toBeTruthy();
});

test("summary errors do not retry the expensive full-page route", async () => {
  summarySearch = async () => {
    throw new Error("unavailable");
  };
  await openMenu();
  await type("unavailable");
  expect(sessionCalls.map((call) => call.projection)).toEqual(["summary", "summary"]);
  expect(input()).toBeTruthy();
});

test("replacing a title query and unmounting abort their summary requests", async () => {
  summarySearch = () => new Promise(() => {});
  await openMenu();
  await type("first");
  const first = sessionCalls[0]!.options.signal!;
  expect(first.aborted).toBe(false);
  await type("second");
  expect(first.aborted).toBe(true);
  expect(sessionCalls[1]!.options.signal!.aborted).toBe(true);
  expect(sessionCalls.map((call) => call.options.search)).toEqual([
    "first",
    "first",
    "second",
    "second",
  ]);
  expect(new Set(sessionCalls.map((call) => call.projection))).toEqual(new Set(["summary"]));
  const second = sessionCalls[2]!.options.signal!;
  await act(async () => root!.unmount());
  root = null;
  expect(second.aborted).toBe(true);
});

test("summary search preserves per-workspace limits and combines pinned and unpinned rows", async () => {
  const otherWorkspace = "11111111-1111-4111-8111-111111111112";
  currentEnv = env({
    workspaces: [
      ...env().workspaces,
      {
        id: otherWorkspace,
        name: "Support",
        organization: "Acme",
        personal: false,
      },
    ],
  });
  summarySearch = async (id, options) => {
    const page = searchPage(id, options);
    const row = { ...page.sessions[0]!, workspaceId: id };
    return id === workspaceId
      ? page
      : {
          pinned: [
            {
              ...row,
              id: "33333333-3333-4333-8333-333333333334",
              title: "Usage pinned support",
              pinned: true,
            },
          ],
          sessions: [
            { ...row, id: "33333333-3333-4333-8333-333333333335", title: "Usage support" },
          ],
          nextCursor: null,
        };
  };
  await openMenu();
  await type("usage");
  expect(
    sessionCalls.map(({ workspaceId: id, projection, options }) => [
      id,
      projection,
      options.limit,
      options.archiveStatus,
      options.parentSessionId,
    ]),
  ).toEqual([
    [workspaceId, "summary", 20, "all", null],
    [workspaceId, "summary", 10, "all", undefined],
    [otherWorkspace, "summary", 6, "all", null],
  ]);
  expect(option("Usage pinned support")).toBeTruthy();
  expect(option("Usage support")).toBeTruthy();
});

test("late summary answers cannot replace results for a newer query", async () => {
  let resolveFirst!: (page: ReturnType<typeof searchPage>) => void;
  summarySearch = (id, options) =>
    options.search === "old"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve(searchPage(id, options));
  await openMenu();
  await type("old");
  await type("usage");
  await act(async () =>
    resolveFirst({
      pinned: [],
      sessions: [
        {
          ...searchPage(workspaceId, { search: "usage" }).sessions[0]!,
          id: "33333333-3333-4333-8333-333333333336",
          title: "Usage stale summary",
        },
      ],
      nextCursor: null,
    }),
  );
  expect(groups().flatMap((group) => group.options)).not.toContain("Usage stale summary");
  expect(option("Usage report follow-up")).toBeTruthy();
});

test("before anything is typed, a few recent Sites show without asking the server", async () => {
  currentEnv = env({ currentSiteId: sites.usage });
  await openMenu();
  const recent = groups().find((group) => group.label === "Recent Sites");
  // The Site on screen is left out; at most three, most recent first.
  expect(recent?.options).toEqual(["Pricing calculator", "Roadmap", "Status page"]);
  expect(groups().map((group) => group.label)).toContain("Go to");
  expect(catalogCalls).toEqual([]);
});

test("typing still lists chats first, then matching Sites in their own group, with the server's matches", async () => {
  catalog = async () => ({
    items: [
      {
        id: sites.launch,
        kind: "site",
        title: "Usage launch checklist",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: sites.usage,
        kind: "site",
        title: "Usage dashboard",
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  });
  await openMenu();
  await type("usage");
  expect(catalogCalls).toEqual([
    {
      workspaceId,
      options: expect.objectContaining({
        kind: "site",
        q: "usage",
        status: "active",
        sort: "updated",
      }),
    },
  ]);
  const listed = groups();
  // Chats keep coming first, even when a Site matches better; Sites follow them.
  expect(listed.map((group) => group.label).slice(0, 2)).toEqual(["Chats", "Sites"]);
  expect(listed.find((group) => group.label === "Sites")?.options).toEqual([
    "Usage dashboard",
    "Usage launch checklist",
  ]);
  expect(listed.find((group) => group.label === "Chats")?.options).toEqual([
    "Usage report follow-up",
  ]);
  expect(listed.at(-1)?.label).toBe("Messages");
  // Sites draw the sidebar's Site icon.
  expect(option("Usage dashboard").querySelector("svg")?.getAttribute("class")).toContain(
    "lucide-panels-top-left",
  );
});

test("a chat with an avatar shows it, the way its sidebar row does", async () => {
  await openMenu();
  await type("usage");
  const row = option("Usage report follow-up");
  expect(row.querySelector('[data-session-avatar="emoji"]')?.textContent).toBe("📈");
  expect(row.querySelector("svg.lucide-message-square")).toBeNull();
});

test("with no matching chats, Sites lead; Enter opens one in the app, the way its sidebar row does", async () => {
  await openMenu();
  await type("pricing");
  expect(groups()[0]).toEqual({ label: "Sites", options: ["Pricing calculator"] });
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(opened).toEqual([sites.pricing]);
  expect(closes).toEqual([false]);
});

test("⌘ and a click open a Site in a new browser tab on the web", async () => {
  const originalOpen = window.open;
  window.open = ((url: string) => {
    newTabs.push(url);
    return null;
  }) as typeof window.open;
  try {
    await openMenu();
    await type("roadmap");
    await act(async () => {
      option("Roadmap").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });
    expect(newTabs).toEqual([`https://app.test/workspaces/${workspaceId}/sites/${sites.roadmap}`]);
    expect(opened).toEqual([]);
  } finally {
    window.open = originalOpen;
  }
});

test("the desktop app opens Sites in the app even with ⌘", async () => {
  currentEnv = env({ surface: "desktop" });
  await openMenu();
  await type("roadmap");
  await act(async () => {
    option("Roadmap").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  });
  expect(opened).toEqual([sites.roadmap]);
});

test("a failing Site search leaves chats, actions and known Sites working", async () => {
  catalog = async () => {
    throw Object.assign(new Error("API 500"), { status: 500 });
  };
  await openMenu();
  await type("usage");
  const listed = groups();
  expect(listed.map((group) => group.label).slice(0, 2)).toEqual(["Chats", "Sites"]);
  expect(listed.find((group) => group.label === "Sites")?.options).toEqual(["Usage dashboard"]);
  expect(listed.find((group) => group.label === "Chats")?.options).toEqual([
    "Usage report follow-up",
  ]);
  expect(listed.at(-1)?.label).toBe("Messages");
});

test("a workspace that refuses Site access is not asked again while the menu stays open", async () => {
  catalog = async () => {
    throw Object.assign(new Error("API 403"), { status: 403 });
  };
  await openMenu();
  await type("usage");
  await type("usage d");
  expect(catalogCalls).toHaveLength(1);
  expect(groups().find((group) => group.label === "Sites")?.options).toEqual(["Usage dashboard"]);
});

function catalogSite(id: string, title: string) {
  return {
    id,
    kind: "site",
    title,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("a Site only the server found stays listed while the next answer loads", async () => {
  catalog = async (options) =>
    options.q === "usage"
      ? { items: [catalogSite(sites.launch, "Usage launch checklist")], nextCursor: null }
      : new Promise(() => {});
  await openMenu();
  await type("usage");
  await type("usage l");
  expect(catalogCalls.map((call) => call.options.q)).toEqual(["usage", "usage l"]);
  expect(groups().find((group) => group.label === "Sites")?.options).toEqual([
    "Usage launch checklist",
  ]);
});

test("quick typing asks the server once, for the last query", async () => {
  await openMenu();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const value of ["u", "us", "usa", "usag", "usage"]) {
      setter.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(catalogCalls.map((call) => call.options.q)).toEqual(["usage"]);
});

test("a slow answer to an earlier query never shows under a later one", async () => {
  catalog = (options) =>
    options.q === "usag"
      ? new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                items: [catalogSite(sites.launch, "Usage stale answer")],
                nextCursor: null,
              }),
            150,
          ),
        )
      : Promise.resolve({ items: [], nextCursor: null });
  await openMenu();
  await type("usag");
  await type("usage");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(groups().find((group) => group.label === "Sites")?.options).toEqual(["Usage dashboard"]);
});

test("one letter matches the sidebar's Sites without asking the server", async () => {
  await openMenu();
  await type("r");
  expect(catalogCalls).toEqual([]);
  expect(groups().find((group) => group.label === "Sites")?.options).toContain("Roadmap");
});

test("Start recording is a general action where meetings record, and finds by meeting", async () => {
  const started: string[] = [];
  const meetings: NonNullable<ActionEnv["meetings"]> = {
    state: "idle",
    start: () => started.push("start"),
    show: () => started.push("show"),
    stop: () => {},
  };
  currentEnv = env({ meetings });
  await openMenu();
  const general = groups().find((group) => group.label === "Go to");
  expect(general?.options).toContain("Start recording");
  expect(general?.options).not.toContain("Stop recording");
  await type("meeting");
  expect(groups().find((group) => group.label === "Actions")?.options).toContain("Start recording");
});

test("while a meeting records, the action goes to it and Stop recording joins it", async () => {
  currentEnv = env({
    meetings: { state: "recording", start: () => {}, show: () => {}, stop: () => {} },
  });
  await openMenu();
  const general = groups().find((group) => group.label === "Go to");
  expect(general?.options).toContain("Go to recording");
  expect(general?.options).toContain("Stop recording");
  expect(general?.options).not.toContain("Start recording");
});

test("without meetings, neither recording action is listed", async () => {
  await openMenu();
  const options = groups().flatMap((group) => group.options);
  expect(options).not.toContain("Start recording");
  expect(options).not.toContain("Stop recording");
});

type MeetingListCall = Parameters<NonNullable<ActionEnv["meetingPages"]>["list"]>[0];

function recording(id: string, title: string, startedAt: Date) {
  return { id, workspaceId, title, startedAt: startedAt.toISOString() } as unknown as Recording;
}

function meetingPages(
  answer: (options: MeetingListCall) => Recording[],
  overrides: Partial<NonNullable<ActionEnv["meetingPages"]>> = {},
) {
  const calls: MeetingListCall[] = [];
  const openedMeetings: string[] = [];
  const pages: NonNullable<ActionEnv["meetingPages"]> = {
    openList: () => openedMeetings.push("list"),
    open: (recordingId) => openedMeetings.push(recordingId),
    link: (recordingId) => `https://app.test/workspaces/${workspaceId}/meetings/${recordingId}`,
    copyLink: () => {},
    list: async (options) => {
      calls.push(options);
      return answer(options);
    },
    current: null,
    ...overrides,
  };
  return { pages, calls, openedMeetings };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function closeMenu() {
  await act(async () => {
    root!.render(
      <CommandMenu
        open={false}
        pickWorkspace={false}
        onOpenChange={(open) => closes.push(open)}
        returnFocus={{ current: null }}
      />,
    );
  });
  // Focus goes back on a timer once the dialog unmounts.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("where meetings exist, the menu lists the newest and goes to Meetings", async () => {
  const { pages, calls, openedMeetings } = meetingPages((options) =>
    options.limit === 4
      ? [
          recording("m1", "Pricing workshop", hoursAgo(2)),
          recording("m2", "Weekly sync", hoursAgo(30)),
          recording("m3", "Customer call", hoursAgo(60)),
          recording("m4", "Retro", hoursAgo(90)),
        ]
      : [],
  );
  currentEnv = env({ meetingPages: pages });
  await openMenu();
  expect(input().placeholder).toBe("Search chats, Sites and meetings, or run an action…");
  expect(calls).toEqual([{ limit: 4, signal: expect.objectContaining({ aborted: false }) }]);
  expect(groups().find((group) => group.label === "Recent meetings")?.options).toEqual([
    "Pricing workshop",
    "Weekly sync",
    "Customer call",
  ]);
  expect(groups().find((group) => group.label === "Go to")?.options).toContain("Meetings");
  await act(async () => {
    option("Weekly sync").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(openedMeetings).toEqual(["m2"]);
});

test("typing finds meetings by who spoke, by words said and by when", async () => {
  const friday = meetingDateRange("friday")!;
  const { pages, calls } = meetingPages((options) => {
    if (options.person === "halvor") return [recording("p1", "Budget review", hoursAgo(5))];
    if (options.query === "halvor") return [recording("w1", "Planning", hoursAgo(50))];
    if (options.startedFrom === friday.from.toISOString()) {
      return [recording("d1", "Kickoff", new Date(friday.from.getTime() + 3_600_000))];
    }
    return [];
  });
  currentEnv = env({ meetingPages: pages });
  await openMenu();
  await type("halvor");
  expect(groups().find((group) => group.label === "Meetings")?.options).toEqual([
    "Budget review",
    "Planning",
  ]);
  await type("friday");
  expect(calls.filter((call) => call.startedFrom)).toEqual([
    {
      startedFrom: friday.from.toISOString(),
      startedTo: friday.to.toISOString(),
      limit: 8,
      signal: expect.objectContaining({}),
    },
  ]);
  expect(groups().find((group) => group.label === "Meetings")?.options).toEqual(["Kickoff"]);
});

test("on a meeting, the menu offers to ask about it, with what was typed", async () => {
  const asked: Array<string | null> = [];
  const { pages } = meetingPages(() => [], {
    current: { recordingId: "m9", ask: (question) => asked.push(question) },
  });
  currentEnv = env({ meetingPages: pages });
  await openMenu();
  expect(groups().find((group) => group.label === "This meeting")?.options).toEqual([
    "Ask about this meeting",
    "Copy meeting link",
  ]);
  expect(groups().find((group) => group.label === "Go to")?.options).not.toContain(
    "Copy meeting link",
  );
  await type("what did we decide on pricing");
  const last = groups()
    .filter((group) => group.label !== "Messages")
    .at(-1);
  expect(last).toEqual({
    label: "This meeting",
    options: ["Ask about this meeting: “what did we decide on pricing”"],
  });
  await act(async () => {
    option("Ask about this meeting: “what did we decide on pricing”").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
  expect(closes).toEqual([false]);
  // Asked once the menu has closed and handed focus back.
  expect(asked).toEqual([]);
  await closeMenu();
  expect(asked).toEqual(["what did we decide on pricing"]);
});

test("a meeting that takes no questions offers only its link", async () => {
  const { pages } = meetingPages(() => [], { current: { recordingId: "m9", ask: null } });
  currentEnv = env({ meetingPages: pages });
  await openMenu();
  expect(groups().find((group) => group.label === "This meeting")?.options).toEqual([
    "Copy meeting link",
  ]);
  await type("pricing");
  expect(groups().map((group) => group.label)).not.toContain("This meeting");
});

describe("sub-agent chats", () => {
  const leadId = "44444444-4444-4444-8444-444444444441";
  const chatRow = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspaceId,
    parentSessionId: null as string | null,
    title,
    titleSource: "user",
    status: "idle",
    pinned: false,
    archived: false,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...extra,
  });
  const lead = chatRow(leadId, "Release lead");
  const worker = (index: number, title: string, parentSessionId = leadId) =>
    chatRow(`44444444-4444-4444-8444-44444444445${index}`, title, {
      parentSessionId,
      updatedAt: `2026-11-01T1${index}:00:00.000Z`,
    });
  const parentOf = (title: string) =>
    option(title).querySelector("[data-chat-parent]")?.textContent ?? null;

  test("one opened here joins Recent chats and says which chat it belongs to", async () => {
    const subject = `reader-${crypto.randomUUID()}`;
    currentEnv = env({ subjectId: subject });
    const visited = worker(1, "Fix flaky test");
    const unopened = worker(2, "Bump dependencies");
    rememberChats(subject, [lead, unopened] as never);
    recordChatVisit(subject, visited as never);
    // The sidebar shows the lead with its worker expanded under it.
    setSidebarOrder(subject, workspaceId, [leadId, unopened.id], []);
    await openMenu();
    expect(groups().find((group) => group.label === "Recent chats")?.options).toEqual([
      "Fix flaky test",
      "Release lead",
    ]);
    expect(parentOf("Fix flaky test")).toBe("in Release lead");
    expect(parentOf("Release lead")).toBeNull();
  });

  test("a search lists top-level chats first, then a few matching sub-agent chats, server ones included", async () => {
    const subject = `reader-${crypto.randomUUID()}`;
    currentEnv = env({ subjectId: subject });
    rememberChats(subject, [lead] as never);
    const workers = [1, 2, 3, 4].map((index) => worker(index, `Deploy worker ${index}`));
    summarySearch = async (_id, options) => ({
      pinned: [],
      sessions: (options.parentSessionId === null
        ? [chatRow("44444444-4444-4444-8444-444444444442", "Deploy checklist")]
        : workers) as never,
      nextCursor: null,
    });
    await openMenu();
    await type("deploy");
    const listed = groups();
    expect(listed.map((group) => group.label).slice(0, 2)).toEqual(["Chats", "Sub-agent chats"]);
    expect(listed.find((group) => group.label === "Chats")?.options).toEqual(["Deploy checklist"]);
    // At most three, most recently active first.
    expect(listed.find((group) => group.label === "Sub-agent chats")?.options).toEqual([
      "Deploy worker 4",
      "Deploy worker 3",
      "Deploy worker 2",
    ]);
    expect(parentOf("Deploy worker 4")).toBe("in Release lead");
  });

  test("a sub-agent chat whose parent isn't loaded gets its parent read, once", async () => {
    const subject = `reader-${crypto.randomUUID()}`;
    currentEnv = env({ subjectId: subject });
    const otherLead = "44444444-4444-4444-8444-444444444443";
    summarySearch = async (_id, options) => {
      const ids = (options as { sessionIds?: string[] }).sessionIds;
      if (ids) {
        return {
          pinned: [],
          sessions: ids.includes(otherLead) ? [chatRow(otherLead, "Billing lead")] : [],
          nextCursor: null,
        } as never;
      }
      return {
        pinned: [],
        sessions: (options.parentSessionId === null
          ? []
          : [worker(5, "Invoice export", otherLead)]) as never,
        nextCursor: null,
      };
    };
    await openMenu();
    await type("invoice");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const parentReads = sessionCalls.filter(
      (call) => (call.options as { sessionIds?: string[] }).sessionIds,
    );
    expect(parentReads).toHaveLength(1);
    expect(parentReads[0]!.options).toMatchObject({
      sessionIds: [otherLead],
      archiveStatus: "all",
    });
    expect(parentOf("Invoice export")).toBe("in Billing lead");
  });

  test("a pinned sub-agent chat lists with the chats, as one of the person's own", async () => {
    const subject = `reader-${crypto.randomUUID()}`;
    currentEnv = env({ subjectId: subject });
    const triage = {
      ...worker(6, "Triage bot"),
      pinned: true,
      pinnedAt: "2026-11-01T12:00:00.000Z",
    };
    rememberChats(subject, [lead, triage] as never);
    // The sidebar's Pinned section lists it above the lead.
    setSidebarOrder(subject, workspaceId, [triage.id, leadId], [triage.id]);
    await openMenu();
    expect(groups().find((group) => group.label === "Recent chats")?.options).toEqual([
      "Triage bot",
      "Release lead",
    ]);
    await type("triage");
    const listed = groups();
    expect(listed.find((group) => group.label === "Chats")?.options).toEqual(["Triage bot"]);
    expect(listed.map((group) => group.label)).not.toContain("Sub-agent chats");
    expect(parentOf("Triage bot")).toBe("in Release lead");
    expect(option("Triage bot").querySelector("svg.lucide-pin")).toBeTruthy();
  });
});
