import { describe, expect, test } from "bun:test";
import {
  archivedSessionImportFileIds,
  assertSessionIsNotImported,
  canonicalArchivedSessionImportHash,
} from "../src/archived-session-imports";

describe("archived session import identity", () => {
  test("sorts object keys but preserves source text, optional presence, timestamps and event order", () => {
    expect(canonicalArchivedSessionImportHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalArchivedSessionImportHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    for (const value of ["a\u0000b", "a\uD800b", "a b", "ab"]) {
      expect(canonicalArchivedSessionImportHash({ text: value })).not.toBe(
        canonicalArchivedSessionImportHash({ text: "a" }),
      );
    }
    expect(canonicalArchivedSessionImportHash({ turnId: null })).not.toBe(
      canonicalArchivedSessionImportHash({}),
    );
    expect(canonicalArchivedSessionImportHash([1, 2])).not.toBe(
      canonicalArchivedSessionImportHash([2, 1]),
    );
    expect(canonicalArchivedSessionImportHash("2020-01-01T00:00:00Z")).not.toBe(
      canonicalArchivedSessionImportHash("2020-01-01T01:00:00+01:00"),
    );
  });

  test("finds nested file references and rejects malformed IDs", () => {
    const fileId = crypto.randomUUID();
    expect(
      archivedSessionImportFileIds([
        {
          type: "user.message",
          createdAt: "2020-01-01T00:00:00Z",
          payload: { resources: [{ kind: "file", fileId }], nested: { fileIds: [fileId] } },
        },
      ]),
    ).toEqual([fileId]);
    expect(() =>
      archivedSessionImportFileIds([
        {
          type: "user.message",
          createdAt: "2020-01-01T00:00:00Z",
          payload: { fileId: "invalid" },
        },
      ]),
    ).toThrow("unavailable workspace file");
  });

  test("read-only follows the immutable marker, not ordinary archived state", () => {
    expect(() => assertSessionIsNotImported({})).not.toThrow();
    expect(() =>
      assertSessionIsNotImported({
        importedArchive: {
          importId: "one",
          importedAt: "2020-01-01T00:00:00Z",
          readOnly: true,
        },
      }),
    ).toThrow("read-only");
  });
});
