import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  type DbClient,
} from "../src/index";

// Deleting a workspace removes its connections. The result must not depend on
// the order in which PostgreSQL fires the workspace's foreign key actions:
// that order follows trigger names, which end in constraint OIDs compared as
// text, so it differs between databases.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connection-origin-workspace-delete");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspaceWithConnection() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `connection-origin-account-${suffix}`,
    accountName: "Connection origin account",
    workspaceExternalSource: "test",
    workspaceExternalId: `connection-origin-workspace-${suffix}`,
    workspaceName: "Connection origin workspace",
    subjectId: `user:connection-origin-${suffix}`,
  });
  const workspace = access.workspaceGrants[0]!;
  const connection = await createConnection(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: null,
    providerDomain: "ai-gateway.vercel.sh",
    kind: "api_key",
    credentialEncrypted: "test-encrypted-gateway-key",
    metadata: { credentialRole: "vercel_ai_gateway" },
    createdBySubjectId: workspace.subjectId,
  });
  return { ...workspace, connectionId: connection.id };
}

async function connectionCount(connectionId: string) {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from connections where id = ${connectionId}`;
  return row!.count;
}

/** The database error a statement raises, or null when it succeeds. */
async function refusal(statement: () => Promise<unknown>): Promise<string | null> {
  try {
    await statement();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("deleting a workspace that holds a connection", () => {
  test("deletes the workspace and its connection", async () => {
    const workspace = await workspaceWithConnection();
    await deleteWorkspace(client.db, workspace.workspaceId);
    expect(await connectionCount(workspace.connectionId)).toBe(0);
  }, 60_000);

  test("succeeds even when the origin action fires before the workspace cascade", async () => {
    const workspace = await workspaceWithConnection();
    // Without the workspace_id cascade only the origin action runs, which is
    // exactly what a database whose trigger order puts it first sees.
    const rollback = new Error("rollback");
    await expect(
      shared.admin.begin(async (tx) => {
        await tx`alter table connections drop constraint connections_workspace_id_fkey`;
        await tx`delete from workspaces where id = ${workspace.workspaceId}`;
        const [row] = await tx<Array<{ count: number }>>`
          select count(*)::int as count from connections where id = ${workspace.connectionId}`;
        expect(row!.count).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }, 60_000);

  test("a connection's origin and owner authority stay immutable", async () => {
    const workspace = await workspaceWithConnection();
    const other = await workspaceWithConnection();
    const immutable = "connection owner authority is immutable";
    for (const origin of [null, other.workspaceId]) {
      expect(
        await refusal(
          () => shared.admin`update connections set origin_workspace_id = ${origin}
            where id = ${workspace.connectionId}`,
        ),
      ).toBe(immutable);
    }
    expect(
      await refusal(
        () => shared.admin`update connections set subject_id = 'user:someone-else'
          where id = ${workspace.connectionId}`,
      ),
    ).toBe(immutable);
    const [row] = await shared.admin<Array<{ origin: string }>>`
      select origin_workspace_id as origin from connections where id = ${workspace.connectionId}`;
    expect(row!.origin).toBe(workspace.workspaceId);
  }, 60_000);
});
