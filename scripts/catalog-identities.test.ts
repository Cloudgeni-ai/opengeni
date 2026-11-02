import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  CURATED_CATALOG,
  catalogIdentityEntriesByMcpUrl,
  curatedCatalogEntriesByMcpUrl,
  curatedCatalogFingerprintInput,
  parseCuratedCatalog,
} from "./catalog-curation";
import {
  VENDORED_LOGO_DIRECTORY,
  readVendoredLogoAsset,
  vendoredLogoEntriesByCapabilityId,
} from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  catalogImportFingerprint,
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  type CatalogIntegrationRow,
} from "./import-integrations-catalog";
import { screenCatalogRowLogos, screenSnapshotDocument } from "./screen-catalog-logos";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;
const BATCH = "00000000-0000-4000-8000-000000000001";
const RAW_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

const rowsPromise = readSnapshotFile(snapshotPath).then(
  (snapshot) => normalizeCatalogSnapshot(snapshot).rows,
);
const rowByDomain = async (domain: string): Promise<CatalogIntegrationRow> => {
  const row = (await rowsPromise).find((candidate) => candidate.domain === domain);
  if (!row) throw new Error(`no importable row for ${domain}`);
  return row;
};

describe("catalog identities: Google Search Console and well-known services", () => {
  test("Google Search Console imports with its product name and a self-hosted Search Console mark", async () => {
    const row = await rowByDomain("searchconsole.googleapis.com");
    expect(row.name).toBe("Google Search Console");
    expect(row.logoSourceUrl).toBe("https://cdn.simpleicons.org/googlesearchconsole");
    const vendored = vendoredLogoEntriesByCapabilityId.get(
      catalogCapabilityId(row.domain, row.mcpUrl),
    );
    expect(vendored?.sourceUrl).toBe(row.logoSourceUrl!);
    const asset = await readVendoredLogoAsset(vendored!, VENDORED_LOGO_DIRECTORY);
    expect(asset.ok).toBe(true);
    expect(new TextDecoder().decode(asset.ok ? asset.bytes : new Uint8Array())).toContain(
      "<title>Google Search Console</title>",
    );
    const input = catalogRowToDbInput(row, { importBatchId: BATCH });
    expect(input.name).toBe("Google Search Console");
    expect(input.homepageUrl).toBe("https://developers.google.com/webmaster-tools/about");
  });

  test.each([
    ["analyticsadmin.googleapis.com", "Google Analytics Admin", "googleanalytics"],
    ["bigquery.googleapis.com", "Google BigQuery", "googlebigquery"],
    ["run.googleapis.com", "Google Cloud Run", "googlecloud"],
    ["pubsub.googleapis.com", "Google Cloud Pub/Sub", "googlepubsub"],
    ["playdeveloperreporting.googleapis.com", "Google Play Developer Reporting", "googleplay"],
    ["facebook.com", "Meta Social Technologies MCP", "meta"],
  ])("%s is %s with the %s mark", async (domain, name, slug) => {
    const row = await rowByDomain(domain);
    expect(row.name).toBe(name);
    expect(row.logoSourceUrl).toBe(`https://cdn.simpleicons.org/${slug}`);
  });

  test.each([
    ["algolia.com", "Algolia"],
    ["newrelic.com", "New Relic"],
    ["cal.com", "Cal.com"],
    ["incident.io", "incident.io"],
    ["x.com", "X MCP"],
    ["leadconnectorhq.com", "HighLevel (ChatGPT endpoint)"],
    ["smartbear.com", "BugSnag"],
  ])("%s shows its own name, %s, and keeps a vendored mark", async (domain, name) => {
    const row = await rowByDomain(domain);
    expect(row.name).toBe(name);
    expect(vendoredLogoEntriesByCapabilityId.has(catalogCapabilityId(row.domain, row.mcpUrl))).toBe(
      true,
    );
  });

  test("every importable Google API row has a human name and a mark, never a hostname or a letter", async () => {
    const google = (await rowsPromise).filter((row) => row.domain.endsWith(".googleapis.com"));
    expect(google.length).toBeGreaterThanOrEqual(40);
    for (const row of google) {
      expect(RAW_HOSTNAME.test(row.name), `${row.domain} is named "${row.name}"`).toBe(false);
      // Gmail, Drive and Calendar deliberately keep their reviewed icon and
      // monogram (curated `logoSourceUrl: null`); every other Google row ships a mark.
      if (curatedCatalogEntriesByMcpUrl.get(row.mcpUrl)?.logoSourceUrl === null) continue;
      expect(
        vendoredLogoEntriesByCapabilityId.has(catalogCapabilityId(row.domain, row.mcpUrl)),
        `${row.domain} has no vendored mark`,
      ).toBe(true);
    }
  });

  test("an identity changes only the name and logo: no curation, promotion, tier or policy", async () => {
    const rows = await rowsPromise;
    const raw = (await readSnapshotFile(snapshotPath)) as { importRows: Record<string, unknown>[] };
    const rawByUrl = new Map(raw.importRows.map((row) => [String(row.mcpUrl), row]));
    let checked = 0;
    for (const row of rows) {
      if (!catalogIdentityEntriesByMcpUrl.has(row.mcpUrl)) continue;
      checked += 1;
      const source = rawByUrl.get(row.mcpUrl)!;
      expect(row.curated, row.domain).toBeUndefined();
      expect(row.featured, row.domain).toBeUndefined();
      expect(row.official, row.domain).toBeUndefined();
      expect(row.tier, row.domain).toBe(source.tier as CatalogIntegrationRow["tier"]);
      expect(row.authKind, row.domain).toBe(source.authKind as CatalogIntegrationRow["authKind"]);
      expect(row.name, row.domain).toBe(
        catalogIdentityEntriesByMcpUrl.get(row.mcpUrl)!.name ?? String(source.name),
      );
      const metadata = catalogRowToDbInput(row, { importBatchId: BATCH }).metadata;
      expect(metadata, row.domain).not.toHaveProperty("curation");
    }
    expect(checked).toBe(CURATED_CATALOG.identities.length);
  });

  test("the snapshot records no generated letter as a row's logo", async () => {
    const document = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      logoScreen: { placeholderRows: Array<{ domain: string; mcpUrl: string }> };
      importRows: Array<{ domain: string; mcpUrl: string; logoSourceUrl: string | null }>;
    };
    expect(document.logoScreen.placeholderRows.length).toBeGreaterThan(0);
    const byKey = new Map(document.importRows.map((row) => [`${row.domain}\n${row.mcpUrl}`, row]));
    for (const placeholder of document.logoScreen.placeholderRows) {
      expect(byKey.get(`${placeholder.domain}\n${placeholder.mcpUrl}`)?.logoSourceUrl).toBeNull();
    }
    const searchConsole = document.importRows.find(
      (row) => row.domain === "searchconsole.googleapis.com",
    );
    expect(searchConsole?.logoSourceUrl).toBeNull();
  });
});

describe("identity overlay document", () => {
  const identity = (extra: Record<string, unknown> = {}) => ({
    mcpUrl: "https://mcp.example.com/mcp",
    name: "Example",
    notes: ["Name as https://example.com writes it."],
    ...extra,
  });

  test("parses name, logo, homepage and notes", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [],
      identities: [
        identity({
          logoSourceUrl: "https://cdn.simpleicons.org/example",
          homepageUrl: "https://example.com",
        }),
        { mcpUrl: "https://b.example/mcp", logoSourceUrl: null, notes: ["No reusable mark."] },
      ],
    });
    expect(parsed.identities).toEqual([
      {
        mcpUrl: "https://mcp.example.com/mcp",
        name: "Example",
        logoSourceUrl: "https://cdn.simpleicons.org/example",
        homepageUrl: "https://example.com",
        notes: ["Name as https://example.com writes it."],
      },
      { mcpUrl: "https://b.example/mcp", logoSourceUrl: null, notes: ["No reusable mark."] },
    ]);
  });

  test.each([
    ["an unknown key", identity({ featured: true }), /unknown key "featured"/],
    ["a non-https logo", identity({ logoSourceUrl: "http://x.example/logo.svg" }), /https URL/],
    ["no notes", identity({ notes: [] }), /notes must record/],
    [
      "neither name nor logo",
      { mcpUrl: "https://a.example/mcp", notes: ["x"] },
      /name or logoSourceUrl/,
    ],
    ["an untrimmed name", identity({ name: " Example" }), /trimmed/],
    ["a non-canonical URL", identity({ mcpUrl: "https://mcp.example.com/mcp/" }), /canonical form/],
  ])("rejects %s", (_label, entry, error) => {
    expect(() => parseCuratedCatalog({ version: 1, entries: [], identities: [entry] })).toThrow(
      error,
    );
  });

  test("rejects an identity for a curated row and duplicate identities", () => {
    expect(() =>
      parseCuratedCatalog({
        version: 1,
        entries: [{ mcpUrl: "https://mcp.example.com/mcp", name: "Curated" }],
        identities: [identity()],
      }),
    ).toThrow(/already curated/);
    expect(() =>
      parseCuratedCatalog({ version: 1, entries: [], identities: [identity(), identity()] }),
    ).toThrow(/duplicate identity/);
    expect(() => parseCuratedCatalog({ version: 1, entries: [], identitys: [] })).toThrow(
      /unknown top-level key "identitys"/,
    );
  });

  test("an identity change invalidates --if-changed; an empty list keeps the old fingerprint", async () => {
    const without = parseCuratedCatalog({ version: 1, entries: [] });
    const empty = parseCuratedCatalog({ version: 1, entries: [], identities: [] });
    const named = parseCuratedCatalog({ version: 1, entries: [], identities: [identity()] });
    const renamed = parseCuratedCatalog({
      version: 1,
      entries: [],
      identities: [identity({ name: "Example Cloud" })],
    });
    expect(curatedCatalogFingerprintInput(empty)).toBe(curatedCatalogFingerprintInput(without));
    expect(curatedCatalogFingerprintInput(without)).toBe(
      JSON.stringify({ version: 1, entries: [] }),
    );
    const input = { snapshotPath, skipLogos: true };
    const fpNamed = await catalogImportFingerprint({ ...input, curatedCatalog: named });
    const fpRenamed = await catalogImportFingerprint({ ...input, curatedCatalog: renamed });
    const fpWithout = await catalogImportFingerprint({ ...input, curatedCatalog: without });
    expect(fpNamed).not.toBe(fpWithout);
    expect(fpRenamed).not.toBe(fpNamed);
  });
});

describe("logo screening", () => {
  const LETTER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect fill="#f5f5f5" height="200" width="200"/><text x="100" y="100">S</text></svg>`;
  const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>`;
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/down.example")) throw new Error("connect ECONNREFUSED");
    return new Response(url.endsWith("/letter.example") ? LETTER : MARK, {
      headers: { "content-type": "image/svg+xml" },
    });
  };
  const row = (
    domain: string,
    logoSourceUrl: string | null = `https://integrations.sh/logo/${domain}`,
  ) => ({
    domain,
    mcpUrl: `https://${domain}/mcp`,
    logoSourceUrl,
  });

  test("clears only a fetched generated letter; real and unreachable logos stay", async () => {
    const rows = [
      row("letter.example"),
      row("mark.example"),
      row("down.example"),
      row("none.example", null),
    ];
    const { rows: screened, summary } = await screenCatalogRowLogos(rows, {
      fetchImpl,
      now: () => new Date("2026-11-02T00:00:00.000Z"),
    });
    expect(screened.map((entry) => entry.logoSourceUrl)).toEqual([
      null,
      "https://integrations.sh/logo/mark.example",
      "https://integrations.sh/logo/down.example",
      null,
    ]);
    expect(rows[0]!.logoSourceUrl).toBe("https://integrations.sh/logo/letter.example");
    expect(summary).toEqual({
      screenedAt: "2026-11-02T00:00:00.000Z",
      checked: 3,
      placeholderRows: [{ domain: "letter.example", mcpUrl: "https://letter.example/mcp" }],
      unreachable: 1,
    });
  });

  test("a re-screen keeps earlier placeholder rows in the header and the header before the rows", async () => {
    const first = await screenSnapshotDocument(
      {
        generatedAt: "g",
        importRows: [row("letter.example"), row("mark.example")],
        skipped: [],
        quarantined: [],
      },
      { fetchImpl },
    );
    const second = await screenSnapshotDocument(first.document, { fetchImpl });
    expect(Object.keys(second.document)).toEqual([
      "generatedAt",
      "logoScreen",
      "importRows",
      "skipped",
      "quarantined",
    ]);
    expect(second.summary.checked).toBe(1);
    expect(second.summary.placeholderRows).toEqual([
      { domain: "letter.example", mcpUrl: "https://letter.example/mcp" },
    ]);
  });
});
