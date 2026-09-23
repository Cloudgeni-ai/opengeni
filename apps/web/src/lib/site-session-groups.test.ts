import { expect, test } from "bun:test";
import { buildPinnedRailSections, summarizeRailNodes, visibleTreeRows } from "./sessions-group";
import type { Session } from "@/types";

const siteId = "11111111-1111-4111-8111-111111111111";
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
test("projects and pins win, while Site origin survives and a single unfiled chat still groups", () => {
  const placed = session("project", { channelId: "project-id" });
  const pinned = session("pin", { pinned: true, pinnedAt: "2026-09-08T10:00:00Z" });
  const result = buildPinnedRailSections([placed, pinned, session("unfiled")]);
  expect(result.pinned.map((n) => n.session.id)).toEqual(["pin"]);
  const roots = [...result.ordinary.running, ...result.ordinary.grouped.flatMap((g) => g.sessions)];
  expect(roots.find((n) => n.session.id === "project")?.siteGroup).toBeUndefined();
  expect(roots.find((n) => n.siteGroup)?.children.map((n) => n.session.id)).toEqual(["unfiled"]);
  expect(placed.metadata._opengeniSiteOrigin).toBeDefined();
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
