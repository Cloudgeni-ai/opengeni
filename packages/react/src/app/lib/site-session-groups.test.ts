import { expect, test } from "bun:test";
import type { SiteConversationGroup } from "@opengeni/sdk";
import {
  buildPinnedRailSections,
  channelRailSections,
  parseSiteRowKey,
  siteRowConversationCount,
  siteRowKey,
  summarizeRailNodes,
  visibleTreeRows,
  type SessionTreeNode,
} from "./sessions-group";
import type { Session } from "../types";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "22222222-2222-4222-8222-222222222222";
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: "ws",
    accountId: "acc",
    rootSessionId: id,
    parentSessionId: null,
    channelId: null,
    status: "idle",
    title: id,
    pinned: false,
    createdAt: "2026-09-08T10:00:00Z",
    updatedAt: "2026-09-08T10:00:00Z",
    effectiveControl: { state: "active" },
    metadata: { _opengeniSiteOrigin: { siteId, title: "Analytics" } },
    ...patch,
  } as Session;
}
test("Site group has stable identity, real children, aggregate activity and no duplicate count", () => {
  const running = session("older", { status: "running", activelyWorking: true });
  const latest = session("newer", { updatedAt: "2026-09-08T11:00:00Z" });
  const result = buildPinnedRailSections([running, latest]);
  const group = result.ordinary.running[0]!;
  expect(group.siteGroup?.siteId).toBe(siteId);
  expect(group.session.id).toBe(`site:${siteId}`);
  expect(group.children.map((n) => n.session.id)).toEqual(["newer", "older"]);
  expect(summarizeRailNodes([group]).total).toBe(2);
  expect(summarizeRailNodes([group])).toMatchObject({ kind: "active", count: 1 });
  expect(
    visibleTreeRows([group], new Set([`site:${siteId}`])).map((r) => r.node.session.id),
  ).toEqual(["newer", "older"]);
  expect(running.parentSessionId).toBeNull();
});
function siteGroup(patch: Partial<SiteConversationGroup> = {}): SiteConversationGroup {
  return {
    siteId,
    channelId: null,
    title: "Analytics",
    conversations: 3,
    updatedAt: "2026-09-08T09:00:00.000Z",
    createdAt: "2026-09-08T09:00:00.000Z",
    total: 3,
    attention: 0,
    attentionSince: null,
    failed: 0,
    active: 0,
    queued: 0,
    waiting: 0,
    unread: 0,
    activeWork: 0,
    ...patch,
  };
}

function railRoots(result: ReturnType<typeof buildPinnedRailSections>): SessionTreeNode[] {
  return [...result.ordinary.running, ...result.ordinary.grouped.flatMap((g) => g.sessions)];
}

test("pins win; projects split Site rows only when the rail shows projects", () => {
  const placed = session("project", { channelId: "project-id" });
  const pinned = session("pin", { pinned: true, pinnedAt: "2026-09-08T10:00:00Z" });
  const sessions = [placed, pinned, session("unfiled")];
  const result = buildPinnedRailSections(sessions);
  expect(result.pinned.map((n) => n.session.id)).toEqual(["pin"]);
  expect(
    railRoots(result).map((n) => [n.session.id, n.children.map((c) => c.session.id).sort()]),
  ).toEqual([[`site:${siteId}`, ["project", "unfiled"]]]);
  const byProject = buildPinnedRailSections(sessions, new Date(), { siteRowsByProject: true });
  const sections = channelRailSections(byProject.ordinary, [
    { id: "project-id", name: "Project" } as never,
  ]);
  expect(
    sections.map((section) => [
      section.channelId,
      section.sessions.map((n) => [n.session.id, n.children.map((c) => c.session.id)]),
    ]),
  ).toEqual(
    expect.arrayContaining([
      ["project-id", [[siteRowKey(siteId, "project-id"), ["project"]]]],
      [null, [[siteRowKey(siteId, null), ["unfiled"]]]],
    ]),
  );
  expect(placed.metadata._opengeniSiteOrigin).toBeDefined();
});

test("Site rows are complete from the server and never depend on the open session", () => {
  const ordinary = session("ordinary", {
    metadata: {},
    updatedAt: "2026-09-08T08:00:00Z",
  });
  const nested = session("nested", { updatedAt: "2026-09-08T09:00:00Z" });
  const groups = [
    siteGroup(),
    siteGroup({ siteId: otherSiteId, title: "Budget", conversations: 1 }),
  ];
  const build = (loaded: Session[]) =>
    railRoots(buildPinnedRailSections(loaded, new Date(), { siteGroups: groups }));
  // The nested conversation is open: the route injects it into the rail.
  const whileOpen = build([ordinary, nested]);
  const site = whileOpen.find((n) => n.session.id === `site:${siteId}`)!;
  expect(site.children.map((n) => n.session.id)).toEqual(["nested"]);
  expect(siteRowConversationCount(site)).toBe(3);
  expect(visibleTreeRows(whileOpen, new Set(), "nested").map((r) => r.node.session.id)).toContain(
    "nested",
  );
  // Another session is selected, so the conversation is no longer injected.
  // Both Sites keep their rows and counts; nothing appears at the top level.
  const afterSelectingAnother = build([ordinary]);
  expect(afterSelectingAnother.map((n) => n.session.id).sort()).toEqual(
    ["ordinary", `site:${otherSiteId}`, `site:${siteId}`].sort(),
  );
  const stable = afterSelectingAnother.find((n) => n.session.id === `site:${siteId}`)!;
  expect(stable.siteGroup).toEqual({ siteId, title: "Analytics" });
  expect(siteRowConversationCount(stable)).toBe(3);
  expect(
    visibleTreeRows(afterSelectingAnother, new Set(), "ordinary").map((r) => r.node.session.id),
  ).toEqual(["ordinary"]);
  // Expanding lists the Site's loaded conversations under the same row.
  const expanded = build([
    ordinary,
    nested,
    session("older", { updatedAt: "2026-09-08T07:00:00Z" }),
  ]);
  expect(
    visibleTreeRows(expanded, new Set([`site:${siteId}`]), "ordinary")
      .map((r) => r.node.session.id)
      .filter((id) => id !== "ordinary"),
  ).toEqual(["nested", "older"]);
});

test("Site rows sort by activity among ordinary rows and summarize complete counts", () => {
  const recent = session("recent", { metadata: {}, updatedAt: "2026-09-08T12:00:00Z" });
  const old = session("old", { metadata: {}, updatedAt: "2026-09-08T06:00:00Z" });
  const result = buildPinnedRailSections([recent, old], new Date("2026-09-08T13:00:00Z"), {
    siteGroups: [siteGroup({ total: 4, unread: 2 })],
  });
  expect(railRoots(result).map((n) => n.session.id)).toEqual(["recent", `site:${siteId}`, "old"]);
  const site = railRoots(result)[1]!;
  expect(summarizeRailNodes([site])).toMatchObject({ kind: "unread", count: 2, total: 4 });
  // Live or waiting conversations float their Site row with the running rows.
  for (const live of [{ active: 1 }, { attention: 1, attentionSince: "2026-09-08T08:30:00Z" }]) {
    const running = buildPinnedRailSections([recent], new Date(), {
      siteGroups: [siteGroup(live)],
    });
    expect(running.ordinary.running.map((n) => n.session.id)).toEqual([`site:${siteId}`]);
  }
});

test("a Site without conversations is a plain row in its creating chat's project", () => {
  const chat = session("chat", {
    metadata: {},
    channelId: "project-id",
    updatedAt: "2026-09-08T11:00:00Z",
  });
  const older = session("older", { metadata: {}, updatedAt: "2026-09-08T06:00:00Z" });
  const created = siteGroup({
    channelId: "project-id",
    conversations: 0,
    total: 0,
    updatedAt: "2026-09-08T10:00:00Z",
  });
  const result = buildPinnedRailSections([chat, older], new Date("2026-09-08T13:00:00Z"), {
    siteGroups: [created],
    siteRowsByProject: true,
  });
  const sections = channelRailSections(result.ordinary, [
    { id: "project-id", name: "Project" } as never,
  ]);
  const project = sections.find((section) => section.channelId === "project-id")!;
  // Top-level beside the chat that made it, ordered by its own activity.
  expect(project.sessions.map((n) => n.session.id)).toEqual([
    "chat",
    siteRowKey(siteId, "project-id"),
  ]);
  const site = project.sessions[1]!;
  expect(site.children).toEqual([]);
  expect(siteRowConversationCount(site)).toBe(0);
  expect(summarizeRailNodes([site])).toMatchObject({ total: 0 });
  // A newer published version moves it above the chat.
  const published = buildPinnedRailSections([chat, older], new Date("2026-09-08T13:00:00Z"), {
    siteGroups: [{ ...created, updatedAt: "2026-09-08T12:30:00Z" }],
    siteRowsByProject: true,
  });
  expect(
    channelRailSections(published.ordinary, [{ id: "project-id", name: "Project" } as never])
      .find((section) => section.channelId === "project-id")!
      .sessions.map((n) => n.session.id),
  ).toEqual([siteRowKey(siteId, "project-id"), "chat"]);
});

test("a loaded conversation's newer messages never move its Site row", () => {
  const chat = session("chat", { metadata: {}, updatedAt: "2026-09-08T11:00:00Z" });
  // The Site was last published at 09:00; one of its conversations is open and
  // had a message at 12:00, after the chat beside it.
  const busy = session("busy", { updatedAt: "2026-09-08T12:00:00Z" });
  const roots = railRoots(
    buildPinnedRailSections([chat, busy], new Date("2026-09-08T13:00:00Z"), {
      siteGroups: [siteGroup()],
    }),
  );
  expect(roots.map((n) => n.session.id)).toEqual(["chat", `site:${siteId}`]);
  const site = roots[1]!;
  expect(site.session.updatedAt).toBe("2026-09-08T09:00:00.000Z");
  expect(site.children.map((n) => n.session.id)).toEqual(["busy"]);
});

test("Site row keys round-trip their Site and project", () => {
  expect(parseSiteRowKey(siteRowKey(siteId))).toEqual({ siteId });
  expect(parseSiteRowKey(siteRowKey(siteId, null))).toEqual({ siteId, channelId: null });
  expect(parseSiteRowKey(siteRowKey(siteId, "project-id"))).toEqual({
    siteId,
    channelId: "project-id",
  });
  expect(parseSiteRowKey(siteId)).toBeNull();
});

test("search and custom browse can keep matched conversations flat", () => {
  const result = buildPinnedRailSections([session("one"), session("two")], new Date(), {
    groupSites: false,
  });
  const roots = [...result.ordinary.running, ...result.ordinary.grouped.flatMap((g) => g.sessions)];
  expect(roots.map((n) => n.session.id).sort()).toEqual(["one", "two"]);
  expect(roots.every((n) => !n.siteGroup)).toBe(true);
});

test("collapsed Site exposes only the selected descendant, matching keyboard order", () => {
  const result = buildPinnedRailSections([
    session("root"),
    session("child", { parentSessionId: "root", rootSessionId: "root" }),
  ]);
  const roots = [...result.ordinary.running, ...result.ordinary.grouped.flatMap((g) => g.sessions)];
  expect(visibleTreeRows(roots, new Set(), "child").map((r) => r.node.session.id)).toEqual([
    "child",
  ]);
});

test("a pinned Site is one Pinned row across projects, ordered with pinned chats", () => {
  const conversation = session("conversation", { channelId: "project-id" });
  const otherConversation = session("other", {
    metadata: { _opengeniSiteOrigin: { siteId: otherSiteId, title: "Roadmap" } },
  });
  const pinnedChat = session("chat", {
    pinned: true,
    pinnedAt: "2026-09-08T12:00:00Z",
    metadata: {},
  });
  const result = buildPinnedRailSections([conversation, otherConversation, pinnedChat], undefined, {
    siteRowsByProject: true,
    siteGroups: [
      siteGroup({ channelId: "project-id", conversations: 1, total: 1 }),
      siteGroup({ channelId: null, conversations: 2, total: 2 }),
      siteGroup({ siteId: otherSiteId, title: "Roadmap", conversations: 1, total: 1 }),
    ].map((group) =>
      group.siteId === siteId
        ? { ...group, pinned: true as const, pinnedAt: "2026-09-08T13:00:00.000Z" }
        : group,
    ),
  });
  // Newest pin first; the pinned Site merges its projects into one row.
  expect(result.pinned.map((node) => node.session.id)).toEqual([`site:${siteId}`, "chat"]);
  const pinnedSite = result.pinned[0]!;
  expect(pinnedSite.session.pinned).toBe(true);
  expect(siteRowConversationCount(pinnedSite)).toBe(3);
  expect(pinnedSite.children.map((node) => node.session.id)).toEqual(["conversation"]);
  // It leaves the ordinary rows, with its conversation; the other Site stays.
  const ordinary = railRoots(result).map((node) => node.session.id);
  expect(ordinary).toEqual([`site:${otherSiteId}:default`]);
});

test("a Site archived from the sidebar leaves with its loaded conversations", () => {
  const open = session("open-conversation");
  const ordinary = session("chat", { metadata: {} });
  const result = buildPinnedRailSections([open, ordinary], undefined, {
    siteGroups: [siteGroup({ conversations: 1, total: 1 })],
    archivedSiteIds: new Set([siteId]),
  });
  expect(railRoots(result).map((node) => node.session.id)).toEqual(["chat"]);
  expect(result.pinned).toEqual([]);
});
