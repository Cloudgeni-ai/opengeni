import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migration = readFileSync(
  new URL(
    "../drizzle/1353_merge_duplicate_personal_logins_across_oauth_clients.sql",
    import.meta.url,
  ),
  "utf8",
);
// The one-time merge, from relaxing FORCE ROW LEVEL SECURITY to restoring it.
const merge = migration.slice(
  migration.indexOf('ALTER TABLE "connections" NO FORCE ROW LEVEL SECURITY;'),
);
const TABLES = [
  "connections",
  "connector_action_policies",
  "organization_user_resource_grants",
  "scheduled_tasks",
  "capability_installations",
  "session_mcp_servers",
  "event_sources",
  "vaults",
  "knowledge_source_sync_states",
  "site_tool_allowances",
  "capability_facet_installations",
  "integration_facet_bindings",
  "agent_slack_installs",
  "slack_agent_intro_posts",
  "slack_agent_suggestions",
];
const GMAIL = "https://gmail.example.test/mcp";

let owned: OwnerMigratedTestDatabase | null = null;
let ownerSql: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("merge-duplicate-logins-across-clients");
  if (!owned) {
    if (requireRealDatabase) throw new Error("login merge PostgreSQL fixture is unavailable");
    return;
  }
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production.
  await migrate(owned.ownerUrl);
  ownerSql = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await ownerSql?.end().catch(() => undefined);
  await owned?.release();
}, 180_000);

async function runMerge() {
  await ownerSql!.unsafe(`BEGIN; ${merge} COMMIT;`);
}

async function workspace(accountId: string, name: string) {
  const [row] = await owned!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
  await owned!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}, ${accountId})`;
  return row!.id;
}

type Person = { accountId: string; subjectId: string };

/** A personal Gmail login, added in `workspaceId` with the given OAuth client. */
async function login(
  person: Person,
  workspaceId: string,
  input: {
    clientId: string;
    email: string;
    scopes: string[];
    issuer?: string;
    lastRefreshAt?: string;
  },
) {
  const metadata = {
    mcpUrl: GMAIL,
    authorizationServerIssuer: input.issuer ?? "https://accounts.example.test",
    clientId: input.clientId,
    gmailEmail: input.email,
  };
  return await owned!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${person.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    await tx`select set_config('opengeni.subject_id', ${person.subjectId}, true)`;
    const [row] = await tx<{ id: string; authorityId: string }[]>`
      insert into connections (account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, granted_scopes, metadata, last_refresh_at)
      values (${person.accountId}, ${workspaceId}, ${person.subjectId}, 'example.test', 'oauth2',
        'ciphertext', ${tx.json(input.scopes)}, ${tx.json(metadata)},
        ${input.lastRefreshAt ?? null})
      returning id, authority_id as "authorityId"`;
    return row!;
  });
}

/** A new organization with one person and their Personal workspace. */
async function organization(name: string) {
  const [account] = await owned!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const accountId = account!.id;
  const personal = await workspace(accountId, `${name} personal`);
  const person = await member(accountId, personal);
  return { accountId, personal, person };
}

async function member(accountId: string, personalWorkspaceId: string): Promise<Person> {
  const subjectId = `user:${crypto.randomUUID()}`;
  await owned!.admin`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId})`;
  return { accountId, subjectId };
}

async function status(connectionId: string) {
  const [row] = await owned!.admin<{ status: string; mergedInto: string | null }[]>`
    select status, metadata ->> 'mergedIntoConnectionId' as "mergedInto"
    from connections where id = ${connectionId}`;
  return row!;
}

async function turnedOnIn(authorityId: string) {
  const rows = await owned!.admin<{ workspaceId: string }[]>`
    select workspace_id as "workspaceId" from organization_user_resource_grants
    where authority_id = ${authorityId} and action = 'connection.use'
      and mode = 'always' and context = 'workspace_shared' and status = 'active'
    order by workspace_id`;
  return rows.map((row) => row.workspaceId);
}

describe("1353 merges duplicate personal logins made with different OAuth clients (real PostgreSQL)", () => {
  test("the same verified account under an earlier client merges into the kept login", async () => {
    if (!owned || !ownerSql) return;
    const forced = async () =>
      await owned!.admin<{ relname: string; forced: boolean }[]>`
        select relname, relforcerowsecurity as forced from pg_class
        where relname in ${owned!.admin(TABLES)} and relkind = 'r'`;
    const before = await forced();
    expect(before).toHaveLength(TABLES.length);
    expect(before.every((row) => row.forced)).toBe(true);

    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('cross-client login merge') returning id`;
    const accountId = account!.id;
    const personal = await workspace(accountId, "owner personal");
    const team = await workspace(accountId, "team");
    const subjectId = `user:${crypto.randomUUID()}`;
    await owned.admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, ${subjectId}, 'active', ${personal})`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${team}, ${subjectId})`;
    const person = { accountId, subjectId };
    const me = "me@example.test";

    // Connected first in Personal with the deployment's first client.
    const kept = await login(person, personal, {
      clientId: "first-client",
      email: me,
      scopes: ["read", "send"],
    });
    // After the deployment replaced its client, the same mailbox saved again.
    const duplicate = await login(person, team, {
      clientId: "replacement-client",
      email: me,
      scopes: ["read"],
    });
    // The same mailbox with a scope the kept login lacks stays.
    const broader = await login(person, team, {
      clientId: "replacement-client",
      email: me,
      scopes: ["read", "admin"],
    });
    // Another authorization server, and another mailbox, are other accounts.
    const otherIssuer = await login(person, team, {
      clientId: "replacement-client",
      email: me,
      scopes: ["read"],
      issuer: "https://other-issuer.example.test",
    });
    const otherMailbox = await login(person, team, {
      clientId: "replacement-client",
      email: "other@example.test",
      scopes: ["read"],
    });
    // The same mailbox again, but an event trigger depends on this login.
    const triggered = await login(person, team, {
      clientId: "replacement-client",
      email: me,
      scopes: [],
    });
    await owned.admin`
      insert into event_sources (account_id, workspace_id, kind, name, connection_id,
        external_key, owner_subject_id, created_by_subject_id)
      values (${accountId}, ${team}, 'gmail', 'New mail', ${triggered.id},
        'me@example.test', ${subjectId}, ${subjectId})`;
    await owned.admin`
      insert into connector_action_policies (account_id, workspace_id, connection_id, server_id,
        tool_name, action_name, policy, created_by_subject_id, updated_by_subject_id)
      values (${accountId}, ${team}, ${duplicate.id}, 'gmail', 'send_email', 'default',
        'block', ${subjectId}, ${subjectId})`;
    await owned.admin`
      insert into capability_installations (account_id, workspace_id, capability_id, kind, config)
      values (${accountId}, ${team}, 'gmail', 'mcp',
        ${owned.admin.json({ connectionRef: { connectionId: duplicate.id, subjectScope: "subject" } })})`;

    expect(await turnedOnIn(duplicate.authorityId)).toEqual([team]);

    await runMerge();

    expect(await status(duplicate.id)).toEqual({ status: "revoked", mergedInto: kept.id });
    expect(await status(kept.id)).toEqual({ status: "active", mergedInto: null });
    for (const left of [broader, otherIssuer, otherMailbox, triggered]) {
      expect(await status(left.id)).toEqual({ status: "active", mergedInto: null });
    }
    expect(await turnedOnIn(kept.authorityId)).toEqual([team]);
    expect(await turnedOnIn(duplicate.authorityId)).toEqual([]);

    const choices = await owned.admin<
      { workspaceId: string; connectionId: string; policy: string }[]
    >`
      select workspace_id as "workspaceId", connection_id as "connectionId", policy
      from connector_action_policies where account_id = ${accountId}`;
    expect([...choices]).toEqual([
      { workspaceId: personal, connectionId: kept.id, policy: "block" },
    ]);
    const [installation] = await owned.admin<{ connectionId: string }[]>`
      select config #>> '{connectionRef,connectionId}' as "connectionId"
      from capability_installations where workspace_id = ${team} and capability_id = 'gmail'`;
    expect(installation!.connectionId).toBe(kept.id);

    // Running it again changes nothing.
    await runMerge();
    expect(await status(kept.id)).toEqual({ status: "active", mergedInto: null });
    expect(await status(triggered.id)).toEqual({ status: "active", mergedInto: null });
    expect(await turnedOnIn(kept.authorityId)).toEqual([team]);

    // The owner role is left under FORCE ROW LEVEL SECURITY again.
    expect((await forced()).every((row) => row.forced)).toBe(true);
  }, 180_000);

  test("the login whose client refreshed most recently is kept over one on a retired client that has not refreshed since", async () => {
    if (!owned || !ownerSql) return;
    const { accountId, personal, person } = await organization("client liveness");
    const me = "me@example.test";
    // Made first, with a client the deployment has since retired: it last
    // refreshed before the replacement and has not refreshed since.
    const retired = await login(person, personal, {
      clientId: "retired-client",
      email: me,
      scopes: ["read", "send"],
      lastRefreshAt: "2026-10-01T00:00:00Z",
    });
    // The same mailbox, connected again with the current client and refreshing.
    const current = await login(person, personal, {
      clientId: "current-client",
      email: me,
      scopes: ["read", "send"],
      lastRefreshAt: "2026-11-08T00:00:00Z",
    });
    // Another person in the organization with the same mailbox address is
    // someone else's login and is never merged with these.
    const theirPersonal = await workspace(accountId, "other personal");
    const someoneElse = await member(accountId, theirPersonal);
    const theirs = await login(someoneElse, theirPersonal, {
      clientId: "current-client",
      email: me,
      scopes: ["read"],
      lastRefreshAt: "2026-11-09T00:00:00Z",
    });

    await runMerge();

    expect(await status(current.id)).toEqual({ status: "active", mergedInto: null });
    expect(await status(retired.id)).toEqual({ status: "revoked", mergedInto: current.id });
    expect(await status(theirs.id)).toEqual({ status: "active", mergedInto: null });
  }, 180_000);
});
