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

  test("accepts each sorting/archive mode and retains legacy defaults", () => {
    for (const sortBy of ["name", "createdAt", "updatedAt"]) {
      for (const archiveStatus of ["active", "archived", "all"]) {
        expect(sessionListQuery({ sortBy, archiveStatus })).toMatchObject({
          sortBy,
          archiveStatus,
        });
      }
    }
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
