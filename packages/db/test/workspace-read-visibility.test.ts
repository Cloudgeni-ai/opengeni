import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { withRlsContext, type Database } from "../src/database";
import * as schema from "../src/schema";
import {
  createDb,
  createWorkspace,
  getWorkspace,
  nestedPostgresSqlState,
  requireWorkspace,
  updateWorkspace,
  type DbClient,
} from "../src/index";

let shared: SharedTestDatabase | null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-read-visibility");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  if (!shared) throw new Error("PostgreSQL unavailable");
  const [account] =
    await shared.admin`insert into managed_accounts (name) values ('Workspace read fixture') returning id`;
  return await createWorkspace(client.db, {
    accountId: String(account!.id),
    name: "Visible workspace",
  });
}

test("nullable workspace reads require a visible control projection, not merely bootstrap metadata", async () => {
  if (!shared) return;
  const workspace = await fixture();
  expect(await getWorkspace(client.db, workspace.id)).toMatchObject({
    id: workspace.id,
    kind: "shared",
    inferenceControl: { state: "active" },
  });
  expect(await getWorkspace(client.db, crypto.randomUUID())).toBeNull();
  // This policy is confined to the test's cloned database. Keep the control
  // row physically present while exercising a real RLS-hidden projection.
  await shared.admin`create policy workspace_read_test_hidden on workspace_inference_controls
    as restrictive for select using (false)`;
  try {
    const [row] =
      await shared.admin`select count(*)::int as count from workspace_inference_controls where workspace_id = ${workspace.id}`;
    expect(row!.count).toBe(1);
    expect(await getWorkspace(client.db, workspace.id)).toBeNull();
    await expect(requireWorkspace(client.db, workspace.id)).rejects.toThrow(
      `Workspace not found: ${workspace.id}`,
    );
  } finally {
    await shared.admin`drop policy workspace_read_test_hidden on workspace_inference_controls`;
  }
  expect(await getWorkspace(client.db, workspace.id)).toMatchObject({ id: workspace.id });
}, 60_000);

test("incomplete bootstrap rows are absent to readers while strict write projections still fail", async () => {
  if (!shared) return;
  const workspace = await fixture();
  await shared.admin`delete from workspace_inference_controls where workspace_id = ${workspace.id}`;
  expect(await getWorkspace(client.db, workspace.id)).toBeNull();
  await expect(
    updateWorkspace(client.db, workspace.id, { name: "Still requires control" }),
  ).rejects.toThrow(`Workspace ${workspace.id} has no inference control`);
}, 60_000);

test("real SQL failures in the control lookup are never converted into missing workspaces", async () => {
  if (!shared) return;
  const workspace = await fixture();
  await shared.admin`alter table workspace_inference_controls rename to unavailable_workspace_controls`;
  try {
    let failure: unknown;
    try {
      await getWorkspace(client.db, workspace.id);
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("42P01");
  } finally {
    await shared.admin`alter table unavailable_workspace_controls rename to workspace_inference_controls`;
  }
  expect(await getWorkspace(client.db, workspace.id)).toMatchObject({ id: workspace.id });
}, 60_000);

test("complete workspace reads use one scope and restore a nested caller on success and failure", async () => {
  if (!shared) return;
  const workspace = await fixture();
  const parent = await fixture();
  const statements: string[] = [];
  const traced = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    debug: (_connection, query) => statements.push(query.trim().toLowerCase()),
  });
  const db = drizzle(traced, { schema }) as unknown as Database;
  try {
    await traced`select 1`;
    statements.length = 0;
    expect(await getWorkspace(db, workspace.id)).toMatchObject({ id: workspace.id });
    const readStatements = [...statements];
    expect(readStatements.filter((query) => query === "begin")).toHaveLength(1);
    expect(readStatements.filter((query) => query === "commit")).toHaveLength(1);
    expect(readStatements).toHaveLength(6);
    expect(readStatements.filter((query) => query.includes("get_workspace_kind"))).toHaveLength(1);

    await withRlsContext(
      db,
      { accountId: parent.accountId, workspaceId: parent.id },
      async (tx) => {
        const settings = async () =>
          await tx.execute(sql`select
        current_setting('opengeni.account_id', true) as account,
        current_setting('opengeni.workspace_id', true) as workspace,
        current_setting('opengeni.subject_id', true) as subject`);
        await tx.execute(
          sql`select set_config('opengeni.subject_id', 'workspace-read-parent', true)`,
        );
        const before = await settings();
        expect(await getWorkspace(tx, workspace.id)).toMatchObject({ id: workspace.id });
        expect(await settings()).toEqual(before);
      },
    );
    await shared.admin`alter table workspace_inference_controls rename to unavailable_workspace_controls`;
    try {
      await withRlsContext(
        db,
        { accountId: parent.accountId, workspaceId: parent.id },
        async (tx) => {
          const settings = async () =>
            await tx.execute(sql`select
          current_setting('opengeni.account_id', true) as account,
          current_setting('opengeni.workspace_id', true) as workspace,
          current_setting('opengeni.subject_id', true) as subject`);
          await tx.execute(
            sql`select set_config('opengeni.subject_id', 'workspace-read-parent', true)`,
          );
          const before = await settings();
          let failure: unknown;
          try {
            await getWorkspace(tx, workspace.id);
          } catch (error) {
            failure = error;
          }
          expect(nestedPostgresSqlState(failure)).toBe("42P01");
          expect(await settings()).toEqual(before);
        },
      );
    } finally {
      await shared.admin`alter table unavailable_workspace_controls rename to workspace_inference_controls`;
    }
  } finally {
    await traced.end();
  }
}, 60_000);
