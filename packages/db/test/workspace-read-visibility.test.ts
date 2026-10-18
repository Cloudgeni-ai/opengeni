import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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
