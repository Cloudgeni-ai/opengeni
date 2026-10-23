import { describe, expect, test } from "bun:test";
import {
  readSidebarSites,
  rememberSidebarSites,
  sitePath,
  siteRecords,
  type SiteRecord,
} from "./site-directory";
import { rankSites, recentSites } from "./site-rank";
import { LOOSE_MATCH_BELOW } from "./rank";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const site = (id: string, title: string, updatedAt = 0): SiteRecord => ({
  id,
  workspaceId,
  title,
  updatedAt,
});

describe("site records", () => {
  test("read sidebar rows and catalog items alike, dropping malformed and duplicate ones", () => {
    expect(
      siteRecords(workspaceId, [
        { siteId: "a", title: " Sales dashboard ", updatedAt: "2026-10-01T10:00:00.000Z" },
        { id: "b", title: "", updatedAt: "not a date" },
        { siteId: "a", title: "Duplicate", updatedAt: "2026-10-02T10:00:00.000Z" },
        { title: "No id", updatedAt: "2026-10-02T10:00:00.000Z" },
      ]),
    ).toEqual([
      {
        id: "a",
        workspaceId,
        title: "Sales dashboard",
        updatedAt: Date.parse("2026-10-01T10:00:00.000Z"),
      },
      { id: "b", workspaceId, title: "Untitled Site", updatedAt: 0 },
    ]);
  });

  test("the sidebar's newest list replaces the last, per person and workspace, newest first", () => {
    const subject = `subject-${crypto.randomUUID()}`;
    rememberSidebarSites(subject, workspaceId, [
      { siteId: "old", title: "Old", updatedAt: "2026-10-01T00:00:00.000Z" },
      { siteId: "new", title: "New", updatedAt: "2026-10-03T00:00:00.000Z" },
    ]);
    expect(readSidebarSites(subject, workspaceId).map((entry) => entry.id)).toEqual(["new", "old"]);
    rememberSidebarSites(subject, workspaceId, [
      { siteId: "only", title: "Only", updatedAt: "2026-10-04T00:00:00.000Z" },
    ]);
    expect(readSidebarSites(subject, workspaceId).map((entry) => entry.id)).toEqual(["only"]);
    expect(readSidebarSites(subject, "another-workspace")).toEqual([]);
    expect(readSidebarSites(`other-${subject}`, workspaceId)).toEqual([]);
  });

  test("a Site's path is its in-app Site view", () => {
    expect(sitePath("ws 1", "a/b")).toBe("/workspaces/ws%201/sites/a%2Fb");
  });
});

describe("rankSites", () => {
  const known = [
    site("analytics", "Analytics", 3),
    site("sales", "Sales dashboard", 2),
    site("dash", "Dashboard", 1),
  ];

  test("ranks titles like chats: whole-title prefix, then word start, then substring", () => {
    expect(rankSites(known, [], "dash").map((entry) => entry.site.id)).toEqual(["dash", "sales"]);
    expect(rankSites(known, [], "analytics").map((entry) => entry.site.id)).toEqual(["analytics"]);
  });

  test("within a match tier, the Site active more recently comes first", () => {
    // Both contain "board" mid-word; Sales dashboard was active more recently.
    expect(rankSites(known, [], "board").map((entry) => entry.site.id)).toEqual(["sales", "dash"]);
    // A Site only the server knows ranks on its title alone.
    expect(
      rankSites([site("old", "Revenue report", 1)], [site("new", "Revenue", 9)], "revenue").map(
        (entry) => entry.site.id,
      ),
    ).toEqual(["new", "old"]);
  });

  test("nothing is listed before anything is typed", () => {
    expect(rankSites(known, [], "  ")).toEqual([]);
  });

  test("server matches join the known Sites once, with the server's current title", () => {
    const ranked = rankSites(
      known,
      [site("sales", "Sales dashboard v2", 1), site("remote", "Remote dashboard", 5)],
      "dashboard",
    );
    expect(ranked.map((entry) => [entry.site.id, entry.site.title])).toEqual([
      ["dash", "Dashboard"],
      ["sales", "Sales dashboard v2"],
      ["remote", "Remote dashboard"],
    ]);
    // The later activity is kept for ties and the empty menu.
    expect(ranked.find((entry) => entry.site.id === "sales")?.site.updatedAt).toBe(2);
  });

  test("a server match whose title folds differently still shows, below real matches", () => {
    const [entry] = rankSites([], [site("odd", "Ünrelated")], "zz");
    expect(entry?.site.id).toBe("odd");
    expect(entry?.rank).toBeLessThan(LOOSE_MATCH_BELOW);
    expect(entry?.loose).toBe(false);
  });

  test("letters-in-order guesses are marked loose", () => {
    const [entry] = rankSites([site("kb", "Keyboard shortcuts")], [], "kbsh");
    expect(entry?.loose).toBe(true);
  });

  test("equal matches go to the Site active most recently", () => {
    // Known Sites arrive most recent first; server-only ones tie-break on activity.
    expect(
      rankSites([site("b", "Report", 9), site("a", "Report", 1)], [], "report").map(
        (entry) => entry.site.id,
      ),
    ).toEqual(["b", "a"]);
    expect(
      rankSites([], [site("a", "Report", 1), site("b", "Report", 9)], "report").map(
        (entry) => entry.site.id,
      ),
    ).toEqual(["b", "a"]);
  });
});

describe("recentSites", () => {
  test("a few of the most recently active Sites, without the one on screen", () => {
    const known = [site("a", "A", 1), site("b", "B", 4), site("c", "C", 3), site("d", "D", 2)];
    expect(recentSites(known, "b", 2).map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(recentSites(known, null, 3).map((entry) => entry.id)).toEqual(["b", "c", "d"]);
    expect(recentSites([], null, 3)).toEqual([]);
  });
});
