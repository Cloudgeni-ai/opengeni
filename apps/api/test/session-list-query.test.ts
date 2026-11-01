import { describe, expect, test } from "bun:test";
import { sessionListQuery } from "../src/routes/sessions";

describe("session list sorting and archive query", () => {
  test("validates root totals and acknowledges attention as a page filter", () => {
    expect(
      sessionListQuery({ parentSessionId: "null", includeTotals: "true", needsYouOnly: "true" }),
    ).toMatchObject({ includeTotals: true, needsYouOnly: true, hasPageFilters: true });
    expect(sessionListQuery({ search: "child", needsYouOnly: "true" }).needsYouOnly).toBe(true);
    expect(sessionListQuery({ pinsOnly: "true", includeTotals: "true" }).includeTotals).toBe(true);
    for (const query of [
      { includeTotals: "true" },
      { needsYouOnly: "1" },
      { includeTotals: "yes" },
    ])
      expect(() => sessionListQuery(query)).toThrow();
    expect(() => sessionListQuery({ needsYouOnly: "true" }, false)).toThrow();
  });

  test("lets the console rail include or group Site conversations", () => {
    const siteId = "00000000-0000-4000-8000-000000000001";
    expect(
      sessionListQuery({ parentSessionId: "null", siteConversations: "group" }).siteConversations,
    ).toBe("group");
    for (const query of [
      { siteConversations: "include" },
      { pinsOnly: "true", siteConversations: "include" },
      { parentSessionId: siteId, siteConversations: "include" },
    ])
      expect(sessionListQuery(query).siteConversations).toBe("include");
    expect(sessionListQuery({}).siteConversations).toBeUndefined();
    for (const query of [
      { siteConversations: "all" },
      { siteConversations: "group" },
      { parentSessionId: siteId, siteConversations: "group" },
      { parentSessionId: "null", pinsOnly: "true", siteConversations: "group" },
      { parentSessionId: "null", archiveStatus: "archived", siteConversations: "group" },
      { parentSessionId: "null", archivedOnly: "true", siteConversations: "group" },
      { originSiteId: siteId, siteConversations: "include" },
      { siteAccessId: siteId, siteConversations: "include" },
    ])
      expect(() => sessionListQuery(query)).toThrow();
    expect(
      sessionListQuery({
        parentSessionId: "null",
        archiveStatus: "all",
        siteConversations: "group",
      }).siteConversations,
    ).toBe("group");
    expect(() => sessionListQuery({ siteConversations: "include" }, false)).toThrow();
  });

  test("accepts Only mine as a page filter", () => {
    expect(sessionListQuery({ parentSessionId: "null", mineOnly: "true" })).toMatchObject({
      mineOnly: true,
      hasPageFilters: true,
    });
    expect(sessionListQuery({ mineOnly: "false" })).toMatchObject({
      mineOnly: false,
      hasPageFilters: false,
    });
    expect(() => sessionListQuery({ mineOnly: "yes" })).toThrow();
    expect(() => sessionListQuery({ mineOnly: "true" }, false)).toThrow();
  });

  test("selects at most 200 session ids as a page filter", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    expect(
      sessionListQuery({ sessionIds: `${id(1)},${id(2)},${id(1)}`, search: "fix" }),
    ).toMatchObject({ sessionIds: [id(1), id(2)], search: "fix", hasPageFilters: true });
    expect(sessionListQuery({ sessionIds: id(1).toUpperCase() }).sessionIds).toEqual([id(1)]);
    expect(
      sessionListQuery({ sessionIds: Array.from({ length: 200 }, (_, n) => id(n)).join(",") })
        .sessionIds,
    ).toHaveLength(200);
    expect(sessionListQuery({}).sessionIds).toBeUndefined();
    for (const query of [
      { sessionIds: "" },
      { sessionIds: `${id(1)},` },
      { sessionIds: "not-a-session" },
      { sessionIds: Array.from({ length: 201 }, (_, n) => id(n)).join(",") },
      { sessionIds: id(1), pinsOnly: "true" },
    ])
      expect(() => sessionListQuery(query)).toThrow();
    expect(() => sessionListQuery({ sessionIds: id(1) }, false)).toThrow();
  });

  test("accepts each sorting/archive mode and retains legacy defaults", () => {
    for (const sortBy of ["name", "createdAt", "updatedAt"]) {
      for (const archiveStatus of ["active", "archived", "all"]) {
        expect(sessionListQuery({ sortBy, archiveStatus })).toMatchObject({
          sortBy,
          archiveStatus,
        });
      }
    }
    // The Archived view sorts by archive date by default.
    expect(sessionListQuery({ sortBy: "archivedAt", archiveStatus: "archived" })).toMatchObject({
      sortBy: "archivedAt",
      archiveStatus: "archived",
    });
    expect(sessionListQuery({ sortBy: "archivedAt", archivedOnly: "true" }).sortBy).toBe(
      "archivedAt",
    );
    expect(sessionListQuery({ archivedOnly: "true" })).toMatchObject({
      archivedOnly: true,
      sortBy: undefined,
    });
    expect(
      sessionListQuery({ archivedOnly: "true", archiveStatus: "archived" }).archiveStatus,
    ).toBe("archived");
  });

  test("rejects invalid modes, contradictory aliases and archived pins", () => {
    for (const query of [
      { sortBy: "archivedAt" },
      { sortBy: "archivedAt", archiveStatus: "active" },
      { sortBy: "archivedAt", archiveStatus: "all" },
      { sortBy: "" },
      { archiveStatus: "idle" },
      { archiveStatus: "all", archivedOnly: "true" },
      { archiveStatus: "active", archivedOnly: "true" },
      { archiveStatus: "archived", pinsOnly: "true" },
      { includePinned: "0" },
      { includePinned: "false", pinsOnly: "true" },
    ])
      expect(() => sessionListQuery(query)).toThrow();
  });

  test("keeps pin hydration by default and permits an ordinary-only page", () => {
    expect(sessionListQuery({}).includePinned).toBe(true);
    expect(sessionListQuery({ includePinned: "true" }).includePinned).toBe(true);
    expect(sessionListQuery({ includePinned: "false" }).includePinned).toBe(false);
  });
});
