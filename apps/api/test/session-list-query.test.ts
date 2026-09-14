import { describe, expect, test } from "bun:test";
import { sessionListQuery } from "../src/routes/sessions";

describe("session list sorting and archive query", () => {
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
    ])
      expect(() => sessionListQuery(query)).toThrow();
  });
});
