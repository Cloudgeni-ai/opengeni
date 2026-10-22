import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session, SessionListPageOptions } from "@opengeni/sdk";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

let permissions = ["sessions:create"];
let conversations: Session[] = [];
const listCalls: SessionListPageOptions[] = [];
const navigations: unknown[] = [];
const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
const client = {
  listSessionPage: async (_workspace: string, options: SessionListPageOptions) => {
    listCalls.push(options);
    return { pinned: [], sessions: conversations, nextCursor: null };
  },
  getWorkspaceArtifact: async () => ({
    artifact: { title: "Opengeni usage", status: "active", currentVersion: { id: "version-4" } },
  }),
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
  Link: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => (
    <a aria-label={props["aria-label"]}>{children}</a>
  ),
}));
mock.module("../lib/console-site", () => ({
  useConsoleSiteViewer: () => ({ kind: "member", id: "user:me" }),
  useConsoleSiteToolBridge: () => () => undefined,
}));
mock.module("../lib/use-session-list-hint-refresh", () => ({
  useSessionListHintRefresh: () => undefined,
}));
mock.module("../../artifacts", () => ({
  SiteView: (props: { siteId: string }) => <div data-site-view={props.siteId} />,
}));
mock.module("../../components/session-conversation", () => ({
  SessionConversation: (props: { sessionId: string }) => (
    <div data-conversation={props.sessionId} />
  ),
}));
mock.module("../../components/new-conversation", () => ({
  NewConversation: (props: {
    createSession: (text: string, key: string, options: object) => Promise<string>;
    onCreated: (created: { sessionId: string }) => void;
    labels: { title: string };
  }) => (
    <button
      type="button"
      data-composer={props.labels.title}
      onClick={() =>
        void props
          .createSession("Why did spend rise?", "key-1", { model: "m", resources: ["x"] })
          .then((sessionId) => props.onCreated({ sessionId }))
      }
    >
      Send
    </button>
  ),
}));
mock.module("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
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
  listCalls.length = 0;
  navigations.length = 0;
  requests.length = 0;
});

const conversation = (n: number, title: string, minutesAgo: number) =>
  ({
    id: id(n),
    workspaceId,
    title,
    titleSource: "user",
    status: "idle",
    archived: false,
    metadata: { _opengeniSiteOrigin: { siteId, title: "Opengeni usage" } },
    effectiveControl: { state: "active" },
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  }) as unknown as Session;

async function render(selected?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <module.SiteViewRoute workspaceId={workspaceId} siteId={siteId} conversation={selected} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return container;
}
const openConversation = (container: HTMLElement) =>
  container.querySelector("[data-conversation]")?.getAttribute("data-conversation");
const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLAnchorElement>("nav[aria-label^='Conversations in'] a"),
];

test("shows the Site with its newest conversation open and the others to switch to", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const container = await render();
  expect(container.querySelector("[data-site-view]")?.getAttribute("data-site-view")).toBe(siteId);
  expect(openConversation(container)).toBe(id(1));
  expect(listCalls[0]).toMatchObject({ originSiteId: siteId, parentSessionId: null });
  expect(rows(container).map((row) => [row.textContent, row.getAttribute("aria-current")])).toEqual(
    [
      ["Time filters across all graphs2m", "true"],
      ["Weekly active users by plan3h", null],
    ],
  );
  expect(rows(container)[1]!.getAttribute("href")).toBe(
    `/workspaces/${workspaceId}/sites/${siteId}?conversation=${id(2)}`,
  );
  await act(async () => rows(container)[1]!.click());
  expect(navigations).toEqual([
    {
      to: "/workspaces/$workspaceId/sites/$siteId",
      params: { workspaceId, siteId },
      search: { conversation: id(2) },
    },
  ]);
});

test("a chosen conversation is the one open", async () => {
  conversations = [
    conversation(2, "Weekly active users by plan", 180),
    conversation(1, "Time filters across all graphs", 2),
  ];
  const container = await render(id(2));
  expect(openConversation(container)).toBe(id(2));
  expect(rows(container).find((row) => row.getAttribute("aria-current"))?.textContent).toBe(
    "Weekly active users by plan3h",
  );
});

test("a new conversation is created as the Site's own, then opened", async () => {
  conversations = [conversation(1, "Time filters across all graphs", 2)];
  const container = await render(id(1));
  // One conversation: nothing else to switch to, so no list.
  expect(rows(container)).toHaveLength(0);
  const newButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "New",
  );
  await act(async () => newButton!.click());
  // Nothing is selected while composing.
  expect(navigations).toEqual([
    { to: "/workspaces/$workspaceId/sites/$siteId", params: { workspaceId, siteId }, search: {} },
  ]);
  const composer = container.querySelector<HTMLButtonElement>("[data-composer]")!;
  expect(composer.getAttribute("data-composer")).toBe("Ask about Opengeni usage");
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
  expect(navigations.at(-1)).toEqual({
    to: "/workspaces/$workspaceId/sites/$siteId",
    params: { workspaceId, siteId },
    search: { conversation: id(99) },
  });
});

test("without permission to start chats there is no New, and an empty Site says so", async () => {
  permissions = [];
  conversations = [];
  const container = await render();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "New"),
  ).toBe(false);
  expect(container.querySelector("[data-composer]")).toBeNull();
  expect(container.textContent).toContain("No conversations yet.");
});
