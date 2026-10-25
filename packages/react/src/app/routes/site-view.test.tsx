import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, SessionListPageOptions } from "@opengeni/sdk";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const otherSiteId = "44444444-4444-4444-8444-444444444444";
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

let permissions = ["sessions:create"];
let subjectId = "me";
let conversations: Session[] = [];
let listPage: ((options: SessionListPageOptions) => object) | null = null;
let fullSessions: Record<string, Session> = {};
let siteDetails: () => Promise<unknown> = async () => ({
  artifact: {
    title: "Opengeni usage",
    status: "active",
    currentVersion: { id: "version-4", revision: 4 },
  },
  versions: [],
  events: [],
});
let hintRefresh: (() => Promise<void>) | null = null;
let hintOptions: { siteConversations?: boolean } | undefined;
const listCalls: SessionListPageOptions[] = [];
const sessionReads: string[] = [];
const navigations: unknown[] = [];
const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
const conversationProps: Array<Record<string, unknown>> = [];
const composerProps: Array<Record<string, unknown>> = [];
const opens: string[] = [];
const siteViewProps: Array<Record<string, unknown>> = [];
const versionMenuProps: Array<Record<string, unknown>> = [];
let siteReads = 0;
/** The Site as read with version `revision` live. */
const siteAt = (revision: number, title = "Opengeni usage") => ({
  artifact: {
    title,
    status: "active",
    currentVersion: { id: `version-${revision}`, revision },
  },
  versions: [],
  events: [],
});
const client = {
  recordSiteOpened: async (_workspace: string, opened: string) => {
    opens.push(opened);
    return { openedAt: new Date().toISOString() };
  },
  listSessionPage: async (_workspace: string, options: SessionListPageOptions) => {
    listCalls.push(options);
    return listPage?.(options) ?? { pinned: [], sessions: conversations, nextCursor: null };
  },
  getSession: async (_workspace: string, sessionId: string) => {
    sessionReads.push(sessionId);
    const session = fullSessions[sessionId];
    if (!session) throw new OpenGeniApiError(404, "");
    return session;
  },
  getWorkspaceArtifact: async () => {
    siteReads++;
    return await siteDetails();
  },
  // The header's published-link read; these tests are about the chat panel,
  // so the link stays the plain "Live" an API without the route gives.
  getSitePublicationLink: async () => {
    throw new OpenGeniApiError(404, "");
  },
};
mock.module("../app-context", () => ({
  useAppContext: () => ({
    client,
    accessContext: { subjectId, workspaceGrants: [{ workspaceId, permissions }] },
  }),
}));
mock.module("../lib/app-api", () => ({
  useAppApi: () => ({
    request: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return { id: id(99) };
    },
  }),
}));
mock.module("../lib/navigation", () => ({
  useNavigate: () => async (options: unknown) => void navigations.push(options),
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
    "aria-label"?: string;
    "aria-current"?: "page";
  }) => (
    <a
      href={JSON.stringify({ to, params, search })}
      aria-label={props["aria-label"]}
      aria-current={props["aria-current"]}
      onClick={(event) => {
        event.preventDefault();
        navigations.push({ to, params, search });
      }}
    >
      {children}
    </a>
  ),
}));
mock.module("../lib/console-site", () => ({
  useConsoleSiteViewer: () => ({ kind: "member", id: "user:me" }),
  useConsoleSiteToolBridge: () => () => undefined,
}));
mock.module("../lib/use-session-list-hint-refresh", () => ({
  useSessionListHintRefresh: (
    refresh: () => Promise<void>,
    _error: unknown,
    options?: { siteConversations?: boolean },
  ) => {
    hintRefresh = refresh;
    hintOptions = options;
  },
}));
mock.module("../../artifacts", () => ({
  SiteView: (props: {
    siteId: string;
    archivedMessage?: string;
    versionId?: string | null;
    versionControl?: ReactNode;
  }) => {
    siteViewProps.push(props);
    return (
      <div
        data-site-view={props.siteId}
        data-version={props.versionId ?? ""}
        data-archived-message={props.archivedMessage}
      >
        {props.versionControl}
      </div>
    );
  },
}));
mock.module("../components/artifacts/site-version-menu", () => ({
  SiteVersionMenu: (props: Record<string, unknown>) => {
    versionMenuProps.push(props);
    return <span data-version-menu="" />;
  },
}));
mock.module("../../components/session-conversation", () => ({
  SessionConversation: (props: { sessionId: string }) => {
    conversationProps.push(props);
    return <div data-conversation={props.sessionId} />;
  },
}));
mock.module("../../components/new-conversation", () => ({
  NewConversation: (props: {
    createSession: (text: string, key: string, options: object) => Promise<string>;
    onCreated: (created: object) => void;
    labels: { title: string };
  }) => {
    composerProps.push(props);
    return (
      <>
        <textarea data-composer-input="" />
        <button
          type="button"
          data-composer={props.labels.title}
          onClick={() =>
            void props
              .createSession("Why did spend rise?", "key-1", { model: "m", resources: ["x"] })
              .then((sessionId) =>
                props.onCreated({
                  sessionId,
                  initialMessage: "Why did spend rise?",
                  sentAt: "2026-10-22T12:00:00.000Z",
                  draft: { text: "and churn?" },
                }),
              )
          }
        >
          Send
        </button>
      </>
    );
  },
}));
mock.module("../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode; asChild?: boolean }) => children,
}));

let module: typeof import("./site-view");
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  module = await import("./site-view");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  permissions = ["sessions:create"];
  subjectId = "me";
  fullSessions = {};
  siteDetails = async () => siteAt(4);
  siteReads = 0;
  siteViewProps.length = 0;
  versionMenuProps.length = 0;
  hintRefresh = null;
  hintOptions = undefined;
  listPage = null;
  listCalls.length = 0;
  sessionReads.length = 0;
  navigations.length = 0;
  requests.length = 0;
  conversationProps.length = 0;
  composerProps.length = 0;
  localStorage.clear();
});

const conversation = (n: number, title: string, minutesAgo: number, site = siteId) =>
  ({
    id: id(n),
    workspaceId,
    title,
    titleSource: "user",
    status: "idle",
    archived: false,
    parentSessionId: null,
    metadata: { _opengeniSiteOrigin: { siteId: site, title: "Opengeni usage" } },
    effectiveControl: { state: "active" },
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  }) as unknown as Session;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

async function render(selected?: string, { startNew }: { startNew?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draw = async (next?: string, nextStartNew = startNew) => {
    await act(async () => {
      root!.render(
        <module.SiteViewRoute
          workspaceId={workspaceId}
          siteId={siteId}
          conversation={next}
          startNew={nextStartNew}
        />,
      );
    });
    await settle();
  };
  await draw(selected);
  return { container, rerender: draw };
}
const openConversation = (container: HTMLElement) =>
  container.querySelector("[data-conversation]")?.getAttribute("data-conversation");
const panel = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("aside[aria-label='Chat']")!;
const heading = (container: HTMLElement) => panel(container).querySelector("h2")?.textContent;
const separator = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[role='separator']")!;
const storageKey = "og.site-view.chat:v1:me";
const press = (element: HTMLElement, key: string, shiftKey = false) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === text);
const link = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("a")].find((element) => element.textContent === text);
const siteRoute = (search: object, replace?: boolean) => ({
  to: "/workspaces/$workspaceId/sites/$siteId",
  params: { workspaceId, siteId },
  search,
  ...(replace === undefined ? {} : { replace }),
});

test("shows the Site with its newest conversation open as a regular chat, without a list", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const { container } = await render();
  expect(container.querySelector("[data-site-view]")?.getAttribute("data-site-view")).toBe(siteId);
  expect(openConversation(container)).toBe(id(1));
  expect(listCalls[0]).toMatchObject({ originSiteId: siteId, parentSessionId: null, limit: 30 });
  expect(listCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  // Updates to Site conversations reach the panel; ordinary ones don't.
  expect(hintOptions).toEqual({ siteConversations: true });
  // The sidebar lists the Site's conversations; the panel doesn't repeat them.
  expect(panel(container).querySelector("nav")).toBeNull();
  // Only the menu's two links; no rows to switch conversations.
  expect(
    [...panel(container).querySelectorAll("a")].filter((a) => !a.closest("[role='menu']")),
  ).toHaveLength(0);
  expect(heading(container)).toBe("Time filters across all graphs");
  // The same chat as a full session, model chip included.
  expect(conversationProps.at(-1)).toMatchObject({ sessionId: id(1), modelPicker: true });
  // Every listed conversation is the Site's own, so no lookup is needed.
  expect(sessionReads).toEqual([]);
});

test("the open conversation stays put when another one becomes newer", async () => {
  conversations = [
    conversation(1, "Time filters across all graphs", 2),
    conversation(2, "Weekly active users by plan", 180),
  ];
  const { container, rerender } = await render();
  expect(openConversation(container)).toBe(id(1));
  // A turn finishes in the other conversation.
  conversations = [
    conversation(2, "Weekly active users by plan", 0),
    conversation(1, "Time filters across all graphs", 2),
  ];
  await act(async () => void (await hintRefresh!()));
  await settle();
  expect(openConversation(container)).toBe(id(1));
  expect(heading(container)).toBe("Time filters across all graphs");
  // Coming back to the Site itself (its rail row) opens the newest again.
  await rerender(id(1));
  await rerender(undefined);
  expect(openConversation(container)).toBe(id(2));
  expect(heading(container)).toBe("Weekly active users by plan");
});

test("opening the Site records it once, so its sidebar row moves up", async () => {
  conversations = [];
  opens.length = 0;
  let announced = 0;
  const listener = () => announced++;
  window.addEventListener("opengeni:site-opened", listener);
  try {
    await render();
    expect(opens).toEqual([siteId]);
    expect(announced).toBe(1);
  } finally {
    window.removeEventListener("opengeni:site-opened", listener);
  }
});

test("a chosen conversation is the one open", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const { container } = await render(id(2));
  expect(openConversation(container)).toBe(id(2));
  expect(heading(container)).toBe("Weekly active users by plan");
});

test("an older conversation of this Site, beyond the first page, stays open", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  fullSessions = { [id(7)]: conversation(7, "Spring pricing review", 60 * 24 * 90) };
  const { container } = await render(id(7));
  expect(sessionReads).toEqual([id(7)]);
  expect(openConversation(container)).toBe(id(7));
  // Named once read, though it isn't among the newest.
  expect(heading(container)).toBe("Spring pricing review");
  expect(navigations).toEqual([]);
});

test("a link to another Site's conversation, a sub-agent or an archived one falls back to the Site", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  fullSessions = {
    [id(5)]: conversation(5, "Another Site's chat", 10, otherSiteId),
    [id(6)]: { ...conversation(6, "A spawned helper", 10), parentSessionId: id(1) } as Session,
    [id(8)]: { ...conversation(8, "Archived", 10), archived: true } as Session,
  };
  for (const foreign of [id(5), id(6), id(8)]) {
    await render(foreign);
    expect(navigations.at(-1)).toEqual(siteRoute({}, true));
    act(() => root?.unmount());
  }
  expect(sessionReads).toEqual([id(5), id(6), id(8)]);
});

test("a link to a conversation that no longer exists falls back to the Site", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container, rerender } = await render(id(9));
  expect(navigations).toEqual([siteRoute({}, true)]);
  await rerender(undefined);
  expect(openConversation(container)).toBe(id(1));
});

test("a new conversation is created as the Site's own, then opened with its first prompt", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container, rerender } = await render(id(1));
  const newButton = button(container, "New")!;
  // New is an action, not a toggle.
  expect(newButton.hasAttribute("aria-pressed")).toBe(false);
  await act(async () => newButton.click());
  // Nothing is selected while composing.
  expect(navigations).toEqual([siteRoute({})]);
  await rerender(undefined);
  const composer = container.querySelector<HTMLButtonElement>("[data-composer]")!;
  expect(composer.getAttribute("data-composer")).toBe("Ask about Opengeni usage");
  // The composer's headline says what to do; the header only names it for
  // screen readers.
  expect(panel(container).querySelector("h2 .sr-only")?.textContent).toBe("New conversation");
  // The regular composer with its model chip; a Site doesn't offer voice-first
  // chats, and its create request carries no files.
  expect(composerProps.at(-1)).toMatchObject({
    modelPicker: true,
    attachments: false,
    realtimeVoice: false,
  });
  await act(async () => {
    composer.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.path).toBe(`/v1/workspaces/${workspaceId}/sessions`);
  expect(requests[0]!.init?.method).toBe("POST");
  expect(requests[0]!.init?.headers).toEqual({
    "x-opengeni-site-id": siteId,
    "x-opengeni-site-version": "version-4",
  });
  // Only what a Site may set: no attachments or other session fields.
  expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
    initialMessage: "Why did spend rise?",
    idempotencyKey: "key-1",
    model: "m",
  });
  expect(navigations.at(-1)).toEqual(siteRoute({ conversation: id(99) }));
  fullSessions = { [id(99)]: conversation(99, "Why did spend rise?", 0) };
  await rerender(id(99));
  expect(openConversation(container)).toBe(id(99));
  // The sent prompt shows at once and anything typed meanwhile carries over.
  expect(conversationProps.at(-1)).toMatchObject({
    sessionId: id(99),
    pendingPrompt: { text: "Why did spend rise?", sentAt: "2026-10-22T12:00:00.000Z" },
    composerOptions: { initialDraft: { text: "and churn?" } },
  });
  // Only for its first open.
  await rerender(id(1));
  await rerender(id(99));
  expect(conversationProps.at(-1)?.pendingPrompt).toBeUndefined();
});

test("choosing a conversation ends composing", async () => {
  conversations = [
    conversation(1, "Time filters across all graphs", 2),
    conversation(2, "Weekly active users by plan", 180),
  ];
  const { container, rerender } = await render();
  await act(async () => button(container, "New")!.click());
  expect(container.querySelector("[data-composer]")).not.toBeNull();
  expect(openConversation(container)).toBeUndefined();
  await rerender(id(2));
  expect(container.querySelector("[data-composer]")).toBeNull();
  expect(openConversation(container)).toBe(id(2));
});

test("the menu opens the conversation as a full chat or the Site's details", async () => {
  permissions = ["sessions:create", "artifacts:publish"];
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container } = await render();
  await act(async () => link(container, "Open as a full chat")!.click());
  await act(async () => link(container, "Site details")!.click());
  expect(navigations).toEqual([
    {
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId: id(1) },
    },
    {
      to: "/workspaces/$workspaceId/artifacts/$artifactId",
      params: { workspaceId, artifactId: siteId },
      // Without a tab the address opens the Site view again.
      search: { tab: "settings" },
    },
  ]);
  expect(container.querySelector("[data-site-view]")?.getAttribute("data-archived-message")).toBe(
    "This Site is archived. Restore it from Site details.",
  );
});

test("an archived Site links to its details, where it can be restored", async () => {
  permissions = ["sessions:create", "artifacts:publish"];
  conversations = [];
  siteDetails = async () => ({
    ...siteAt(4),
    artifact: { ...siteAt(4).artifact, status: "archived" },
  });
  const { container } = await render();
  expect(container.querySelector("[data-site-view]")).toBeNull();
  expect(container.textContent).toContain("This Site is archived.");
  await act(async () => link(container, "Restore it from Site details")!.click());
  expect(navigations.at(-1)).toEqual({
    to: "/workspaces/$workspaceId/artifacts/$artifactId",
    params: { workspaceId, artifactId: siteId },
    search: { tab: "settings" },
  });
});

test("someone who can't restore an archived Site isn't told to restore it", async () => {
  conversations = [];
  siteDetails = async () => ({
    ...siteAt(4),
    artifact: { ...siteAt(4).artifact, status: "archived" },
  });
  const { container } = await render();
  expect(container.textContent).toContain("This Site is archived.");
  expect(container.textContent).not.toContain("Restore");
  await act(async () => link(container, "View Site details")!.click());
  // Without a tab the address opens the Site view again; details pick the
  // first tab this person can see.
  expect(navigations.at(-1)).toEqual({
    to: "/workspaces/$workspaceId/artifacts/$artifactId",
    params: { workspaceId, artifactId: siteId },
    search: { tab: "settings" },
  });
});

test("without permission to start chats there is no New, and an empty Site says so", async () => {
  permissions = [];
  conversations = [];
  const { container } = await render();
  expect(button(container, "New")).toBeUndefined();
  expect(container.querySelector("[data-composer]")).toBeNull();
  expect(container.textContent).toContain("No conversations yet.");
});

test("an empty Site waits for its details, and offers to retry when they fail", async () => {
  conversations = [];
  let release: (() => void) | undefined;
  siteDetails = () => new Promise((_resolve, reject) => (release = () => reject(new Error("x"))));
  const { container } = await render();
  expect(container.textContent).toContain("Loading Site");
  expect(container.textContent).not.toContain("No conversations yet.");
  await act(async () => release!());
  await settle();
  expect(container.textContent).toContain("Couldn’t load this Site.");
  siteDetails = async () => siteAt(4);
  await act(async () => button(container, "Try again")!.click());
  await settle();
  expect(container.querySelector("[data-composer]")).not.toBeNull();
});

test("the panel's width is remembered per person and resized from the keyboard", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 512, collapsed: false }));
  const { container } = await render();
  const handle = separator(container);
  expect(handle.getAttribute("aria-label")).toBe("Resize chat");
  expect(handle.getAttribute("aria-controls")).toBe(panel(container).id);
  expect(handle.getAttribute("aria-valuenow")).toBe("512");
  expect(handle.getAttribute("aria-valuemin")).toBe("320");
  expect(handle.getAttribute("aria-valuemax")).toBe("720");
  expect(panel(container).style.getPropertyValue("--og-site-chat-width")).toBe("512px");
  // The handle is on the panel's left edge: Left widens it.
  await press(handle, "ArrowLeft");
  expect(separator(container).getAttribute("aria-valuenow")).toBe("528");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ width: 528, collapsed: false });
  await press(separator(container), "ArrowRight", true);
  expect(separator(container).getAttribute("aria-valuenow")).toBe("464");
  await press(separator(container), "Home");
  expect(separator(container).getAttribute("aria-valuenow")).toBe("320");
  await press(separator(container), "End");
  expect(separator(container).getAttribute("aria-valuenow")).toBe("720");
  expect(JSON.parse(localStorage.getItem(storageKey)!).width).toBe(720);
});

test("a stored width outside the limits is brought back within them", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 4000 }));
  const { container } = await render();
  expect(separator(container).getAttribute("aria-valuenow")).toBe("720");
});

test("the chat can be hidden and shown again, and stays as it was left", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container } = await render();
  const hide = container.querySelector<HTMLButtonElement>("button[aria-label='Hide chat']")!;
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  await act(async () => hide.click());
  // Hidden, not unmounted: the conversation keeps its place.
  expect(panel(container).hidden).toBe(true);
  expect(openConversation(container)).toBe(id(1));
  const show = container.querySelector<HTMLButtonElement>("button[aria-label='Show chat']")!;
  expect(show.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(show);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ width: 400, collapsed: true });
  // Opening another Site, or this one later, keeps it hidden.
  act(() => root?.unmount());
  const again = await render();
  expect(panel(again.container).hidden).toBe(true);
  await act(async () =>
    again.container.querySelector<HTMLButtonElement>("button[aria-label='Show chat']")!.click(),
  );
  expect(panel(again.container).hidden).toBe(false);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Hide chat");
  expect(JSON.parse(localStorage.getItem(storageKey)!).collapsed).toBe(false);
  // Enter on the handle hides it too, as a window splitter collapses its pane.
  await press(separator(again.container), "Enter");
  expect(panel(again.container).hidden).toBe(true);
});

test("choosing a conversation shows a hidden chat; opening the page keeps it hidden", async () => {
  conversations = [
    conversation(1, "Time filters across all graphs", 2),
    conversation(2, "Weekly active users by plan", 180),
  ];
  localStorage.setItem(storageKey, JSON.stringify({ width: 400, collapsed: true }));
  const { container, rerender } = await render(id(1));
  expect(panel(container).hidden).toBe(true);
  // The sidebar is where conversations are chosen now.
  await rerender(id(2));
  expect(panel(container).hidden).toBe(false);
  expect(openConversation(container)).toBe(id(2));
  expect(JSON.parse(localStorage.getItem(storageKey)!).collapsed).toBe(false);
  // Back to the Site itself: it stays as the person left it.
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-label='Hide chat']")!.click(),
  );
  await rerender(undefined);
  expect(panel(container).hidden).toBe(true);
});

test("the chat never takes the room the Site needs, unless the window is narrower still", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 720, collapsed: false }));
  const measure = HTMLElement.prototype.getBoundingClientRect;
  let frameWidth = 900;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return { ...measure.call(this).toJSON(), width: frameWidth } as DOMRect;
  };
  try {
    // 900px leaves 540 beside the Site's 360.
    let view = await render();
    expect(separator(view.container).getAttribute("aria-valuemax")).toBe("540");
    expect(separator(view.container).getAttribute("aria-valuenow")).toBe("540");
    expect(panel(view.container).style.getPropertyValue("--og-site-chat-width")).toBe("540px");
    // The stored choice is kept for a wider window.
    expect(JSON.parse(localStorage.getItem(storageKey)!).width).toBe(720);
    act(() => root?.unmount());
    // Narrower than both: the chat keeps its minimum.
    frameWidth = 500;
    view = await render();
    expect(separator(view.container).getAttribute("aria-valuemax")).toBe("320");
    act(() => root?.unmount());
    // Not laid out yet: only the chat's own limit applies.
    frameWidth = 0;
    view = await render();
    expect(separator(view.container).getAttribute("aria-valuemax")).toBe("720");
  } finally {
    HTMLElement.prototype.getBoundingClientRect = measure;
  }
});

test("another person signing in on the page gets their own layout", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 512, collapsed: false }));
  localStorage.setItem(
    "og.site-view.chat:v1:someone",
    JSON.stringify({ width: 336, collapsed: true }),
  );
  const { container, rerender } = await render();
  expect(separator(container).getAttribute("aria-valuenow")).toBe("512");
  subjectId = "someone";
  await rerender(undefined);
  expect(panel(container).hidden).toBe(true);
  expect(separator(container).getAttribute("aria-valuenow")).toBe("336");
  // And what they change is saved as theirs.
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-label='Show chat']")!.click(),
  );
  expect(JSON.parse(localStorage.getItem("og.site-view.chat:v1:someone")!).collapsed).toBe(false);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ width: 512, collapsed: false });
});

const shownVersion = (container: HTMLElement) =>
  container.querySelector("[data-site-view]")?.getAttribute("data-version");

test("a publish from the side chat reloads the preview with the new version", async () => {
  conversations = [conversation(1, "Make the header blue", 2)];
  const { container } = await render();
  expect(shownVersion(container)).toBe("version-4");
  expect(siteViewProps.at(-1)).toMatchObject({ versionId: "version-4", watch: "live" });
  const onEvent = conversationProps.at(-1)!.onEvent as (event: { type: string }) => void;
  // The agent publishes version 5; its tool call returns in this conversation.
  siteDetails = async () => siteAt(5);
  const before = siteReads;
  await act(async () => onEvent({ type: "agent.toolCall.output" }));
  await settle();
  expect(siteReads).toBe(before + 1);
  expect(shownVersion(container)).toBe("version-5");
  // The chip follows, with the version now live.
  expect(
    (versionMenuProps.at(-1)!.detail as ReturnType<typeof siteAt>).artifact.currentVersion,
  ).toEqual({ id: "version-5", revision: 5 });
  // Streaming text changes nothing, so it reads nothing.
  await act(async () => onEvent({ type: "agent.message.delta" }));
  await settle();
  expect(siteReads).toBe(before + 1);
});

test("a rollback restored from the version chip reloads the preview", async () => {
  conversations = [conversation(1, "Make the header blue", 2)];
  siteDetails = async () => siteAt(5);
  const { container } = await render();
  expect(shownVersion(container)).toBe("version-5");
  siteDetails = async () => siteAt(4);
  await act(async () => (versionMenuProps.at(-1)!.onRestored as () => void)());
  await settle();
  expect(shownVersion(container)).toBe("version-4");
});

test("the chip offers Undo only to people who may publish the Site", async () => {
  conversations = [];
  await render();
  expect(versionMenuProps.at(-1)).toMatchObject({ workspaceId, siteId, canPublish: false });
  act(() => root?.unmount());
  permissions = ["sessions:create", "artifacts:publish"];
  await render();
  expect(versionMenuProps.at(-1)).toMatchObject({ canPublish: true });
});

test("a version published elsewhere shows within a few seconds while the Site is open", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  permissions = ["sessions:create", "artifacts:publish"];
  const intervals: Array<{ run: () => void; ms: number }> = [];
  const setIntervalBefore = window.setInterval;
  window.setInterval = ((run: () => void, ms: number) => {
    intervals.push({ run, ms });
    return intervals.length;
  }) as unknown as typeof window.setInterval;
  try {
    const { container } = await render();
    expect(shownVersion(container)).toBe("version-4");
    const poll = intervals.find((interval) => interval.ms === 5_000)!;
    expect(poll).toBeDefined();
    siteDetails = async () => siteAt(6);
    await act(async () => poll.run());
    await settle();
    expect(shownVersion(container)).toBe("version-6");
    // The context of the next message names the version now live.
    const sendExtras = (conversationProps.at(-1)!.composerOptions as { sendExtras: () => object })
      .sendExtras;
    expect(sendExtras()).toEqual({
      modelContext: expect.stringContaining("at version 6 (version id version-6)"),
    });
  } finally {
    window.setInterval = setIntervalBefore;
  }
});

test("a failed check says the Site is reconnecting, and the next one makes it live again", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container } = await render();
  const onEvent = conversationProps.at(-1)!.onEvent as (event: { type: string }) => void;
  siteDetails = async () => {
    throw new Error("offline");
  };
  await act(async () => onEvent({ type: "turn.completed" }));
  await settle();
  expect(siteViewProps.at(-1)).toMatchObject({ watch: "reconnecting" });
  // What was shown stays shown.
  expect(shownVersion(container)).toBe("version-4");
  siteDetails = async () => siteAt(4);
  await act(async () => window.dispatchEvent(new Event("online")));
  await settle();
  expect(siteViewProps.at(-1)).toMatchObject({ watch: "live" });
});

test("every message in the side chat says which Site and version it is about", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  permissions = ["sessions:create", "artifacts:publish"];
  siteDetails = async () => siteAt(4, "Spend  dashboard");
  await render();
  const { sendExtras } = conversationProps.at(-1)!.composerOptions as {
    sendExtras: () => { modelContext?: string };
  };
  const context = sendExtras().modelContext!;
  expect(context).toContain(`“Spend dashboard” (Site id ${siteId})`);
  expect(context).toContain("at version 4 (version id version-4)");
  expect(context).toContain("publish the change as a new version of this Site");
});

test("someone who can't publish the Site gets no editing context, as from the API", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  await render();
  const { sendExtras } = conversationProps.at(-1)!.composerOptions as {
    sendExtras: () => { modelContext?: string };
  };
  expect(sendExtras()).toEqual({});
});

test("Edit with Opengeni opens a new conversation beside the Site, composer focused", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  // Even with the chat hidden last time.
  localStorage.setItem(storageKey, JSON.stringify({ width: 400, collapsed: true }));
  const { container } = await render(undefined, { startNew: true });
  await settle();
  expect(panel(container).hidden).toBe(false);
  expect(container.querySelector("[data-composer]")).not.toBeNull();
  expect(openConversation(container)).toBeUndefined();
  expect(document.activeElement?.hasAttribute("data-composer-input")).toBe(true);
  // The address drops the request, so going back or reloading doesn't repeat it.
  expect(navigations).toEqual([siteRoute({}, true)]);
});

test("Edit with Opengeni waits for the Site before focusing the composer", async () => {
  conversations = [];
  let release: (() => void) | undefined;
  siteDetails = () => new Promise((resolve) => (release = () => resolve(siteAt(4))));
  const { container } = await render(undefined, { startNew: true });
  expect(container.textContent).toContain("Loading Site");
  await act(async () => release!());
  await settle();
  await settle();
  expect(document.activeElement?.hasAttribute("data-composer-input")).toBe(true);
});

test("Edit with Opengeni on a Site already open starts a new conversation once", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container, rerender } = await render(id(1));
  expect(openConversation(container)).toBe(id(1));
  await rerender(id(1), true);
  expect(container.querySelector("[data-composer]")).not.toBeNull();
  expect(navigations).toEqual([siteRoute({}, true)]);
  // Until the address drops the request, rendering again asks nothing more.
  await rerender(id(1), true);
  expect(navigations).toHaveLength(1);
});
