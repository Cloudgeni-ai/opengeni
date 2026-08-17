import { describe, expect, test } from "bun:test";
import {
  CURATED_CATALOG,
  curatedCatalogByMcpUrl,
  curatedCatalogEntriesByMcpUrl,
  parseCuratedCatalog,
} from "./catalog-curation";
import { catalogRowToDbInput, normalizeCatalogSnapshot } from "./import-integrations-catalog";

describe("curated catalog overlay document", () => {
  test("the committed overlay parses and keys entries by exact MCP URL", () => {
    expect(CURATED_CATALOG.version).toBe(1);
    expect(CURATED_CATALOG.entries.length).toBeGreaterThan(0);
    for (const entry of CURATED_CATALOG.entries) {
      expect(curatedCatalogEntriesByMcpUrl.get(entry.mcpUrl)).toBe(entry);
    }
  });

  test("every committed entry that claims official is served from the provider domain family", () => {
    // `official` is a checkable claim, not a review. Keep it checkable.
    for (const entry of CURATED_CATALOG.entries) {
      if (!entry.official) continue;
      const host = new URL(entry.mcpUrl).hostname;
      expect(host.includes(".")).toBe(true);
    }
  });

  test("a name-only entry carries only the name", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [{ mcpUrl: "https://mcp.example.com/mcp", name: "Example" }],
    });
    expect(parsed.entries[0]).toEqual({ mcpUrl: "https://mcp.example.com/mcp", name: "Example" });
  });

  test("preserves an explicit null logoSourceUrl and distinguishes it from omission", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [
        { mcpUrl: "https://a.example/mcp", logoSourceUrl: null },
        { mcpUrl: "https://b.example/mcp" },
      ],
    });
    expect(parsed.entries[0]).toHaveProperty("logoSourceUrl", null);
    expect(parsed.entries[1]).not.toHaveProperty("logoSourceUrl");
  });

  test.each([
    ["missing mcpUrl", { version: 1, entries: [{ name: "X" }] }, /mcpUrl is required/],
    ["wrong version", { version: 2, entries: [] }, /unsupported version 2/],
    [
      "duplicate mcpUrl",
      {
        version: 1,
        entries: [{ mcpUrl: "https://a.example/mcp" }, { mcpUrl: "https://a.example/mcp" }],
      },
      /duplicate entry/,
    ],
    [
      "invalid authKind",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", authKind: "magic" }] },
      /authKind must be one of/,
    ],
    [
      "invalid tier",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", tier: "gold" }] },
      /tier must be one of/,
    ],
    [
      "invalid connectionOwnership",
      {
        version: 1,
        entries: [{ mcpUrl: "https://a.example/mcp", connectionOwnership: "workspace" }],
      },
      /connectionOwnership must be/,
    ],
    [
      "empty logoSourceUrl",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", logoSourceUrl: "" }] },
      /logoSourceUrl must be/,
    ],
    [
      "non-boolean featured",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", featured: "yes" }] },
      /featured must be a boolean/,
    ],
    [
      "malformed requireApproval",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", requireApproval: 3 }] },
      /requireApproval must be/,
    ],
  ])("rejects a malformed overlay: %s", (_label, document, message) => {
    expect(() => parseCuratedCatalog(document)).toThrow(message);
  });

  test("curatedCatalogByMcpUrl builds a lookup for an arbitrary parsed document", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [{ mcpUrl: "https://a.example/mcp", featured: true }],
    });
    expect(curatedCatalogByMcpUrl(parsed).get("https://a.example/mcp")?.featured).toBe(true);
  });
});

describe("curated fields flow through import normalization", () => {
  test("a featured official curated row keeps its category and curation through to the DB input", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-08-17T00:00:00.000Z",
      importRows: [
        {
          domain: "linear.app",
          name: "linear",
          mcpUrl: "https://mcp.linear.app/mcp",
          transport: "streamable-http",
          authKind: "oauth2",
          probe: { status: "real", reason: "auth_challenge", httpStatus: 401 },
        },
      ],
    });
    expect(normalized.rows).toHaveLength(1);
    const linear = normalized.rows[0]!;
    expect(linear).toMatchObject({
      name: "Linear",
      category: "project-management",
      featured: true,
      official: true,
    });

    const dbInput = catalogRowToDbInput(linear, { importBatchId: "batch-1" });
    expect(dbInput.category).toBe("project-management");
    expect(dbInput.metadata).toMatchObject({ curation: { featured: true, official: true } });
  });

  test("an uncurated row carries no category, no curation, and no metadata curation key", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-08-17T00:00:00.000Z",
      importRows: [
        {
          domain: "plain.example",
          name: "Plain",
          mcpUrl: "https://plain.example/mcp",
          transport: "streamable-http",
          authKind: "none",
          probe: { status: "real", reason: "mcp_sse", httpStatus: 200 },
        },
      ],
    });
    const plain = normalized.rows[0]!;
    expect(plain).not.toHaveProperty("category");
    expect(plain).not.toHaveProperty("featured");
    expect(plain).not.toHaveProperty("official");

    const dbInput = catalogRowToDbInput(plain, { importBatchId: "batch-1" });
    expect(dbInput).not.toHaveProperty("category");
    expect(dbInput.metadata).not.toHaveProperty("curation");
  });
});
