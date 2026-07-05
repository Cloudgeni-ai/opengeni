import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createImportBatch,
  listCapabilityCatalogItems,
  markStaleRegistryCatalogItems,
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
  test("upserts registry rows by domain and MCP URL, marks removed rows stale, and lists them globally", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const batch1 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-03T23:41:44.132Z"),
      snapshotRef: "fixture-1",
      attributionNote: "MIT attribution",
    });

    await upsertRegistryCapabilityCatalogItem(db, registryRow({
      id: "mcp:integrations-sh:one-a",
      importBatchId: batch1.id,
      providerDomain: "one.example",
      mcpUrl: "https://one.example/mcp",
      name: "One",
      tier: "verified",
      provenance: "detected",
      logoAssetPath: "catalog-assets/integrations-sh/logos/one.example/logo.png",
    }));
    await upsertRegistryCapabilityCatalogItem(db, registryRow({
      id: "mcp:integrations-sh:two-a",
      importBatchId: batch1.id,
      providerDomain: "two.example",
      mcpUrl: "https://two.example/mcp",
      name: "Two",
      tier: "community",
      provenance: "discovered",
    }));
    await upsertRegistryCapabilityCatalogItem(db, registryRow({
      id: "mcp:integrations-sh:one-renamed",
      importBatchId: batch1.id,
      providerDomain: "one.example",
      mcpUrl: "https://one.example/mcp",
      name: "One Renamed",
      tier: "verified",
      provenance: "detected",
    }));

    const afterUpsert = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM capability_catalog_items
      WHERE source = 'registry' AND provider_domain = 'one.example' AND mcp_url = 'https://one.example/mcp'`;
    expect(afterUpsert[0]?.n).toBe(1);

    const batch2 = await createImportBatch(db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-07-04T00:00:00.000Z"),
      snapshotRef: "fixture-2",
      attributionNote: "MIT attribution",
    });
    const staleCount = await markStaleRegistryCatalogItems(db, [{
      providerDomain: "one.example",
      mcpUrl: "https://one.example/mcp",
    }], batch2.id);
    expect(staleCount).toBe(1);

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
      stale: true,
      importBatchId: batch2.id,
    });
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
