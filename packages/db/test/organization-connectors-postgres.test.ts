import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  deleteOrganizationConnector,
  enableCapabilityInstallation,
  insertOrganizationConnector,
  listEnabledMcpCapabilityServerIds,
  listEnabledMcpCapabilityServers,
  listOrganizationConnectors,
  listOrganizationConnectorsReachingWorkspace,
  mcpServerIdForCapability,
  OrganizationConnectorWorkspaceNotInOrganizationError,
  restoreOrganizationConnectorInWorkspace,
  turnOffOrganizationConnectorInWorkspace,
  updateOrganizationConnector,
  withWorkspaceRls,
  type DbClient,
} from "../src";
import * as schema from "../src/schema";

// Organization connectors (migration 1175, OR-11): an organization owner or
// admin adds an MCP connector once and chooses which workspaces it reaches.
// Row security serves each workspace exactly the connectors that reach it,
// only an administrator without a workspace writes them, and a workspace's
// own setup of the same connector, on or off, wins. Runs as the non-superuser
// opengeni_app role, so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
type Org = {
  accountId: string;
  sharedId: string;
  otherSharedId: string;
  personalId: string;
  admin: string;
  member: string;
};
let one: Org;
let two: Org;
const catalogId = `mcp:org-connector-fixture-${crypto.randomUUID()}`;
const ok = { mcpConnectivity: { status: "ok", checkedAt: "2026-10-31T00:00:00.000Z" } };

async function seedOrganization(admin: postgres.Sql, label: string): Promise<Org> {
  const suffix = crypto.randomUUID();
  const member = `user:org-connectors-member-${suffix}`;
  const administrator = `user:org-connectors-admin-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: `Connectors fixture ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: `Connectors fixture ${label}`,
    subjectId: member,
  });
  const grant = access.workspaceGrants[0]!;
  const [otherShared, personal, adminPersonal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Other shared'), (${grant.accountId}, 'Personal'),
      (${grant.accountId}, 'Administrator Personal')
    returning id`;
  await admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${member}, 'member', 'active', ${personal!.id}),
      (${grant.accountId}, ${administrator}, 'admin', 'active', ${adminPersonal!.id})`;
  return {
    accountId: grant.accountId,
    sharedId: grant.workspaceId,
    otherSharedId: otherShared!.id,
    personalId: personal!.id,
    admin: administrator,
    member,
  };
}

function as(org: Org, subjectId: string) {
  return async () => ({ accountId: org.accountId, subjectId });
}

async function add(
  org: Org,
  input: {
    capabilityId: string;
    custom?: { name: string; endpointUrl: string };
    allowedWorkspaceIds?: readonly string[] | null;
    allowPersonalWorkspaces?: boolean;
    config?: Record<string, unknown>;
  },
) {
  return await insertOrganizationConnector(
    client.db,
    { accountId: org.accountId },
    {
      capabilityId: input.capabilityId,
      customDefinition: input.custom ? { ...input.custom, description: null } : null,
      config: input.config ?? {},
      metadata: ok,
      allowedWorkspaceIds: input.allowedWorkspaceIds ? [...input.allowedWorkspaceIds] : null,
      allowPersonalWorkspaces: input.allowPersonalWorkspaces ?? false,
    },
    as(org, org.admin),
  );
}

async function reaching(workspaceId: string): Promise<string[]> {
  return (await listOrganizationConnectorsReachingWorkspace(client.db, workspaceId)).map(
    (connector) => connector.capabilityId,
  );
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-connectors");
  if (!shared) {
    available = false;
    console.warn("[organization-connectors] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  one = await seedOrganization(shared.admin, "one");
  two = await seedOrganization(shared.admin, "two");
  await shared.admin`
    insert into capability_catalog_items (id, kind, source, name, endpoint_url, metadata)
    values (${catalogId}, 'mcp', 'manual', 'Zeta catalog', 'https://zeta.example.test/mcp',
      '{"requireApproval": true}'::jsonb)`;
}, 180_000);

afterAll(async () => {
  if (shared) await shared.admin`delete from capability_catalog_items where id = ${catalogId}`;
  await client?.close();
  await shared?.release();
}, 180_000);

describe("reach", () => {
  test("every shared workspace, the listed ones, and Personal only by its switch", async () => {
    if (!available) return;
    const everywhere = `mcp:organization-everywhere-${crypto.randomUUID()}`;
    const listed = `mcp:organization-listed-${crypto.randomUUID()}`;
    const withPersonal = `mcp:organization-personal-${crypto.randomUUID()}`;
    const custom = (name: string) => ({ name, endpointUrl: `https://${name}.example.test/mcp` });
    for (const [id, reach] of [
      [everywhere, { allowedWorkspaceIds: null }],
      [listed, { allowedWorkspaceIds: [one.sharedId] }],
      [withPersonal, { allowedWorkspaceIds: [one.sharedId], allowPersonalWorkspaces: true }],
    ] as const)
      await add(one, { capabilityId: id, custom: custom("reach"), ...reach });
    const ours = (ids: string[]) =>
      ids.filter((id) => [everywhere, listed, withPersonal].includes(id));
    expect(ours(await reaching(one.sharedId)).sort()).toEqual(
      [everywhere, listed, withPersonal].sort(),
    );
    expect(ours(await reaching(one.otherSharedId))).toEqual([everywhere]);
    expect(ours(await reaching(one.personalId))).toEqual([withPersonal]);
    // Never another organization's workspaces.
    for (const workspaceId of [two.sharedId, two.otherSharedId, two.personalId])
      expect(ours(await reaching(workspaceId))).toEqual([]);
  });

  test("a selected list holds only this organization's shared workspaces", async () => {
    if (!available) return;
    for (const allowedWorkspaceIds of [[one.personalId], [two.sharedId]])
      await expect(
        add(one, {
          capabilityId: `mcp:organization-invalid-${crypto.randomUUID()}`,
          custom: { name: "Invalid", endpointUrl: "https://invalid.example.test/mcp" },
          allowedWorkspaceIds,
        }),
      ).rejects.toBeInstanceOf(OrganizationConnectorWorkspaceNotInOrganizationError);
  });
});

describe("administration", () => {
  test("only an organization owner or admin, never from a workspace, writes", async () => {
    if (!available) return;
    const capabilityId = `mcp:organization-admin-${crypto.randomUUID()}`;
    const input = {
      capabilityId,
      customDefinition: { name: "Admin", endpointUrl: "https://admin.example.test/mcp" },
      config: {},
      metadata: ok,
      allowedWorkspaceIds: null,
      allowPersonalWorkspaces: false,
    };
    await expect(
      insertOrganizationConnector(
        client.db,
        { accountId: one.accountId },
        input,
        as(one, one.member),
      ),
    ).rejects.toThrow();
    // Another organization's administrator is not one here.
    await expect(
      insertOrganizationConnector(client.db, { accountId: one.accountId }, input, async () => ({
        accountId: one.accountId,
        subjectId: two.admin,
      })),
    ).rejects.toThrow();
    await expect(
      withWorkspaceRls(client.db, one.sharedId, async (tx) =>
        tx.insert(schema.organizationConnectors).values({
          accountId: one.accountId,
          capabilityId,
          createdBySubjectId: one.admin,
          updatedBySubjectId: one.admin,
        }),
      ),
    ).rejects.toThrow();
    const created = await insertOrganizationConnector(
      client.db,
      { accountId: one.accountId },
      input,
      as(one, one.admin),
    );
    expect(created.createdBySubjectId).toBe(one.admin);
    expect(
      (
        await listOrganizationConnectors(
          client.db,
          { accountId: one.accountId },
          as(one, one.admin),
        )
      )
        .map((row) => row.id)
        .includes(created.id),
    ).toBe(true);
    await expect(
      listOrganizationConnectors(client.db, { accountId: one.accountId }, as(one, one.member)),
    ).rejects.toThrow();
    // The same connector once per organization.
    await expect(
      insertOrganizationConnector(
        client.db,
        { accountId: one.accountId },
        input,
        as(one, one.admin),
      ),
    ).rejects.toThrow();

    const scope = { accountId: one.accountId, connectorId: created.id };
    expect(
      await updateOrganizationConnector(
        client.db,
        scope,
        { expectedGeneration: created.generation + 1, status: "disabled" },
        as(one, one.admin),
      ),
    ).toBeNull();
    const disabled = await updateOrganizationConnector(
      client.db,
      scope,
      { expectedGeneration: created.generation, status: "disabled" },
      as(one, one.admin),
    );
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.generation).toBe(created.generation + 1);
    expect(await reaching(one.sharedId)).not.toContain(capabilityId);
    expect(await deleteOrganizationConnector(client.db, scope, as(one, one.admin))).toBe(true);
    expect(await deleteOrganizationConnector(client.db, scope, as(one, one.admin))).toBe(false);
  });
});

describe("what agents in a workspace get", () => {
  test("the organization's connectors, in name order, with the server ids a workspace setup gives", async () => {
    if (!available) return;
    const customId = `mcp:organization-alpha-${crypto.randomUUID()}`;
    await add(two, { capabilityId: catalogId });
    await add(two, {
      capabilityId: customId,
      custom: { name: "Alpha custom", endpointUrl: "https://alpha.example.test/mcp" },
      config: { allowedTools: ["search"] },
    });
    // A workspace's own custom server sorts between them.
    const ownId = `mcp:own-middle-${crypto.randomUUID()}`;
    await shared!.admin`
      insert into capability_catalog_items (id, account_id, workspace_id, kind, source, name, endpoint_url)
      values (${ownId}, ${two.accountId}, ${two.sharedId}, 'mcp', 'manual', 'Middle own', 'https://middle.example.test/mcp')`;
    await enableCapabilityInstallation(client.db, {
      accountId: two.accountId,
      workspaceId: two.sharedId,
      capabilityId: ownId,
      kind: "mcp",
      metadata: ok,
    });

    const servers = await listEnabledMcpCapabilityServers(client.db, two.sharedId);
    expect(servers.map((server) => server.name)).toEqual([
      "Alpha custom",
      "Middle own",
      "Zeta catalog",
    ]);
    const catalog = servers.find((server) => server.capabilityId === catalogId)!;
    const custom = servers.find((server) => server.capabilityId === customId)!;
    expect(catalog.id).toBe(mcpServerIdForCapability(catalogId, { requireApproval: true }));
    expect(catalog.url).toBe("https://zeta.example.test/mcp");
    // A catalog connector keeps the catalog's approval floor; a custom one, like
    // a workspace's own custom server, has none.
    expect(catalog.approvalFloor).toBe(true);
    expect(custom.approvalFloor).toBeUndefined();
    expect(custom.allowedTools).toEqual(["search"]);
    expect(custom.id).toBe(mcpServerIdForCapability(customId));
    expect((await listEnabledMcpCapabilityServerIds(client.db, two.sharedId)).sort()).toEqual(
      servers.map((server) => server.id).sort(),
    );
    // A narrowed read gives exactly the narrowed rows.
    expect(
      (
        await listEnabledMcpCapabilityServers(client.db, two.sharedId, {
          capabilityIds: [customId],
          serverIds: [],
        })
      ).map((server) => server.capabilityId),
    ).toEqual([customId]);
    // Personal workspaces only when the switch is on.
    expect(
      (await listEnabledMcpCapabilityServers(client.db, two.personalId)).map(
        (server) => server.capabilityId,
      ),
    ).toEqual([]);
  });

  test("a workspace turns it off, back on, or replaces it with its own setup", async () => {
    if (!available) return;
    const served = async (workspaceId: string) =>
      (await listEnabledMcpCapabilityServers(client.db, workspaceId)).filter(
        (server) => server.capabilityId === catalogId,
      );
    expect(await served(two.otherSharedId)).toHaveLength(1);
    const off = await turnOffOrganizationConnectorInWorkspace(client.db, {
      accountId: two.accountId,
      workspaceId: two.otherSharedId,
      capabilityId: catalogId,
    });
    expect(off.status).toBe("disabled");
    expect(await served(two.otherSharedId)).toEqual([]);
    expect(await listEnabledMcpCapabilityServerIds(client.db, two.otherSharedId)).not.toContain(
      mcpServerIdForCapability(catalogId, { requireApproval: true }),
    );
    // Other workspaces are unaffected.
    expect(await served(two.sharedId)).toHaveLength(1);
    expect(
      await restoreOrganizationConnectorInWorkspace(client.db, two.otherSharedId, catalogId),
    ).toBe(true);
    expect(await served(two.otherSharedId)).toHaveLength(1);

    await enableCapabilityInstallation(client.db, {
      accountId: two.accountId,
      workspaceId: two.otherSharedId,
      capabilityId: catalogId,
      kind: "mcp",
      config: { allowedTools: ["own"] },
      metadata: ok,
    });
    const own = await served(two.otherSharedId);
    expect(own).toHaveLength(1);
    expect(own[0]!.allowedTools).toEqual(["own"]);
    // Restoring never removes a workspace's own setup.
    expect(
      await restoreOrganizationConnectorInWorkspace(client.db, two.otherSharedId, catalogId),
    ).toBe(false);
  });
});
