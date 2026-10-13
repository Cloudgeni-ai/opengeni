// Migration 0754: schedules that start their own session follow the
// workspace's default connectors at each run. Schedules saved before it hold
// a copy of the defaults in `tools`. They are staged on a database migrated
// without 0754, then 0754 is applied alone. Each one gains the
// `workspace_default` policy with nothing excluded and keeps its tools as
// additions; the owner and authority revision stay, and the current-revision
// authority that matched the old digest follows the new one. A list a person
// made directly, knowledge syncs and schedules that already have a policy are
// untouched.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0754_schedule_connectors_follow_workspace_defaults.sql";

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("schedule-connectors-follow-defaults");
  if (!database) throw new Error("Real PostgreSQL is required");
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 2 });
});

afterAll(async () => {
  await client?.close();
  await database?.release();
});

test.skipIf(!realDb)(
  "0754 makes schedules whose connectors nobody chose follow the workspace defaults",
  async () => {
    const admin = database!.admin;
    const userId = `schedule-defaults-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Schedule defaults",
    });
    const grant = access.workspaceGrants[0]!;
    const accountId = grant.accountId;
    const workspaceId = grant.workspaceId;
    const owner = `user:${userId}`;
    const tasks = {
      perRun: crypto.randomUUID(),
      reusable: crypto.randomUUID(),
      staleAuthority: crypto.randomUUID(),
      knowledge: crypto.randomUUID(),
      following: crypto.randomUUID(),
      personMade: crypto.randomUUID(),
      serviceMade: crypto.randomUUID(),
    };
    // An agent made these through its turn; only a person's direct list is kept.
    const agentMade = {
      via: [{ kind: "agent", sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() }],
    };
    const creators: Record<string, { kind: string; subject: string; context: object }> = {
      [tasks.personMade]: { kind: "subject", subject: owner, context: {} },
      [tasks.serviceMade]: { kind: "service", subject: "service:scheduler", context: {} },
    };
    const policy = { mode: "workspace_default", excludedMcpServerIds: [] };
    const baseConfig = {
      prompt: "Check the inbox",
      tools: [{ kind: "mcp", id: "linear" }],
      resources: [],
    };
    const configs: Record<string, Record<string, unknown>> = {
      [tasks.perRun]: baseConfig,
      [tasks.reusable]: baseConfig,
      [tasks.staleAuthority]: baseConfig,
      [tasks.knowledge]: { ...baseConfig, knowledgeSource: { kind: "example" } },
      [tasks.following]: {
        ...baseConfig,
        toolPolicy: { mode: "workspace_default", excludedMcpServerIds: ["mail"] },
      },
      [tasks.personMade]: baseConfig,
      [tasks.serviceMade]: baseConfig,
    };
    // Tasks go through the ordinary triggers, so the database derives each
    // execution digest exactly as a previous release's save did.
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`;
      for (const [id, config] of Object.entries(configs)) {
        const creator = creators[id] ?? { kind: "subject", subject: owner, context: agentMade };
        await tx`
          insert into scheduled_tasks (
            id, account_id, workspace_id, name, status, schedule,
            temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
            created_by_kind, created_by_subject_id, created_by_context,
            authority_revision, metadata
          ) values (
            ${id}, ${accountId}, ${workspaceId}, 'Inbox check', 'active',
            '{"type":"manual"}'::jsonb, ${`0753-${id}`},
            ${id === tasks.reusable ? "reusable_session" : "new_session_per_run"},
            'buffer_one', '{"kind":"agent_turn"}'::jsonb, ${tx.json(config as never)}::jsonb,
            ${creator.kind}, ${creator.subject}, ${tx.json(creator.context as never)}::jsonb,
            3, '{}'::jsonb
          )`;
      }
    });
    // Revision authority rows are staged directly; only their digest matters here.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const id of Object.keys(configs)) {
        const [row] = await tx<{ digest: string }[]>`
          select execution_digest as digest from scheduled_tasks where id = ${id}`;
        await tx`
          insert into scheduled_task_revision_authorities (
            task_id, task_authority_revision, account_id, workspace_id, subject_id,
            organization_membership_id, membership_authorization_revision,
            execution_digest
          ) values (
            ${id}, 3, ${accountId}, ${workspaceId}, ${owner}, ${crypto.randomUUID()}, 1,
            ${id === tasks.staleAuthority ? "f".repeat(64) : row!.digest}
          )`;
      }
    });
    const read = async (sql: postgres.Sql) =>
      await sql<
        {
          id: string;
          config: Record<string, unknown>;
          revision: number;
          digest: string;
          recomputed: string;
          authorityDigest: string;
        }[]
      >`
        select task.id::text as id, task.agent_config as config,
          task.authority_revision::int as revision, task.execution_digest as digest,
          scheduled_task_execution_digest(task) as recomputed,
          authority.execution_digest as "authorityDigest"
        from scheduled_tasks task
        join scheduled_task_revision_authorities authority
          on authority.task_id = task.id
         and authority.task_authority_revision = task.authority_revision
        where task.workspace_id = ${workspaceId}::uuid`;
    const before = Object.fromEntries((await read(admin)).map((row) => [row.id, row]));
    const forcedRls = async (sql: postgres.Sql) =>
      await sql<{ relname: string; forced: boolean }[]>`
        select relname, relforcerowsecurity as forced from pg_class
        where relname in (
          'scheduled_tasks', 'scheduled_task_revision_authorities',
          'scheduled_task_personal_resource_authorities',
          'scheduled_task_connection_authority_snapshots'
        ) and relnamespace = 'public'::regnamespace order by relname`;
    const enabledTriggers = async (sql: postgres.Sql) =>
      await sql<{ name: string; enabled: string }[]>`
        select tgname as name, tgenabled as enabled from pg_trigger
        where tgrelid = 'scheduled_tasks'::regclass and not tgisinternal order by tgname`;
    const forcedBefore = await forcedRls(admin);
    const triggersBefore = await enabledTriggers(admin);
    expect(forcedBefore).toHaveLength(4);

    const applying = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await applying`delete from schema_migrations where name = ${MIGRATION}`;
    } finally {
      await applying.end();
    }
    await migrate(database!.ownerUrl);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });

    const after = postgres(database!.adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const rows = Object.fromEntries((await read(after)).map((row) => [row.id, row]));
      for (const id of [tasks.perRun, tasks.reusable, tasks.staleAuthority, tasks.serviceMade]) {
        const row = rows[id]!;
        // It follows the defaults, excludes nothing and keeps its tools.
        expect(row.config).toEqual({ ...baseConfig, toolPolicy: policy });
        expect(row.revision).toBe(3);
        expect(row.digest).toBe(row.recomputed);
        expect(row.digest).not.toBe(before[id]!.digest);
      }
      // Authority that matched the previous digest follows the new one.
      expect(rows[tasks.perRun]!.authorityDigest).toBe(rows[tasks.perRun]!.digest);
      expect(rows[tasks.reusable]!.authorityDigest).toBe(rows[tasks.reusable]!.digest);
      // Authority that was already out of step is left exactly as it was.
      expect(rows[tasks.staleAuthority]!.authorityDigest).toBe("f".repeat(64));
      // A person's own list, a knowledge sync and a schedule that already has
      // a policy are byte-identical.
      expect(rows[tasks.personMade]).toEqual(before[tasks.personMade]!);
      expect(rows[tasks.knowledge]).toEqual(before[tasks.knowledge]!);
      expect(rows[tasks.following]).toEqual(before[tasks.following]!);

      expect(await forcedRls(after)).toEqual(forcedBefore);
      expect(await enabledTriggers(after)).toEqual(triggersBefore);
    } finally {
      await after.end();
    }
  },
);
