import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivacyPreferences,
  personalWorkspaceClosedToNewWork,
  updateOrganizationPrivacyPreferences,
} from "../src/index";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-personal-workspaces-setting");
  if (!acquired) throw new Error("Personal workspace setting tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("turning Personal workspaces off closes them to new work and lands people in a shared one", async () => {
  const userId = `personal-off-${crypto.randomUUID()}`;
  const input = { userId, email: `${userId}@example.test`, name: "Personal off owner" };
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, input);
  const membership = provisioned.organizationMemberships[0]!;
  const organizationId = membership.organizationId;
  const personalWorkspaceId = membership.personalWorkspaceId;
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) => grant.accountId === organizationId && grant.workspaceId !== personalWorkspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  const closed = (workspaceId: string) =>
    personalWorkspaceClosedToNewWork(client.db, { accountId: organizationId, workspaceId });

  // On by default, before any row exists.
  expect(
    (await getOrganizationPrivacyPreferences(client.db, organizationId)).personalWorkspacesEnabled,
  ).toBe(true);
  expect(await closed(personalWorkspaceId)).toBe(false);
  expect(await closed(sharedWorkspaceId)).toBe(false);

  const off = await updateOrganizationPrivacyPreferences(client.db, {
    organizationId,
    actorSubjectId: `user:${userId}`,
    personalWorkspacesEnabled: false,
  });
  expect(off.personalWorkspacesEnabled).toBe(false);
  // The other choices are untouched.
  expect(off.defaultVisibility).toBe("workspace_shared");
  expect(await closed(personalWorkspaceId)).toBe(true);
  expect(await closed(sharedWorkspaceId)).toBe(false);
  const afterOff = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, input);
  // Nobody lands in a hidden Personal workspace.
  expect(afterOff.accessContext.defaultWorkspaceId).not.toBe(personalWorkspaceId);
  // The Personal workspace itself stays: it anchors the person's own things.
  expect(afterOff.organizationMemberships[0]!.personalWorkspaceId).toBe(personalWorkspaceId);
  expect(
    afterOff.accessContext.workspaceGrants.some(
      (grant) => grant.workspaceId === personalWorkspaceId,
    ),
  ).toBe(true);

  await updateOrganizationPrivacyPreferences(client.db, {
    organizationId,
    actorSubjectId: `user:${userId}`,
    personalWorkspacesEnabled: true,
  });
  expect(await closed(personalWorkspaceId)).toBe(false);
});

test("only an owner or admin turns Personal workspaces off", async () => {
  const userId = `personal-off-owner-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal off owner",
  });
  const organizationId = provisioned.organizationMemberships[0]!.organizationId;
  await expect(
    updateOrganizationPrivacyPreferences(client.db, {
      organizationId,
      actorSubjectId: `user:stranger-${crypto.randomUUID()}`,
      personalWorkspacesEnabled: false,
    }),
  ).rejects.toThrow();
  expect(
    (await getOrganizationPrivacyPreferences(client.db, organizationId)).personalWorkspacesEnabled,
  ).toBe(true);
});
