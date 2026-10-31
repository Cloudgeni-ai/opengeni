import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivacyPreferences,
  getOwnMachineConnectPolicy,
  updateOrganizationPrivacyPreferences,
} from "../src/index";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-own-machines-setting");
  if (!acquired) throw new Error("Own machines setting tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function organization(label: string) {
  const userId = `${label}-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Own machines owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) =>
      grant.accountId === membership.organizationId &&
      grant.workspaceId !== membership.personalWorkspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  return {
    actorSubjectId: `user:${userId}`,
    organizationId: membership.organizationId,
    personalWorkspaceId: membership.personalWorkspaceId,
    sharedWorkspaceId,
  };
}

test("members connect their own machines until an owner or admin turns it off", async () => {
  const fixture = await organization("own-machines");
  const policy = (workspaceId: string) =>
    getOwnMachineConnectPolicy(client.db, { accountId: fixture.organizationId, workspaceId });

  // On by default, before any row exists.
  expect(
    (await getOrganizationPrivacyPreferences(client.db, fixture.organizationId))
      .membersConnectOwnMachines,
  ).toBe(true);
  expect(await policy(fixture.sharedWorkspaceId)).toEqual({
    membersConnectOwnMachines: true,
    personalWorkspace: false,
  });

  const off = await updateOrganizationPrivacyPreferences(client.db, {
    organizationId: fixture.organizationId,
    actorSubjectId: fixture.actorSubjectId,
    membersConnectOwnMachines: false,
  });
  expect(off.membersConnectOwnMachines).toBe(false);
  // The other choices are untouched.
  expect(off.personalWorkspacesEnabled).toBe(true);
  expect(off.defaultVisibility).toBe("workspace_shared");
  // Off, a Personal workspace is told apart: every machine there is its owner's own.
  expect(await policy(fixture.sharedWorkspaceId)).toEqual({
    membersConnectOwnMachines: false,
    personalWorkspace: false,
  });
  expect(await policy(fixture.personalWorkspaceId)).toEqual({
    membersConnectOwnMachines: false,
    personalWorkspace: true,
  });

  // Changing another choice keeps this one.
  const other = await updateOrganizationPrivacyPreferences(client.db, {
    organizationId: fixture.organizationId,
    actorSubjectId: fixture.actorSubjectId,
    adminsSeePrivateSchedules: false,
  });
  expect(other.membersConnectOwnMachines).toBe(false);

  const on = await updateOrganizationPrivacyPreferences(client.db, {
    organizationId: fixture.organizationId,
    actorSubjectId: fixture.actorSubjectId,
    membersConnectOwnMachines: true,
  });
  expect(on.membersConnectOwnMachines).toBe(true);
});

test("only an owner or admin turns members' own machines off", async () => {
  const fixture = await organization("own-machines-stranger");
  await expect(
    updateOrganizationPrivacyPreferences(client.db, {
      organizationId: fixture.organizationId,
      actorSubjectId: `user:stranger-${crypto.randomUUID()}`,
      membersConnectOwnMachines: false,
    }),
  ).rejects.toThrow();
  expect(
    (await getOrganizationPrivacyPreferences(client.db, fixture.organizationId))
      .membersConnectOwnMachines,
  ).toBe(true);
});
