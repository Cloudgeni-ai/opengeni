import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import type { AccessGrant } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createDb, getCapabilityInstallation, listEnabledMcpCapabilityServers } from "@opengeni/db";
import {
  buildCapabilityCatalog,
  disableCapability,
  enableCapability,
} from "../src/domain/capabilities";

// Organization connectors (OR-11) in a workspace's connector page and its
// enable/disable actions: listed once as the organization's, turned off here
// by a workspace manager and back on by an empty enable, never replaced by a
// member's personal setup, and a custom organization server is only ever used
// as the organization set it up.

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let sql: postgres.Sql;
const settings = testSettings({ sandboxBackend: "none" });

type Fixture = Awaited<ReturnType<typeof seed>>;
let f: Fixture;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-organization-connectors");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-organization-connectors] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  sql = shared.admin;
  f = await seed();
}, 180_000);

afterAll(async () => {
  if (!shared) return;
  await sql`delete from capability_catalog_items where id = ${f.catalogId}`;
  await client.close().catch(() => undefined);
  await shared.release();
}, 60_000);

async function workspace(accountId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
  await sql`insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}, ${accountId})`;
  return row!.id;
}

async function seed() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`organization connectors ${suffix}`}) returning id`;
  const accountId = org!.id;
  const team = await workspace(accountId, "Team");
  const ops = await workspace(accountId, "Ops");
  const admin = `user:admin-${suffix}`;
  const member = `user:member-${suffix}`;
  const docs = {
    id: `mcp:organization-team-docs-${suffix}`,
    domain: `docs-${suffix}.example.test`,
  };
  const open = { id: `mcp:organization-open-data-${suffix}` };
  const catalogId = `registry:org-catalog-${suffix}`;
  await sql`insert into capability_catalog_items (
      id, kind, source, name, endpoint_url, auth_model, auth_kind, provider_domain, mcp_url, metadata
    ) values (
      ${catalogId}, 'mcp', 'manual', 'Catalog tracker', ${`https://tracker-${suffix}.example.test/mcp`},
      'oauth2', 'oauth2', ${`tracker-${suffix}.example.test`}, ${`https://tracker-${suffix}.example.test/mcp`},
      ${sql.json({ mcpServerId: `tracker-${suffix}` })}
    )`;
  const connector = (input: {
    capabilityId: string;
    custom: Record<string, unknown> | null;
    config: Record<string, unknown>;
    metadata: Record<string, unknown>;
    allowedWorkspaceIds?: string[] | null;
  }) => sql`insert into organization_connectors (
      account_id, capability_id, custom_definition, config, metadata, allowed_workspace_ids,
      created_by_subject_id, updated_by_subject_id
    ) values (
      ${accountId}, ${input.capabilityId}, ${input.custom ? sql.json(input.custom) : null},
      ${sql.json(input.config)}, ${sql.json(input.metadata)},
      ${input.allowedWorkspaceIds ?? null}::uuid[], ${admin}, ${admin}
    )`;
  const eachPerson = {
    connectionRef: { providerDomain: docs.domain, kind: "oauth2", subjectScope: "subject" },
  };
  await connector({
    capabilityId: docs.id,
    custom: { name: "Team docs", description: null, endpointUrl: `https://${docs.domain}/mcp` },
    config: eachPerson,
    metadata: { mcpConnectivity: { status: "auth_deferred" } },
  });
  await connector({
    capabilityId: open.id,
    custom: {
      name: "Open data",
      description: null,
      endpointUrl: `https://open-${suffix}.example.test/mcp`,
    },
    config: {},
    metadata: { mcpConnectivity: { status: "ok" } },
    allowedWorkspaceIds: [team],
  });
  await connector({
    capabilityId: catalogId,
    custom: null,
    config: {
      connectionRef: {
        providerDomain: `tracker-${suffix}.example.test`,
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
    metadata: { mcpConnectivity: { status: "auth_deferred" } },
  });
  return { accountId, team, ops, admin, member, docs, open, catalogId };
}

function grant(workspaceId: string, subjectId: string, manage: boolean): AccessGrant {
  return {
    accountId: f.accountId,
    workspaceId,
    subjectId,
    permissions: manage
      ? ["capabilities:read", "capabilities:manage", "connections:write"]
      : ["capabilities:read", "connections:personal"],
    metadata: {},
  };
}

async function catalogItem(workspaceId: string, id: string) {
  const catalog = await buildCapabilityCatalog({ db: client.db, workspaceId, settings });
  return catalog.items.filter((item) => item.id === id);
}

test("the connector page lists each organization connector once, as the organization's", async () => {
  if (!shared) return;
  const [docs] = await catalogItem(f.team, f.docs.id);
  expect(docs).toMatchObject({
    name: "Team docs",
    enabled: true,
    enabledReason: "From your organization",
    actions: ["disconnect", "inspect"],
    lifecycle: { status: "ready", managedBy: "organization", detail: "From your organization" },
    metadata: { organizationConnector: { login: "each_person", source: "custom", generation: 1 } },
  });
  expect(docs!.connectionRef?.subjectScope).toBe("subject");
  const [open] = await catalogItem(f.team, f.open.id);
  expect(open).toMatchObject({
    enabled: true,
    actions: ["disconnect", "inspect"],
    metadata: { organizationConnector: { login: "none" } },
  });
  // Listed workspaces only.
  expect(await catalogItem(f.ops, f.open.id)).toEqual([]);
  // A catalog connector replaces the catalog's own entry rather than adding one.
  const tracker = await catalogItem(f.ops, f.catalogId);
  expect(tracker).toHaveLength(1);
  expect(tracker[0]).toMatchObject({
    enabled: true,
    lifecycle: { managedBy: "organization" },
    metadata: { organizationConnector: { source: "catalog" } },
  });
}, 60_000);

test("a workspace manager turns it off here, and an empty enable turns it back on", async () => {
  if (!shared) return;
  const off = await disableCapability({
    db: client.db,
    accountId: f.accountId,
    workspaceId: f.ops,
    settings,
    capabilityId: f.docs.id,
  });
  expect(off.status).toBe("disabled");
  const [docs] = await catalogItem(f.ops, f.docs.id);
  expect(docs).toMatchObject({
    enabled: false,
    actions: ["connect", "inspect"],
    lifecycle: { status: "available", managedBy: "organization" },
  });
  expect(docs!.lifecycle.detail).toContain("Turned off in this workspace");
  expect(
    (await listEnabledMcpCapabilityServers(client.db, f.ops)).some(
      (server) => server.capabilityId === f.docs.id,
    ),
  ).toBe(false);
  // Other workspaces keep it.
  expect((await catalogItem(f.team, f.docs.id))[0]?.enabled).toBe(true);

  // A member's personal setup never turns back on what an admin turned off.
  await expect(
    enableCapability({
      db: client.db,
      grant: grant(f.ops, f.member, false),
      personalSetup: true,
      accountId: f.accountId,
      workspaceId: f.ops,
      settings,
      capabilityId: f.docs.id,
      payload: { config: {}, metadata: {}, headers: {} },
    }),
  ).rejects.toMatchObject({ status: 409 });

  const on = await enableCapability({
    db: client.db,
    grant: grant(f.ops, f.admin, true),
    accountId: f.accountId,
    workspaceId: f.ops,
    settings,
    capabilityId: f.docs.id,
    payload: { config: {}, metadata: {}, headers: {} },
  });
  expect(on.status).toBe("active");
  expect(await getCapabilityInstallation(client.db, f.ops, f.docs.id)).toBeNull();
  expect((await catalogItem(f.ops, f.docs.id))[0]?.enabled).toBe(true);
}, 60_000);

test("a member's own sign-in never becomes a workspace setup over the organization's", async () => {
  if (!shared) return;
  const installation = await enableCapability({
    db: client.db,
    grant: grant(f.team, f.member, false),
    personalSetup: true,
    accountId: f.accountId,
    workspaceId: f.team,
    settings,
    capabilityId: f.catalogId,
    payload: {
      config: {},
      metadata: {},
      headers: {},
      connectionRef: {
        providerDomain: f.catalogId.replace("registry:org-catalog-", "tracker-") + ".example.test",
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
  });
  expect(installation.status).toBe("active");
  expect(await getCapabilityInstallation(client.db, f.team, f.catalogId)).toBeNull();
  expect((await catalogItem(f.team, f.catalogId))[0]?.lifecycle.managedBy).toBe("organization");
}, 60_000);

test("an admin connecting their own account uses the organization's setup too", async () => {
  if (!shared) return;
  const tracker = f.catalogId.replace("registry:org-catalog-", "tracker-") + ".example.test";
  for (const [capabilityId, providerDomain] of [
    [f.catalogId, tracker],
    [f.docs.id, f.docs.domain],
  ] as const) {
    const installation = await enableCapability({
      db: client.db,
      grant: grant(f.team, f.admin, true),
      accountId: f.accountId,
      workspaceId: f.team,
      settings,
      capabilityId,
      payload: {
        config: {},
        metadata: {},
        headers: {},
        connectionRef: {
          providerDomain,
          kind: "oauth2",
          subjectScope: "subject",
          accountSelection: "all_eligible",
        },
      },
    });
    expect(installation.status).toBe("active");
    expect(await getCapabilityInstallation(client.db, f.team, capabilityId)).toBeNull();
    expect((await catalogItem(f.team, capabilityId))[0]?.lifecycle.managedBy).toBe("organization");
  }
}, 60_000);

test("a custom organization server is used only as the organization set it up", async () => {
  if (!shared) return;
  await expect(
    enableCapability({
      db: client.db,
      grant: grant(f.team, f.admin, true),
      accountId: f.accountId,
      workspaceId: f.team,
      settings,
      capabilityId: f.open.id,
      payload: { config: { allowedTools: ["one"] }, metadata: {}, headers: {} },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await getCapabilityInstallation(client.db, f.team, f.open.id)).toBeNull();
}, 60_000);
