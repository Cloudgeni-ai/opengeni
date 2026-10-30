import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { normalizePermission, type Permission } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  allWorkspacePermissions,
  bootstrapWorkspace,
  createDb,
  ensureManagedAccessForUser,
  type DbClient,
} from "../src";

const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  shared = await acquireSharedTestDatabase("canonical-workspace-defaults");
  if (!shared) throw new Error("Real PostgreSQL is required for workspace grant persistence");
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function expectCanonical(permissions: readonly string[]) {
  expect(permissions.map(normalizePermission)).toEqual([...permissions]);
  expect(new Set(permissions).size).toBe(permissions.length);
  for (const permission of ["secrets:list", "secrets:read", "secrets:write", "secrets:use"]) {
    expect(permissions).toContain(permission);
  }
}

test("default workspace grants issue only canonical permissions and retain secret use", () => {
  expectCanonical(allWorkspacePermissions);
  // Before retirement the six names below were present alongside list/read/
  // write. Only attach/use added authority not already granted canonically.
  const previous = [
    ...allWorkspacePermissions.filter((permission) => permission !== "secrets:use"),
    "variable-sets:list",
    "variable-sets:read",
    "variable-sets:write",
    "variable-sets:manage",
    "variable-sets:attach",
    "variable-sets:use",
  ];
  expect([...new Set(previous.map(normalizePermission))].sort()).toEqual(
    [...allWorkspacePermissions].sort(),
  );
});

describe.skipIf(!realDatabase)("persisted default grants", () => {
  test("bootstrap stores the canonical defaults without rewriting caller-supplied authority", async () => {
    const subjectId = `bootstrap:${crypto.randomUUID()}`;
    const input = {
      accountExternalSource: "canonical-default-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Default grants",
      workspaceExternalSource: "canonical-default-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Default grants",
      subjectId,
    };
    const access = await bootstrapWorkspace(client!.db, input);
    const workspaceId = access.defaultWorkspaceId!;
    const [stored] = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from workspace_memberships
      where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
    expectCanonical(stored!.permissions);
    expect(
      access.workspaceGrants.find((grant) => grant.workspaceId === workspaceId)?.permissions,
    ).toEqual(stored!.permissions);
    const custom = await bootstrapWorkspace(client!.db, {
      ...input,
      workspaceExternalId: crypto.randomUUID(),
      workspacePermissions: ["workspace:read"],
    });
    expect(
      custom.workspaceGrants.find((grant) => grant.workspaceId === custom.defaultWorkspaceId)
        ?.permissions,
    ).toEqual(["workspace:read"]);
  }, 180_000);

  test("fallback managed-user bootstrap is canonical and refresh preserves stored authority", async () => {
    const userId = crypto.randomUUID();
    const input = { userId, email: `${userId}@example.test`, name: "Default grant owner" };
    const access = await ensureManagedAccessForUser(client!.db, input);
    const subjectId = `user:${userId}`;
    const [stored] = await shared!.admin<{ id: string; permissions: Permission[] }[]>`
      select id, permissions from workspace_memberships
      where workspace_id = ${access.defaultWorkspaceId!} and subject_id = ${subjectId}`;
    expect(stored).toBeDefined();
    expectCanonical(stored!.permissions);
    // Existing active memberships are projected, not replaced by defaults on
    // refresh. Stop the producer without changing that authority boundary.
    const legacy: Permission[] = [
      ...stored!.permissions.filter((permission) => permission !== "secrets:use"),
      "variable-sets:use",
    ];
    await shared!.admin`
      update workspace_memberships set permissions = ${shared!.admin.json(legacy)}
      where id = ${stored!.id}`;
    const refreshed = await ensureManagedAccessForUser(client!.db, input);
    const [after] = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from workspace_memberships where id = ${stored!.id}`;
    expect(after!.permissions).toEqual(legacy);
    expect(
      refreshed.workspaceGrants.find((grant) => grant.workspaceId === access.defaultWorkspaceId)
        ?.permissions,
    ).toEqual(after!.permissions);
  }, 180_000);
});
