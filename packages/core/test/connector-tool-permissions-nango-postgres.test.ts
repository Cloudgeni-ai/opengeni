import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { nangoProviderDomain } from "@opengeni/contracts";
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
  updateConnectorToolPermissions,
} from "../src/domain/connector-tool-permissions";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";

// A connector the operator serves through Nango keeps per-tool approvals: the
// person's Nango account is the one they are managed for, the same account a
// turn binds, so what they choose is what runs (docs/nango.md).

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;
let sql: postgres.Sql;

const settings = testSettings({ sandboxBackend: "none", nangoSecretKey: "nango-secret-test" });
const GMAIL_URL = "https://gmailmcp.googleapis.com/mcp/v1";

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

test("a Nango-backed connector's approvals are managed and enforced for the Nango account", async () => {
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
  // Mia's Gmail, connected through Nango.
  const nangoGmail = await createConnection(client.db, {
    accountId,
    workspaceId: team,
    subjectId: mia,
    providerDomain: nangoProviderDomain("gmail"),
    kind: "oauth2",
    status: "active",
    credentialEncrypted: "unused",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    metadata: { integrationBackend: "nango", mcpUrl: GMAIL_URL, accountEmail: "mia@example.com" },
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
  await switchGmail("nango");
  try {
    // The approvals page binds the Nango account, with Gmail's own tools.
    const permissions = await getConnectorToolPermissions(input(team));
    expect(permissions.connectionId).toBe(nangoGmail.id);
    expect(permissions.serverId).toBe(serverId);
    expect(permissions.accounts).toEqual([
      expect.objectContaining({ connectionId: nangoGmail.id, scope: "personal" }),
    ]);
    expect(permissions.discoveryError).toBeNull();
    expect(permissions.tools.map((tool) => tool.name)).toContain("send_message");

    // A choice is stored for that account ...
    await updateConnectorToolPermissions({
      ...input(team),
      payload: {
        connectionId: nangoGmail.id,
        target: "tools",
        toolNames: ["send_message"],
        permission: "block",
      },
    });
    const reread = await getConnectorToolPermissions(input(team));
    expect(reread.tools.find((tool) => tool.name === "send_message")).toMatchObject({
      permission: "block",
    });

    // ... and a turn binds the same account, so the choice applies to its calls.
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
    const policies = await listConnectorToolPermissionPolicies(client.db, {
      accountId,
      workspaceId: team,
      connectionId: nangoGmail.id,
    });
    expect(connectorActionPoliciesForAccountRoutes(policies, bindings)).toContainEqual(
      expect.objectContaining({
        serverId: bindings[0]!.serverId,
        connectionId: nangoGmail.id,
        toolName: "send_message",
        policy: "block",
      }),
    );

    // Carried into Mia's Personal workspace, the same account and choice apply.
    const carried = await getConnectorToolPermissions(input(personal));
    expect(carried.connectionId).toBe(nangoGmail.id);
    expect(carried.tools.find((tool) => tool.name === "send_message")).toMatchObject({
      permission: "block",
    });
  } finally {
    await switchGmail("native");
  }
}, 60_000);
