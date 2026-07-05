import { describe, expect, test } from "bun:test";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  storeLogoForRow,
  type CatalogIntegrationRow,
  type LogoStorage,
} from "./import-integrations-catalog";

const fixtureUrl = new URL("./fixtures/integrations-catalog-sample.json", import.meta.url);

describe("integrations.sh catalog import normalization", () => {
  test("normalizes the committed sample fixture and quarantines flagged suspicious URLs", async () => {
    const snapshot = await readSnapshotFile(fixtureUrl.pathname);
    const normalized = normalizeCatalogSnapshot(snapshot);

    expect(normalized.generatedAt).toBe("2026-07-03T23:41:44.132Z");
    expect(normalized.rows).toHaveLength(11);
    expect(normalized.quarantined).toHaveLength(1);
    expect(normalized.quarantined[0]?.row.domain).toBe("activepieces.com");
    expect(normalized.quarantined[0]?.reason).toContain("manual confirmation");

    const accessOwl = normalized.rows.find((row) => row.domain === "accessowl.com");
    expect(accessOwl?.tier).toBe("verified");
    expect(accessOwl?.authKind).toBe("oauth2");

    const acko = normalized.rows.find((row) => row.domain === "acko.com");
    expect(acko?.tier).toBe("community");
    expect(acko?.authKind).toBe("none");

    const bump = normalized.rows.filter((row) => row.domain === "bump.sh");
    expect(bump).toHaveLength(3);
    expect(new Set(bump.map((row) => row.mcpUrl)).size).toBe(3);
  });

  test("applies importability filters and dedupes by domain plus MCP URL", () => {
    const snapshot = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      importRows: [
        row({ domain: "valid.example", mcpUrl: "https://valid.example/mcp" }),
        row({ domain: "valid.example", mcpUrl: "https://valid.example/mcp" }),
        row({ domain: "templated.example", mcpUrl: "https://example.com/{APP_ID}/mcp" }),
        row({ domain: "redacted.example", mcpUrl: "https://example.com/mcp?key=REDACTED" }),
        row({ domain: "stdio.example", mcpUrl: "stdio://server" }),
        row({ domain: "sse.example", mcpUrl: "https://sse.example/mcp", transport: "sse" }),
        row({ domain: "snake-game-mcp.onrender.com", mcpUrl: "https://snake-game-mcp.onrender.com/mcp" }),
      ],
    };

    const normalized = normalizeCatalogSnapshot(snapshot);

    expect(normalized.rows.map((candidate) => candidate.domain)).toEqual(["valid.example"]);
    expect(normalized.skipped.map((skip) => skip.reason).sort()).toEqual([
      "dead_demo_domain",
      "duplicate_surface",
      "non_http_url",
      "templated_url",
      "templated_url",
      "transport_not_streamable_http",
    ].sort());
  });

  test("derives rows from raw API plus per-domain surface docs", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-07-03T00:00:00.000Z",
      api: [{
        domain: "raw.example",
        name: "Raw Example",
        icon: "https://integrations.sh/logo/raw.example",
      }],
      surfaceDocs: {
        "raw.example": {
          domain: "raw.example",
          credentials: {
            raw_oauth: {
              type: "oauth2",
              generateUrl: "https://raw.example/oauth/register",
              setup: "Register a client.",
              fields: { client_id: "string" },
            },
          },
          surfaces: [{
            type: "mcp",
            url: "https://raw.example/mcp",
            transports: ["sse", "streamable-http"],
            auth: { status: "required", entries: [{ use: [{ id: "raw_oauth" }], scopes: ["read"] }] },
            basis: { via: "detected" },
          }],
        },
      },
    });

    expect(normalized.rows).toHaveLength(1);
    expect(normalized.rows[0]).toMatchObject({
      domain: "raw.example",
      name: "Raw Example",
      mcpUrl: "https://raw.example/mcp",
      authKind: "oauth2",
      tier: "verified",
      provenance: "detected",
      scopesHint: ["read"],
    });
    expect(normalized.rows[0]?.credentialFacts[0]).toMatchObject({
      id: "raw_oauth",
      type: "oauth2",
      generateUrl: "https://raw.example/oauth/register",
    });
  });

  test("generates stable ids keyed by domain and MCP URL", () => {
    expect(catalogCapabilityId("bump.sh", "https://developers.bump.sh/mcp"))
      .toBe(catalogCapabilityId("bump.sh", "https://developers.bump.sh/mcp"));
    expect(catalogCapabilityId("bump.sh", "https://developers.bump.sh/mcp"))
      .not.toBe(catalogCapabilityId("bump.sh", "https://developers.bump.sh/doc/workspace/mcp"));
  });
});

describe("integrations.sh logo storage", () => {
  test("stores a valid image response under a self-hosted object key", async () => {
    const stored: Array<{ key: string; contentType: string; body: Uint8Array; sha256?: string | null }> = [];
    const storage: LogoStorage = {
      async putObject(args) {
        stored.push(args);
      },
    };
    const result = await storeLogoForRow(row({ domain: "logo.example", mcpUrl: "https://logo.example/mcp" }), {
      storage,
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "3" },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.path.startsWith("catalog-assets/integrations-sh/logos/logo.example/")).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.contentType).toBe("image/png");
    expect(stored[0]?.body.byteLength).toBe(3);
  });

  test("rejects non-image and oversized logos without throwing", async () => {
    const storage: LogoStorage = { async putObject() { throw new Error("should not store"); } };
    const nonImage = await storeLogoForRow(row({ domain: "text.example", mcpUrl: "https://text.example/mcp" }), {
      storage,
      fetchImpl: async () => new Response("not an image", { headers: { "content-type": "text/plain" } }),
    });
    expect(nonImage).toEqual({
      ok: false,
      sourceUrl: "https://integrations.sh/logo/text.example",
      reason: "invalid_content_type:text/plain",
    });

    const oversized = await storeLogoForRow(row({ domain: "large.example", mcpUrl: "https://large.example/mcp" }), {
      storage,
      fetchImpl: async () => new Response(new Uint8Array([]), {
        headers: { "content-type": "image/png", "content-length": String(512 * 1024 + 1) },
      }),
    });
    expect(oversized).toEqual({
      ok: false,
      sourceUrl: "https://integrations.sh/logo/large.example",
      reason: "image_too_large",
    });
  });

  test("tolerates logo fetch failures and unavailable storage", async () => {
    const noStorage = await storeLogoForRow(row({ domain: "nostore.example", mcpUrl: "https://nostore.example/mcp" }), {
      storage: null,
      fetchImpl: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    });
    expect(noStorage).toEqual({
      ok: false,
      sourceUrl: "https://integrations.sh/logo/nostore.example",
      reason: "object_storage_unavailable",
    });

    const failedFetch = await storeLogoForRow(row({ domain: "fail.example", mcpUrl: "https://fail.example/mcp" }), {
      storage: { async putObject() { throw new Error("should not store"); } },
      fetchImpl: async () => { throw new Error("network down"); },
    });
    expect(failedFetch.ok).toBe(false);
    expect(!failedFetch.ok && failedFetch.reason).toBe("fetch_failed:network down");
  });
});

function row(overrides: Partial<CatalogIntegrationRow> & { domain: string; mcpUrl: string }): CatalogIntegrationRow {
  return {
    domain: overrides.domain,
    name: overrides.name ?? overrides.domain,
    mcpUrl: overrides.mcpUrl,
    transport: overrides.transport ?? "streamable-http",
    authKind: overrides.authKind ?? "none",
    scopesHint: overrides.scopesHint ?? [],
    credentialFacts: overrides.credentialFacts ?? [],
    tier: overrides.tier ?? "community",
    provenance: overrides.provenance ?? "discovered",
    logoSourceUrl: overrides.logoSourceUrl ?? `https://integrations.sh/logo/${overrides.domain}`,
  };
}
