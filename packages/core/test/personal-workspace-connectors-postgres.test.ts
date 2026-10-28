import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  createSession,
  getSessionTurnMcpAccountBindings,
  listEnabledMcpCapabilityServers,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";
import {
  buildCapabilityCatalog,
  settingsWithEnabledCapabilityMcpServers,
} from "../src/domain/capabilities";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";
import { getConnectorToolPermissions } from "../src/domain/connector-tool-permissions";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";

// The Personal workspace is an extension of the organization for its one
// owner: connectors behind the owner's own "Only me" connections made in a
// shared workspace reach the Personal workspace's agents and connector page,
// derived live, without enabling anything there.

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let sql: postgres.Sql;

type Fixture = Awaited<ReturnType<typeof seed>>;
let fixture: Fixture;

const settings = testSettings({ sandboxBackend: "none" });

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-personal-workspace-connectors");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-personal-workspace-connectors] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  sql = shared.admin;
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  if (!shared) return;
  await client.close();
  await shared.release();
});

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
  resource?: string;
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
        'oauth2', 'fixture-ciphertext',
        ${tx.json(input.resource ? { resource: input.resource } : {})}
      ) returning id`;
    return row!.id;
  });
}

async function catalogItem(input: {
  id: string;
  accountId: string | null;
  workspaceId: string | null;
  name: string;
  endpoint: string;
  providerDomain: string;
  serverId: string;
  metadata?: Record<string, unknown>;
}) {
  await sql`insert into capability_catalog_items (
    id, account_id, workspace_id, kind, source, name, endpoint_url,
    auth_model, auth_kind, provider_domain, mcp_url, metadata
  ) values (
    ${input.id}, ${input.accountId}, ${input.workspaceId}, 'mcp', 'manual', ${input.name},
    ${input.endpoint}, 'oauth2', 'oauth2', ${input.providerDomain}, ${input.endpoint},
    ${sql.json({ mcpServerId: input.serverId, ...(input.metadata ?? {}) })}
  )`;
}

async function installation(input: {
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  status?: "active" | "disabled";
  config: Record<string, unknown>;
}) {
  await sql`insert into capability_installations (
    account_id, workspace_id, capability_id, kind, status, config, metadata
  ) values (
    ${input.accountId}, ${input.workspaceId}, ${input.capabilityId}, 'mcp',
    ${input.status ?? "active"}, ${sql.json(input.config)},
    ${sql.json({ mcpConnectivity: { status: "auth_deferred" } })}
  )`;
}

async function seed() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`personal extension ${suffix}`}) returning id`;
  const [otherOrg] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`other org ${suffix}`}) returning id`;
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

  // A custom MCP defined by the shared workspace, enabled for each member's
  // own account. Its installation also stores workspace credential headers,
  // which must never travel.
  const custom = {
    id: `mcp:acme-${suffix}`,
    serverId: `acme-${suffix}`,
    endpoint: `https://acme-${suffix}.example.test/mcp`,
    providerDomain: `acme-${suffix}.example.test`,
  };
  await catalogItem({
    ...custom,
    accountId,
    workspaceId: team,
    name: "Acme MCP",
    metadata: { allowedTools: ["acme_search"] },
  });
  await installation({
    accountId,
    workspaceId: team,
    capabilityId: custom.id,
    config: {
      allowedTools: ["acme_search", "acme_write"],
      headersEncrypted: { "X-Workspace-Secret": "workspace-ciphertext" },
      connectionRef: {
        providerDomain: custom.providerDomain,
        kind: "oauth2",
        resource: custom.endpoint,
        subjectScope: "subject",
      },
    },
  });
  // A curated (global catalog) connector, enabled in the shared workspace with
  // workspace-local configuration that must not be copied.
  const curated = {
    id: `registry:linear-${suffix}`,
    serverId: `linear-${suffix}`,
    endpoint: `https://linear-${suffix}.example.test/mcp`,
    providerDomain: `linear-${suffix}.example.test`,
  };
  await catalogItem({ ...curated, accountId: null, workspaceId: null, name: "Linear" });
  await installation({
    accountId,
    workspaceId: team,
    capabilityId: curated.id,
    config: {
      allowedTools: ["team_only_tool"],
      connectionRef: {
        providerDomain: curated.providerDomain,
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
  });
  // A shared-workspace connector used only through a workspace-owned account.
  const workspaceOnly = {
    id: `mcp:wiki-${suffix}`,
    serverId: `wiki-${suffix}`,
    endpoint: `https://wiki-${suffix}.example.test/mcp`,
    providerDomain: `wiki-${suffix}.example.test`,
  };
  await catalogItem({ ...workspaceOnly, accountId, workspaceId: team, name: "Team wiki" });
  const teamWikiConnection = await connection({
    accountId,
    workspaceId: team,
    subjectId: null,
    providerDomain: workspaceOnly.providerDomain,
  });
  await installation({
    accountId,
    workspaceId: team,
    capabilityId: workspaceOnly.id,
    config: {
      connectionRef: {
        providerDomain: workspaceOnly.providerDomain,
        kind: "oauth2",
        connectionId: teamWikiConnection,
        subjectScope: "workspace",
      },
    },
  });

  const miaAcme = await connection({
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: custom.providerDomain,
    resource: custom.endpoint,
  });
  const miaLinear = await connection({
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: curated.providerDomain,
  });
  // A workspace-owned Linear account in the shared workspace never follows.
  const teamLinear = await connection({
    accountId,
    workspaceId: team,
    subjectId: null,
    providerDomain: curated.providerDomain,
  });
  const bobAcme = await connection({
    accountId,
    workspaceId: team,
    subjectId: bob,
    providerDomain: custom.providerDomain,
    resource: custom.endpoint,
  });
  return {
    accountId,
    otherOrgId: otherOrg!.id,
    team,
    miaPersonal,
    bobPersonal,
    otherOrgPersonal,
    mia,
    bob,
    custom,
    curated,
    workspaceOnly,
    connections: { miaAcme, miaLinear, teamLinear, bobAcme, teamWikiConnection },
  };
}

async function personalServers(input: {
  workspaceId: string;
  subjectId?: string;
  delegations?: Parameters<typeof settingsWithEnabledCapabilityMcpServers>[3] extends infer O
    ? O extends { personalConnectionDelegations?: infer D }
      ? D
      : never
    : never;
}) {
  let resolved: readonly EnabledMcpCapabilityServer[] = [];
  const result = await settingsWithEnabledCapabilityMcpServers(
    client.db,
    input.workspaceId,
    settings,
    {
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(input.delegations ? { personalConnectionDelegations: input.delegations } : {}),
      onResolvedCapabilityServers: (servers) => {
        resolved = servers;
      },
    },
  );
  return { servers: result.mcpServers, resolved };
}

function ids(servers: readonly { id: string }[]): string[] {
  return servers.map((server) => server.id).sort();
}

test("the owner's Personal workspace carries the shared workspace's custom MCP and curated connector and binds their own accounts", async () => {
  if (!shared) return;
  const f = fixture;
  const { servers, resolved } = await personalServers({
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
  });
  expect(ids(servers)).toEqual([f.custom.serverId, f.curated.serverId].sort());
  const acme = servers.find((server) => server.id === f.custom.serverId)!;
  const linear = servers.find((server) => server.id === f.curated.serverId)!;
  // The origin's custom definition travels; its workspace headers never do.
  expect(acme.url).toBe(f.custom.endpoint);
  expect(acme.allowedTools).toEqual(["acme_search", "acme_write"]);
  expect(acme.headers).toBeUndefined();
  expect(resolved.every((server) => server.headersEncrypted === undefined)).toBe(true);
  expect(acme.connectionRef).toEqual({
    providerDomain: f.custom.providerDomain,
    kind: "oauth2",
    resource: f.custom.endpoint,
    subjectScope: "subject",
  });
  // The curated connector uses its catalog definition, not the origin's config.
  expect(linear.url).toBe(f.curated.endpoint);
  expect(linear.allowedTools).toBeUndefined();
  expect(linear.connectionRef).toEqual({
    providerDomain: f.curated.providerDomain,
    kind: "oauth2",
    subjectScope: "subject",
  });
  // The shared workspace's own enabled set still carries its headers there.
  const teamEnabled = await listEnabledMcpCapabilityServers(client.db, f.team);
  expect(teamEnabled.find((server) => server.id === f.custom.serverId)?.headersEncrypted).toEqual({
    "X-Workspace-Secret": "workspace-ciphertext",
  });

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
      [f.custom.serverId, f.connections.miaAcme, f.team, f.mia],
      [f.curated.serverId, f.connections.miaLinear, f.team, f.mia],
    ].sort(),
  );

  // At turn claim the owner comes from the frozen delegations alone.
  const claimed = await personalServers({
    workspaceId: f.miaPersonal,
    delegations: frozen.personalConnectionDelegations,
  });
  expect(ids(claimed.servers)).toEqual(ids(servers));
}, 60_000);

test("an accepted message in the Personal workspace binds the carried connectors to the sender's accounts", async () => {
  if (!shared) return;
  const f = fixture;
  const scope = { accountId: f.accountId, workspaceId: f.miaPersonal };
  const tools = [
    { kind: "mcp" as const, id: f.custom.serverId },
    { kind: "mcp" as const, id: f.curated.serverId },
  ];
  const session = await createSession(client.db, {
    ...scope,
    subjectId: f.mia,
    initialMessage: "personal session",
    resources: [],
    tools,
    metadata: {},
    createdBy: { kind: "subject", subjectId: f.mia },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const accepted = await acceptSessionUserMessageWithOutcome(
    {
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: { wakeSessionWorkflow: async () => {} },
      objectStorage: null,
    } as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[0],
    {
      ...scope,
      subjectId: f.mia,
      permissions: ["admin"],
      principalKind: "human_session",
    } as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
    scope.workspaceId,
    session.id,
    { text: "use my tools", clientEventId: crypto.randomUUID(), delivery: "send" },
  );
  const bindings = await getSessionTurnMcpAccountBindings(
    client.db,
    scope.workspaceId,
    session.id,
    accepted.turn.id,
  );
  expect(
    bindings?.map((binding) => [binding.canonicalServerId, binding.connectionId]).sort(),
  ).toEqual(
    [
      [f.custom.serverId, f.connections.miaAcme],
      [f.curated.serverId, f.connections.miaLinear],
    ].sort(),
  );
}, 60_000);

test("the Personal connector page shows carried connectors labelled with their workspace", async () => {
  if (!shared) return;
  const f = fixture;
  const catalog = await buildCapabilityCatalog({
    db: client.db,
    workspaceId: f.miaPersonal,
    settings,
    subjectId: f.mia,
  });
  for (const id of [f.custom.id, f.curated.id]) {
    const item = catalog.items.find((candidate) => candidate.id === id);
    expect(item?.enabled).toBe(true);
    expect(item?.enabledReason).toBe("From Team workspace");
    expect(item?.lifecycle.detail).toBe("From Team workspace");
    expect(item?.actions).toEqual(["inspect"]);
    expect(item?.metadata.personalExtension).toEqual({
      originWorkspaceId: f.team,
      originWorkspaceName: "Team workspace",
    });
    expect(item?.connectionRef?.subjectScope).toBe("subject");
    expect(item?.connectionRef?.connectionId).toBeUndefined();
  }
  expect(catalog.items.some((item) => item.id === f.workspaceOnly.id)).toBe(false);
  expect(catalog.installations).toEqual([]);
  // Without a subject (or for anyone else) nothing is carried.
  const anonymous = await buildCapabilityCatalog({
    db: client.db,
    workspaceId: f.miaPersonal,
    settings,
  });
  expect(anonymous.items.find((item) => item.id === f.curated.id)?.enabled).toBe(false);
  expect(anonymous.items.some((item) => item.id === f.custom.id)).toBe(false);
}, 60_000);

test("the owner can open a carried connector's approvals in their Personal workspace", async () => {
  if (!shared) return;
  const f = fixture;
  const input = (subjectId: string, capabilityId: string, personalOwnerVerified = true) => ({
    db: client.db,
    settings,
    workspaceId: f.miaPersonal,
    capabilityId,
    personalOwnerVerified,
    grant: {
      accountId: f.accountId,
      workspaceId: f.miaPersonal,
      subjectId,
      permissions: ["capabilities:read", "capabilities:manage"],
      metadata: {},
    },
  });
  const expected = [
    [f.custom.id, f.connections.miaAcme],
    [f.curated.id, f.connections.miaLinear],
  ] as const;
  for (const [capabilityId, connectionId] of expected) {
    const permissions = await getConnectorToolPermissions(input(f.mia, capabilityId));
    expect(permissions.connectionId).toBe(connectionId);
    expect(permissions.accounts.map((account) => account.connectionId)).toEqual([connectionId]);
    expect(permissions.accounts.every((account) => account.scope === "personal")).toBe(true);
    // Without owner verification the carried connector does not exist here.
    await expect(
      getConnectorToolPermissions(input(f.mia, capabilityId, false)),
    ).rejects.toMatchObject({ status: 404 });
  }
}, 60_000);

test("nothing crosses to another member, another organization or a shared workspace", async () => {
  if (!shared) return;
  const f = fixture;
  // Bob's own Personal workspace carries only Bob's own connector.
  expect(
    ids((await personalServers({ workspaceId: f.bobPersonal, subjectId: f.bob })).servers),
  ).toEqual([f.custom.serverId]);
  // Naming another member never reaches a Personal workspace that is not theirs.
  expect((await personalServers({ workspaceId: f.miaPersonal, subjectId: f.bob })).servers).toEqual(
    [],
  );
  expect((await personalServers({ workspaceId: f.bobPersonal, subjectId: f.mia })).servers).toEqual(
    [],
  );
  // Mia's Personal workspace in another organization receives nothing.
  expect(
    (await personalServers({ workspaceId: f.otherOrgPersonal, subjectId: f.mia })).servers,
  ).toEqual([]);
  // The shared workspace's own set is unchanged.
  expect(ids((await personalServers({ workspaceId: f.team, subjectId: f.mia })).servers)).toEqual(
    ids(await listEnabledMcpCapabilityServers(client.db, f.team)),
  );
  // Workspace accounts in the origin never bind in the Personal workspace.
  const { servers } = await personalServers({ workspaceId: f.miaPersonal, subjectId: f.mia });
  const frozen = await freezeConnectionAccounts({
    db: client.db,
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    settings: { ...settings, mcpServers: servers },
    tools: servers.map((server) => ({ kind: "mcp" as const, id: server.id })),
    source: { kind: "subject", subjectId: f.mia, accountId: f.accountId },
  });
  const bound = new Set(frozen.mcpAccountBindings?.map((binding) => binding.connectionId));
  expect(bound.has(f.connections.teamLinear)).toBe(false);
  expect(bound.has(f.connections.teamWikiConnection)).toBe(false);
  expect(bound.has(f.connections.bobAcme)).toBe(false);
}, 60_000);

test("losing origin membership, a removed connection, Personal's own choices and organization policy all win", async () => {
  if (!shared) return;
  const f = fixture;
  const carried = async () =>
    ids((await personalServers({ workspaceId: f.miaPersonal, subjectId: f.mia })).servers);
  expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId].sort());

  // Removed from the origin workspace: re-checked at serving time.
  await sql`delete from workspace_memberships
    where workspace_id = ${f.team} and subject_id = ${f.mia}`;
  expect(await carried()).toEqual([]);
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${f.accountId}, ${f.team}, ${f.mia})`;
  expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId].sort());

  // A revoked connection leaves nothing behind.
  await sql`update connections set status = 'revoked' where id = ${f.connections.miaAcme}`;
  expect(await carried()).toEqual([f.curated.serverId]);
  await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;

  // Personal's explicit disable of the curated connector wins.
  await installation({
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    capabilityId: f.curated.id,
    status: "disabled",
    config: {
      connectionRef: {
        providerDomain: f.curated.providerDomain,
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
  });
  expect(await carried()).toEqual([f.custom.serverId]);
  // Enabled in Personal itself: Personal's own installation serves it, once.
  await sql`update capability_installations set status = 'active'
    where workspace_id = ${f.miaPersonal} and capability_id = ${f.curated.id}`;
  const own = await personalServers({ workspaceId: f.miaPersonal, subjectId: f.mia });
  expect(ids(own.servers)).toEqual([f.custom.serverId, f.curated.serverId].sort());
  expect(own.resolved.filter((server) => server.id === f.curated.serverId)).toHaveLength(1);
  await sql`delete from capability_installations
    where workspace_id = ${f.miaPersonal} and capability_id = ${f.curated.id}`;

  // An organization that does not allow MCP connectors carries none.
  await sql`insert into organization_integration_policies (account_id, mode, allowed_integration_keys, revision)
    values (${f.accountId}, 'restricted', '[]'::jsonb, 1)`;
  expect(await carried()).toEqual([]);
  await sql`update organization_integration_policies
    set allowed_integration_keys = '["custom:mcp"]'::jsonb, revision = 2
    where account_id = ${f.accountId}`;
  expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId].sort());
  await sql`delete from organization_integration_policies where account_id = ${f.accountId}`;
}, 60_000);

test("each carried connector needs the policy key its own setup in Personal would check", async () => {
  if (!shared) return;
  const f = fixture;
  // A curated connector served by a dedicated adapter (Gmail) is gated by its
  // own key, not by the custom MCP switch.
  const suffix = crypto.randomUUID().slice(0, 8);
  const gmail = {
    id: `registry:gmail-${suffix}`,
    serverId: `gmail-${suffix}`,
    endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    providerDomain: "gmailmcp.googleapis.com",
  };
  await catalogItem({ ...gmail, accountId: null, workspaceId: null, name: "Gmail" });
  await installation({
    accountId: f.accountId,
    workspaceId: f.team,
    capabilityId: gmail.id,
    config: {
      connectionRef: {
        providerDomain: gmail.providerDomain,
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
  });
  const miaGmail = await connection({
    accountId: f.accountId,
    workspaceId: f.team,
    subjectId: f.mia,
    providerDomain: gmail.providerDomain,
  });
  const carried = async () =>
    ids((await personalServers({ workspaceId: f.miaPersonal, subjectId: f.mia })).servers);
  const policy = async (keys: string[], revision: number) => {
    await sql`insert into organization_integration_policies (account_id, mode, allowed_integration_keys, revision)
      values (${f.accountId}, 'restricted', ${sql.json(keys)}, ${revision})
      on conflict (account_id) do update
        set allowed_integration_keys = excluded.allowed_integration_keys, revision = excluded.revision`;
  };
  try {
    expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId, gmail.serverId].sort());
    await policy(["custom:mcp"], 1);
    expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId].sort());
    await policy(["gmail"], 2);
    expect(await carried()).toEqual([gmail.serverId]);
    await policy(["gmail", "custom:mcp"], 3);
    expect(await carried()).toEqual([f.custom.serverId, f.curated.serverId, gmail.serverId].sort());
  } finally {
    await sql`delete from organization_integration_policies where account_id = ${f.accountId}`;
    await sql`delete from connections where id = ${miaGmail}`;
    await sql`delete from capability_installations
      where workspace_id = ${f.team} and capability_id = ${gmail.id}`;
    await sql`delete from capability_catalog_items where id = ${gmail.id}`;
  }
}, 60_000);
