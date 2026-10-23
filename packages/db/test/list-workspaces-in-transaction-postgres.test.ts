import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  listSharedWorkspacesForAccount,
  listWorkspacesForSubject,
  withAccountRls,
} from "../src";

// Workspace listings project each row through its own nested RLS scope. Inside
// a caller's transaction those scopes are savepoints on one backend, so they
// must run one after another: concurrent savepoints overwrite each other's
// transaction-local tenant settings, and the first failure ended the outer
// transaction while the others still issued SAVEPOINT on the released backend.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;
let accountId = "";
const subjectId = `user:list-in-tx-${crypto.randomUUID()}`;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("list-workspaces-in-transaction");
  if (!shared) {
    if (requireRealDatabase) throw new Error("Real PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const accountExternalId = crypto.randomUUID();
  for (let index = 0; index < 5; index++) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId,
      accountName: "Listing",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: `Listing ${index}`,
      subjectId,
    });
    const grant = access.workspaceGrants.find(
      (candidate) => !workspaceIds.includes(candidate.workspaceId),
    )!;
    accountId = grant.accountId;
    workspaceIds.push(grant.workspaceId);
  }
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("lists a subject's workspaces inside an account-scoped transaction", async () => {
  if (!client) return;
  const pooled = await listWorkspacesForSubject(client.db, subjectId);
  expect(new Set(pooled.map((workspace) => workspace.id))).toEqual(new Set(workspaceIds));
  for (let attempt = 0; attempt < 5; attempt++) {
    const scoped = await withAccountRls(client.db, accountId, (tx) =>
      listWorkspacesForSubject(tx, subjectId),
    );
    expect(scoped.map((workspace) => workspace.id)).toEqual(
      pooled.map((workspace) => workspace.id),
    );
    expect(scoped.map((workspace) => workspace.inferenceControl.state)).toEqual(
      pooled.map(() => "active"),
    );
  }
});

test("lists an account's shared workspaces inside an account-scoped transaction", async () => {
  if (!client) return;
  const pooled = await listSharedWorkspacesForAccount(client.db, accountId);
  expect(pooled.length).toBeGreaterThanOrEqual(workspaceIds.length);
  for (let attempt = 0; attempt < 5; attempt++) {
    const scoped = await withAccountRls(client.db, accountId, (tx) =>
      listSharedWorkspacesForAccount(tx, accountId),
    );
    expect(scoped.map((workspace) => workspace.id)).toEqual(
      pooled.map((workspace) => workspace.id),
    );
  }
});
