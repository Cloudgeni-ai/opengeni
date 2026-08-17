import { describe, expect, test } from "bun:test";
import {
  catalogCandidateRows,
  normalizeCatalogSnapshot,
  type NormalizedCatalogSnapshot,
} from "./import-integrations-catalog";
import { probeCatalogSnapshot } from "./integrations-catalog-probe";
import {
  buildRefreshedSnapshot,
  hydrateSurfaceDocs,
  mergeCandidateRows,
  parseArgs,
  parseCommittedRows,
} from "./refresh-integrations-catalog";

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

  test("accepts a discovery document whose surfaces is one bare surface object", async () => {
    const hydration = await hydrateSurfaceDocs(
      { ...INDEX, data: [INDEX.data[0]] },
      "https://integrations.example/api.json",
      async () => ({ result: { ...ACME_DOC, surfaces: ACME_DOC.surfaces[0] } }),
    );
    expect(hydration).toMatchObject({ domains: 1, fetched: 1, failed: [] });
    expect(catalogCandidateRows(hydration.snapshot).map((row) => row.mcpUrl)).toEqual([
      "https://mcp.acme.example/mcp",
    ]);
  });

  test("rejects a discovery document whose surfaces is neither array nor object", async () => {
    const hydration = await hydrateSurfaceDocs(
      { ...INDEX, data: [INDEX.data[0]] },
      "https://integrations.example/api.json",
      async () => ({ result: { ...ACME_DOC, surfaces: "nope" } }),
    );
    expect(hydration).toMatchObject({
      domains: 1,
      fetched: 0,
      failed: [{ domain: "acme.example", reason: "malformed_discovery_document" }],
    });
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
    expect(merged.retained).toEqual([
      { domain: "reviewed.example", mcpUrl: "https://mcp.reviewed.example/mcp" },
    ]);
    expect(merged.candidates).toEqual([
      ...upstream,
      { domain: "reviewed.example", mcpUrl: "https://mcp.reviewed.example/mcp" },
    ]);
  });

  test("fails loudly on a committed row with a malformed mcpUrl", () => {
    expect(() =>
      mergeCandidateRows([], [{ domain: "broken.example", mcpUrl: "not a url" }]),
    ).toThrow(/committed snapshot row for broken.example has an invalid mcpUrl "not a url"/);
    expect(() => mergeCandidateRows([], [{ domain: "broken.example" }])).toThrow(
      /committed snapshot row for broken.example has no string mcpUrl/,
    );
  });

  test("fails loudly on an unparseable or shapeless committed snapshot", () => {
    expect(() => parseCommittedRows("{ not json", "data/x.json")).toThrow(
      /committed snapshot data\/x.json is not valid JSON/,
    );
    expect(() => parseCommittedRows(JSON.stringify({ rows: [] }), "data/x.json")).toThrow(
      /committed snapshot data\/x.json has no importRows array/,
    );
    expect(() => parseCommittedRows(JSON.stringify({ importRows: [1] }), "data/x.json")).toThrow(
      /importRows\[0\] is not an object/,
    );
    expect(parseCommittedRows(JSON.stringify({ importRows: [{ domain: "a" }] }), "x")).toEqual([
      { domain: "a" },
    ]);
  });

  test("parses --allow-shrink and --no-retain", () => {
    expect(parseArgs([])).toMatchObject({ retainCommittedRows: true, allowShrink: false });
    expect(parseArgs(["--allow-shrink", "--no-retain", "--output", "out.json"])).toMatchObject({
      retainCommittedRows: false,
      allowShrink: true,
      outputPath: "out.json",
    });
  });
});

const REAL_MCP_RESPONSE = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function committedRow(domain: string, mcpUrl: string) {
  return {
    domain,
    name: domain,
    mcpUrl,
    transport: "streamable-http",
    authKind: "none",
    scopesHint: [],
    credentialFacts: [],
    tier: "community",
    provenance: "discovered",
    logoSourceUrl: null,
    probe: { status: "real", reason: "mcp_json_rpc", httpStatus: 200 },
  };
}

function stubProbe(liveHosts: string[]) {
  return (normalized: NormalizedCatalogSnapshot) =>
    probeCatalogSnapshot(normalized, {
      transientRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        return liveHosts.some((host) => url.includes(host))
          ? REAL_MCP_RESPONSE()
          : new Response("not found", { status: 404 });
      },
    });
}

describe("catalog refresh snapshot build", () => {
  const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");
  const baseInput = {
    rawSnapshot: INDEX,
    sourceUrl: "https://integrations.example/api.json",
    hydrate: true,
    retainCommittedRows: true,
    allowShrink: false,
    outputPath: "data/catalog/test-snapshot.json",
  };
  const acmeOnlyDoc = async () => ({ result: ACME_DOC });

  test("refuses to overwrite the committed file when upstream normalizes to zero rows", async () => {
    await expect(
      buildRefreshedSnapshot(
        { ...baseInput, committedRows: [] },
        {
          fetchDoc: async () => {
            throw new Error("HTTP 503");
          },
          probe: async () => {
            throw new Error("must not probe");
          },
        },
      ),
    ).rejects.toThrow(
      /zero candidate rows \(3 domains, 0 discovery documents fetched, 3 failed\); refusing to overwrite data\/catalog\/test-snapshot.json/,
    );
  });

  test("records retention decisions in the snapshot header", async () => {
    const committedRows = [
      committedRow("acme.example", "https://mcp.acme.example/mcp"),
      committedRow("reviewed.example", "https://mcp.reviewed.example/mcp"),
      committedRow("dead.example", "https://mcp.dead.example/mcp"),
    ];
    const result = await buildRefreshedSnapshot(
      { ...baseInput, committedRows },
      {
        fetchDoc: acmeOnlyDoc,
        probe: stubProbe(["mcp.acme.example", "mcp.reviewed.example"]),
        now: () => FIXED_NOW,
      },
    );
    expect(result.upstreamCandidates).toBe(1);
    expect(result.document).toMatchObject({
      generatedAt: INDEX.generatedAt,
      source: "integrations.sh",
      cleanedAt: FIXED_NOW.toISOString(),
      probe: { kept: 2, dropped: 1, real: 2, unverified: 0, googleapisDropped: 0 },
      retention: {
        candidateRows: 2,
        retainedRows: [{ domain: "reviewed.example", mcpUrl: "https://mcp.reviewed.example/mcp" }],
        droppedRows: [
          {
            domain: "dead.example",
            mcpUrl: "https://mcp.dead.example/mcp",
            reason: "probe_http_not_found",
          },
        ],
      },
    });
    expect(result.document.importRows.map((row) => row.mcpUrl)).toEqual([
      "https://mcp.acme.example/mcp",
      "https://mcp.reviewed.example/mcp",
    ]);
    expect(Object.keys(result.document)).toEqual([
      "generatedAt",
      "source",
      "cleanedAt",
      "cleaning",
      "probe",
      "retention",
      "importRows",
      "skipped",
      "quarantined",
    ]);
  });

  test("--no-retain re-probes only upstream rows but keeps the shrink floor", async () => {
    const committedRows = [
      committedRow("acme.example", "https://mcp.acme.example/mcp"),
      committedRow("reviewed.example", "https://mcp.reviewed.example/mcp"),
    ];
    const result = await buildRefreshedSnapshot(
      { ...baseInput, committedRows, retainCommittedRows: false },
      { fetchDoc: acmeOnlyDoc, probe: stubProbe(["mcp.acme.example"]) },
    );
    expect(result.document.retention).toEqual({
      candidateRows: 0,
      retainedRows: [],
      droppedRows: [],
    });
    expect(result.document.importRows.map((row) => row.mcpUrl)).toEqual([
      "https://mcp.acme.example/mcp",
    ]);
  });

  test("falls back to the current time when upstream carries no generatedAt", async () => {
    const { generatedAt: _omitted, ...indexWithoutDate } = INDEX;
    const result = await buildRefreshedSnapshot(
      { ...baseInput, rawSnapshot: indexWithoutDate, committedRows: null },
      { fetchDoc: acmeOnlyDoc, probe: stubProbe(["mcp.acme.example"]), now: () => FIXED_NOW },
    );
    expect(result.document.generatedAt).toBe(FIXED_NOW.toISOString());
  });

  test("refuses to write a snapshot that keeps fewer than half the committed rows", async () => {
    const committedRows = [
      committedRow("acme.example", "https://mcp.acme.example/mcp"),
      committedRow("one.example", "https://mcp.one.example/mcp"),
      committedRow("two.example", "https://mcp.two.example/mcp"),
      committedRow("three.example", "https://mcp.three.example/mcp"),
    ];
    // Probe outage: every endpoint fails, including the upstream row.
    const outage = stubProbe([]);
    await expect(
      buildRefreshedSnapshot(
        { ...baseInput, committedRows },
        { fetchDoc: acmeOnlyDoc, probe: outage },
      ),
    ).rejects.toThrow(
      /refresh kept 0 rows but the committed snapshot has 4 \(floor 2\).*pass --allow-shrink to override/,
    );

    // Exactly the floor is allowed: 2 of 4 kept.
    const atFloor = await buildRefreshedSnapshot(
      { ...baseInput, committedRows },
      { fetchDoc: acmeOnlyDoc, probe: stubProbe(["mcp.acme.example", "mcp.one.example"]) },
    );
    expect(atFloor.document.probe.kept).toBe(2);

    // The override writes the shrunken snapshot.
    const forced = await buildRefreshedSnapshot(
      { ...baseInput, committedRows, allowShrink: true },
      { fetchDoc: acmeOnlyDoc, probe: outage },
    );
    expect(forced.document.importRows).toEqual([]);
    expect(forced.document.retention.droppedRows.map((row) => row.domain)).toEqual([
      "one.example",
      "three.example",
      "two.example",
    ]);

    // A first refresh with no committed file has no floor.
    const first = await buildRefreshedSnapshot(
      { ...baseInput, committedRows: null },
      { fetchDoc: acmeOnlyDoc, probe: outage },
    );
    expect(first.document.importRows).toEqual([]);
  });
});
