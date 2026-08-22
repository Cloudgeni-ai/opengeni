import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getPrivateSessionCreatePolicy,
  nestedPostgresSqlState,
  updateOrganizationPrivateSessionSettings,
  type DbClient,
} from "../src";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0315-private-session-enablement");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("migration 0315 organization private-session enablement", () => {
  test("personal workspaces are private-ready without organization activation", async () => {
    if (!shared || !client) return;
    const userId = `personal-private-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Personal private",
    });
    const personalWorkspaceId = access.organizationMemberships[0]?.personalWorkspaceId;
    if (!personalWorkspaceId) throw new Error("personal workspace missing");
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: personalWorkspaceId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: true,
      platformAvailable: false,
      organizationEnabled: false,
    });
  });

  test("owner/admin enablement gates ordinary members without using member-list authority", async () => {
    if (!shared || !client) return;
    const userId = `org-private-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Organization private",
    });
    const sharedGrant = access.workspaceGrants.find(
      (grant) => grant.workspaceId === access.defaultWorkspaceId,
    );
    const membershipId = access.organizationMemberships[0]?.id;
    if (!sharedGrant || !membershipId) throw new Error("organization authority missing");

    await expect(
      getOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toMatchObject({ enabled: false, available: false, version: 0 });
    let readinessDenied: unknown;
    try {
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      readinessDenied = error;
    }
    expect(nestedPostgresSqlState(readinessDenied)).toBe("55000");

    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${sharedGrant.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, '0315-test'
      )`;
    const enableOperationId = crypto.randomUUID();
    const enabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: 0,
      operationId: enableOperationId,
    });
    expect(enabled).toMatchObject({ enabled: true, available: true, version: 1, changed: true });

    await shared.admin`
      update organization_memberships set role = 'admin'
      where id = ${membershipId}`;
    const disableOperationId = crypto.randomUUID();
    const adminDisabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: false,
      expectedVersion: 1,
      operationId: disableOperationId,
    });
    expect(adminDisabled).toMatchObject({ enabled: false, version: 2, changed: true });
    const adminEnabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
    });
    expect(adminEnabled).toMatchObject({ enabled: true, version: 3, changed: true });
    await expect(
      updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: false,
        expectedVersion: 1,
        operationId: disableOperationId,
      }),
    ).resolves.toEqual(adminDisabled);

    await shared.admin`
      update organization_memberships set role = 'member'
      where id = ${membershipId}`;
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: sharedGrant.workspaceId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: true,
    });
    let denied: unknown;
    try {
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: false,
        expectedVersion: 3,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      denied = error;
    }
    expect(nestedPostgresSqlState(denied)).toBe("42501");
  }, 180_000);
});