import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createScheduledTask,
  getScheduledTaskCreatorPolicy,
  type DbClient,
} from "../src";

const source = readFileSync(
  new URL("../drizzle/0427_scheduled_task_creator_policy.sql", import.meta.url),
  "utf8",
);

test("0427 adds three nullable creator-policy columns as a rolling change", () => {
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source.match(/ADD COLUMN/g)).toHaveLength(3);
  expect(source).toContain('ADD COLUMN "creator_first_party_mcp_tools" jsonb');
  expect(source).toContain('ADD COLUMN "creator_first_party_mcp_permissions" jsonb');
  expect(source).toContain('ADD COLUMN "creator_session_policy" jsonb');
  expect(source).toContain("jsonb_typeof(creator_first_party_mcp_tools) = 'array'");
  expect(source).toContain("jsonb_typeof(creator_first_party_mcp_permissions) = 'array'");
  expect(source).toContain("jsonb_typeof(creator_session_policy) = 'object'");
  expect(source).not.toContain("CREATE TABLE");
  expect(source).not.toContain("NOT NULL");
  expect(source).not.toMatch(/\bUPDATE\s+scheduled_tasks\b/i);
});

test("0427 keeps the execution digest byte-stable for NULL creator policy and re-pins search_path", () => {
  // Both digest routines strip the three keys only while NULL, so every
  // existing row and every human/API-created task keeps its pre-0427 digest.
  for (const routine of [
    "scheduled_task_execution_digest(",
    "set_scheduled_task_execution_digest()",
  ]) {
    expect(source).toContain(`CREATE OR REPLACE FUNCTION ${routine}`);
  }
  for (const column of [
    "creator_first_party_mcp_tools",
    "creator_first_party_mcp_permissions",
    "creator_session_policy",
  ]) {
    expect(
      source.match(new RegExp(`CASE WHEN (?:p_task|NEW)\\.${column} IS NULL`, "g")),
    ).toHaveLength(2);
  }
  // CREATE OR REPLACE resets proconfig: the 0252 data-schema re-pin must follow.
  expect(source).toContain(
    "'ALTER FUNCTION %1$I.scheduled_task_execution_digest(%1$I.scheduled_tasks) '",
  );
  expect(source).toContain("'ALTER FUNCTION %1$I.set_scheduled_task_execution_digest() '");
  expect(source.match(/SET search_path = pg_catalog, %1\$I, pg_temp/g)).toHaveLength(2);
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION scheduled_task_execution_digest(scheduled_tasks) FROM PUBLIC;",
  );
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION set_scheduled_task_execution_digest() FROM PUBLIC;",
  );
});

describe("0427 creator policy (real PostgreSQL)", () => {
  let shared: SharedTestDatabase | null = null;
  let admin: postgres.Sql;
  let client: DbClient;

  beforeAll(async () => {
    shared = await acquireSharedTestDatabase("migration-0427-creator-policy");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
      }
      return;
    }
    admin = shared.admin;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await shared?.release();
  });

  async function workspace() {
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('creator policy') returning id`;
    const [ws] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'creator policy')
      returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${ws!.id}, ${account!.id})`;
    return { accountId: account!.id, workspaceId: ws!.id };
  }

  function taskInput(scope: { accountId: string; workspaceId: string }, name: string) {
    return {
      ...scope,
      name,
      status: "active" as const,
      schedule: { type: "manual" as const },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run" as const,
      overlapPolicy: "allow_concurrent" as const,
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject" as const, subjectId: "user:creator-policy" },
      metadata: {},
    };
  }

  test("both digest routines keep the data-schema search_path re-pin", async () => {
    if (!shared) return;
    const rows = await admin<Array<{ name: string; config: string[] | null }>>`
      select proc.proname as name, proc.proconfig as config
      from pg_proc proc
      join pg_namespace ns on ns.oid = proc.pronamespace
      where ns.nspname = current_schema()
        and proc.proname in ('scheduled_task_execution_digest', 'set_scheduled_task_execution_digest')
      order by proc.proname`;
    expect(rows).toHaveLength(2);
    const schemaRow = (
      await admin<Array<{ schema: string }>>`select current_schema() as schema`
    )[0];
    if (!schemaRow) throw new Error("current_schema() returned no row");
    for (const row of rows) {
      expect(row.config).toEqual([`search_path=pg_catalog, ${schemaRow.schema}, pg_temp`]);
    }
  });

  test("a NULL creator policy hashes exactly like the pre-0427 whole-row digest", async () => {
    if (!shared) return;
    const scope = await workspace();
    const task = await createScheduledTask(client.db, taskInput(scope, "human created"));
    expect(await getScheduledTaskCreatorPolicy(client.db, scope.workspaceId, task.id)).toEqual({
      firstPartyMcpTools: null,
      firstPartyMcpPermissions: null,
      sessionPolicy: null,
    });
    const [row] = await admin<Array<{ stored: string; legacy: string; recomputed: string }>>`
      select task.execution_digest as stored,
        encode(sha256(convert_to((
          to_jsonb(task) - array[
            'name', 'status', 'updated_at', 'authority_revision', 'execution_digest',
            'creator_first_party_mcp_tools', 'creator_first_party_mcp_permissions',
            'creator_session_policy'
          ]::text[]
        )::text, 'UTF8')), 'hex') as legacy,
        scheduled_task_execution_digest(task) as recomputed
      from scheduled_tasks task
      where task.id = ${task.id}`;
    expect(row!.stored).toBe(row!.legacy);
    expect(row!.recomputed).toBe(row!.legacy);
  });

  test("a frozen creator policy is stored exactly, read back, and enters the digest", async () => {
    if (!shared) return;
    const scope = await workspace();
    const creatorPolicy = {
      firstPartyMcpTools: ["set_session_title" as const, "scheduled_tasks_create" as const],
      firstPartyMcpPermissions: ["sessions:read" as const, "scheduled_tasks:manage" as const],
      sessionPolicy: {
        agentAccess: "session",
        endUser: { source: "acme", id: "u_42" },
        memoryScope: "user",
      },
    };
    const task = await createScheduledTask(client.db, {
      ...taskInput(scope, "agent created"),
      creatorPolicy,
    });
    expect(await getScheduledTaskCreatorPolicy(client.db, scope.workspaceId, task.id)).toEqual(
      creatorPolicy,
    );
    const [row] = await admin<Array<{ stored: string; stripped: string; full: string }>>`
      select task.execution_digest as stored,
        encode(sha256(convert_to((
          to_jsonb(task) - array[
            'name', 'status', 'updated_at', 'authority_revision', 'execution_digest',
            'creator_first_party_mcp_tools', 'creator_first_party_mcp_permissions',
            'creator_session_policy'
          ]::text[]
        )::text, 'UTF8')), 'hex') as stripped,
        encode(sha256(convert_to((
          to_jsonb(task) - array[
            'name', 'status', 'updated_at', 'authority_revision', 'execution_digest'
          ]::text[]
        )::text, 'UTF8')), 'hex') as full
      from scheduled_tasks task
      where task.id = ${task.id}`;
    expect(row!.stored).toBe(row!.full);
    expect(row!.stored).not.toBe(row!.stripped);
    // A tombstoned task still answers so run recovery stays deterministic.
    await admin`
      update scheduled_tasks set deleted_at = now(), status = 'paused' where id = ${task.id}`;
    expect(await getScheduledTaskCreatorPolicy(client.db, scope.workspaceId, task.id)).toEqual(
      creatorPolicy,
    );
  });

  test("malformed creator policy shapes are rejected by the column checks", async () => {
    if (!shared) return;
    const scope = await workspace();
    const task = await createScheduledTask(client.db, taskInput(scope, "shape checks"));
    for (const [column, value] of [
      ["creator_first_party_mcp_tools", '{"not":"an array"}'],
      ["creator_first_party_mcp_permissions", '"sessions:read"'],
      ["creator_session_policy", '["not","an object"]'],
    ] as const) {
      // postgres.js queries are lazy thenables; hand expect a real promise.
      await expect(
        Promise.resolve(
          admin.unsafe(`update scheduled_tasks set ${column} = $1::jsonb where id = $2`, [
            value,
            task.id,
          ]),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
