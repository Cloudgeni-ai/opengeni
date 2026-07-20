import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { importIntegrationsCatalog } from "../../../scripts/import-integrations-catalog";
import {
  createDb,
  createImportBatch,
  enableCapabilityInstallation,
  getCapabilityCatalogItem,
  listCapabilityCatalogItems,
  listEnabledMcpCapabilityServers,
  listRegistryCatalogSurfaceKeys,
  markStaleRegistryCatalogItems,
  upsertCapabilityCatalogItem,
  upsertRegistryCapabilityCatalogItem,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("catalog-imports");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[catalog-imports] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    // noop
  }
  await shared?.release();
}, 180_000);

describe("catalog import persistence", () => {
  test("upserts registry rows by domain and MCP URL and keeps fresh registry rows visible", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch1 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "fixture-1",
      attributionNote: "MIT attribution",
    });

    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:one-a",
        importBatchId: batch1.id,
        providerDomain: "one.example",
        mcpUrl: "https://one.example/mcp",
        name: "One",
        tier: "verified",
        provenance: "detected",
        logoAssetPath: "catalog-assets/integrations-sh/logos/one.example/logo.png",
      }),
    );
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:two-a",
        importBatchId: batch1.id,
        providerDomain: "two.example",
        mcpUrl: "https://two.example/mcp",
        name: "Two",
        tier: "community",
        provenance: "discovered",
      }),
    );
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:one-renamed",
        importBatchId: batch1.id,
        providerDomain: "one.example",
        mcpUrl: "https://one.example/mcp",
        name: "One Renamed",
        tier: "verified",
        provenance: "detected",
      }),
    );

    const afterUpsert = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM capability_catalog_items
      WHERE source = 'registry' AND provider_domain = 'one.example' AND mcp_url = 'https://one.example/mcp'`;
    expect(afterUpsert[0]?.n).toBe(1);

    const catalog = await listCapabilityCatalogItems(db, ws.workspaceId);
    const one = catalog.find((item) => item.providerDomain === "one.example");
    const two = catalog.find((item) => item.providerDomain === "two.example");
    expect(one).toMatchObject({
      id: "mcp:integrations-sh:one-renamed",
      source: "registry",
      name: "One Renamed",
      tier: "verified",
      authKind: "none",
      logoAssetPath: "catalog-assets/integrations-sh/logos/one.example/logo.png",
      stale: false,
    });
    expect(one?.accountId).toBeUndefined();
    expect(one?.workspaceId).toBeUndefined();
    expect(two).toMatchObject({
      source: "registry",
      name: "Two",
      tier: "community",
      provenance: "discovered",
      stale: false,
    });
  }, 180_000);

  test("importIntegrationsCatalog aborts empty snapshots before DB writes and leaves registry rows fresh", async () => {
    if (!available) return;
    const batch = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "empty-abort-seed",
      attributionNote: "MIT attribution",
    });
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:empty-abort",
        importBatchId: batch.id,
        providerDomain: "empty-abort.example",
        mcpUrl: "https://empty-abort.example/mcp",
        name: "Empty Abort",
        tier: "verified",
        provenance: "detected",
      }),
    );
    const before = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM import_batches`;

    await expect(
      importIntegrationsCatalog({
        db,
        snapshot: { generatedAt: "2026-07-04T00:00:00.000Z", importRows: [] },
        storage: null,
        storeLogos: false,
      }),
    ).rejects.toThrow("zero importable rows");

    const after = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM import_batches`;
    expect(after[0]?.n).toBe(before[0]?.n);
    const rows = await admin<
      { stale: boolean; stale_at: Date | null; import_batch_id: string | null }[]
    >`
      SELECT stale, stale_at, import_batch_id
      FROM capability_catalog_items
      WHERE source = 'registry'
        AND provider_domain = 'empty-abort.example'
        AND mcp_url = 'https://empty-abort.example/mcp'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stale).toBe(false);
    expect(rows[0]?.stale_at).toBeNull();
    expect(rows[0]?.import_batch_id).toBe(batch.id);
  }, 180_000);

  test("getCapabilityCatalogItem prefers the workspace-scoped row over a global registry row with the same id", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "workspace-preference",
      attributionNote: "MIT attribution",
    });
    const capabilityId = "mcp:integrations-sh:shared-preference";
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: capabilityId,
        importBatchId: batch.id,
        providerDomain: "shared-preference.example",
        mcpUrl: "https://shared-preference.example/mcp",
        name: "Global Shared Preference",
        tier: "community",
        provenance: "discovered",
      }),
    );
    await upsertCapabilityCatalogItem(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Workspace Shared Preference",
      endpointUrl: "https://workspace.shared-preference.example/mcp",
      category: "custom",
      tags: ["mcp", "workspace"],
    });

    const item = await getCapabilityCatalogItem(db, ws.workspaceId, capabilityId);

    expect(item).toMatchObject({
      id: capabilityId,
      source: "manual",
      name: "Workspace Shared Preference",
      workspaceId: ws.workspaceId,
      accountId: ws.accountId,
    });
  }, 180_000);

  test("listEnabledMcpCapabilityServers returns one entry when workspace and global rows share a capability id", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "enabled-server-dedupe",
      attributionNote: "MIT attribution",
    });
    const capabilityId = "mcp:integrations-sh:enabled-dedupe";
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: capabilityId,
        importBatchId: batch.id,
        providerDomain: "enabled-dedupe.example",
        mcpUrl: "https://global.enabled-dedupe.example/mcp",
        name: "Global Enabled Dedupe",
        tier: "community",
        provenance: "discovered",
      }),
    );
    await upsertCapabilityCatalogItem(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Workspace Enabled Dedupe",
      endpointUrl: "https://workspace.enabled-dedupe.example/mcp",
      category: "custom",
      tags: ["mcp", "workspace"],
    });
    await enableCapabilityInstallation(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok" } },
    });

    const servers = await listEnabledMcpCapabilityServers(db, ws.workspaceId);
    const matching = servers.filter((server) => server.capabilityId === capabilityId);

    expect(matching).toHaveLength(1);
    expect(matching[0]?.url).toBe("https://workspace.enabled-dedupe.example/mcp");
  }, 180_000);

  test("listEnabledMcpCapabilityServers excludes stale registry entries", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "stale-runtime-fence",
      attributionNote: "MIT attribution",
    });
    const capabilityId = "mcp:integrations-sh:stale-runtime-fence";
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: capabilityId,
        importBatchId: batch.id,
        providerDomain: "stale-runtime.example",
        mcpUrl: "https://stale-runtime.example/mcp",
        name: "Stale Runtime Fence",
        tier: "community",
        provenance: "discovered",
      }),
    );
    await enableCapabilityInstallation(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok" } },
    });
    expect(await listEnabledMcpCapabilityServers(db, ws.workspaceId)).toHaveLength(1);

    await markStaleRegistryCatalogItems(db, [], batch.id);

    expect(await listEnabledMcpCapabilityServers(db, ws.workspaceId)).toEqual([]);
  }, 180_000);

  test("markStaleRegistryCatalogItems marks multiple removed registry rows in one call", async () => {
    if (!available) return;
    const batch1 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "multi-stale-seed",
      attributionNote: "MIT attribution",
    });
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:multi-active",
        importBatchId: batch1.id,
        providerDomain: "multi-active.example",
        mcpUrl: "https://multi-active.example/mcp",
        name: "Multi Active",
        tier: "verified",
        provenance: "detected",
      }),
    );
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:multi-stale-one",
        importBatchId: batch1.id,
        providerDomain: "multi-stale-one.example",
        mcpUrl: "https://multi-stale-one.example/mcp",
        name: "Multi Stale One",
        tier: "community",
        provenance: "discovered",
      }),
    );
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:multi-stale-two",
        importBatchId: batch1.id,
        providerDomain: "multi-stale-two.example",
        mcpUrl: "https://multi-stale-two.example/mcp",
        name: "Multi Stale Two",
        tier: "community",
        provenance: "discovered",
      }),
    );

    const batch2 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-04T00:00:00.000Z"),
      snapshotRef: "multi-stale-refresh",
      attributionNote: "MIT attribution",
    });
    const staleDomains = new Set(["multi-stale-one.example", "multi-stale-two.example"]);
    const activeKeys = (await listRegistryCatalogSurfaceKeys(db)).filter(
      (key) => !staleDomains.has(key.providerDomain),
    );

    const staleCount = await markStaleRegistryCatalogItems(db, activeKeys, batch2.id);

    expect(staleCount).toBe(2);
    const rows = await admin<
      { provider_domain: string; stale: boolean; import_batch_id: string | null }[]
    >`
      SELECT provider_domain, stale, import_batch_id
      FROM capability_catalog_items
      WHERE source = 'registry'
        AND provider_domain IN ('multi-stale-one.example', 'multi-stale-two.example')
      ORDER BY provider_domain`;
    expect(
      rows.map((row) => ({
        provider_domain: row.provider_domain,
        stale: row.stale,
        import_batch_id: row.import_batch_id,
      })),
    ).toEqual([
      { provider_domain: "multi-stale-one.example", stale: true, import_batch_id: batch2.id },
      { provider_domain: "multi-stale-two.example", stale: true, import_batch_id: batch2.id },
    ]);
  }, 180_000);

  test("listCapabilityCatalogItems excludes stale global registry rows by default", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch1 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "stale-list-seed",
      attributionNote: "MIT attribution",
    });
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:list-active",
        importBatchId: batch1.id,
        providerDomain: "list-active.example",
        mcpUrl: "https://list-active.example/mcp",
        name: "List Active",
        tier: "verified",
        provenance: "detected",
      }),
    );
    await upsertRegistryCapabilityCatalogItem(
      db,
      registryRow({
        id: "mcp:integrations-sh:list-stale",
        importBatchId: batch1.id,
        providerDomain: "list-stale.example",
        mcpUrl: "https://list-stale.example/mcp",
        name: "List Stale",
        tier: "community",
        provenance: "discovered",
      }),
    );
    const batch2 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-04T00:00:00.000Z"),
      snapshotRef: "stale-list-refresh",
      attributionNote: "MIT attribution",
    });
    const activeKeys = (await listRegistryCatalogSurfaceKeys(db)).filter(
      (key) => key.providerDomain !== "list-stale.example",
    );
    expect(await markStaleRegistryCatalogItems(db, activeKeys, batch2.id)).toBe(1);

    const catalog = await listCapabilityCatalogItems(db, ws.workspaceId);

    expect(catalog.some((item) => item.providerDomain === "list-active.example")).toBe(true);
    expect(catalog.some((item) => item.providerDomain === "list-stale.example")).toBe(false);
  }, 180_000);
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    INSERT INTO managed_accounts (name) VALUES ('catalog imports account') RETURNING id`;
  const [workspace] = await admin<{ id: string }[]>`
    INSERT INTO workspaces (account_id, name) VALUES (${account!.id}, 'catalog imports workspace') RETURNING id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function registryRow(overrides: {
  id: string;
  importBatchId: string;
  providerDomain: string;
  mcpUrl: string;
  name: string;
  tier: "verified" | "community";
  provenance: string;
  logoAssetPath?: string | null;
}) {
  return {
    id: overrides.id,
    importBatchId: overrides.importBatchId,
    providerDomain: overrides.providerDomain,
    mcpUrl: overrides.mcpUrl,
    name: overrides.name,
    transport: "streamable-http" as const,
    authKind: "none" as const,
    credentialFacts: [],
    tier: overrides.tier,
    provenance: overrides.provenance,
    logoAssetPath: overrides.logoAssetPath ?? null,
  };
}
