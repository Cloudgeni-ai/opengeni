/**
 * Migrations 0909-0912 (docs/session-message-search.md): indexed message
 * search. On a real database whose owner is NOSUPERUSER and NOBYPASSRLS, the
 * batched backfill copies every existing user and completed assistant message,
 * site sessions included, then removes its owner-only capability; the trigger
 * indexes later messages; and the application role, under FORCE RLS, can use
 * the trigram index for the search pattern while seeing nothing without it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  searchSessionMessagesForSubject,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { sessionMessagePostgresPattern } from "../src/session-message-search";

const FILES = [
  "0909_session_message_search_index.sql",
  "0910_session_message_search_backfill.sql",
  "0911_session_message_search_trigram_index.sql",
  "0912_session_message_search_backfill_cleanup.sql",
];
let owned: OwnerMigratedTestDatabase;
let client: DbClient;
let app: postgres.Sql;
let admin: postgres.Sql;
const subjectId = `user:search-migration-${crypto.randomUUID()}`;
const workspaces: { accountId: string; workspaceId: string }[] = [];
const sessions: { workspaceId: string; accountId: string; id: string }[] = [];

/** Event writes run the owner's cursor triggers, which are tenant-bound under
 * FORCE RLS like every production writer. */
async function asTenant(
  accountId: string,
  workspaceId: string,
  run: (tx: postgres.TransactionSql) => Promise<unknown>,
) {
  await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    await run(tx);
  });
}

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("migration-0909-message-search");
  if (!acquired) throw new Error("Real PostgreSQL required");
  owned = acquired;
  admin = owned.admin;
  // Migrate to just before 0909, as the release before it left the schema.
  const setup = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  await setup.unsafe(
    `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
  );
  for (const file of FILES) await setup`insert into schema_migrations (name) values (${file})`;
  await setup.end();
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  client = createDb(url.toString(), { max: 2 });
  app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  // Runtime protocol markers every current application connection carries.
  await app`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', false),
    set_config('opengeni.session_variable_set_attachments_v1', '1', false)`;

  // History written before the index existed: two workspaces, more sessions
  // than one backfill batch, and a site session.
  for (let w = 0; w < 2; w++) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: `Search ${w}`,
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: `Search ${w}`,
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    workspaces.push({ accountId: grant.accountId, workspaceId: grant.workspaceId! });
  }
  for (let n = 0; n < 30; n++) {
    const { accountId, workspaceId } = workspaces[n % 2]!;
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "title only",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    sessions.push({ accountId, workspaceId, id: session.id });
    await asTenant(
      accountId,
      workspaceId,
      (tx) => tx`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values
        (${accountId}, ${workspaceId}, ${session.id}, 1, 'user.message', ${tx.json({ text: `historical prompt ${n}` })}),
        (${accountId}, ${workspaceId}, ${session.id}, 2, 'agent.message.delta', ${tx.json({ delta: "historical" })}),
        (${accountId}, ${workspaceId}, ${session.id}, 3, 'agent.message.completed', ${tx.json({ text: `Historical answer ${n} with yubikey` })})`,
    );
  }
  // A site session: the backfill must not lose it to site-viewer isolation.
  const site = sessions[0]!;
  await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set site_access_root_id = id, site_owner_subject_id = ${subjectId}
      where workspace_id = ${site.workspaceId} and id = ${site.id}`;
  });

  // Now run 0909-0912 exactly as a deployment would.
  await admin`delete from schema_migrations where name = any(${FILES})`;
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await app?.end();
  await owned?.release();
}, 60_000);

test("the backfill copies every existing message, site sessions included, and cleans up", async () => {
  const [copied] = await admin<{ count: number; sessions: number }[]>`
    select count(*)::int as count, count(distinct session_id)::int as sessions
    from session_message_search_texts`;
  expect(copied).toEqual({ count: 60, sessions: 30 });
  const [site] = await admin<{ count: number }[]>`
    select count(*)::int as count from session_message_search_texts where session_id = ${sessions[0]!.id}`;
  expect(site!.count).toBe(2);
  const [leftovers] = await admin<{ count: number }[]>`
    select count(*)::int as count from pg_policies where policyname like '%message_search_backfill%'`;
  expect(leftovers!.count).toBe(0);
  const [progress] = await admin<{ table: string | null }[]>`
    select to_regclass('opengeni_private.session_message_search_backfill')::text as table`;
  expect(progress!.table).toBeNull();
  const applied = await admin<{ name: string }[]>`
    select name from schema_migrations where name = any(${FILES}) order by name`;
  expect(applied.map((row) => row.name)).toEqual(FILES);
}, 120_000);

test("new messages are indexed by the trigger and deleting an event removes its row", async () => {
  const { accountId, workspaceId, id } = sessions[1]!;
  await asTenant(
    accountId,
    workspaceId,
    (tx) => tx`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values
      (${accountId}, ${workspaceId}, ${id}, 4, 'user.message', ${tx.json({ text: "fresh prompt" })}),
      (${accountId}, ${workspaceId}, ${id}, 5, 'agent.toolCall.output', ${tx.json({ text: "tool text" })})`,
  );
  const rows = await admin<{ sequence: number; text: string; encoded: boolean }[]>`
    select sequence, text, encoded from session_message_search_texts
    where workspace_id = ${workspaceId} and session_id = ${id} order by sequence`;
  expect([...rows]).toEqual([
    { sequence: 1, text: "historical prompt 1", encoded: false },
    { sequence: 3, text: "Historical answer 1 with yubikey", encoded: false },
    { sequence: 4, text: "fresh prompt", encoded: false },
  ]);
  await admin`delete from session_events where workspace_id = ${workspaceId} and session_id = ${id} and sequence = 4`;
  const [left] = await admin<{ count: number }[]>`
    select count(*)::int as count from session_message_search_texts
    where workspace_id = ${workspaceId} and session_id = ${id}`;
  expect(left!.count).toBe(2);
}, 120_000);

test("the application role reads only through the pattern and can use the trigram index", async () => {
  const { accountId, workspaceId } = workspaces[1]!;
  // Enough ordinary history that the selective pattern, not the key, is the
  // cheapest way in.
  const busy = sessions[3]!;
  await asTenant(
    accountId,
    workspaceId,
    (tx) => tx`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    select ${accountId}, ${workspaceId}, ${busy.id}, n, 'agent.message.completed',
      jsonb_build_object('text', 'ordinary reply number ' || n)
    from generate_series(4, 10003) n`,
  );
  await admin`analyze session_message_search_texts`;
  await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${subjectId}, true),
      set_config('opengeni.principal_kind', 'human_session', true)`;
    const [hidden] = await tx<{ count: number }[]>`
      select count(*)::int as count from session_message_search_texts`;
    expect(hidden!.count).toBe(0);
    await tx`select set_config('opengeni.session_message_search_pattern', ${sessionMessagePostgresPattern("YubiKey")!}, true)`;
    const [visible] = await tx<{ count: number }[]>`
      select count(*)::int as count from session_message_search_texts`;
    expect(visible!.count).toBe(15);
    const plan = await tx<{ "QUERY PLAN": string }[]>`
      explain select session_id, sequence from session_message_search_texts
      where workspace_id = ${workspaceId}`;
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "session_message_search_texts_trgm_idx",
    );
  });
}, 120_000);

test("the application role's own message inserts are indexed, and it can write nothing else", async () => {
  const { accountId, workspaceId, id } = sessions[1]!;
  const asApp = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('opengeni.principal_kind', 'human_session', true)`;
      return run(tx);
    });
  // The trigger runs with the application role's own rights (no SECURITY
  // DEFINER routine), admitted by the event-mirror policy.
  const [mode] = await admin<{ definer: boolean }[]>`
    select prosecdef as definer from pg_proc
    where oid = 'opengeni_private.index_session_message_search_text()'::regprocedure`;
  expect(mode!.definer).toBe(false);
  const [last] = await admin<{ sequence: number }[]>`
    select max(sequence)::int as sequence from session_events
    where workspace_id = ${workspaceId} and session_id = ${id}`;
  const prompt = last!.sequence + 1;
  const tool = prompt + 1;
  await asApp(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended('session-tenancy:' || ${workspaceId}::text, 0))`;
    await tx`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values
      (${accountId}, ${workspaceId}, ${id}, ${prompt}, 'user.message', ${tx.json({ text: "app prompt" })}),
      (${accountId}, ${workspaceId}, ${id}, ${tool}, 'agent.toolCall.output', ${tx.json({ text: "app tool" })})`;
  });
  const indexed = await admin<{ sequence: number; text: string }[]>`
    select sequence, text from session_message_search_texts
    where workspace_id = ${workspaceId} and session_id = ${id} and sequence >= ${prompt} order by sequence`;
  expect([...indexed]).toEqual([{ sequence: prompt, text: "app prompt" }]);
  // A row that does not mirror a visible message event is refused: no event,
  // different text, or an event that is not a message.
  for (const [sequence, text] of [
    [99, "forged"],
    [3, "Historical answer 1 with forged text"],
    [tool, "app tool"],
  ] as const) {
    await expect(
      asApp(
        (tx) => tx`insert into session_message_search_texts
          (account_id, workspace_id, session_id, sequence, encoded, text)
          values (${accountId}, ${workspaceId}, ${id}, ${sequence}, false, ${text})`,
      ),
    ).rejects.toThrow(/row-level security/);
  }
  // The application role still cannot change or remove indexed text.
  await expect(
    asApp((tx) => tx`update session_message_search_texts set text = 'changed'`),
  ).rejects.toThrow(/permission denied/);
  await expect(asApp((tx) => tx`delete from session_message_search_texts`)).rejects.toThrow(
    /permission denied/,
  );
}, 120_000);

test("search finds historical messages through the index", async () => {
  const { workspaceId } = workspaces[0]!;
  const page = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "YUBIKEY", limit: 50 },
    { subjectId },
  );
  expect(page.hasMore).toBe(false);
  // Workspace 0 holds the even sessions; the site session is not listed for
  // ordinary search, exactly as before.
  expect(page.matches).toHaveLength(14);
  expect(page.scannedMessages).toBe(14);
  expect(new Set(page.matches.map((match) => match.sessionId)).has(sessions[0]!.id)).toBe(false);
}, 120_000);

test("search texts are workspace isolated", async () => {
  const [other] = workspaces;
  const { accountId } = workspaces[1]!;
  await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaces[1]!.workspaceId}, true),
      set_config('opengeni.subject_id', ${subjectId}, true),
      set_config('opengeni.principal_kind', 'human_session', true),
      set_config('opengeni.session_message_search_pattern', ${sessionMessagePostgresPattern("historical")!}, true)`;
    const [leaked] = await tx<{ count: number }[]>`
      select count(*)::int as count from session_message_search_texts
      where workspace_id = ${other!.workspaceId}`;
    expect(leaked!.count).toBe(0);
  });
}, 120_000);
