import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  installApiIntegration,
  type ApiIntegrationRuntime,
  type InstallApiIntegrationInput,
} from "@opengeni/db";
import {
  settingsWithEnabledCapabilityMcpServers,
  settingsWithEnabledCapabilityMcpServersForTargets,
} from "../src/domain/capabilities";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";
import { getConnectorToolPermissions } from "../src/domain/connector-tool-permissions";
import {
  listApiIntegrationsWithPersonalExtension,
  personalWorkspaceExtensionApiIntegrations,
} from "../src/domain/personal-workspace-connectors";

// The Personal workspace is an extension of the organization for its one
// owner: API Integrations (a curated one such as Outlook Mail, or a
// workspace's own OpenAPI service) bound to the owner's "Only me" account in a
// shared workspace reach the Personal workspace's agents and connector page,
// derived live, without installing anything there.

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let sql: postgres.Sql;

type Fixture = Awaited<ReturnType<typeof seed>>;
let fixture: Fixture;

const settings = testSettings({ sandboxBackend: "none" });

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-personal-workspace-api-integrations");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-personal-workspace-api-integrations] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  sql = shared.admin;
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  if (!shared) return;
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

async function connection(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
}): Promise<string> {
  return await sql.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${input.accountId}, true),
      set_config('opengeni.workspace_id', ${input.workspaceId}, true),
      set_config('opengeni.subject_id', ${input.subjectId ?? ""}, true)`;
    const [row] = await tx<{ id: string }[]>`
      insert into connections (
        account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted, metadata
      ) values (
        ${input.accountId}, ${input.workspaceId}, ${input.subjectId}, ${input.providerDomain},
        'oauth2', 'fixture-ciphertext', ${tx.json({})}
      ) returning id`;
    return row!.id;
  });
}

function integration(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  connectionId: string;
  ownership: "workspace" | "subject";
  curated: boolean;
  key: string;
  providerDomain: string;
}): InstallApiIntegrationInput {
  const definitionId = input.curated ? "microsoft-outlook-mail" : `inventory-${input.key}`;
  const baseUrl = `https://${input.providerDomain}/v1/`;
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    capabilityId: input.curated ? "api:microsoft-outlook-mail" : `api:inventory-${input.key}`,
    pluginKey: input.curated ? "integration/microsoft-outlook-mail" : `integration/${input.key}`,
    serverId: input.curated ? "microsoft_outlook_mail" : `inventory_${input.key}`,
    name: input.curated ? "Outlook Mail" : `Inventory ${input.key}`,
    description: "Read items.",
    definitionId,
    definitionProvenance: input.curated ? "curated" : "workspace",
    providerDomain: input.providerDomain,
    protocol: "openapi",
    baseUrl,
    sourceUrl: `${baseUrl}openapi.json`,
    authScheme: { kind: "oauth2" },
    connectionId: input.connectionId,
    instanceKey: `account-${input.key}`,
    displayName: `${input.curated ? "Outlook Mail" : "Inventory"} ${input.key}`,
    requiredScopes: [],
    ownership: input.ownership,
    revision: {
      id: `openapi:${input.key.padEnd(24, "0").slice(0, 24)}`,
      protocol: "openapi",
      definitionId,
      contentSha256: "1".repeat(64),
      source: { url: `${baseUrl}openapi.json` },
      title: "Items API",
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List items.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: baseUrl,
          parameters: [],
        },
      },
    },
  };
}

async function seed() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`personal api extension ${suffix}`}) returning id`;
  const [otherOrg] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`other api org ${suffix}`}) returning id`;
  const accountId = org!.id;
  const team = await workspace(accountId, "Team workspace");
  const miaPersonal = await workspace(accountId, "Mia personal");
  const bobPersonal = await workspace(accountId, "Bob personal");
  const otherOrgPersonal = await workspace(otherOrg!.id, "Mia personal elsewhere");
  const mia = `user:mia-${suffix}`;
  const bob = `user:bob-${suffix}`;
  await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${mia}, 'active', ${miaPersonal}),
           (${accountId}, ${bob}, 'active', ${bobPersonal}),
           (${otherOrg!.id}, ${mia}, 'active', ${otherOrgPersonal})`;
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${team}, ${mia}), (${accountId}, ${team}, ${bob})`;

  const graph = "graph.microsoft.com";
  const inventoryDomain = `inventory-${suffix}.example.test`;
  const miaOutlook = await connection({
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: graph,
  });
  const miaInventory = await connection({
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: inventoryDomain,
  });
  const bobInventory = await connection({
    accountId,
    workspaceId: team,
    subjectId: bob,
    providerDomain: inventoryDomain,
  });
  const teamInventory = await connection({
    accountId,
    workspaceId: team,
    subjectId: null,
    providerDomain: inventoryDomain,
  });
  const base = { accountId, workspaceId: team };
  const outlook = await installApiIntegration(
    client.db,
    integration({
      ...base,
      subjectId: mia,
      connectionId: miaOutlook,
      ownership: "subject",
      curated: true,
      key: `mia-mail-${suffix}`,
      providerDomain: graph,
    }),
  );
  const inventory = await installApiIntegration(
    client.db,
    integration({
      ...base,
      subjectId: mia,
      connectionId: miaInventory,
      ownership: "subject",
      curated: false,
      key: `mia-${suffix}`,
      providerDomain: inventoryDomain,
    }),
  );
  // Bob's own account in the same shared workspace never reaches Mia.
  const bobInstance = await installApiIntegration(
    client.db,
    integration({
      ...base,
      subjectId: bob,
      connectionId: bobInventory,
      ownership: "subject",
      curated: false,
      key: `bob-${suffix}`,
      providerDomain: inventoryDomain,
    }),
  );
  // A workspace-owned account in the shared workspace never follows anyone.
  const teamInstance = await installApiIntegration(
    client.db,
    integration({
      ...base,
      subjectId: mia,
      connectionId: teamInventory,
      ownership: "workspace",
      curated: false,
      key: `team-${suffix}`,
      providerDomain: inventoryDomain,
    }),
  );
  return {
    accountId,
    team,
    miaPersonal,
    bobPersonal,
    otherOrgPersonal,
    mia,
    bob,
    servers: {
      outlook: outlook.serverId,
      inventory: inventory.serverId,
      bob: bobInstance.serverId,
      team: teamInstance.serverId,
    },
    capabilities: {
      outlook: outlook.capabilityId,
      inventory: inventory.capabilityId,
    },
    connections: { miaOutlook, miaInventory, bobInventory, teamInventory },
  };
}

async function personalIntegrations(workspaceId: string, subjectId?: string) {
  let resolved: readonly ApiIntegrationRuntime[] = [];
  const result = await settingsWithEnabledCapabilityMcpServers(client.db, workspaceId, settings, {
    ...(subjectId ? { subjectId } : {}),
    onResolvedApiIntegrations: (items) => {
      resolved = items;
    },
  });
  return { servers: result.mcpServers, resolved };
}

function ids(servers: readonly { id: string }[]): string[] {
  return servers.map((server) => server.id).sort();
}

test("the owner's Personal workspace carries a curated and a workspace API Integration and binds their own accounts", async () => {
  if (!shared) return;
  const f = fixture;
  const { servers, resolved } = await personalIntegrations(f.miaPersonal, f.mia);
  expect(ids(servers)).toEqual([f.servers.outlook, f.servers.inventory].sort());
  expect(resolved.map((item) => [item.serverId, item.connectionRef?.connectionId]).sort()).toEqual(
    [
      [f.servers.outlook, f.connections.miaOutlook],
      [f.servers.inventory, f.connections.miaInventory],
    ].sort(),
  );
  expect(resolved.every((item) => item.connectionRef?.subjectScope === "subject")).toBe(true);

  const frozen = await freezeConnectionAccounts({
    db: client.db,
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    settings: { ...settings, mcpServers: servers },
    tools: servers.map((server) => ({ kind: "mcp" as const, id: server.id })),
    source: { kind: "subject", subjectId: f.mia, accountId: f.accountId },
  });
  expect(
    frozen.mcpAccountBindings
      ?.map((binding) => [
        binding.canonicalServerId,
        binding.connectionId,
        binding.originWorkspaceId,
        binding.ownerSubjectId,
      ])
      .sort(),
  ).toEqual(
    [
      [f.servers.outlook, f.connections.miaOutlook, f.team, f.mia],
      [f.servers.inventory, f.connections.miaInventory, f.team, f.mia],
    ].sort(),
  );

  // At turn claim the owner comes from the frozen delegations alone.
  const claimed = await settingsWithEnabledCapabilityMcpServers(
    client.db,
    f.miaPersonal,
    settings,
    { personalConnectionDelegations: frozen.personalConnectionDelegations },
  );
  expect(ids(claimed.mcpServers)).toEqual(ids(servers));

  // The live tool-call fence resolves each carried target on its own.
  for (const serverId of [f.servers.outlook, f.servers.inventory]) {
    let fenced: readonly ApiIntegrationRuntime[] = [];
    const target = await settingsWithEnabledCapabilityMcpServersForTargets(
      client.db,
      f.miaPersonal,
      settings,
      {
        subjectId: f.mia,
        accountId: f.accountId,
        serverIds: [serverId],
        capabilityIds: [],
        onResolvedApiIntegrations: (items) => {
          fenced = items;
        },
      },
    );
    expect(ids(target.mcpServers)).toEqual([serverId]);
    expect(fenced.map((item) => item.serverId)).toEqual([serverId]);
  }
}, 60_000);

test("the Personal integrations list labels carried instances and the owner can open their approvals", async () => {
  if (!shared) return;
  const f = fixture;
  const listed = await listApiIntegrationsWithPersonalExtension(client.db, {
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    accountId: f.accountId,
  });
  expect(listed.map((item) => item.serverId).sort()).toEqual(
    [f.servers.outlook, f.servers.inventory].sort(),
  );
  for (const item of listed) {
    expect(item.personalExtension).toEqual({
      originWorkspaceId: f.team,
      originWorkspaceName: "Team workspace",
      catalogScope: item.definitionProvenance === "curated" ? "global" : "workspace",
    });
  }
  // The shared workspace's own list is unchanged and unlabelled.
  const teamListed = await listApiIntegrationsWithPersonalExtension(client.db, {
    workspaceId: f.team,
    subjectId: f.mia,
    accountId: f.accountId,
  });
  expect(teamListed.some((item) => item.personalExtension)).toBe(false);

  const input = (capabilityId: string, personalOwnerVerified = true) => ({
    db: client.db,
    settings,
    workspaceId: f.miaPersonal,
    capabilityId,
    personalOwnerVerified,
    grant: {
      accountId: f.accountId,
      workspaceId: f.miaPersonal,
      subjectId: f.mia,
      permissions: ["capabilities:read", "capabilities:manage"],
      metadata: {},
    },
  });
  for (const [capabilityId, connectionId] of [
    [f.capabilities.outlook, f.connections.miaOutlook],
    [f.capabilities.inventory, f.connections.miaInventory],
  ] as const) {
    const permissions = await getConnectorToolPermissions(
      input(capabilityId) as Parameters<typeof getConnectorToolPermissions>[0],
    );
    expect(permissions.connectionId).toBe(connectionId);
    expect(permissions.accounts.map((account) => account.connectionId)).toEqual([connectionId]);
    await expect(
      getConnectorToolPermissions(
        input(capabilityId, false) as Parameters<typeof getConnectorToolPermissions>[0],
      ),
    ).rejects.toMatchObject({ status: 404 });
  }
}, 60_000);

test("nothing crosses to another member, another organization or a shared workspace", async () => {
  if (!shared) return;
  const f = fixture;
  // Bob's Personal workspace carries only Bob's own instance.
  expect(ids((await personalIntegrations(f.bobPersonal, f.bob)).servers)).toEqual([f.servers.bob]);
  // Naming another member never reaches a Personal workspace that is not theirs.
  expect((await personalIntegrations(f.miaPersonal, f.bob)).servers).toEqual([]);
  expect((await personalIntegrations(f.bobPersonal, f.mia)).servers).toEqual([]);
  // Mia's Personal workspace in another organization receives nothing.
  expect((await personalIntegrations(f.otherOrgPersonal, f.mia)).servers).toEqual([]);
  // Without a subject nothing is carried.
  expect((await personalIntegrations(f.miaPersonal)).servers).toEqual([]);
  // The shared workspace serves what it served before, carrying nothing.
  const team = await personalIntegrations(f.team, f.mia);
  expect(ids(team.servers)).toEqual(
    [f.servers.outlook, f.servers.inventory, f.servers.team].sort(),
  );
  // Workspace-owned and other people's accounts never appear in Personal.
  const mine = await personalIntegrations(f.miaPersonal, f.mia);
  const bound = new Set(mine.resolved.map((item) => item.connectionRef?.connectionId));
  expect(bound.has(f.connections.teamInventory)).toBe(false);
  expect(bound.has(f.connections.bobInventory)).toBe(false);
}, 60_000);

test("losing origin membership, a revoked account and organization policy all win", async () => {
  if (!shared) return;
  const f = fixture;
  const carried = async () => ids((await personalIntegrations(f.miaPersonal, f.mia)).servers);
  const both = [f.servers.outlook, f.servers.inventory].sort();
  expect(await carried()).toEqual(both);

  // Removed from the origin workspace: re-checked at serving time.
  await sql`delete from workspace_memberships
    where workspace_id = ${f.team} and subject_id = ${f.mia}`;
  expect(await carried()).toEqual([]);
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${f.accountId}, ${f.team}, ${f.mia})`;
  expect(await carried()).toEqual(both);

  // A revoked account leaves nothing behind.
  await sql`update connections set status = 'revoked' where id = ${f.connections.miaInventory}`;
  expect(await carried()).toEqual([f.servers.outlook]);
  await sql`update connections set status = 'active' where id = ${f.connections.miaInventory}`;

  // Each carried instance needs the key its own setup in Personal would check:
  // a curated definition's own id, or the custom key of its protocol.
  const policy = async (keys: string[], revision: number) => {
    await sql`insert into organization_integration_policies (account_id, mode, allowed_integration_keys, revision)
      values (${f.accountId}, 'restricted', ${sql.json(keys)}, ${revision})
      on conflict (account_id) do update
        set allowed_integration_keys = excluded.allowed_integration_keys, revision = excluded.revision`;
  };
  try {
    await policy([], 1);
    expect(await carried()).toEqual([]);
    await policy(["custom:openapi"], 2);
    expect(await carried()).toEqual([f.servers.inventory]);
    await policy(["microsoft-outlook-mail"], 3);
    expect(await carried()).toEqual([f.servers.outlook]);
    await policy(["custom:mcp"], 4);
    expect(await carried()).toEqual([]);
  } finally {
    await sql`delete from organization_integration_policies where account_id = ${f.accountId}`;
  }
  expect(await carried()).toEqual(both);
}, 60_000);

test("dedupe is per account: Personal's own instance on the same account or a taken server id wins, another account sits beside", async () => {
  if (!shared) return;
  const f = fixture;
  const carried = async (input: {
    own?: { connectionRef: ApiIntegrationRuntime["connectionRef"] }[];
    taken?: string[];
  }) =>
    (
      await personalWorkspaceExtensionApiIntegrations(client.db, {
        workspaceId: f.miaPersonal,
        subjectId: f.mia,
        accountId: f.accountId,
        takenServerIds: input.taken ?? [],
        ...(input.own ? { ownIntegrations: input.own } : {}),
      })
    )
      .map((item) => item.serverId)
      .sort();
  const both = [f.servers.outlook, f.servers.inventory].sort();
  expect(await carried({})).toEqual(both);
  // Personal already has an instance bound to the same account: it wins.
  const sameAccount = (connectionId: string) => ({
    connectionRef: {
      providerDomain: "graph.microsoft.com",
      kind: "oauth2",
      connectionId,
      subjectScope: "subject" as const,
    },
  });
  expect(await carried({ own: [sameAccount(f.connections.miaOutlook)] })).toEqual([
    f.servers.inventory,
  ]);
  // A server id Personal already serves wins.
  expect(await carried({ taken: [f.servers.inventory] })).toEqual([f.servers.outlook]);

  // Personal's own Outlook on a different account sits beside the carried one.
  const personalOutlook = await connection({
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    providerDomain: "graph.microsoft.com",
  });
  const own = await installApiIntegration(
    client.db,
    integration({
      accountId: f.accountId,
      workspaceId: f.miaPersonal,
      subjectId: f.mia,
      connectionId: personalOutlook,
      ownership: "subject",
      curated: true,
      key: `mia-personal-mail-${crypto.randomUUID().slice(0, 8)}`,
      providerDomain: "graph.microsoft.com",
    }),
  );
  try {
    const { resolved } = await personalIntegrations(f.miaPersonal, f.mia);
    expect(
      resolved.map((item) => [item.serverId, item.connectionRef?.connectionId]).sort(),
    ).toEqual(
      [
        [own.serverId, personalOutlook],
        [f.servers.outlook, f.connections.miaOutlook],
        [f.servers.inventory, f.connections.miaInventory],
      ].sort(),
    );
    const listed = await listApiIntegrationsWithPersonalExtension(client.db, {
      workspaceId: f.miaPersonal,
      subjectId: f.mia,
      accountId: f.accountId,
    });
    expect(
      listed.find((item) => item.serverId === own.serverId)?.personalExtension,
    ).toBeUndefined();
    expect(
      listed.find((item) => item.serverId === f.servers.outlook)?.personalExtension
        ?.originWorkspaceId,
    ).toBe(f.team);
  } finally {
    await sql`delete from integration_facet_bindings where connection_id = ${personalOutlook}`;
    await sql`delete from connections where id = ${personalOutlook}`;
  }
}, 60_000);
