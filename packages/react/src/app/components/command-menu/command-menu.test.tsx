import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentType, RefObject } from "react";
import type { Root } from "react-dom/client";
import type { ActionEnv } from "../../lib/actions/registry";

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

const client = {
  listSessionPage: async (_workspaceId: string, options: { search?: string }) => ({
    pinned: [],
    sessions: options.search?.toLowerCase().includes("usage")
      ? [
          {
            id: "33333333-3333-4333-8333-333333333333",
            workspaceId,
            parentSessionId: null,
            title: "Usage report follow-up",
            titleSource: "user",
            status: "idle",
            pinned: false,
            archived: false,
            createdAt: "2026-10-20T10:00:00.000Z",
            updatedAt: "2026-10-20T10:00:00.000Z",
          },
        ]
      : [],
    nextCursor: null,
  }),
  listSessionSummaryPage: async () => ({ pinned: [], sessions: [], nextCursor: null }),
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
