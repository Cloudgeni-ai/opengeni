import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, type DbClient } from "../src";
import { executeMigrationFile, migrate } from "../src/migrate";

const migrationFile = "0856_session_fork_workflow_identity.sql";
const migration = await readFile(new URL(`../drizzle/${migrationFile}`, import.meta.url), "utf8");
let owned: OwnerMigratedTestDatabase;
let admin: postgres.Sql;
let owner: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("migration-0856-fork-workflow");
  if (!acquired) throw new Error("Real PostgreSQL required");
  owned = acquired;
  await migrate(owned.ownerUrl);
  admin = owned.admin;
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  client = createDb(owned.adminUrl);
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
}, 60_000);

test("gives existing forks their own workflow identity and leaves other sessions alone", async () => {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  const accountId = account!.id;
  const workspaceId = workspace!.id;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspaceId}, ${accountId})`;
  const session = async () =>
    (
      await createSession(client.db, {
        accountId,
        workspaceId,
        initialMessage: "hi",
        resources: [],
        metadata: {},
        model: "gpt",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      })
    ).id;
  const source = await session();
  const fork = await session();
  const startedFork = await session();
  const notStarted = await session();
  // Forks as written before this migration, with no workflow identity of their
  // own. Fixture rows only, so the fork lifecycle triggers are skipped.
  const forkedFrom = (tx: postgres.TransactionSql, forkId: string, workflowId: string | null) => tx`
    update sessions set forked_from_session_id = ${source}, forked_from_authority_epoch = 1,
      forked_from_visibility = 'workspace_shared', forked_at = now(),
      forked_by_organization_membership_id = ${crypto.randomUUID()},
      temporal_workflow_id = ${workflowId}
    where id = ${forkId}`;
  await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await forkedFrom(tx, fork, null);
    await forkedFrom(tx, startedFork, `session-${startedFork}`);
    await tx`update sessions set temporal_workflow_id = null where id = ${notStarted}`;
  });

  // Run as the production migration principal: a NOSUPERUSER/NOBYPASSRLS
  // owner, for whom FORCE RLS and the workspace fence trigger both engage.
  await owner.begin(async (tx) => {
    await executeMigrationFile(tx as unknown as postgres.Sql, migrationFile, migration);
  });

  const rows = await admin<{ id: string; temporal_workflow_id: string | null }[]>`
    select id, temporal_workflow_id from sessions
    where id in (${fork}, ${startedFork}, ${notStarted})`;
  const identity = Object.fromEntries(rows.map((row) => [row.id, row.temporal_workflow_id]));
  expect(identity).toEqual({
    [fork]: `session-${fork}`,
    [startedFork]: `session-${startedFork}`,
    // Only forks are repaired; a session that never started keeps its state.
    [notStarted]: null,
  });
  const [rls] = await admin<{ force: boolean }[]>`
    select relforcerowsecurity as force from pg_class where relname = 'sessions'`;
  expect(rls!.force).toBe(true);
  const [fence] = await admin<{ enabled: string }[]>`
    select tgenabled as enabled from pg_trigger
    where tgname = 'session_tenancy_workspace_fence' and tgrelid = 'sessions'::regclass`;
  expect(fence!.enabled).toBe("O");
}, 120_000);
