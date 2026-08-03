import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { provisionRoles } from "../src/provision-roles";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const expandMigration = "0109_nested_agent_depth_expand.sql";
const boundaryMigration = "0110_nested_agent_depth_boundary.sql";
const backfillMigration = "0111_nested_agent_depth_backfill.sql";
const contractMigrations = [
  "0112_nested_agent_depth_contract.sql",
  "0113_nested_agent_depth_validate.sql",
  "0114_nested_agent_depth_contract.sql",
  "0115_nested_agent_depth_validate.sql",
  "0116_nested_agent_depth_index.sql",
] as const;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0109-nested-agent-depth");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0109] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("0109-0116 nested-agent depth rolling upgrade (real PostgreSQL)", () => {
  test("fences pre-trigger writers, backfills legacy rows, and preserves tenant isolation", async () => {
    if (!available || !blank) return;

    const sql = postgres(blank.databaseUrl, {
      max: 12,
      prepare: false,
      onnotice: () => undefined,
    });
    const sleep = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

    try {
      await sql`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;

      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const apply = async (file: string): Promise<number> => {
        const migrationSql = await readFile(join(migrationsDir, file), "utf8");
        if (file === backfillMigration) {
          // Match the canonical migration runner: 0111 is one bounded batch
          // per statement and must repeat until RETURNING is empty.
          let updatedBatchCount = 0;
          for (;;) {
            const updated = await sql.unsafe(migrationSql);
            if (updated.length === 0) break;
            updatedBatchCount += 1;
          }
          return updatedBatchCount;
        } else {
          await sql.unsafe(migrationSql);
        }
        await sql`insert into schema_migrations (name)
          values (${file}) on conflict do nothing`;
        return 0;
      };

      for (const file of files.filter(
        (candidate) => candidate.localeCompare(expandMigration) < 0,
      )) {
        await apply(file);
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name)
        values ('migration-0109-account')
        returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0109-workspace')
        returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;

      // These rows are the legacy shape: they predate the nullable lineage
      // columns introduced by 0109 and are intentionally not materialized yet.
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        ) values (
          ${rootId}, ${account!.id}, ${workspace!.id}, 'legacy root',
          'migration-test', 'none', ${rootId}
        )`;
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, parent_session_id
        ) values (
          ${childId}, ${account!.id}, ${workspace!.id}, 'legacy child',
          'migration-test', 'none', ${childId}, ${rootId}
        )`;

      // Force 0111 to exercise its repeated bounded-batch contract instead of
      // silently passing with a fixture that fits in one 1000-row statement.
      await sql`
        insert into sessions (
          account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        )
        select
          ${account!.id}, ${workspace!.id},
          'legacy batch root ' || series,
          'migration-test', 'none', gen_random_uuid()
        from generate_series(1, 1001) as series`;
      await apply(expandMigration);

      // A legacy writer can already be inside its transaction after expand
      // and before the boundary trigger exists.  0110 must wait for this
      // writer before installing the trigger and reconciling the ledger.
      const key = `migration-pre-trigger-${crypto.randomUUID()}`;
      let preTriggerSessionId: string | null = null;
      let signalInserted: (() => void) | undefined;
      const inserted = new Promise<void>((resolve) => {
        signalInserted = resolve;
      });
      const oldWriter = sql.begin(async (transaction) => {
        const [session] = await transaction<{ id: string }[]>`
          insert into sessions (
            account_id, workspace_id, initial_message, model,
            sandbox_backend, sandbox_group_id, parent_session_id,
            create_idempotency_key
          ) values (
            ${account!.id}, ${workspace!.id}, 'pre-trigger child',
            'migration-test', 'none', ${crypto.randomUUID()}, ${childId}, ${key}
          )
          returning id`;
        preTriggerSessionId = session!.id;
        signalInserted?.();
        await transaction`select pg_sleep(1.5)`;
        return session!.id;
      });
      await inserted;

      const boundaryStarted = performance.now();
      const boundary = apply(boundaryMigration);
      let sawUnGrantedLock = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(100);
        const locks = await sql<{ pid: number }[]>`
          select l.pid
          from pg_locks l
          where l.relation = 'sessions'::regclass
            and not l.granted
            and l.pid <> pg_backend_pid()`;
        if (locks.length > 0) {
          sawUnGrantedLock = true;
          break;
        }
      }
      const [committedId] = await Promise.all([oldWriter, boundary]);
      const boundaryElapsed = performance.now() - boundaryStarted;
      if (preTriggerSessionId === null) {
        throw new Error("pre-trigger writer did not return a session id");
      }
      const committedSessionId = preTriggerSessionId;

      expect(committedId).toBe(committedSessionId);
      expect(sawUnGrantedLock).toBe(true);
      expect(boundaryElapsed).toBeGreaterThan(900);

      const backfillUpdatedBatchCount = await apply(backfillMigration);
      expect(backfillUpdatedBatchCount).toBeGreaterThan(1);
      for (const file of contractMigrations) await apply(file);

      const [lineage] = await sql<
        {
          rootSessionId: string;
          nestedAgentDepth: number;
          effectiveMaxNestedAgentDepth: number;
          policySource: string;
        }[]
      >`
        select root_session_id as "rootSessionId",
          nested_agent_depth as "nestedAgentDepth",
          effective_max_nested_agent_depth as "effectiveMaxNestedAgentDepth",
          nested_agent_depth_policy_source as "policySource"
        from sessions
        where id = ${committedSessionId}`;
      expect(lineage).toEqual({
        rootSessionId: rootId,
        nestedAgentDepth: 2,
        effectiveMaxNestedAgentDepth: 3,
        policySource: "default",
      });

      const [ledger] = await sql<{ outcome: string; sessionId: string | null }[]>`
        select outcome, session_id as "sessionId"
        from session_create_idempotency_guard
        where workspace_id = ${workspace!.id}
          and idempotency_key = ${key}`;
      expect(ledger).toEqual({ outcome: "session", sessionId: committedSessionId });

      const duplicate = await sql<{ id: string }[]>`
        insert into sessions (
          account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, parent_session_id,
          create_idempotency_key
        ) values (
          ${account!.id}, ${workspace!.id}, 'duplicate',
          'migration-test', 'none', ${crypto.randomUUID()}, ${committedSessionId}, ${key}
        )
        returning id`;
      expect(duplicate).toHaveLength(0);

      const [otherAccount] = await sql<{ id: string }[]>`
        insert into managed_accounts (name)
        values ('migration-0109-other-account')
        returning id`;
      const [otherWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${otherAccount!.id}, 'migration-0109-other-workspace')
        returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${otherWorkspace!.id}, ${otherAccount!.id})`;
      await sql`
        insert into session_spawn_denials (
          account_id, workspace_id, current_depth, attempted_depth,
          effective_max_nested_agent_depth, policy_source, code, idempotency_key
        ) values (
          ${account!.id}, ${workspace!.id}, 3, 4, 3, 'default',
          'nested_agent_depth_exceeded', ${`denial-${crypto.randomUUID()}`}
        )`;

      await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "force",
        appPassword: "apppw",
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const app = postgres(appUrl.toString(), {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      try {
        const [deploymentDepth] = await app<
          { max_nested_agent_depth: number; policy_source: string }[]
        >`
          select max_nested_agent_depth, policy_source
          from lock_nested_agent_depth_configuration()
        `;
        expect(deploymentDepth?.max_nested_agent_depth).toBeGreaterThanOrEqual(0);
        expect(deploymentDepth?.policy_source).toBeTruthy();

        const [rls] = await sql<{ forced: boolean }[]>`
          select relforcerowsecurity as forced
          from pg_class
          where oid = 'session_spawn_denials'::regclass`;
        expect(rls?.forced).toBe(true);

        const [crossTenant] = await app.begin(async (transaction) => {
          await transaction`
            select set_config('opengeni.account_id', ${otherAccount!.id}, true)`;
          await transaction`
            select set_config('opengeni.workspace_id', ${otherWorkspace!.id}, true)`;
          return transaction<{ count: number }[]>`
            select count(*)::int as count
            from session_spawn_denials
            where workspace_id = ${workspace!.id}`;
        });
        expect(crossTenant?.count).toBe(0);
      } finally {
        await app.end();
      }
    } finally {
      await sql.end();
    }
  }, 240_000);
});
