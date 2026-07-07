import { describe, expect, test } from "bun:test";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  storeLogoForRow,
  type CatalogIntegrationRow,
  type LogoStorage,
} from "./import-integrations-catalog";
import { probeCatalogSnapshot, probeMcpEndpoint } from "./integrations-catalog-probe";

const fixtureUrl = new URL("./fixtures/integrations-catalog-sample.json", import.meta.url);

describe("integrations.sh catalog import normalization", () => {
  test("normalizes the committed sample fixture and quarantines flagged suspicious URLs", async () => {
    const snapshot = await readSnapshotFile(fixtureUrl.pathname);
    const normalized = normalizeCatalogSnapshot(snapshot);

    expect(normalized.generatedAt).toBe("2026-07-03T23:41:44.132Z");
    expect(normalized.rows).toHaveLength(8);
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
    expect(bump).toHaveLength(1);
    expect(bump[0]?.mcpUrl).toBe("https://developers.bump.sh/doc/portal/mcp");
    expect(normalized.skipped.filter((skip) => skip.domain === "bump.sh" && skip.reason === "duplicate_domain_name"))
      .toHaveLength(2);
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

  test("strips raw control characters from all string fields", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-07-03T00:00:00.000Z",
      importRows: [
        row({
          domain: "control.example\u0000",
          name: "Control\u0007 Example",
          mcpUrl: "https://control.example/mcp\u0001",
          scopesHint: ["read\u0002write", "keeps\ttab\nnewline"],
          credentialFacts: [{ setup: "bad\u001Fvalue" }],
        }),
      ],
    });

    expect(normalized.cleaning.controlCharacterFields).toBe(6);
    expect(normalized.rows[0]).toMatchObject({
      domain: "control.example",
      name: "Control Example",
      mcpUrl: "https://control.example/mcp",
      scopesHint: ["readwrite", "keeps\ttab\nnewline"],
      credentialFacts: [{ setup: "badvalue" }],
    });
  });

  test("dedupes junk clusters by normalized domain plus name and keeps the best row", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-07-03T00:00:00.000Z",
      importRows: [
        row({
          domain: "games.example",
          name: "ABC Word Search",
          mcpUrl: "https://games.example/discovered/mcp",
          provenance: "discovered",
          logoSourceUrl: null,
        }),
        row({
          domain: "GAMES.EXAMPLE",
          name: "abc   word search",
          mcpUrl: "https://games.example/detected/mcp",
          provenance: "detected",
          logoSourceUrl: "https://integrations.sh/logo/games.example",
        }),
        row({
          domain: "games.example",
          name: "ABC Word Search",
          mcpUrl: "https://games.example/other/mcp",
          provenance: "discovered",
          logoSourceUrl: "https://integrations.sh/logo/games.example",
        }),
      ],
    });

    expect(normalized.rows).toHaveLength(1);
    expect(normalized.rows[0]?.mcpUrl).toBe("https://games.example/detected/mcp");
    expect(normalized.cleaning.duplicateDomainNameRows).toBe(2);
    expect(normalized.skipped.filter((skip) => skip.reason === "duplicate_domain_name")).toHaveLength(2);
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

describe("integrations.sh MCP endpoint probe", () => {
  test("classifies a 200 JSON-RPC initialize response as real MCP", async () => {
    const outcome = await probeMcpEndpoint("https://mcp.example/mcp", {
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "Example", version: "1" } },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    expect(outcome).toMatchObject({ status: "real", reason: "mcp_json_rpc", httpStatus: 200 });
  });

  test("classifies auth-gated MCP endpoints with WWW-Authenticate as real", async () => {
    const outcome = await probeMcpEndpoint("https://linear.example/mcp", {
      fetchImpl: async () => new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\"https://linear.example/.well-known/oauth-protected-resource\"" },
      }),
    });

    expect(outcome).toMatchObject({ status: "real", reason: "auth_challenge", httpStatus: 401 });
  });

  test("classifies 404s, HTML, generic JSON, and DNS failures as junk", async () => {
    await expect(probeMcpEndpoint("https://missing.example/mcp", {
      fetchImpl: async () => new Response("not found", { status: 404 }),
    })).resolves.toMatchObject({ status: "junk", reason: "http_not_found" });

    await expect(probeMcpEndpoint("https://html.example/mcp", {
      fetchImpl: async () => new Response("<!doctype html><title>No MCP</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    })).resolves.toMatchObject({ status: "junk", reason: "html_response" });

    await expect(probeMcpEndpoint("https://api.example/mcp", {
      fetchImpl: async () => new Response(JSON.stringify({ kind: "gmail#profile", emailAddress: "me@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })).resolves.toMatchObject({ status: "junk", reason: "non_mcp_json" });

    await expect(probeMcpEndpoint("https://dns.example/mcp", {
      fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND dns.example"); },
    })).resolves.toMatchObject({ status: "junk", reason: "connection_error" });
  });

  test("filters junk rows while keeping unverified rows with probe metadata", async () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-07-03T00:00:00.000Z",
      importRows: [
        row({ domain: "real.example", mcpUrl: "https://real.example/mcp" }),
        row({ domain: "gmail.googleapis.com", mcpUrl: "https://gmail.googleapis.com/mcp" }),
        row({ domain: "maybe.example", mcpUrl: "https://maybe.example/mcp" }),
      ],
    });
    const probed = await probeCatalogSnapshot(normalized, {
      concurrency: 2,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("real.example")) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("googleapis.com")) {
          return new Response("not found", { status: 404 });
        }
        return new Response("busy", { status: 503 });
      },
    });

    expect(probed.rows.map((candidate) => candidate.domain)).toEqual(["maybe.example", "real.example"]);
    expect(probed.probe).toMatchObject({ kept: 2, dropped: 1, real: 1, unverified: 1, googleapisDropped: 1 });
    expect(probed.rows.find((candidate) => candidate.domain === "maybe.example")?.probe)
      .toMatchObject({ status: "unverified", reason: "http_status", httpStatus: 503 });
    expect(probed.skipped.find((skip) => skip.domain === "gmail.googleapis.com")).toMatchObject({
      reason: "probe_http_not_found",
    });
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
