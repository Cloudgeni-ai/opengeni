import { describe, expect, spyOn, test } from "bun:test";
import { ATTEMPT_TOOL_CATALOG_MAX_BYTES } from "@opengeni/contracts";
import {
  AttemptToolCatalogTooLargeError,
  digestAttemptToolCatalog,
  verifyAttemptToolCatalog,
} from "../src";

function catalog(text: string) {
  const unsigned = {
    version: 1 as const,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
    generation: 1,
    createdAt: "2026-08-09T12:00:00.000Z",
    entries: [
      {
        identity: { serverId: "docs", toolName: "search" },
        modelName: "docs__search",
        codemodePath: ["docs", "search"],
        inputSchema: { description: text },
        source: "docs" as const,
        approval: "none" as const,
      },
    ],
  };
  return { ...unsigned, digest: digestAttemptToolCatalog(unsigned) };
}

describe("attempt catalog byte accounting", () => {
  test("counts serialized UTF-8 exactly without allocating an encoded catalog", () => {
    for (const text of [
      "",
      "ascii",
      "ø",
      "漢字",
      "😀",
      "e\u0301",
      "\ud800",
      "\udfff",
      '\u0000\n"\\',
    ]) {
      const input = catalog(text);
      const expected = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      const encode = spyOn(TextEncoder.prototype, "encode");
      try {
        const verified = verifyAttemptToolCatalog(input);
        expect(verified.byteLength).toBe(expected);
        expect(verified.catalog).toEqual(input);
        expect(encode).not.toHaveBeenCalled();
      } finally {
        encode.mockRestore();
      }
    }
  });

  test("preserves the exact serialized-byte limit", () => {
    const overhead = new TextEncoder().encode(JSON.stringify(catalog(""))).byteLength;
    for (const delta of [-1, 0, 1]) {
      const input = catalog("x".repeat(ATTEMPT_TOOL_CATALOG_MAX_BYTES - overhead + delta));
      const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      expect(bytes).toBe(ATTEMPT_TOOL_CATALOG_MAX_BYTES + delta);
      if (delta > 0) {
        expect(() => verifyAttemptToolCatalog(input)).toThrow(AttemptToolCatalogTooLargeError);
      } else {
        expect(verifyAttemptToolCatalog(input).byteLength).toBe(bytes);
      }
    }
  });
});
