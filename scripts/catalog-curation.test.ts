import { describe, expect, test } from "bun:test";
import {
  CURATED_CATALOG,
  canonicalMcpUrl,
  curatedCatalogByMcpUrl,
  curatedCatalogEntriesByMcpUrl,
  curatedCatalogFingerprintInput,
  parseCuratedCatalog,
} from "./catalog-curation";
import {
  catalogImportFingerprint,
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;

describe("curated catalog overlay document", () => {
  test("the committed overlay parses and keys entries by exact MCP URL", () => {
    expect(CURATED_CATALOG.version).toBe(1);
    expect(CURATED_CATALOG.entries.length).toBeGreaterThan(0);
    for (const entry of CURATED_CATALOG.entries) {
      expect(curatedCatalogEntriesByMcpUrl.get(entry.mcpUrl)).toBe(entry);
    }
  });

  test("every committed entry matches an importable row of the committed snapshot", async () => {
    // A curated entry that matches nothing silently curates nothing. Keep the
    // committed overlay and snapshot in lockstep.
    const normalized = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath));
    expect(normalized.unmatchedCurated).toEqual([]);
    expect(normalized.rows.filter((row) => row.curated)).toHaveLength(
      CURATED_CATALOG.entries.length,
    );
    for (const row of normalized.rows.filter((candidate) => candidate.curated)) {
      expect(
        catalogRowToDbInput(row, {
          importBatchId: "00000000-0000-4000-8000-000000000001",
        }).metadata,
      ).toMatchObject({ curation: { curated: true } });
    }
  });

  test("every committed entry that claims official is served from the row's own provider domain", async () => {
    // `official` is a checkable claim, not a review. Check it the same way the
    // importer's quality score does: endpoint host is the domain or a subdomain.
    const normalized = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath));
    const rowsByUrl = new Map(normalized.rows.map((row) => [row.mcpUrl, row]));
    for (const entry of CURATED_CATALOG.entries) {
      if (!entry.official) continue;
      const row = rowsByUrl.get(entry.mcpUrl);
      expect(row, entry.mcpUrl).toBeDefined();
      const host = new URL(entry.mcpUrl).hostname;
      const domain = row!.domain;
      expect(
        host === domain || host.endsWith(`.${domain}`),
        `${entry.mcpUrl} is marked official but ${host} is not under ${domain}`,
      ).toBe(true);
    }
  });

  test("every committed entry is written in canonical MCP URL form", () => {
    for (const entry of CURATED_CATALOG.entries) {
      expect(canonicalMcpUrl(entry.mcpUrl)).toBe(entry.mcpUrl);
    }
  });

  test("a name-only entry carries only the name", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [{ mcpUrl: "https://mcp.example.com/mcp", name: "Example" }],
    });
    expect(parsed.entries[0]).toEqual({ mcpUrl: "https://mcp.example.com/mcp", name: "Example" });
  });

  test("parses a declarative oauthProfile and rejects malformed ones loudly", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [
        {
          mcpUrl: "https://mcp.pinned.example/mcp",
          oauthProfile: {
            clientSource: "dcr",
            exactMcpUrl: "https://mcp.pinned.example/mcp",
            pinnedIssuerOrigins: ["https://auth.pinned.example"],
            sendResourceParameter: false,
            allowedOwnership: ["personal"],
            requestedScopes: ["files:read"],
            extraAuthorizeParams: { audience: "pinned" },
          },
        },
      ],
    });
    expect(parsed.entries[0]!.oauthProfile).toEqual({
      clientSource: "dcr",
      exactMcpUrl: "https://mcp.pinned.example/mcp",
      pinnedIssuerOrigins: ["https://auth.pinned.example"],
      sendResourceParameter: false,
      allowedOwnership: ["personal"],
      requestedScopes: ["files:read"],
      extraAuthorizeParams: { audience: "pinned" },
    });

    const entry = (oauthProfile: unknown) => ({
      version: 1,
      entries: [{ mcpUrl: "https://a.example/mcp", oauthProfile }],
    });
    expect(() => parseCuratedCatalog(entry("dcr"))).toThrow(/must be an object/);
    expect(() => parseCuratedCatalog(entry({ surprise: true }))).toThrow(/unknown key "surprise"/);
    expect(() => parseCuratedCatalog(entry({ clientSource: "magic" }))).toThrow(
      /clientSource must be one of/,
    );
    expect(() => parseCuratedCatalog(entry({ allowedOwnership: [] }))).toThrow(/allowedOwnership/);
    expect(() => parseCuratedCatalog(entry({ allowedOwnership: ["group"] }))).toThrow(
      /allowedOwnership/,
    );
    expect(() => parseCuratedCatalog(entry({ pinnedIssuerOrigins: ["nonsense"] }))).toThrow(
      /entries must be URLs/,
    );
    expect(() => parseCuratedCatalog(entry({ extraAuthorizeParams: { a: 1 } }))).toThrow(
      /string-to-string/,
    );
    for (const reserved of ["scope", "state", "redirect_uri", "code_challenge", "resource"]) {
      expect(() =>
        parseCuratedCatalog(entry({ extraAuthorizeParams: { [reserved]: "x" } })),
      ).toThrow(/reserved OAuth parameter/);
    }
  });

  test("parses presentation copy and rejects malformed shapes loudly", () => {
    const parsed = parseCuratedCatalog({
      version: 1,
      entries: [
        {
          mcpUrl: "https://mcp.copy.example/mcp",
          presentation: {
            providerName: "Copy",
            icon: "files",
            introduction: "Let agents work with Copy.",
            capabilities: [{ title: "Find things", description: "Search your Copy content." }],
            permissionSummary: "Copy asks for access you approve.",
            scopeLabels: { "copy:read": { label: "Read Copy", description: "Read your content." } },
          },
        },
      ],
    });
    expect(parsed.entries[0]!.presentation).toEqual({
      providerName: "Copy",
      icon: "files",
      introduction: "Let agents work with Copy.",
      capabilities: [{ title: "Find things", description: "Search your Copy content." }],
      permissionSummary: "Copy asks for access you approve.",
      scopeLabels: { "copy:read": { label: "Read Copy", description: "Read your content." } },
    });

    const entry = (presentation: unknown) => ({
      version: 1,
      entries: [{ mcpUrl: "https://a.example/mcp", presentation }],
    });
    expect(() => parseCuratedCatalog(entry("copy"))).toThrow(/must be an object/);
    expect(() => parseCuratedCatalog(entry({ surprise: true }))).toThrow(/unknown key "surprise"/);
    expect(() => parseCuratedCatalog(entry({ icon: "rocket" }))).toThrow(/icon must be one of/);
    expect(() => parseCuratedCatalog(entry({ capabilities: [] }))).toThrow(/1 to 8/);
    expect(() => parseCuratedCatalog(entry({ capabilities: [{ title: "x" }] }))).toThrow(
      /title, description/,
    );
    expect(() => parseCuratedCatalog(entry({ scopeLabels: { s: { label: "x" } } }))).toThrow(
      /label, description/,
    );
    expect(() => parseCuratedCatalog(entry({ introduction: " " }))).toThrow(/non-empty string/);
    // Contract bounds are enforced at review time, matching the definitions lane.
    expect(() => parseCuratedCatalog(entry({ introduction: "x".repeat(501) }))).toThrow(
      /at most 500/,
    );
    expect(() => parseCuratedCatalog(entry({ providerName: "x".repeat(121) }))).toThrow(
      /at most 120/,
    );
    expect(() =>
      parseCuratedCatalog(
        entry({
          capabilities: Array.from({ length: 9 }, (_, index) => ({
            title: `t${index}`,
            description: "d",
          })),
        }),
      ),
    ).toThrow(/1 to 8/);
    // An empty presentation is a reviewer error, not a silent no-op.
    expect(() => parseCuratedCatalog(entry({}))).toThrow(/at least one field/);
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
    [
      "unknown key (typo of official)",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", offical: true }] },
      /unknown key "offical"/,
    ],
    [
      "unknown key (typo of featured)",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp", feature: true }] },
      /unknown key "feature"/,
    ],
    [
      "non-canonical mcpUrl (trailing slash)",
      { version: 1, entries: [{ mcpUrl: "https://a.example/mcp/", name: "A" }] },
      /canonical form "https:\/\/a.example\/mcp"/,
    ],
    [
      "non-canonical mcpUrl (surrounding whitespace)",
      { version: 1, entries: [{ mcpUrl: "  https://a.example/mcp  ", name: "A" }] },
      /canonical form/,
    ],
    [
      "non-canonical mcpUrl (upper-case host)",
      { version: 1, entries: [{ mcpUrl: "https://A.EXAMPLE/mcp", name: "A" }] },
      /canonical form "https:\/\/a.example\/mcp"/,
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
    // The committed overlay expresses Linear's DCR-compatibility override as
    // profile data, and the importer carries it into the row metadata the
    // OAuth client resolves at start time.
    expect(linear.oauthProfile).toEqual({ clientSource: "dcr" });
    expect(dbInput.metadata).toMatchObject({ oauthProfile: { clientSource: "dcr" } });
  });

  test("the curated Gmail presentation flows through normalization into the DB metadata", () => {
    const normalized = normalizeCatalogSnapshot({
      generatedAt: "2026-08-17T00:00:00.000Z",
      importRows: [
        {
          domain: "gmailmcp.googleapis.com",
          name: "gmail",
          mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
          transport: "streamable-http",
          authKind: "oauth2",
          probe: { status: "real", reason: "auth_challenge", httpStatus: 401 },
        },
      ],
    });
    const gmail = normalized.rows[0]!;
    expect(gmail.presentation).toMatchObject({
      providerName: "Google",
      icon: "mail",
    });
    const dbInput = catalogRowToDbInput(gmail, { importBatchId: "batch-1" });
    expect(dbInput.metadata).toMatchObject({
      presentation: {
        providerName: "Google",
        icon: "mail",
        introduction: "Let agents work with the Gmail account you choose.",
      },
    });
    // The three curated scope labels cover exactly the row's scopesHint, so
    // every requested scope renders with a human label.
    const presentation = dbInput.metadata.presentation as {
      scopeLabels: Record<string, unknown>;
    };
    expect(Object.keys(presentation.scopeLabels).sort()).toEqual([...gmail.scopesHint].sort());
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

describe("curated overlay participates in the import fingerprint", () => {
  test("a semantic overlay change invalidates --if-changed while reformatting does not", async () => {
    const base = parseCuratedCatalog({
      version: 1,
      entries: [{ mcpUrl: "https://a.example/mcp", name: "A", featured: true }],
    });
    const reordered = parseCuratedCatalog({
      version: 1,
      entries: [{ featured: true, name: "A", mcpUrl: "https://a.example/mcp" }],
    });
    const changed = parseCuratedCatalog({
      version: 1,
      entries: [{ mcpUrl: "https://a.example/mcp", name: "A", featured: false }],
    });

    expect(curatedCatalogFingerprintInput(reordered)).toBe(curatedCatalogFingerprintInput(base));
    expect(curatedCatalogFingerprintInput(changed)).not.toBe(curatedCatalogFingerprintInput(base));

    const input = { snapshotPath, skipLogos: true };
    const fpBase = await catalogImportFingerprint({ ...input, curatedCatalog: base });
    const fpReordered = await catalogImportFingerprint({ ...input, curatedCatalog: reordered });
    const fpChanged = await catalogImportFingerprint({ ...input, curatedCatalog: changed });
    expect(fpReordered).toBe(fpBase);
    expect(fpChanged).not.toBe(fpBase);
  });
});

describe("unmatched curated entries are reported", () => {
  test("a curated URL that matches no importable row is listed, not dropped", () => {
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
    // Every committed curated URL is absent from this one-row snapshot.
    expect(normalized.unmatchedCurated).toEqual([...curatedCatalogEntriesByMcpUrl.keys()].sort());
    expect(normalized.rows).toHaveLength(1);
  });
});
