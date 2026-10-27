import { describe, expect, spyOn, test } from "bun:test";
import { ATTEMPT_TOOL_CATALOG_MAX_BYTES } from "@opengeni/contracts";
import { digestToolGatewayCatalog, parseVerifiedToolGatewayCatalog } from "../src/catalog";
import { ToolGatewayCatalogTooLargeError } from "../src/errors";

function catalog(text: string) {
  const unsigned = {
    version: 1 as const,
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
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
  return { ...unsigned, digest: digestToolGatewayCatalog(unsigned) };
}

describe("gateway catalog byte accounting", () => {
  test("preserves Unicode catalog values without allocating an encoded catalog", () => {
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
      const encode = spyOn(TextEncoder.prototype, "encode");
      try {
        expect(parseVerifiedToolGatewayCatalog(input)).toEqual(input);
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
      expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(
        ATTEMPT_TOOL_CATALOG_MAX_BYTES + delta,
      );
      if (delta > 0) {
        expect(() => parseVerifiedToolGatewayCatalog(input)).toThrow(
          ToolGatewayCatalogTooLargeError,
        );
      } else {
        expect(parseVerifiedToolGatewayCatalog(input)).toEqual(input);
      }
    }
  });
});
