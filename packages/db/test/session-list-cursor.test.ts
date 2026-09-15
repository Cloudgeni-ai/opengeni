import { describe, expect, test } from "bun:test";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  type SessionListKeysetCursor,
} from "../src/index";

describe("session list v4 cursor", () => {
  test("roundtrips every sort/archive identity including empty and Unicode names", () => {
    for (const sortBy of ["updatedAt", "createdAt", "name", "archivedAt"] as const) {
      for (const archiveMode of ["active", "archived", "all"] as const) {
        if (sortBy === "archivedAt" && archiveMode !== "archived") continue;
        for (const name of ["", "alpha", "é😀"]) {
          const cursor: SessionListKeysetCursor = {
            kind: "keyset",
            sortBy,
            archiveMode,
            snapshotRevision: "123",
            id: "00000000-0000-4000-8000-000000000001",
            sortAt: sortBy === "name" ? name : "2026-01-01T00:00:00.123456Z",
            parentSessionFilter: "null",
            search: null,
            filter: "all",
          };
          const encoded = encodeSessionListCursor(cursor);
          expect(JSON.parse(Buffer.from(encoded, "base64url").toString()).version).toBe(4);
          expect(decodeSessionListCursor(encoded)).toEqual(cursor);
        }
      }
    }
  });

  test("rejects unknown versions and invalid sort boundaries", () => {
    const envelope = {
      version: 4,
      sortBy: "name",
      sortAt: "alpha",
      archiveMode: "all",
      snapshotRevision: "1",
      id: "00000000-0000-4000-8000-000000000001",
      parentSessionFilter: "null",
      search: null,
    };
    for (const change of [
      { version: 5 },
      { sortBy: "title" },
      { sortBy: "createdAt" },
      { sortBy: "archivedAt" },
      { sortAt: "a\u0000b" },
    ]) {
      expect(
        decodeSessionListCursor(
          Buffer.from(JSON.stringify({ ...envelope, ...change })).toString("base64url"),
        ),
      ).toBeNull();
    }
  });
});
