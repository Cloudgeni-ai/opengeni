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
let conversations: Session[] = [];
let listPage: ((options: SessionListPageOptions) => object) | null = null;
let fullSessions: Record<string, Session> = {};
let siteDetails: () => Promise<unknown> = async () => ({
  artifact: { title: "Opengeni usage", status: "active", currentVersion: { id: "version-4" } },
});
let hintRefresh: (() => Promise<void>) | null = null;
let hintOptions: { siteConversations?: boolean } | undefined;
const listCalls: SessionListPageOptions[] = [];
const sessionReads: string[] = [];
const navigations: unknown[] = [];
const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
const conversationProps: Array<Record<string, unknown>> = [];
const composerProps: Array<Record<string, unknown>> = [];
const client = {
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
  getWorkspaceArtifact: async () => await siteDetails(),
};
mock.module("../app-context", () => ({
  useAppContext: () => ({
    client,
    accessContext: { subjectId: "me", workspaceGrants: [{ workspaceId, permissions }] },
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
  SiteView: (props: { siteId: string; archivedMessage?: string }) => (
    <div data-site-view={props.siteId} data-archived-message={props.archivedMessage} />
  ),
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
  fullSessions = {};
  siteDetails = async () => ({
    artifact: { title: "Opengeni usage", status: "active", currentVersion: { id: "version-4" } },
  });
  hintRefresh = null;
  hintOptions = undefined;
  listPage = null;
  listCalls.length = 0;
  sessionReads.length = 0;
  navigations.length = 0;
  requests.length = 0;
  conversationProps.length = 0;
  composerProps.length = 0;
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

async function render(selected?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draw = async (next?: string) => {
    await act(async () => {
      root!.render(
        <module.SiteViewRoute workspaceId={workspaceId} siteId={siteId} conversation={next} />,
      );
    });
    await settle();
  };
  await draw(selected);
  return { container, rerender: draw };
}
const openConversation = (container: HTMLElement) =>
  container.querySelector("[data-conversation]")?.getAttribute("data-conversation");
const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLAnchorElement>("nav[aria-label^='Conversations in'] a"),
];
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

test("shows the Site with its newest conversation open and the others to switch to", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const { container } = await render();
  expect(container.querySelector("[data-site-view]")?.getAttribute("data-site-view")).toBe(siteId);
  expect(openConversation(container)).toBe(id(1));
  expect(listCalls[0]).toMatchObject({ originSiteId: siteId, parentSessionId: null });
  expect(listCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  // Updates to Site conversations reach this list; ordinary ones don't.
  expect(hintOptions).toEqual({ siteConversations: true });
  expect(rows(container).map((row) => [row.textContent, row.getAttribute("aria-current")])).toEqual(
    [
      ["Time filters across all graphs2m", "page"],
      ["Weekly active users by plan3h", null],
    ],
  );
  // The accessible name says how recent it is, not only the visual "3h".
  expect(rows(container)[1]!.getAttribute("aria-label")).toStartWith(
    "Weekly active users by plan. Idle. Updated ",
  );
  expect(JSON.parse(rows(container)[1]!.getAttribute("href")!)).toEqual(
    siteRoute({ conversation: id(2) }),
  );
  await act(async () => rows(container)[1]!.click());
  expect(navigations).toEqual([siteRoute({ conversation: id(2) })]);
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
  expect(rows(container)[0]!.textContent).toStartWith("Weekly active users by plan");
  expect(openConversation(container)).toBe(id(1));
  // Coming back to the Site itself (its rail row) opens the newest again.
  await rerender(id(1));
  await rerender(undefined);
  expect(openConversation(container)).toBe(id(2));
});

test("an update keeps the older conversations the person loaded", async () => {
  const all = Array.from({ length: 35 }, (_, n) => conversation(n + 1, `Question ${n + 1}`, n));
  listPage = (options) =>
    options.cursor === "older"
      ? { pinned: [], sessions: all.slice(30), nextCursor: null }
      : {
          pinned: [],
          sessions: all.slice(0, options.limit),
          nextCursor: (options.limit ?? 0) < all.length ? "older" : null,
        };
  const { container } = await render();
  expect(rows(container)).toHaveLength(30);
  await act(async () => button(container, "Show older")!.click());
  await settle();
  expect(rows(container)).toHaveLength(35);
  await act(async () => void (await hintRefresh!()));
  await settle();
  expect(listCalls.at(-1)).toMatchObject({ limit: 35 });
  expect(listCalls.at(-1)?.cursor).toBeUndefined();
  expect(rows(container)).toHaveLength(35);
  expect(button(container, "Show older")).toBeUndefined();
});

test("a chosen conversation is the one open", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const { container } = await render(id(2));
  expect(openConversation(container)).toBe(id(2));
  expect(rows(container).find((row) => row.getAttribute("aria-current"))?.textContent).toBe(
    "Weekly active users by plan3h",
  );
});

test("an older conversation of this Site, beyond the first page, stays open", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  fullSessions = { [id(7)]: conversation(7, "Spring pricing review", 60 * 24 * 90) };
  const { container } = await render(id(7));
  expect(sessionReads).toEqual([id(7)]);
  expect(openConversation(container)).toBe(id(7));
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
  // One conversation: nothing else to switch to, so no list.
  expect(rows(container)).toHaveLength(0);
  const newButton = button(container, "New")!;
  // New is an action, not a toggle.
  expect(newButton.hasAttribute("aria-pressed")).toBe(false);
  await act(async () => newButton.click());
  // Nothing is selected while composing.
  expect(navigations).toEqual([siteRoute({})]);
  await rerender(undefined);
  const composer = container.querySelector<HTMLButtonElement>("[data-composer]")!;
  expect(composer.getAttribute("data-composer")).toBe("Ask about Opengeni usage");
  // A Site doesn't offer voice-first chats.
  expect(composerProps.at(-1)?.realtimeVoice).toBe(false);
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
    },
  ]);
  expect(container.querySelector("[data-site-view]")?.getAttribute("data-archived-message")).toBe(
    "This Site is archived. Restore it from Site details.",
  );
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
  siteDetails = async () => ({
    artifact: { title: "Opengeni usage", status: "active", currentVersion: { id: "version-4" } },
  });
  await act(async () => button(container, "Try again")!.click());
  await settle();
  expect(container.querySelector("[data-composer]")).not.toBeNull();
});
