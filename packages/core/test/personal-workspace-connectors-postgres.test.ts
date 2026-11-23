import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createDb,
  createSession,
  getSessionTurnConnectionAccountIntent,
  getSessionTurnMcpAccountBindings,
  listEnabledMcpCapabilityServers,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";
import { CODEX_APPS_MCP_SERVER_ID } from "@opengeni/codex";
import {
  buildCapabilityCatalog,
  carriedConnectorCandidateIds,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithEnabledCapabilityMcpServersForTargets,
} from "../src/domain/capabilities";
import { mcpAccountRouteId } from "../src/domain/mcp-account-bindings";
import {
  freezeConnectionAccounts,
  personalWorkspaceOwnerOriginConnections,
} from "../src/domain/personal-connection-delegations";
import { personalWorkspaceExtensionMcpServers } from "../src/domain/personal-workspace-connectors";
import { resolveContinuedConnectionAccounts } from "../src/domain/session-connection-accounts";
import { getConnectorToolPermissions } from "../src/domain/connector-tool-permissions";
import {
  acceptSessionUserMessageWithOutcome,
  createSessionForRequest,
  updateSessionToolPolicy,
} from "../src/domain/sessions";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS } from "@opengeni/contracts";

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

test("a carried connector whose account stopped working stays listed but never runs", async () => {
  if (!shared) return;
  const f = fixture;
  const listed = async () =>
    (
      await buildCapabilityCatalog({
        db: client.db,
        workspaceId: f.miaPersonal,
        settings,
        subjectId: f.mia,
      })
    ).items.find((item) => item.id === f.custom.id);
  const runs = async () =>
    ids((await personalServers({ workspaceId: f.miaPersonal, subjectId: f.mia })).servers);
  for (const status of ["needs_reauth", "error", "revoked"] as const) {
    await sql`update connections set status = ${status} where id = ${f.connections.miaAcme}`;
    try {
      // The connector page and composer keep it, so it shows "Reconnect required"
      // on every device and after a reload, until it is reconnected.
      const item = await listed();
      expect(item?.enabled).toBe(true);
      expect(item?.metadata.personalExtension).toEqual({
        originWorkspaceId: f.team,
        originWorkspaceName: "Team workspace",
      });
      // Listed as needing attention, never as ready: nothing selects it by
      // default or offers it as runnable until it is reconnected.
      expect(item?.runtime.available).toBe(false);
      expect(item?.lifecycle.readiness).toBe("attention");
      // Nothing that runs or binds a connector uses it.
      expect(await runs()).toEqual([f.curated.serverId]);
      // Its approvals page is not offered while it can't run.
      await expect(
        getConnectorToolPermissions({
          db: client.db,
          settings,
          workspaceId: f.miaPersonal,
          capabilityId: f.custom.id,
          personalOwnerVerified: true,
          grant: {
            accountId: f.accountId,
            workspaceId: f.miaPersonal,
            subjectId: f.mia,
            permissions: ["capabilities:read", "capabilities:manage"],
            metadata: {},
          } as unknown as Parameters<typeof getConnectorToolPermissions>[0]["grant"],
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
    }
  }
  expect(await runs()).toEqual([f.custom.serverId, f.curated.serverId].sort());
}, 60_000);

test("a carried connector whose account stopped working never blocks starting or continuing a chat", async () => {
  if (!shared) return;
  const f = fixture;
  const scope = { accountId: f.accountId, workspaceId: f.miaPersonal };
  const grant = {
    ...scope,
    subjectId: f.mia,
    permissions: ["admin", "sessions:control"],
    principalKind: "human_session",
  } as unknown as Parameters<typeof createSessionForRequest>[1];
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => {} },
    objectStorage: null,
  } as unknown as Parameters<typeof createSessionForRequest>[0];
  const custom = { kind: "mcp" as const, id: f.custom.serverId };
  const curated = { kind: "mcp" as const, id: f.curated.serverId };
  const create = async (tools: { kind: "mcp"; id: string }[]) =>
    await createSessionForRequest(deps, grant, f.miaPersonal, {
      initialMessage: "use my tools",
      resources: [],
      tools,
      model: "scripted-model",
      idempotencyKey: crypto.randomUUID(),
    });
  const gapsOf = async (sessionId: string) =>
    (
      await sql<{ gaps: unknown }[]>`
        select metadata -> 'connectionAccountGaps' as gaps from session_turns
        where session_id = ${sessionId} order by created_at`
    ).map((row) => row.gaps);

  // Chosen while it worked: a chat whose tools name it.
  const before = await create([custom, curated]);
  await sql`update connections set status = 'needs_reauth' where id = ${f.connections.miaAcme}`;
  try {
    // A new chat whose selection still names it keeps it chosen but starts
    // without running or binding it.
    const including = await create([custom, curated]);
    expect(
      including.tools
        .filter((tool) => tool.kind === "mcp")
        .map((tool) => tool.id)
        .sort(),
    ).toEqual([f.curated.serverId, f.custom.serverId].sort());
    const firstTurns = await sql<{ id: string }[]>`
      select id from session_turns where session_id = ${including.id} order by created_at`;
    const firstBindings = await getSessionTurnMcpAccountBindings(
      client.db,
      f.miaPersonal,
      including.id,
      firstTurns[0]!.id,
    );
    expect(firstBindings?.map((binding) => binding.canonicalServerId) ?? []).not.toContain(
      f.custom.serverId,
    );
    expect(await gapsOf(including.id)).toEqual([
      [
        {
          serverId: f.custom.serverId,
          connectionId: f.connections.miaAcme,
          reason: "account_inactive",
        },
      ],
    ]);
    // One without it is unaffected.
    const excluding = await create([curated]);
    expect(excluding.tools.filter((tool) => tool.kind === "mcp").map((tool) => tool.id)).toEqual([
      f.curated.serverId,
    ]);
    // Any other unknown connector is still refused.
    await expect(create([{ kind: "mcp", id: "not_a_connector" }])).rejects.toMatchObject({
      status: 422,
    });

    // A follow-up in the chat that chose it is accepted, without that connector.
    const followUp = await acceptSessionUserMessageWithOutcome(
      deps as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[0],
      grant as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
      f.miaPersonal,
      before.id,
      { text: "again", clientEventId: crypto.randomUUID(), delivery: "send" },
    );
    const bindings = await getSessionTurnMcpAccountBindings(
      client.db,
      f.miaPersonal,
      before.id,
      followUp.turn.id,
    );
    expect(bindings?.map((binding) => binding.canonicalServerId)).toEqual([f.curated.serverId]);

    // Turning it on for a chat that never had it keeps it chosen, not run.
    const updated = await updateSessionToolPolicy(
      deps as unknown as Parameters<typeof updateSessionToolPolicy>[0],
      grant,
      excluding.id,
      {
        mode: "explicit",
        tools: [curated, custom],
        firstPartyMcpTools: [...(excluding.firstPartyMcpTools ?? DEFAULT_FIRST_PARTY_MCP_TOOLS)],
        expectedVersion: excluding.toolPolicyVersion ?? 1,
      },
    );
    expect(updated.tools.map((tool) => tool.id)).toContain(f.custom.serverId);
    await expect(
      updateSessionToolPolicy(
        deps as unknown as Parameters<typeof updateSessionToolPolicy>[0],
        grant,
        excluding.id,
        {
          mode: "explicit",
          tools: [curated, { kind: "mcp", id: "not_a_connector" }],
          firstPartyMcpTools: [...(updated.firstPartyMcpTools ?? DEFAULT_FIRST_PARTY_MCP_TOOLS)],
          expectedVersion: updated.toolPolicyVersion ?? 2,
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Once the account is reconnected, the chat that kept it chosen gets it back.
    await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
    const reconnected = await acceptSessionUserMessageWithOutcome(
      deps as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[0],
      grant as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
      f.miaPersonal,
      including.id,
      { text: "it works again", clientEventId: crypto.randomUUID(), delivery: "send" },
    );
    const reconnectedBindings = await getSessionTurnMcpAccountBindings(
      client.db,
      f.miaPersonal,
      including.id,
      reconnected.turn.id,
    );
    expect(
      reconnectedBindings?.find((binding) => binding.canonicalServerId === f.custom.serverId),
    ).toMatchObject({ connectionId: f.connections.miaAcme });
  } finally {
    await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
  }
}, 120_000);

test("a child chat can't widen its parent's tools through a carried connector whose account stopped working", async () => {
  if (!shared) return;
  const f = fixture;
  const grant = {
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    permissions: ["admin", "sessions:control"],
    principalKind: "human_session",
    metadata: {},
  } as unknown as Parameters<typeof createSessionForRequest>[1];
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => {} },
    objectStorage: null,
  } as unknown as Parameters<typeof createSessionForRequest>[0];
  const custom = { kind: "mcp" as const, id: f.custom.serverId };
  const curated = { kind: "mcp" as const, id: f.curated.serverId };
  const create = async (tools: { kind: "mcp"; id: string }[], parentSessionId?: string) =>
    await createSessionForRequest(
      deps,
      parentSessionId
        ? ({
            ...grant,
            metadata: { sessionId: parentSessionId },
          } as unknown as Parameters<typeof createSessionForRequest>[1])
        : grant,
      f.miaPersonal,
      {
        initialMessage: "use my tools",
        resources: [],
        tools,
        model: "scripted-model",
        idempotencyKey: crypto.randomUUID(),
      },
    );
  const mcpIds = (session: { tools: { kind: string; id: string }[] }) =>
    session.tools
      .filter((tool) => tool.kind === "mcp")
      .map((tool) => tool.id)
      .sort();

  const narrowParent = await create([curated]);
  // With a working account, a child asking for more than its parent is refused.
  await expect(create([curated, custom], narrowParent.id)).rejects.toMatchObject({ status: 403 });
  await sql`update connections set status = 'needs_reauth' where id = ${f.connections.miaAcme}`;
  try {
    // A lapsed account doesn't change that.
    await expect(create([curated, custom], narrowParent.id)).rejects.toMatchObject({
      status: 403,
    });
    // A parent that keeps the lapsed connector chosen can pass it on.
    const wideParent = await create([curated, custom]);
    expect(mcpIds(wideParent)).toEqual([f.curated.serverId, f.custom.serverId].sort());
    const child = await create([curated, custom], wideParent.id);
    expect(mcpIds(child)).toEqual([f.curated.serverId, f.custom.serverId].sort());
  } finally {
    await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
  }
  // After reconnecting, the narrow parent's children still can't widen it.
  await expect(create([curated, custom], narrowParent.id)).rejects.toMatchObject({ status: 403 });
}, 120_000);

test("a pick for a carried connector whose account stopped working is kept, so later work binds only that account", async () => {
  if (!shared) return;
  const f = fixture;
  const grant = {
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    permissions: ["admin", "sessions:control"],
    principalKind: "human_session",
    metadata: {},
  } as unknown as Parameters<typeof createSessionForRequest>[1];
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => {} },
    objectStorage: null,
  } as unknown as Parameters<typeof createSessionForRequest>[0];
  const custom = { kind: "mcp" as const, id: f.custom.serverId };
  const curated = { kind: "mcp" as const, id: f.curated.serverId };
  const pickA = [{ serverId: f.custom.serverId, connectionId: f.connections.miaAcme }];
  const turnIds = async (sessionId: string) =>
    (
      await sql<{ id: string }[]>`
        select id from session_turns where session_id = ${sessionId} order by created_at`
    ).map((row) => row.id);
  let accountB: string | null = null;
  await sql`update connections set status = 'needs_reauth' where id = ${f.connections.miaAcme}`;
  try {
    // A new chat picking account A while it has stopped working.
    const chat = await createSessionForRequest(deps, grant, f.miaPersonal, {
      initialMessage: "use account A",
      resources: [],
      tools: [custom, curated],
      connectionAccounts: pickA,
      model: "scripted-model",
      idempotencyKey: crypto.randomUUID(),
    } as Parameters<typeof createSessionForRequest>[3]);
    const [firstTurn] = await turnIds(chat.id);
    const firstIntent = await getSessionTurnConnectionAccountIntent(
      client.db,
      f.miaPersonal,
      chat.id,
      firstTurn!,
    );
    expect(firstIntent?.selections).toEqual(pickA);
    // A follow-up still picking it is accepted too, and keeps the pick.
    const followUp = await acceptSessionUserMessageWithOutcome(
      deps as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[0],
      grant as unknown as Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
      f.miaPersonal,
      chat.id,
      {
        text: "again with A",
        clientEventId: crypto.randomUUID(),
        delivery: "send",
        connectionAccounts: pickA,
      },
    );
    const followUpIntent = await getSessionTurnConnectionAccountIntent(
      client.db,
      f.miaPersonal,
      chat.id,
      followUp.turn.id,
    );
    expect(followUpIntent?.selections).toEqual(pickA);

    // Reconnect A and add a second account B for the same connector.
    await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
    accountB = await connection({
      accountId: f.accountId,
      workspaceId: f.team,
      subjectId: f.mia,
      providerDomain: f.custom.providerDomain,
      resource: f.custom.endpoint,
    });
    // Work continuing either turn binds A only, never B.
    for (const intent of [firstIntent!, followUpIntent!]) {
      const continued = await resolveContinuedConnectionAccounts({
        db: client.db,
        settings,
        accountId: f.accountId,
        workspaceId: f.miaPersonal,
        sessionId: chat.id,
        intent,
      });
      expect(
        (continued.mcpAccountBindings ?? [])
          .filter((binding) => binding.canonicalServerId === f.custom.serverId)
          .map((binding) => binding.connectionId),
      ).toEqual([f.connections.miaAcme]);
    }
  } finally {
    await sql`update connections set status = 'active' where id = ${f.connections.miaAcme}`;
    if (accountB) await sql`delete from connections where id = ${accountB}`;
  }
}, 120_000);

test("a carried connector a working origin serves is never listed as lapsed from another origin", async () => {
  if (!shared) return;
  const f = fixture;
  const [origin] = await personalWorkspaceOwnerOriginConnections(client.db, {
    accountId: f.accountId,
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    includeLapsed: true,
  });
  expect(origin?.originWorkspaceId).toBe(f.team);
  // The same connectors offered first by an origin whose accounts stopped working.
  const lapsedFirst = {
    ...origin!,
    connections: origin!.connections.map((account) => ({
      ...account,
      status: "needs_reauth" as const,
    })),
  };
  const carried = await personalWorkspaceExtensionMcpServers(client.db, {
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    accountId: f.accountId,
    ownServers: [],
    origins: [lapsedFirst, origin!],
    includeLapsed: true,
  });
  const byId = new Map(carried.map((server) => [server.id, server]));
  for (const id of [f.custom.serverId, f.curated.serverId]) {
    expect(byId.get(id)).toBeDefined();
    expect(byId.get(id)?.lapsedConnection).toBeUndefined();
  }
  // With only the lapsed origin, it is listed as lapsed.
  const onlyLapsed = await personalWorkspaceExtensionMcpServers(client.db, {
    workspaceId: f.miaPersonal,
    subjectId: f.mia,
    accountId: f.accountId,
    ownServers: [],
    origins: [lapsedFirst],
    includeLapsed: true,
  });
  expect(
    onlyLapsed.find((server) => server.id === f.custom.serverId)?.lapsedConnection,
  ).toBeDefined();
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

test("the live tool-call fence finds carried connectors only where something is unresolved", async () => {
  if (!shared) return;
  const f = fixture;
  const fence = async (workspaceId: string, serverIds: string[]) =>
    ids(
      (
        await settingsWithEnabledCapabilityMcpServersForTargets(client.db, workspaceId, settings, {
          subjectId: f.mia,
          accountId: f.accountId,
          serverIds,
          capabilityIds: [],
        })
      ).mcpServers,
    );
  // A gateway fence names canonical connector ids beside their account routes.
  const targets = [
    f.custom.serverId,
    mcpAccountRouteId(f.custom.serverId, f.connections.miaAcme),
    f.curated.serverId,
    mcpAccountRouteId(f.curated.serverId, f.connections.miaLinear),
    CODEX_APPS_MCP_SERVER_ID,
  ];
  expect(await fence(f.miaPersonal, targets)).toEqual(
    [f.custom.serverId, f.curated.serverId].sort(),
  );
  // Removed from the origin workspace, the same fence resolves nothing carried.
  await sql`delete from workspace_memberships
    where workspace_id = ${f.team} and subject_id = ${f.mia}`;
  try {
    expect(await fence(f.miaPersonal, targets)).toEqual([]);
  } finally {
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${f.accountId}, ${f.team}, ${f.mia})`;
  }
  // In the shared workspace every connector resolves from its own rows, so the
  // fence never looks for carried connectors there.
  const teamResolved = await fence(f.team, targets);
  expect(teamResolved).toEqual([f.custom.serverId, f.curated.serverId].sort());
  expect(carriedConnectorCandidateIds(targets, teamResolved)).toEqual([]);
  expect(carriedConnectorCandidateIds(targets, [])).toEqual([
    f.custom.serverId,
    f.curated.serverId,
  ]);
}, 60_000);
