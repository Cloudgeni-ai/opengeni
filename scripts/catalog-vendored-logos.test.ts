import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURATED_CATALOG, curatedCatalogEntriesByMcpUrl } from "./catalog-curation";
import {
  VENDORED_LOGO_DIRECTORY,
  VENDORED_LOGO_MANIFEST,
  catalogLogoObjectKey,
  parseVendoredLogoManifest,
  readVendoredLogoAsset,
  serializeVendoredLogoManifest,
  validateLogoAsset,
  vendoredLogoManifestFingerprintInput,
  vendoredLogosByCapabilityId,
  type VendoredLogoEntry,
  type VendoredLogoManifest,
} from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  catalogImportFingerprint,
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  resolveCatalogRowLogo,
  type CatalogIntegrationRow,
  type LogoStorage,
} from "./import-integrations-catalog";
import { curatedLogoCandidates, vendorCatalogLogos } from "./vendor-catalog-logos";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;
const fixtureUrl = new URL("./fixtures/integrations-catalog-sample.json", import.meta.url);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function row(
  overrides: Partial<CatalogIntegrationRow> & { domain: string; mcpUrl: string },
): CatalogIntegrationRow {
  return {
    domain: overrides.domain,
    name: overrides.name ?? overrides.domain,
    mcpUrl: overrides.mcpUrl,
    transport: "streamable-http",
    authKind: overrides.authKind ?? "none",
    scopesHint: [],
    credentialFacts: [],
    tier: overrides.tier ?? "community",
    provenance: overrides.provenance ?? "discovered",
    logoSourceUrl:
      overrides.logoSourceUrl !== undefined
        ? overrides.logoSourceUrl
        : `https://integrations.sh/logo/${overrides.domain}`,
  };
}

function entryFor(
  target: CatalogIntegrationRow,
  bytes: Uint8Array,
  overrides: Partial<VendoredLogoEntry> = {},
): VendoredLogoEntry {
  return {
    capabilityId: catalogCapabilityId(target.domain, target.mcpUrl),
    domain: target.domain,
    mcpUrl: target.mcpUrl,
    file: `${target.domain.replace(/[^a-z0-9.-]+/g, "-")}.png`,
    sourceUrl: target.logoSourceUrl ?? `https://integrations.sh/logo/${target.domain}`,
    sha256: sha256(bytes),
    contentType: "image/png",
    sizeBytes: bytes.byteLength,
    fetchedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function recordingStorage(): {
  storage: LogoStorage;
  stored: Array<{ key: string; contentType: string; body: Uint8Array }>;
} {
  const stored: Array<{ key: string; contentType: string; body: Uint8Array }> = [];
  return {
    storage: {
      async putObject(args) {
        stored.push({ key: args.key, contentType: args.contentType, body: args.body });
      },
    },
    stored,
  };
}

function refusingFetch(counter: { fetches: number }) {
  return async () => {
    counter.fetches += 1;
    throw new Error("network must not be used");
  };
}

describe("vendored logo resolution", () => {
  let directory: string;
  const curatedRow = row({ domain: "curated.example", mcpUrl: "https://curated.example/mcp" });
  const uncuratedRow = row({ domain: "tail.example", mcpUrl: "https://tail.example/mcp" });
  const suppressedRow = row({
    domain: "nologo.example",
    mcpUrl: "https://nologo.example/mcp",
    logoSourceUrl: null,
  });
  let manifest: VendoredLogoManifest;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "opengeni-vendored-logos-"));
    const curatedEntry = entryFor(curatedRow, PNG_BYTES);
    // A vendored file that somehow exists for a suppressed row must be ignored.
    const suppressedEntry = entryFor(suppressedRow, PNG_BYTES, {
      sourceUrl: "https://integrations.sh/logo/nologo.example",
    });
    await writeFile(join(directory, curatedEntry.file), PNG_BYTES);
    await writeFile(join(directory, suppressedEntry.file), PNG_BYTES);
    manifest = { version: 1, entries: [curatedEntry, suppressedEntry] };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("with skipLogos, a vendored curated row is stored without any fetch and the long tail keeps the monogram", async () => {
    const counter = { fetches: 0 };
    const { storage, stored } = recordingStorage();
    const common = {
      storage,
      fetchImpl: refusingFetch(counter),
      storeLogos: false,
      vendoredLogos: vendoredLogosByCapabilityId(manifest),
      vendoredLogoDirectory: directory,
    };

    const curated = await resolveCatalogRowLogo(curatedRow, common);
    const expectedKey = catalogLogoObjectKey("curated.example", sha256(PNG_BYTES), "image/png");
    expect(curated).toEqual({ logoAssetPath: expectedKey, logoSource: "vendored", failure: null });
    expect(stored).toEqual([{ key: expectedKey, contentType: "image/png", body: PNG_BYTES }]);
    expect(
      catalogRowToDbInput(curatedRow, {
        importBatchId: "00000000-0000-4000-8000-000000000001",
        logoAssetPath: curated.logoAssetPath,
        logoSource: curated.logoSource,
      }),
    ).toMatchObject({
      logoAssetPath: expectedKey,
      metadata: {
        logoSource: "vendored",
        originalLogoUrl: "https://integrations.sh/logo/curated.example",
      },
    });

    const uncurated = await resolveCatalogRowLogo(uncuratedRow, common);
    expect(uncurated).toEqual({
      logoAssetPath: null,
      logoSource: "generic_monogram",
      failure: null,
    });
    expect(
      catalogRowToDbInput(uncuratedRow, {
        importBatchId: "00000000-0000-4000-8000-000000000001",
        logoAssetPath: uncurated.logoAssetPath,
        logoSource: uncurated.logoSource,
      }).metadata,
    ).toMatchObject({ logoSource: "generic_monogram" });
    expect(counter.fetches).toBe(0);
    expect(stored).toHaveLength(1);
  });

  test("without skipLogos, vendored rows still use the vendored bytes and the long tail fetches", async () => {
    const fetched: string[] = [];
    const { storage, stored } = recordingStorage();
    const common = {
      storage,
      fetchImpl: async (input: string | URL) => {
        fetched.push(String(input));
        return new Response(new Uint8Array([9, 9, 9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      },
      storeLogos: true,
      vendoredLogos: vendoredLogosByCapabilityId(manifest),
      vendoredLogoDirectory: directory,
    };

    const curated = await resolveCatalogRowLogo(curatedRow, common);
    expect(curated.logoSource).toBe("vendored");
    expect(stored[0]?.body).toEqual(PNG_BYTES);

    const uncurated = await resolveCatalogRowLogo(uncuratedRow, common);
    expect(uncurated.logoSource).toBe("integrations.sh");
    expect(uncurated.logoAssetPath).toBe(
      catalogLogoObjectKey("tail.example", sha256(new Uint8Array([9, 9, 9])), "image/jpeg"),
    );
    expect(fetched).toEqual(["https://integrations.sh/logo/tail.example"]);
    expect(stored).toHaveLength(2);
  });

  test("a curated logoSourceUrl of null wins over a vendored file in either mode", async () => {
    for (const storeLogos of [true, false]) {
      const counter = { fetches: 0 };
      const { storage, stored } = recordingStorage();
      const result = await resolveCatalogRowLogo(suppressedRow, {
        storage,
        fetchImpl: refusingFetch(counter),
        storeLogos,
        vendoredLogos: vendoredLogosByCapabilityId(manifest),
        vendoredLogoDirectory: directory,
      });
      expect(result).toEqual({
        logoAssetPath: null,
        logoSource: "generic_monogram",
        failure: null,
      });
      expect(counter.fetches).toBe(0);
      expect(stored).toHaveLength(0);
    }
  });

  test("a stale or corrupted vendored asset fails closed to the monogram with a visible reason", async () => {
    const counter = { fetches: 0 };
    const { storage, stored } = recordingStorage();
    const base = {
      storage,
      fetchImpl: refusingFetch(counter),
      storeLogos: false,
      vendoredLogoDirectory: directory,
    };

    const moved = row({
      ...curatedRow,
      logoSourceUrl: "https://curated.example/brand/new-logo.png",
    });
    const stale = await resolveCatalogRowLogo(moved, {
      ...base,
      vendoredLogos: vendoredLogosByCapabilityId(manifest),
    });
    expect(stale).toEqual({
      logoAssetPath: null,
      logoSource: "generic_monogram",
      failure: {
        reason: "vendored_logo_source_mismatch",
        sourceUrl: "https://curated.example/brand/new-logo.png",
      },
    });

    await writeFile(join(directory, manifest.entries[0]!.file), new Uint8Array([7, 7]));
    const corrupted = await resolveCatalogRowLogo(curatedRow, {
      ...base,
      vendoredLogos: vendoredLogosByCapabilityId(manifest),
    });
    expect(corrupted.logoAssetPath).toBeNull();
    expect(corrupted.failure?.reason).toBe("vendored_logo_digest_mismatch");

    const noStorage = await resolveCatalogRowLogo(curatedRow, {
      ...base,
      storage: null,
      vendoredLogos: vendoredLogosByCapabilityId(manifest),
    });
    expect(noStorage.failure?.reason).toBe("object_storage_unavailable");
    expect(counter.fetches).toBe(0);
    expect(stored).toHaveLength(0);
  });

  test("the vendored manifest participates in the import fingerprint", async () => {
    const base = { snapshotPath: fixtureUrl.pathname, snapshotRef: "reviewed", skipLogos: true };
    const empty: VendoredLogoManifest = { version: 1, entries: [] };
    const one: VendoredLogoManifest = { version: 1, entries: [entryFor(curatedRow, PNG_BYTES)] };
    const replaced: VendoredLogoManifest = {
      version: 1,
      entries: [entryFor(curatedRow, new Uint8Array([1, 2, 3, 4]))],
    };
    const reformatted: VendoredLogoManifest = {
      version: 1,
      entries: [entryFor(curatedRow, PNG_BYTES, { fetchedAt: "2030-01-01T00:00:00.000Z" })],
    };

    const withEmpty = await catalogImportFingerprint({ ...base, vendoredLogos: empty });
    const withOne = await catalogImportFingerprint({ ...base, vendoredLogos: one });
    const withReplaced = await catalogImportFingerprint({ ...base, vendoredLogos: replaced });
    const withReformatted = await catalogImportFingerprint({ ...base, vendoredLogos: reformatted });
    const committed = await catalogImportFingerprint(base);

    expect(withOne).not.toBe(withEmpty);
    expect(withReplaced).not.toBe(withOne);
    // fetchedAt is provenance, not content: it must not churn the fingerprint.
    expect(withReformatted).toBe(withOne);
    expect(committed).toBe(
      await catalogImportFingerprint({ ...base, vendoredLogos: VENDORED_LOGO_MANIFEST }),
    );
    expect(vendoredLogoManifestFingerprintInput(one)).toBe(
      vendoredLogoManifestFingerprintInput(reformatted),
    );
  });
});

describe("vendored logo manifest document", () => {
  test("rejects malformed entries loudly", () => {
    const valid = entryFor(
      row({ domain: "a.example", mcpUrl: "https://a.example/mcp" }),
      PNG_BYTES,
    );
    expect(() => parseVendoredLogoManifest({ version: 1, entries: [valid] })).not.toThrow();
    expect(() => parseVendoredLogoManifest({ version: 2, entries: [] })).toThrow(/version/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, file: "../escape.png" }] }),
    ).toThrow(/safe asset file name/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, sha256: "abc" }] }),
    ).toThrow(/sha256/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, contentType: "text/html" }] }),
    ).toThrow(/invalid_content_type/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, sizeBytes: 512 * 1024 + 1 }] }),
    ).toThrow(/sizeBytes/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, sourceUrl: "http://x" }] }),
    ).toThrow(/https/);
    expect(() =>
      parseVendoredLogoManifest({ version: 1, entries: [{ ...valid, extra: true }] }),
    ).toThrow(/unknown key/);
    expect(() => parseVendoredLogoManifest({ version: 1, entries: [valid, valid] })).toThrow(
      /duplicate/,
    );
  });

  test("validates assets exactly like a fetched logo", () => {
    expect(validateLogoAsset({ contentType: "text/plain", bytes: PNG_BYTES })).toEqual({
      ok: false,
      reason: "invalid_content_type:text/plain",
    });
    expect(validateLogoAsset({ contentType: "image/png", bytes: new Uint8Array() })).toEqual({
      ok: false,
      reason: "image_empty",
    });
    expect(
      validateLogoAsset({ contentType: "image/png", bytes: new Uint8Array(512 * 1024 + 1) }),
    ).toEqual({ ok: false, reason: "image_too_large" });
    const ok = validateLogoAsset({ contentType: "IMAGE/PNG; charset=binary", bytes: PNG_BYTES });
    expect(ok.ok && ok.contentType).toBe("image/png");
  });

  test("the committed manifest covers exactly the curated rows that permit a logo, byte for byte", async () => {
    const normalized = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath));
    const { fetchable, suppressed } = curatedLogoCandidates(normalized.rows);
    const committed = vendoredLogosByCapabilityId(VENDORED_LOGO_MANIFEST);

    expect(committed.size).toBe(fetchable.length);
    for (const candidate of fetchable) {
      const entry = committed.get(candidate.capabilityId);
      expect(entry, candidate.capabilityId).toBeDefined();
      expect(entry!.sourceUrl).toBe(candidate.sourceUrl);
      expect(entry!.domain).toBe(candidate.row.domain);
      expect(entry!.mcpUrl).toBe(candidate.row.mcpUrl);
      const asset = await readVendoredLogoAsset(entry!, VENDORED_LOGO_DIRECTORY);
      expect(asset.ok, `${entry!.file}: ${asset.ok ? "" : asset.reason}`).toBe(true);
    }
    // Gmail and Mobbin publish no reusable logo licence; the overlay keeps the
    // monogram and no asset may be vendored for them.
    for (const { capabilityId } of suppressed) {
      expect(committed.has(capabilityId)).toBe(false);
    }
    expect(suppressed.map((entry) => entry.domain).sort()).toEqual([
      "gmailmcp.googleapis.com",
      "mobbin.com",
    ]);
    // Every vendored row is curated: the long tail is never vendored.
    for (const entry of VENDORED_LOGO_MANIFEST.entries) {
      expect(curatedCatalogEntriesByMcpUrl.has(entry.mcpUrl), entry.capabilityId).toBe(true);
    }
    // No orphaned files next to the manifest.
    const files = (await readdir(VENDORED_LOGO_DIRECTORY)).filter(
      (name) => name !== "manifest.json",
    );
    expect(files.sort()).toEqual(VENDORED_LOGO_MANIFEST.entries.map((entry) => entry.file).sort());
    expect(CURATED_CATALOG.entries.filter((entry) => entry.logoSourceUrl === null).length).toBe(
      suppressed.length,
    );
  });
});

describe("vendor-catalog-logos script", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "opengeni-vendor-logos-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const snapshot = async () => readSnapshotFile(snapshotPath);

  test("writes only validated assets, records provenance, and refuses invalid responses", async () => {
    const good = new Uint8Array([1, 2, 3, 4, 5]);
    const fetched: string[] = [];
    const result = await vendorCatalogLogos({
      snapshot: await snapshot(),
      directory,
      now: () => new Date("2026-08-17T10:00:00.000Z"),
      fetchImpl: async (input) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith("/slack.com")) {
          return new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
        }
        if (url.endsWith("/linear.app")) {
          return new Response(new Uint8Array(512 * 1024 + 1), {
            headers: { "content-type": "image/png" },
          });
        }
        return new Response(good, { headers: { "content-type": "image/png" } });
      },
    });

    const normalized = normalizeCatalogSnapshot(await snapshot());
    const { fetchable } = curatedLogoCandidates(normalized.rows);
    expect(fetched.sort()).toEqual(fetchable.map((c) => c.sourceUrl).sort());
    expect(result.failed.map((f) => [f.domain, f.reason]).sort()).toEqual([
      ["linear.app", "image_too_large"],
      ["slack.com", "invalid_content_type:text/html"],
    ]);
    expect(result.suppressed.map((s) => s.domain).sort()).toEqual([
      "gmailmcp.googleapis.com",
      "mobbin.com",
    ]);
    expect(result.manifest.entries).toHaveLength(fetchable.length - 2);
    expect(result.totalBytes).toBe(good.byteLength * (fetchable.length - 2));

    const written = await readFile(join(directory, "manifest.json"), "utf8");
    const parsed = parseVendoredLogoManifest(JSON.parse(written));
    expect(written).toBe(serializeVendoredLogoManifest(parsed));
    const files = (await readdir(directory)).filter((name) => name !== "manifest.json");
    expect(files.sort()).toEqual(parsed.entries.map((entry) => entry.file).sort());
    for (const entry of parsed.entries) {
      expect(entry.sha256).toBe(sha256(good));
      expect(entry.contentType).toBe("image/png");
      expect(entry.fetchedAt).toBe("2026-08-17T10:00:00.000Z");
      expect(entry.sourceUrl).toBe(`https://integrations.sh/logo/${entry.domain}`);
      expect(entry.file.endsWith(".png")).toBe(true);
      const asset = await readVendoredLogoAsset(entry, directory);
      expect(asset.ok).toBe(true);
    }
    expect(files.some((name) => name.startsWith("slack-com-"))).toBe(false);
    expect(files.some((name) => name.startsWith("linear-app-"))).toBe(false);
  });

  test("keeps a still-valid prior asset when a refetch fails, keeps fetchedAt stable for identical bytes, and removes orphans", async () => {
    const good = new Uint8Array([1, 2, 3, 4, 5]);
    const first = await vendorCatalogLogos({
      snapshot: await snapshot(),
      directory,
      now: () => new Date("2026-08-17T10:00:00.000Z"),
      fetchImpl: async () => new Response(good, { headers: { "content-type": "image/png" } }),
    });
    expect(first.failed).toEqual([]);
    await writeFile(join(directory, "orphan.png"), good);

    const second = await vendorCatalogLogos({
      snapshot: await snapshot(),
      directory,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      fetchImpl: async (input) => {
        if (String(input).endsWith("/slack.com")) {
          throw new Error("connection reset");
        }
        return new Response(good, { headers: { "content-type": "image/png" } });
      },
    });
    expect(second.failed).toEqual([]);
    expect(second.retained).toEqual([
      {
        capabilityId: catalogCapabilityId("slack.com", "https://mcp.slack.com/mcp"),
        reason: "fetch_failed:connection reset",
      },
    ]);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(first.manifest.entries.length - 1);
    expect(second.removed).toEqual(["orphan.png"]);
    expect(second.manifest.entries.every((e) => e.fetchedAt === "2026-08-17T10:00:00.000Z")).toBe(
      true,
    );
    expect((await readdir(directory)).includes("orphan.png")).toBe(false);
  });
});
