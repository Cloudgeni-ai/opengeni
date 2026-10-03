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
