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
  new URL("../drizzle/1226_merge_duplicate_personal_logins.sql", import.meta.url),
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
];
const GMAIL = "https://gmail.example.test/mcp";
const LINEAR = "https://linear.example.test/mcp";

let owned: OwnerMigratedTestDatabase | null = null;
let ownerSql: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("merge-duplicate-personal-logins");
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

type Person = { accountId: string; subjectId: string; personal: string };

/** A personal OAuth login, added in `workspaceId` the way connecting adds one. */
async function login(
  person: Person,
  workspaceId: string,
  input: { mcpUrl: string; identity?: Record<string, string>; scopes: string[] },
) {
  const metadata = {
    mcpUrl: input.mcpUrl,
    authorizationServerIssuer: "https://auth.example.test",
    clientId: "client-1",
    ...input.identity,
  };
  return await owned!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${person.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    await tx`select set_config('opengeni.subject_id', ${person.subjectId}, true)`;
    const [row] = await tx<{ id: string; authorityId: string }[]>`
      insert into connections (account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, granted_scopes, metadata)
      values (${person.accountId}, ${workspaceId}, ${person.subjectId}, 'example.test', 'oauth2',
        'ciphertext', ${tx.json(input.scopes)}, ${tx.json(metadata)})
      returning id, authority_id as "authorityId"`;
    return row!;
  });
}

async function choice(
  person: Person,
  workspaceId: string,
  connectionId: string,
  toolName: string,
  policy: "allow" | "ask" | "block",
) {
  await owned!.admin`
    insert into connector_action_policies (account_id, workspace_id, connection_id, server_id,
      tool_name, action_name, policy, created_by_subject_id, updated_by_subject_id)
    values (${person.accountId}, ${workspaceId}, ${connectionId}, 'gmail', ${toolName}, 'default',
      ${policy}, ${person.subjectId}, ${person.subjectId})`;
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

async function choices(accountId: string) {
  const rows = await owned!.admin<
    { workspaceId: string; connectionId: string; toolName: string; policy: string }[]
  >`
    select workspace_id as "workspaceId", connection_id as "connectionId",
      tool_name as "toolName", policy
    from connector_action_policies where account_id = ${accountId}
    order by tool_name, connection_id`;
  return [...rows];
}

describe("1226 merges duplicate personal logins (real PostgreSQL)", () => {
  test("one login per verified account: choices, turn-ons and references move to the kept login", async () => {
    if (!owned || !ownerSql) return;
    const forced = async () =>
      await owned!.admin<{ relname: string; forced: boolean }[]>`
        select relname, relforcerowsecurity as forced from pg_class
        where relname in ${owned!.admin(TABLES)} and relkind = 'r'`;
    const before = await forced();
    expect(before).toHaveLength(TABLES.length);
    expect(before.every((row) => row.forced)).toBe(true);

    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('login merge') returning id`;
    const accountId = account!.id;
    const personal = await workspace(accountId, "owner personal");
    const design = await workspace(accountId, "design");
    const sales = await workspace(accountId, "sales");
    const subjectId = `user:${crypto.randomUUID()}`;
    await owned.admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, ${subjectId}, 'active', ${personal})`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${design}, ${subjectId}), (${accountId}, ${sales}, ${subjectId})`;
    const person = { accountId, subjectId, personal };
    const me = { gmailEmail: "me@example.test" };

    // Connected first in the Personal workspace, with the broader scopes.
    const kept = await login(person, personal, {
      mcpUrl: GMAIL,
      identity: me,
      scopes: ["read", "send"],
    });
    // Turning Gmail on in Design signed in again: the same mailbox, saved twice.
    const duplicate = await login(person, design, {
      mcpUrl: GMAIL,
      identity: me,
      scopes: ["read"],
    });
    // The same mailbox again, but an event trigger depends on this login.
    const triggered = await login(person, sales, { mcpUrl: GMAIL, identity: me, scopes: [] });
    await owned.admin`
      insert into event_sources (account_id, workspace_id, kind, name, connection_id,
        external_key, owner_subject_id, created_by_subject_id)
      values (${accountId}, ${sales}, 'gmail', 'New mail', ${triggered.id},
        'me@example.test', ${subjectId}, ${subjectId})`;
    // The same mailbox with a scope the kept login lacks: merging would lose it.
    const broader = await login(person, sales, {
      mcpUrl: GMAIL,
      identity: me,
      scopes: ["read", "admin"],
    });
    // A different mailbox, and a service that verifies no identity.
    const other = await login(person, design, {
      mcpUrl: GMAIL,
      identity: { gmailEmail: "other@example.test" },
      scopes: ["read"],
    });
    const linearFirst = await login(person, design, { mcpUrl: LINEAR, scopes: [] });
    const linearSecond = await login(person, sales, { mcpUrl: LINEAR, scopes: [] });

    await choice(person, personal, kept.id, "send_email", "allow");
    await choice(person, design, duplicate.id, "send_email", "block");
    await choice(person, design, duplicate.id, "add_label", "allow");
    await owned.admin`
      insert into capability_installations (account_id, workspace_id, capability_id, kind, config)
      values (${accountId}, ${design}, 'gmail', 'mcp',
        ${owned.admin.json({ connectionRef: { connectionId: duplicate.id, subjectScope: "subject" } })})`;
    // A schedule pinned to both logins of the mailbox, and to another connector.
    const schedule = await owned.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
      const [row] = await tx<{ id: string }[]>`
        insert into scheduled_tasks (account_id, workspace_id, name, owner_subject_id, schedule,
          temporal_schedule_id, agent_config, created_by_subject_id)
        values (${accountId}, ${design}, 'Morning mail', ${subjectId},
          ${tx.json({ kind: "cron", expression: "0 7 * * *", timezone: "UTC" })},
          ${`schedule-${crypto.randomUUID()}`},
          ${tx.json({
            prompt: "Summarize my mail",
            pinnedAccounts: [
              { serverId: "gmail", connectionId: duplicate.id },
              { serverId: "linear", connectionId: linearFirst.id },
              { serverId: "gmail", connectionId: kept.id },
            ],
          })},
          ${subjectId})
        returning id`;
      return row;
    });

    expect(await turnedOnIn(duplicate.authorityId)).toEqual([design]);
    expect(await turnedOnIn(kept.authorityId)).toEqual([]);

    await runMerge();

    expect(await status(duplicate.id)).toEqual({ status: "revoked", mergedInto: kept.id });
    expect(await status(kept.id)).toEqual({ status: "active", mergedInto: null });
    for (const left of [triggered, broader, other, linearFirst, linearSecond]) {
      expect(await status(left.id)).toEqual({ status: "active", mergedInto: null });
    }

    // Turned on where the duplicate was; the duplicate's turn-on ended.
    expect(await turnedOnIn(kept.authorityId)).toEqual([design]);
    expect(await turnedOnIn(duplicate.authorityId)).toEqual([]);

    // One set of choices, in the kept login's own workspace; the strictest won.
    expect(await choices(accountId)).toEqual([
      { workspaceId: personal, connectionId: kept.id, toolName: "add_label", policy: "allow" },
      { workspaceId: personal, connectionId: kept.id, toolName: "send_email", policy: "block" },
    ]);

    const [installation] = await owned.admin<{ connectionId: string }[]>`
      select config #>> '{connectionRef,connectionId}' as "connectionId"
      from capability_installations where workspace_id = ${design} and capability_id = 'gmail'`;
    expect(installation!.connectionId).toBe(kept.id);

    // Each pin names the kept login once, in its first place.
    const [pinned] = await owned.admin<{ pins: unknown; prompt: string }[]>`
      select agent_config -> 'pinnedAccounts' as pins, agent_config ->> 'prompt' as prompt
      from scheduled_tasks where id = ${schedule!.id}`;
    expect(pinned!.pins).toEqual([
      { serverId: "gmail", connectionId: kept.id },
      { serverId: "linear", connectionId: linearFirst.id },
    ]);
    expect(pinned!.prompt).toBe("Summarize my mail");

    // Running it again changes nothing.
    const snapshot = await choices(accountId);
    await runMerge();
    expect(await choices(accountId)).toEqual(snapshot);
    expect(await status(triggered.id)).toEqual({ status: "active", mergedInto: null });
    expect(await turnedOnIn(kept.authorityId)).toEqual([design]);

    // The owner role is left under FORCE ROW LEVEL SECURITY again.
    expect((await forced()).every((row) => row.forced)).toBe(true);
  }, 180_000);
});
