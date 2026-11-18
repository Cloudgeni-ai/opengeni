import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { nangoProviderDomain, type ConnectorToolPermissionsResponse } from "@opengeni/contracts";
import {
  connectorActionPoliciesForAccountRoutes,
  createConnection,
  createDb,
  integrationBackendSettingsCache,
  listConnectorToolPermissionPolicies,
} from "@opengeni/db";
import { settingsWithEnabledCapabilityMcpServers } from "../src/domain/capabilities";
import {
  getConnectorToolPermissions,
  reviewedConnectorToolCatalog,
  updateConnectorToolPermissions,
} from "../src/domain/connector-tool-permissions";
import { carryConnectorToolChoices } from "../src/domain/connector-tool-choice-accounts";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";
import { nangoDriveTools } from "@opengeni/runtime";

// Per-tool approvals are the same for a connector the operator serves through
// Nango as for its native backend: the same tools, the same safe defaults, the
// account a turn binds is the one they are managed for, and an account's
// choices survive switching the backend either way (docs/nango.md).

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let sql: postgres.Sql;

const settings = testSettings({ sandboxBackend: "none", nangoSecretKey: "nango-secret-test" });
const GMAIL_URL = "https://gmailmcp.googleapis.com/mcp/v1";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-connector-tool-permissions-nango");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    console.warn("[core-connector-tool-permissions-nango] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  sql = shared.admin;
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

async function switchGmail(backend: "nango" | "native") {
  await sql`insert into integration_backend_revisions
      (integration_key, backend, nango_provider_config_key, enabled, changed_by, reason)
    values ('gmail', ${backend}, ${backend === "nango" ? "google-mail" : null}, true, 'test',
      'connector tool permissions test')`;
  integrationBackendSettingsCache.invalidate();
}

function tool(permissions: ConnectorToolPermissionsResponse, name: string) {
  const entry = permissions.tools.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`missing tool ${name}`);
  return entry;
}

test("a Nango-backed connector's approvals load, save, are enforced and survive backend switches", async () => {
  if (!shared) return;
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`nango approvals ${suffix}`}) returning id`;
  const accountId = org!.id;
  const team = await workspace(accountId, "Team workspace");
  const personal = await workspace(accountId, "Mia personal");
  const mia = `user:mia-${suffix}`;
  await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${mia}, 'active', ${personal})`;
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${team}, ${mia})`;
  // Gmail, enabled in the team workspace for each member's own account.
  const capabilityId = `registry:gmail-${suffix}`;
  const serverId = `gmail-${suffix}`;
  await sql`insert into capability_catalog_items (
    id, account_id, workspace_id, kind, source, name, endpoint_url,
    auth_model, auth_kind, provider_domain, mcp_url, metadata
  ) values (
    ${capabilityId}, null, null, 'mcp', 'manual', 'Gmail', ${GMAIL_URL},
    'oauth2', 'oauth2', 'gmailmcp.googleapis.com', ${GMAIL_URL},
    ${sql.json({ mcpServerId: serverId })}
  )`;
  await sql`insert into capability_installations (
    account_id, workspace_id, capability_id, kind, status, config, metadata
  ) values (
    ${accountId}, ${team}, ${capabilityId}, 'mcp', 'active',
    ${sql.json({
      connectionRef: {
        providerDomain: "gmailmcp.googleapis.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    })},
    ${sql.json({ mcpConnectivity: { status: "auth_deferred" } })}
  )`;
  // Mia's Gmail, first connected natively.
  const nativeGmail = await createConnection(client.db, {
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status: "active",
    credentialEncrypted: "unused",
    grantedScopes: GMAIL_SCOPES,
    metadata: { oauthDiscovery: true, mcpUrl: GMAIL_URL, gmailEmail: "Mia@Example.com" },
    createdBySubjectId: mia,
  });
  const input = (workspaceId: string) => ({
    db: client.db,
    settings,
    workspaceId,
    capabilityId,
    personalOwnerVerified: true,
    grant: {
      accountId,
      workspaceId,
      subjectId: mia,
      principalKind: "human_session" as const,
      permissions: ["capabilities:read", "capabilities:manage"],
      metadata: {},
    },
  });
  const choose = async (
    connectionId: string,
    toolName: string,
    permission: "allow" | "ask" | "block",
  ) =>
    await updateConnectorToolPermissions({
      ...input(team),
      payload: { connectionId, target: "tools", toolNames: [toolName], permission },
    });

  // Native: Mia always allows sending.
  const native = await getConnectorToolPermissions(input(team));
  expect(native.connectionId).toBe(nativeGmail.id);
  await choose(nativeGmail.id, "send_message", "allow");

  // The operator moves Gmail to Nango, and Mia connects the same account there.
  await switchGmail("nango");
  try {
    const nangoGmail = await createConnection(client.db, {
      accountId,
      workspaceId: team,
      subjectId: mia,
      providerDomain: nangoProviderDomain("gmail"),
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "unused",
      grantedScopes: GMAIL_SCOPES,
      metadata: {
        integrationBackend: "nango",
        mcpUrl: GMAIL_URL,
        gmailEmail: "mia@example.com",
        accountEmail: "mia@example.com",
      },
      createdBySubjectId: mia,
    });
    // Connecting it carries the account's choices (what the Nango completion runs).
    await carryConnectorToolChoices(client.db, nangoGmail);

    // The approvals page binds the Nango account, with Gmail's own tools.
    const permissions = await getConnectorToolPermissions(input(team));
    expect(permissions.connectionId).toBe(nangoGmail.id);
    expect(permissions.serverId).toBe(serverId);
    expect(permissions.accounts).toEqual([
      expect.objectContaining({ connectionId: nangoGmail.id, scope: "personal" }),
    ]);
    expect(permissions.discoveryError).toBeNull();
    // The same tools with the same defaults as native (a tool native asks
    // first for asks first here too), from the same reviewed catalog.
    expect(permissions.tools.map((entry) => entry.name)).toEqual(
      native.tools.map((entry) => entry.name),
    );
    for (const entry of native.tools.filter((entry) => entry.name !== "send_message"))
      expect(tool(permissions, entry.name)).toMatchObject({
        group: entry.group,
        permission: entry.permission,
        source: "recommended",
      });
    const nangoRef = { providerDomain: nangoProviderDomain("gmail"), kind: "oauth2" as const };
    const nativeRef = { providerDomain: "gmailmcp.googleapis.com", kind: "oauth2" as const };
    expect(
      reviewedConnectorToolCatalog(
        { url: GMAIL_URL, connectionRef: nangoRef },
        GMAIL_SCOPES,
        settings,
      ),
    ).toEqual(
      reviewedConnectorToolCatalog(
        { url: GMAIL_URL, connectionRef: nativeRef },
        GMAIL_SCOPES,
        settings,
      ),
    );
    // The native choice was kept.
    expect(tool(permissions, "send_message")).toMatchObject({
      permission: "allow",
      source: "tool",
    });

    // A choice made under Nango is stored for that account ...
    await choose(nangoGmail.id, "create_draft", "block");
    expect(tool(await getConnectorToolPermissions(input(team)), "create_draft")).toMatchObject({
      permission: "block",
    });

    // ... and a turn binds the same account, so its calls follow both choices.
    const runSettings = await settingsWithEnabledCapabilityMcpServers(client.db, team, settings, {
      subjectId: mia,
    });
    const frozen = await freezeConnectionAccounts({
      db: client.db,
      accountId,
      workspaceId: team,
      settings: runSettings,
      tools: [{ kind: "mcp", id: serverId }],
      source: { kind: "subject", subjectId: mia, accountId },
    });
    const bindings = frozen.mcpAccountBindings ?? [];
    expect(bindings).toEqual([
      expect.objectContaining({ canonicalServerId: serverId, connectionId: nangoGmail.id }),
    ]);
    const enforced = connectorActionPoliciesForAccountRoutes(
      await listConnectorToolPermissionPolicies(client.db, {
        accountId,
        workspaceId: team,
        connectionId: nangoGmail.id,
      }),
      bindings,
    ).filter((policy) => policy.serverId === bindings[0]!.serverId);
    expect(enforced.map((policy) => [policy.toolName, policy.policy]).sort()).toEqual([
      ["create_draft", "block"],
      ["send_message", "allow"],
    ]);

    // Carried into Mia's Personal workspace, the same account and choices apply.
    const carried = await getConnectorToolPermissions(input(personal));
    expect(carried.connectionId).toBe(nangoGmail.id);
    expect(tool(carried, "create_draft")).toMatchObject({ permission: "block" });
  } finally {
    await switchGmail("native");
  }

  // Back on native: the native account has the choices made under Nango too.
  const back = await getConnectorToolPermissions(input(team));
  expect(back.connectionId).toBe(nativeGmail.id);
  expect(tool(back, "send_message")).toMatchObject({ permission: "allow" });
  expect(tool(back, "create_draft")).toMatchObject({ permission: "block" });
}, 60_000);

test("an account first opened under Nango starts from its native choices; another account never does", async () => {
  if (!shared) return;
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into managed_accounts (name) values (${`nango carry ${suffix}`}) returning id`;
  const accountId = org!.id;
  const team = await workspace(accountId, "Team workspace");
  const benPersonal = await workspace(accountId, "Ben personal");
  const ben = `user:ben-${suffix}`;
  await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${ben}, 'active', ${benPersonal})`;
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${team}, ${ben})`;
  const row = async (providerDomain: string, email: string) =>
    await createConnection(client.db, {
      accountId,
      workspaceId: team,
      subjectId: ben,
      providerDomain,
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "unused",
      grantedScopes: GMAIL_SCOPES,
      metadata: { mcpUrl: GMAIL_URL, gmailEmail: email },
      createdBySubjectId: ben,
    });
  const native = await row("gmailmcp.googleapis.com", "ben@example.com");
  await sql`insert into connector_action_policies (
    account_id, workspace_id, connection_id, server_id, tool_name, action_name, policy,
    created_by_subject_id, updated_by_subject_id
  ) values (${accountId}, ${team}, ${native.id}, 'gmail', 'send_message', '*', 'allow', ${ben}, ${ben})`;
  const choices = async (connectionId: string) =>
    (
      await listConnectorToolPermissionPolicies(client.db, {
        accountId,
        workspaceId: team,
        connectionId,
      })
    ).map((policy) => [policy.serverId, policy.toolName, policy.policy]);
  // Another Google account under Nango gets nothing.
  const other = await row(nangoProviderDomain("gmail"), "someone-else@example.com");
  await carryConnectorToolChoices(client.db, other);
  expect(await choices(other.id)).toEqual([]);
  // The same account gets its choices, once; a choice already made there wins.
  const same = await row(nangoProviderDomain("gmail"), "BEN@example.com");
  await sql`insert into connector_action_policies (
    account_id, workspace_id, connection_id, server_id, tool_name, action_name, policy,
    created_by_subject_id, updated_by_subject_id
  ) values (${accountId}, ${team}, ${same.id}, 'gmail', 'create_draft', '*', 'block', ${ben}, ${ben})`;
  await carryConnectorToolChoices(client.db, same);
  expect(await choices(same.id)).toEqual([["gmail", "create_draft", "block"]]);
  await sql`delete from connector_action_policies where connection_id = ${same.id}`;
  await carryConnectorToolChoices(client.db, same);
  await carryConnectorToolChoices(client.db, same);
  expect(await choices(same.id)).toEqual([["gmail", "send_message", "allow"]]);
}, 60_000);

test("Drive through Nango lists the tools its REST bridge serves, without reaching its hosted server", () => {
  const tools = reviewedConnectorToolCatalog(
    {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      connectionRef: {
        providerDomain: nangoProviderDomain("google-drive"),
        kind: "oauth2",
        subjectScope: "subject",
      },
    },
    [],
    settings,
  );
  expect(tools?.map((entry) => entry.name)).toEqual(nangoDriveTools().map((entry) => entry.name));
  expect(tools?.find((entry) => entry.name === "update_file")?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});
