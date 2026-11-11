import { describe, expect, test } from "bun:test";
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  type SessionListKeysetCursor,
} from "../src/index";

describe("session list v4 cursor", () => {
  test("preserves full xid precision and rejects a tagged updated cursor without its xid", () => {
    const cursor: SessionListKeysetCursor = {
      kind: "keyset",
      sortBy: "updatedAt",
      archiveMode: "all",
      snapshotRevision: "18446744073709551616",
      sortXid: "18446744073709551615",
      id: "00000000-0000-4000-8000-000000000001",
      sortAt: "2026-01-01T00:00:00.123456Z",
      parentSessionFilter: "null",
      search: null,
      filter: "all",
    };
    expect(decodeSessionListCursor(encodeSessionListCursor(cursor))).toEqual(cursor);
    const { sortXid: _sortXid, ...withoutXid } = cursor;
    expect(decodeSessionListCursor(encodeSessionListCursor(withoutXid))).toBeNull();
    for (const sortXid of ["18446744073709551616", "-1", "1.5"]) {
      expect(decodeSessionListCursor(encodeSessionListCursor({ ...cursor, sortXid }))).toBeNull();
    }
  });

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
