import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { act, createContext, useContext, type ReactNode } from "react";
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
  // The header's published-link read: an API without the route (404) unless
  // a test publishes the Site.
  getSitePublicationLink: async () => await publicationLink(),
};
let publicationLink: () => Promise<unknown> = async () => {
  throw new OpenGeniApiError(404, "");
};
const notPublished = async () => {
  throw new OpenGeniApiError(404, JSON.stringify({ error: { code: "site_not_published" } }));
};
const published = {
  siteId,
  hostname: "usage-4k9x.sites.example",
  url: "https://usage-4k9x.sites.example/",
  status: "active",
};
const publishPageProps: Array<Record<string, unknown>> = [];
const managementArgs: Array<Record<string, unknown>> = [];
const publications: unknown[] = [];
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
  useSearch: () => ({}),
  useStringifySearch: () => () => "",
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
    liveStatus?: ReactNode;
    fullScreen?: boolean;
  }) => {
    siteViewProps.push(props);
    return (
      <div
        data-site-view={props.siteId}
        data-version={props.versionId ?? ""}
        data-archived-message={props.archivedMessage}
        data-full-screen={String(props.fullScreen)}
      >
        {props.versionControl}
        <div data-live-status-slot="">{props.liveStatus}</div>
      </div>
    );
  },
}));
// The Site's own publish form and its management, as the Settings tab uses
// them; the form's own behaviour is tested with it.
mock.module("../components/artifacts/site-settings", () => ({
  useSiteManagement: (args: Record<string, unknown>) => {
    managementArgs.push(args);
    return {
      canPublish: true,
      isAdmin: false,
      manageData: true,
      workspaceName: "Acme",
      showAudience: true,
      publication: {
        load: { state: "none" },
        reload: async () => {},
        setPublication: (next: unknown) => publications.push(next),
      },
      audience: { share: undefined, dialog: <div data-audience-dialog="" /> },
    };
  },
}));
mock.module("../components/artifacts/site-publishing", () => ({
  SitePublishPage: (props: Record<string, unknown>) => {
    publishPageProps.push(props);
    const publish = () => {
      (props.onPublication as (next: unknown) => void)({ ...published, access: "members" });
      (props.onSubmitted as () => void)();
    };
    return (
      <form data-publish-page={String(props.layout)}>
        {/* As FormPage's title: focusable from script only. */}
        <h1 tabIndex={-1}>Publish to web</h1>
        <button type="button" onClick={publish}>
          Publish now
        </button>
        <button type="button" onClick={props.onBack as () => void}>
          Back to the Site
        </button>
      </form>
    );
  },
}));
mock.module("../components/artifacts/site-version-menu", () => ({
  SiteVersionMenu: (props: Record<string, unknown>) => {
    versionMenuProps.push(props);
    return <span data-version-menu="" />;
  },
}));
// The regular chat route and new-chat composer; their own tests cover them.
// Here the panel's file drop target stands in for the chat's, so drops on
// the Site can be followed to it.
let dropped: File[] = [];
mock.module("./session", () => ({
  SessionRoute: (props: { sessionId: string }) => {
    conversationProps.push(props);
    return (
      <ChatViewportFileDropTarget
        data-workspace-scroll-owner="self-managed"
        enabled
        onFiles={(files) => (dropped = [...dropped, ...files])}
      >
        <div data-conversation={props.sessionId} />
      </ChatViewportFileDropTarget>
    );
  },
}));
mock.module("../components/session/console-new-conversation", () => ({
  ConsoleNewConversation: (props: {
    createSession: (text: string, key: string, options: object) => Promise<string>;
    onCreated: (created: object) => void;
    title: string;
  }) => {
    composerProps.push(props);
    return (
      <>
        <textarea data-composer-input="" />
        <button
          type="button"
          data-composer={props.title}
          onClick={() =>
            void props
              .createSession("Why did spend rise?", "key-1", {
                model: "m",
                resources: [{ kind: "file", fileId: "f-1" }],
              })
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
// The menu renders open; selecting a row closes it as Radix does, calling the
// content's onCloseAutoFocus unless the row kept the menu open.
const MenuClosed = createContext<((event: Event) => void) | undefined>(undefined);
function MockMenuItem({
  children,
  asChild,
  onSelect,
}: {
  children: ReactNode;
  asChild?: boolean;
  onSelect?: (event: Event) => void;
}) {
  const closed = useContext(MenuClosed);
  return asChild || !onSelect ? (
    children
  ) : (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        onSelect(event.nativeEvent);
        if (!event.nativeEvent.defaultPrevented) closed?.(new Event("focus", { cancelable: true }));
      }}
    >
      {children}
    </button>
  );
}
mock.module("../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: Event) => void;
  }) => (
    <MenuClosed.Provider value={onCloseAutoFocus}>
      <div role="menu">{children}</div>
    </MenuClosed.Provider>
  ),
  DropdownMenuItem: MockMenuItem,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DropdownMenuSeparator: () => <hr />,
}));
// The Site view loads its publish page through the Artifacts route; here that
// route is only the real page (over the mocked form and management above).
let publishingPage: typeof import("../components/artifacts/site-publishing-page");
mock.module("./artifacts", () => ({
  SitePublishingPage: (props: Parameters<typeof publishingPage.SitePublishingPage>[0]) => (
    <publishingPage.SitePublishingPage {...props} />
  ),
}));

let module: typeof import("./site-view");
let ChatViewportFileDropTarget: typeof import("../components/session/chat-viewport-file-drop-target").ChatViewportFileDropTarget;
let ownsDom = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  publishingPage = await import("../components/artifacts/site-publishing-page");
  ({ ChatViewportFileDropTarget } =
    await import("../components/session/chat-viewport-file-drop-target"));
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
  publicationLink = async () => {
    throw new OpenGeniApiError(404, "");
  };
  publishPageProps.length = 0;
  managementArgs.length = 0;
  publications.length = 0;
  hintRefresh = null;
  hintOptions = undefined;
  listPage = null;
  listCalls.length = 0;
  sessionReads.length = 0;
  navigations.length = 0;
  requests.length = 0;
  conversationProps.length = 0;
  composerProps.length = 0;
  dropped = [];
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
  // The regular chat route, laid out for a narrow panel.
  expect(conversationProps.at(-1)).toMatchObject({
    workspaceId,
    sessionId: id(1),
    placement: "panel",
  });
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
  expect(composerProps.at(-1)).toMatchObject({ workspaceId, title: "Ask about Opengeni usage" });
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
  // What a Site's own chat may set, and the person's attached files.
  const body = JSON.parse(String(requests[0]!.init?.body));
  expect(body).toEqual({
    initialMessage: "Why did spend rise?",
    clientEventId: expect.any(String),
    idempotencyKey: "key-1",
    resources: [{ kind: "file", fileId: "f-1" }],
    model: "m",
  });
  expect(navigations.at(-1)).toEqual(siteRoute({ conversation: id(99) }));
  fullSessions = { [id(99)]: conversation(99, "Why did spend rise?", 0) };
  await rerender(id(99));
  expect(openConversation(container)).toBe(id(99));
  // The sent prompt shows at once, as the message the chat will receive, and
  // anything typed meanwhile carries over.
  expect(conversationProps.at(-1)).toMatchObject({
    sessionId: id(99),
    creationHandoff: { session: { id: id(99) }, clientEventId: body.clientEventId },
    initialDraft: { text: "and churn?" },
  });
  // Only for its first open.
  await rerender(id(1));
  await rerender(id(99));
  expect(conversationProps.at(-1)?.creationHandoff).toBeNull();
  expect(conversationProps.at(-1)?.initialDraft).toBeUndefined();
});

test("a retried create keeps its first message's identity", async () => {
  conversations = [];
  const { container } = await render(undefined, { startNew: true });
  const send = async () =>
    act(async () => {
      container.querySelector<HTMLButtonElement>("[data-composer]")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  await send();
  await send();
  const [first, second] = requests.map((request) => JSON.parse(String(request.init?.body)));
  expect(first.idempotencyKey).toBe(second.idempotencyKey);
  expect(first.clientEventId).toBe(second.clientEventId);
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
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    width: 528,
    collapsed: false,
    position: "right",
  });
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
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    width: 400,
    collapsed: true,
    position: "right",
  });
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
    const messageContext = conversationProps.at(-1)!.messageContext as () => string | undefined;
    expect(messageContext()).toContain("at version 6 (version id version-6)");
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
  const context = (conversationProps.at(-1)!.messageContext as () => string | undefined)()!;
  expect(context).toContain(`“Spend dashboard” (Site id ${siteId})`);
  expect(context).toContain("at version 4 (version id version-4)");
  expect(context).toContain("publish the change as a new version of this Site");
});

test("someone who can't publish the Site gets no editing context, as from the API", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  await render();
  expect((conversationProps.at(-1)!.messageContext as () => string | undefined)()).toBeUndefined();
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

const publicationSlot = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-live-status-slot]")!;
const siteHidden = (container: HTMLElement) =>
  container.querySelector("[data-site-view]")!.parentElement!.classList.contains("hidden");

test("an unpublished Site offers Publish, which opens its publish form beside the chat", async () => {
  conversations = [conversation(1, "Make the header blue", 2)];
  permissions = ["sessions:create", "artifacts:publish"];
  publicationLink = notPublished;
  const { container } = await render();
  expect(publicationSlot(container).textContent).toBe("Publish");
  expect(container.querySelector("[data-publish-page]")).toBeNull();

  await act(async () => button(container, "Publish")!.click());
  // The form's code loads when it opens.
  await settle();
  // The Site's own publish form, as a page in place of the Site; the Site
  // stays mounted behind it and the chat stays beside it.
  expect(container.querySelector("[data-publish-page]")?.getAttribute("data-publish-page")).toBe(
    "page",
  );
  // Focus moves into the form: the button that opened it is hidden now.
  expect(document.activeElement?.textContent).toBe("Publish to web");
  expect(siteHidden(container)).toBe(true);
  expect(container.querySelector("[data-site-view]")).not.toBeNull();
  expect(openConversation(container)).toBe(id(1));
  expect(managementArgs.at(-1)).toMatchObject({ workspaceId, siteId });
  expect(publishPageProps.at(-1)).toMatchObject({
    workspaceId,
    workspaceName: "Acme",
    canManage: true,
    isAdmin: false,
    personalWorkspace: false,
    site: { title: "Opengeni usage" },
    load: { state: "none" },
  });
  expect(container.querySelector("[data-audience-dialog]")).not.toBeNull();

  // Publishing returns to the Site, which now says Published at once.
  await act(async () => button(container, "Publish now")!.click());
  await settle();
  expect(container.querySelector("[data-publish-page]")).toBeNull();
  expect(siteHidden(container)).toBe(false);
  expect(publications).toHaveLength(1);
  expect(publicationSlot(container).textContent).toContain("Published");
  expect(publicationSlot(container).textContent).toContain("usage-4k9x.sites.example");
  // Focus goes back to the control that opened the form.
  expect(document.activeElement?.getAttribute("data-site-publication")).toBe("published");
});

test("a published Site's settings open the same form; its back link returns to the Site", async () => {
  conversations = [];
  permissions = ["sessions:create", "artifacts:publish"];
  publicationLink = async () => published;
  const { container } = await render();
  const slot = publicationSlot(container);
  expect(slot.textContent).toContain("Published");
  expect(slot.querySelector("a")?.getAttribute("href")).toBe("https://usage-4k9x.sites.example/");

  // From full screen, the form first leaves it.
  await act(async () =>
    (siteViewProps.at(-1)!.onFullScreenChange as (next: boolean) => void)(true),
  );
  expect(siteViewProps.at(-1)!.fullScreen).toBe(true);
  await act(async () => button(container, "Publishing settings")!.click());
  await settle();
  expect(siteViewProps.at(-1)!.fullScreen).toBe(false);
  expect(container.querySelector("[data-publish-page]")).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Publish to web");

  await act(async () => button(container, "Back to the Site")!.click());
  expect(container.querySelector("[data-publish-page]")).toBeNull();
  expect(siteHidden(container)).toBe(false);
  expect(publications).toHaveLength(0);
  expect(document.activeElement?.getAttribute("data-site-publication")).toBe("published");
});

test("people who can't publish see Published and its address, with no Publish or settings", async () => {
  conversations = [];
  publicationLink = async () => published;
  const { container } = await render();
  expect(publicationSlot(container).textContent).toContain("Published");
  expect(button(container, "Publishing settings")).toBeUndefined();
  act(() => root?.unmount());
  publicationLink = notPublished;
  const next = await render();
  expect(publicationSlot(next.container).textContent).toBe("");
  expect(managementArgs).toHaveLength(0);
});

test("the header never says Live, also where publishing isn't available", async () => {
  conversations = [];
  permissions = ["sessions:create", "artifacts:publish"];
  const { container } = await render();
  // A replacement is always given, so the frame's plain "Live" never shows.
  expect(siteViewProps.at(-1)!.liveStatus).toBeDefined();
  expect(publicationSlot(container).textContent).toBe("");
});

const menuItem = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find(
    (element) => element.textContent === text,
  );
const layoutRoot = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-site-chat-position]")!;

test("the chat moves to the left from its menu, and stays there for this person", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 512, collapsed: false }));
  const { container } = await render();
  // On the right by default.
  expect(layoutRoot(container).getAttribute("data-site-chat-position")).toBe("right");
  expect(layoutRoot(container).className).not.toContain("lg:flex-row-reverse");
  expect(panel(container).className).toContain("lg:border-l");
  expect(menuItem(container, "Move chat to right")).toBeUndefined();
  const site = container.querySelector("[data-site-view]");
  const chat = container.querySelector("[data-conversation]");
  await act(async () => menuItem(container, "Move chat to left")!.click());
  expect(layoutRoot(container).getAttribute("data-site-chat-position")).toBe("left");
  // The page only reverses: neither the Site nor the chat is drawn again.
  expect(layoutRoot(container).className).toContain("lg:flex-row-reverse");
  expect(container.querySelector("[data-site-view]")).toBe(site);
  expect(container.querySelector("[data-conversation]")).toBe(chat);
  expect(panel(container).getAttribute("data-position")).toBe("left");
  expect(panel(container).className).toContain("lg:border-r");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    width: 512,
    collapsed: false,
    position: "left",
  });
  // The handle is now on the panel's right edge, toward the Site: Right widens it.
  await press(separator(container), "ArrowRight");
  expect(separator(container).getAttribute("aria-valuenow")).toBe("528");
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
    width: 528,
    position: "left",
  });
  // Hiding and showing keep it on the left.
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button[aria-label='Hide chat']")!.click(),
  );
  expect(panel(container).hidden).toBe(true);
  const show = container.querySelector<HTMLButtonElement>("button[aria-label='Show chat']")!;
  expect(show.parentElement!.parentElement!.className).toContain("lg:border-r");
  await act(async () => show.click());
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    width: 528,
    collapsed: false,
    position: "left",
  });
  // Another visit opens it on the left, and the menu offers the way back.
  act(() => root?.unmount());
  const again = await render();
  expect(layoutRoot(again.container).getAttribute("data-site-chat-position")).toBe("left");
  await act(async () => menuItem(again.container, "Move chat to right")!.click());
  expect(layoutRoot(again.container).getAttribute("data-site-chat-position")).toBe("right");
  expect(JSON.parse(localStorage.getItem(storageKey)!).position).toBe("right");
});

function fireFileDrag(
  target: Element,
  type: "dragenter" | "dragover" | "dragleave" | "drop" | "dragend",
  files: File[],
) {
  const list = Object.assign([...files], { item: (index: number) => files[index] ?? null });
  const event = new DragEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: list, dropEffect: "none" },
  });
  target.dispatchEvent(event);
  return event;
}
const cover = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-testid='chat-file-drop-cover']");
const chatOverlay = (container: HTMLElement) =>
  container.querySelector("[data-testid='chat-viewport-drop-overlay']");

test("a screenshot dropped on the Site goes to the chat, not the Site's frame", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container } = await render();
  const shot = new File(["png"], "Screenshot.png", { type: "image/png" });
  // Nothing covers the Site until files are dragged over the page.
  expect(cover(container)).toBeNull();
  await act(async () => void fireFileDrag(document.body, "dragenter", [shot]));
  const over = cover(container)!;
  expect(over).not.toBeNull();
  // The cover lies over the Site, in its column.
  expect(over.parentElement!.contains(container.querySelector("[data-site-view]"))).toBe(true);
  let event: DragEvent | undefined;
  await act(async () => void (event = fireFileDrag(over, "dragover", [shot])));
  // Accepted here, so the browser neither opens the file nor hands it to the frame…
  expect(event!.defaultPrevented).toBe(true);
  // …and the chat shows it will take it.
  expect(chatOverlay(container)).not.toBeNull();
  await act(async () => void (event = fireFileDrag(over, "drop", [shot])));
  expect(event!.defaultPrevented).toBe(true);
  expect(dropped.map((file) => file.name)).toEqual(["Screenshot.png"]);
  expect(chatOverlay(container)).toBeNull();
  expect(cover(container)).toBeNull();
});

test("a drag that leaves the Site clears the chat's highlight; text drags are left alone", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const { container } = await render();
  const shot = new File(["png"], "Screenshot.png", { type: "image/png" });
  await act(async () => void fireFileDrag(document.body, "dragenter", [shot]));
  await act(async () => void fireFileDrag(cover(container)!, "dragover", [shot]));
  expect(chatOverlay(container)).not.toBeNull();
  await act(async () => void fireFileDrag(cover(container)!, "dragleave", [shot]));
  expect(chatOverlay(container)).toBeNull();
  await act(async () => void fireFileDrag(document.body, "dragend", [shot]));
  expect(cover(container)).toBeNull();
  // Selected text dragged over the page doesn't cover the Site.
  const text = new DragEvent("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(text, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
  await act(async () => void document.body.dispatchEvent(text));
  expect(cover(container)).toBeNull();
});

test("with the chat hidden, or no chat to take files, the Site keeps its drops", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  localStorage.setItem(storageKey, JSON.stringify({ width: 400, collapsed: true }));
  const shot = new File(["png"], "Screenshot.png", { type: "image/png" });
  const hidden = await render();
  await act(async () => void fireFileDrag(document.body, "dragenter", [shot]));
  expect(cover(hidden.container)).toBeNull();
  act(() => root?.unmount());
  document.body.innerHTML = "";
  // Someone who can't start chats, on a Site without any.
  localStorage.clear();
  permissions = [];
  conversations = [];
  const empty = await render();
  await act(async () => void fireFileDrag(document.body, "dragenter", [shot]));
  expect(cover(empty.container)).toBeNull();
});
