// The whole chain, with the real Site view route, preview and version chip:
// the side chat's agent publishes, its tool call returns in the conversation,
// and the preview on the left reloads with the new version. Only the
// conversation itself is a stand-in that streams the events it would.
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SitePublicationLink } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { Session, SessionEvent, WorkspaceArtifactVersion } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const sessionId = "00000000-0000-4000-9000-000000000001";

const html: Record<number, string> = {
  4: "<header style='background:white'>Opengeni usage</header>",
  5: "<header style='background:blue'>Opengeni usage</header>",
};
const server = { revision: 4, reads: 0, checks: 0, failHtml: false };
// The header's published-link read; an API without the route (404) keeps the
// plain Live label.
let publishedLink: SitePublicationLink | null = null;
const version = (revision: number) =>
  ({
    id: `version-${revision}`,
    revision,
    requestedTools: [],
    createdAt: `2026-10-23T12:0${revision}:00Z`,
  }) as unknown as WorkspaceArtifactVersion;
const artifact = () => ({
  id: siteId,
  workspaceId,
  title: "Opengeni usage",
  status: "active",
  currentVersion: version(server.revision),
  updatedAt: `2026-10-23T12:0${server.revision}:00Z`,
});
const client = {
  recordSiteOpened: async () => ({ openedAt: new Date().toISOString() }),
  listSessionPage: async () => ({
    pinned: [],
    sessions: [
      {
        id: sessionId,
        workspaceId,
        title: "Make the header blue",
        titleSource: "user",
        status: "running",
        archived: false,
        parentSessionId: null,
        metadata: { _opengeniSiteOrigin: { siteId, title: "Opengeni usage" } },
        effectiveControl: { state: "active" },
        updatedAt: new Date().toISOString(),
      } as unknown as Session,
    ],
    nextCursor: null,
  }),
  getWorkspaceArtifact: async () => {
    server.reads++;
    const versions = Array.from({ length: server.revision }, (_, index) => version(index + 1));
    return {
      artifact: artifact(),
      versions,
      events: [],
      versionsTruncated: false,
      eventsTruncated: false,
    };
  },
  getWorkspaceArtifactCurrent: async () => {
    server.checks++;
    return { artifact: artifact() };
  },
  getWorkspaceArtifactHtml: async (
    _workspace: string,
    _site: string,
    options: { versionId: string },
  ) => {
    if (server.failHtml) throw new OpenGeniApiError(503, "{}");
    return html[Number(options.versionId.replace("version-", ""))]!;
  },
  getSitePublicationLink: async () => {
    if (!publishedLink) throw new OpenGeniApiError(404, "{}");
    return publishedLink;
  },
};
mock.module("../app-context", () => ({
  useAppContext: () => ({
    client,
    accessContext: {
      subjectId: "me",
      workspaceGrants: [{ workspaceId, permissions: ["sessions:create", "artifacts:publish"] }],
    },
    authSession: { user: { name: "Bendik" } },
  }),
}));
mock.module("../lib/app-api", () => ({ useAppApi: () => ({ request: async () => ({}) }) }));
mock.module("../lib/navigation", () => ({
  useNavigate: () => async () => {},
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
mock.module("../lib/console-site", () => ({
  useConsoleSiteViewer: () => ({ kind: "member", id: "user:me" }),
  useConsoleSiteToolBridge: () => () => undefined,
}));
mock.module("../lib/use-session-list-hint-refresh", () => ({
  useSessionListHintRefresh: () => {},
}));
// The conversation streams what a real one would; the test drives it.
let stream: ((event: Pick<SessionEvent, "type">) => void) | null = null;
mock.module("../../components/session-conversation", () => ({
  SessionConversation: (props: { sessionId: string; onEvent?: (event: SessionEvent) => void }) => {
    stream = (event) => props.onEvent?.(event as SessionEvent);
    return <div data-conversation={props.sessionId} />;
  },
}));
mock.module("../../components/new-conversation", () => ({ NewConversation: () => null }));

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
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
const preview = (container: HTMLElement) =>
  container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
const chip = (container: HTMLElement) =>
  container.querySelector("[data-site-version-chip]")?.textContent;
const label = (container: HTMLElement) =>
  container.querySelector("[data-live-status]")?.textContent;

test("a publish from the side chat reloads the preview with the new version", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<module.SiteViewRoute workspaceId={workspaceId} siteId={siteId} />),
  );
  await settle();
  await settle();
  expect(container.querySelector("[data-conversation]")?.getAttribute("data-conversation")).toBe(
    sessionId,
  );
  expect(preview(container)).toContain("background:white");
  expect(chip(container)).toBe("v4");
  expect(label(container)).toBe("Live");

  // The agent streams its reply; nothing about the Site changed yet.
  const before = { ...server };
  await act(async () => stream!({ type: "agent.message.delta" }));
  await settle();
  expect(server).toEqual(before);

  // It publishes version 5 and its tool call returns in the conversation.
  server.revision = 5;
  await act(async () => stream!({ type: "agent.toolCall.output" }));
  await settle();
  await settle();
  expect(preview(container)).toContain("background:blue");
  expect(chip(container)).toBe("v5");
  expect(label(container)).toBe("Live");
  // One cheap check saw the change, then the history was read once.
  expect(server.checks).toBe(before.checks + 1);
  expect(server.reads).toBeGreaterThan(before.reads);

  // The turn ends; the check finds nothing new and reads no history.
  const reads = server.reads;
  await act(async () => stream!({ type: "turn.completed" }));
  await settle();
  expect(server.checks).toBe(before.checks + 2);
  expect(server.reads).toBe(reads);
  expect(preview(container)).toContain("background:blue");
});

test("a published Site keeps its link in the header and says so when an update fails", async () => {
  server.revision = 4;
  publishedLink = {
    siteId,
    hostname: "usage.sites.example.test",
    url: "https://usage.sites.example.test/",
    status: "active",
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  try {
    await act(async () =>
      root!.render(<module.SiteViewRoute workspaceId={workspaceId} siteId={siteId} />),
    );
    await settle();
    await settle();
    const link = () => container.querySelector("[data-site-public-link] a");
    expect(link()?.getAttribute("href")).toBe("https://usage.sites.example.test/");
    // While the Site on screen is the live one, the link is the Live label;
    // the status region beside it stays mounted, empty, to announce changes.
    expect(label(container)).toBeUndefined();
    const region = () => container.querySelector("[data-live-state-region]");
    expect(region()?.getAttribute("role")).toBe("status");
    expect(region()?.textContent).toBe("");

    // A publish from the chat whose new version can't be loaded: the old
    // version stays on screen, the link stays, and the header says so.
    server.failHtml = true;
    server.revision = 5;
    await act(async () => stream!({ type: "agent.toolCall.output" }));
    await settle();
    await settle();
    expect(preview(container)).toContain("background:white");
    expect(label(container)).toBe("Reconnecting");
    expect(region()?.textContent).toBe("Reconnecting");
    expect(link()?.getAttribute("href")).toBe("https://usage.sites.example.test/");
  } finally {
    server.failHtml = false;
    publishedLink = null;
  }
});
