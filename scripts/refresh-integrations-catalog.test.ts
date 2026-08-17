import { describe, expect, test } from "bun:test";
import { catalogCandidateRows, normalizeCatalogSnapshot } from "./import-integrations-catalog";
import { hydrateSurfaceDocs, mergeCandidateRows } from "./refresh-integrations-catalog";

const INDEX = {
  version: 1,
  generatedAt: "2026-07-08T01:44:23.703Z",
  data: [
    { id: "mcp/acme", kind: "mcp", name: "Acme", domain: "acme.example", icon: "https://i/acme" },
    { id: "mcp/acme-alias", kind: "mcp", name: "Acme alias", domain: "acme-alias.example" },
    { id: "openapi/acme", kind: "openapi", name: "Acme API", domain: "acme.example" },
    { id: "mcp/missing", kind: "mcp", name: "Missing", domain: "missing.example" },
  ],
};

const ACME_DOC = {
  version: 3,
  domain: "acme.example",
  credentials: { acme_oauth: { type: "oauth2", label: "Acme OAuth" } },
  surfaces: [
    {
      slug: "acme-mcp",
      name: "Acme MCP",
      type: "mcp",
      url: "https://mcp.acme.example/mcp",
      transports: ["streamable-http"],
      basis: { via: "detected" },
      auth: { status: "required", entries: [{ use: [{ id: "acme_oauth" }] }] },
    },
    { slug: "acme-api", name: "Acme API", type: "http", url: "https://api.acme.example" },
  ],
};

describe("catalog refresh upstream hydration", () => {
  test("fetches one discovery document per distinct MCP domain and dedupes alias answers", async () => {
    const requested: string[] = [];
    const hydration = await hydrateSurfaceDocs(
      INDEX,
      "https://integrations.example/api.json",
      async (url) => {
        requested.push(url);
        if (url.endsWith("/missing.example/discovery")) {
          throw new Error("HTTP 404");
        }
        // The alias domain answers with the canonical owner's document.
        return { result: ACME_DOC };
      },
    );

    expect(requested).toEqual([
      "https://integrations.example/api/acme-alias.example/discovery",
      "https://integrations.example/api/acme.example/discovery",
      "https://integrations.example/api/missing.example/discovery",
    ]);
    expect(hydration).toMatchObject({ domains: 3, fetched: 1 });
    expect(hydration.failed).toEqual([{ domain: "missing.example", reason: "HTTP 404" }]);

    const candidates = catalogCandidateRows(hydration.snapshot);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      domain: "acme.example",
      name: "Acme",
      mcpUrl: "https://mcp.acme.example/mcp",
      authKind: "oauth2",
      provenance: "detected",
      logoAsset: "https://i/acme",
    });

    const normalized = normalizeCatalogSnapshot(hydration.snapshot, {
      allowUnprobedCandidates: true,
    });
    expect(normalized.rows.map((row) => row.mcpUrl)).toEqual(["https://mcp.acme.example/mcp"]);
  });

  test("leaves an index that already embeds surface documents untouched", async () => {
    const embedded = { ...INDEX, surfaceDocs: [ACME_DOC] };
    const hydration = await hydrateSurfaceDocs(
      embedded,
      "https://integrations.example/api.json",
      async () => {
        throw new Error("must not fetch");
      },
    );
    expect(hydration).toEqual({ snapshot: embedded, domains: 0, fetched: 0, failed: [] });
  });

  test("retains committed rows whose endpoint upstream no longer lists", () => {
    const upstream = [
      { domain: "acme.example", mcpUrl: "https://mcp.acme.example/mcp/" },
      { domain: "broken.example", mcpUrl: "not a url" },
    ];
    const committed = [
      { domain: "acme-old.example", mcpUrl: "https://mcp.acme.example/mcp" },
      { domain: "reviewed.example", mcpUrl: "https://mcp.reviewed.example/mcp" },
    ];
    const merged = mergeCandidateRows(upstream, committed);
    expect(merged.retained).toBe(1);
    expect(merged.candidates).toEqual([
      ...upstream,
      { domain: "reviewed.example", mcpUrl: "https://mcp.reviewed.example/mcp" },
    ]);
  });
});
