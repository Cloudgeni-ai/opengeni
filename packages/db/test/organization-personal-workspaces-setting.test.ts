import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivacyPreferences,
  getWorkspaceUsage,
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

test("an organization's per-person monthly limit stops Personal-workspace spending, nothing else", async () => {
  const userId = `personal-limit-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal limit owner",
  });
  const membership = provisioned.organizationMemberships[0]!;
  const accountId = membership.organizationId;
  const personal = { accountId, workspaceId: membership.personalWorkspaceId };
  const sharedWorkspaceId = provisioned.accessContext.workspaceGrants.find(
    (grant) => grant.accountId === accountId && grant.workspaceId !== personal.workspaceId,
  )?.workspaceId;
  if (!sharedWorkspaceId) throw new Error("fixture has no shared workspace");
  const sharedScope = { accountId, workspaceId: sharedWorkspaceId };
  const charge = (scope: typeof personal, micros: number) => {
    const key = crypto.randomUUID();
    return applyCreditDebitAfterUse(client.db, {
      ...scope,
      type: "test",
      amountMicros: micros,
      sourceType: "test",
      sourceId: key,
      idempotencyKey: key,
    });
  };
  const setLimit = (credits: number | null) =>
    updateOrganizationPrivacyPreferences(client.db, {
      organizationId: accountId,
      actorSubjectId: `user:${userId}`,
      personalWorkspaceMonthlyCredits: credits,
    });

  // Off by default: no limit anywhere.
  expect(
    (await getOrganizationPrivacyPreferences(client.db, accountId)).personalWorkspaceMonthlyCredits,
  ).toBeNull();
  await charge(personal, 400_000);
  expect((await getWorkspaceUsage(client.db, personal)).workspace.limit).toBeNull();
  expect(await checkWorkspaceAllowance(client.db, personal)).toBeNull();

  // $1 a month: this month's spending so far counts against it.
  const limited = await setLimit(1_000_000);
  expect(limited.personalWorkspaceMonthlyCredits).toBe(1_000_000);
  // The other choices are untouched.
  expect(limited.personalWorkspacesEnabled).toBe(true);
  const usage = await getWorkspaceUsage(client.db, personal);
  expect(usage.workspace).toMatchObject({
    limit: 1_000_000,
    used: 400_000,
    remaining: 600_000,
    status: "ok",
    includedCredits: 1_000_000,
  });
  expect(usage.workspace.resetsAt).not.toBeNull();
  expect(await checkWorkspaceAllowance(client.db, personal)).toBeNull();

  await charge(personal, 600_000);
  expect(await checkWorkspaceAllowance(client.db, personal)).toMatchObject({
    code: "allowance_exhausted",
    scope: "workspace",
    resetsAt: usage.workspace.resetsAt,
  });
  // Work paid by the person's own plans or keys spends no credits and goes on.
  expect(
    await checkWorkspaceAllowance(client.db, { ...personal, fundedWithoutCredits: true }),
  ).toBeNull();
  // Shared workspaces keep their own budgets, or none.
  await charge(sharedScope, 5_000_000);
  expect((await getWorkspaceUsage(client.db, sharedScope)).workspace.limit).toBeNull();
  expect(await checkWorkspaceAllowance(client.db, sharedScope)).toBeNull();
  // A past month keeps no record of the limit.
  expect(
    (await getWorkspaceUsage(client.db, { ...personal, period: "2020-01" })).workspace.limit,
  ).toBeNull();

  // Removing the limit lets work go on at once.
  expect((await setLimit(null)).personalWorkspaceMonthlyCredits).toBeNull();
  expect(await checkWorkspaceAllowance(client.db, personal)).toBeNull();

  await expect(setLimit(-1)).rejects.toThrow();
  await expect(
    updateOrganizationPrivacyPreferences(client.db, {
      organizationId: accountId,
      actorSubjectId: `user:stranger-${crypto.randomUUID()}`,
      personalWorkspaceMonthlyCredits: 0,
    }),
  ).rejects.toThrow();
  expect(
    (await getOrganizationPrivacyPreferences(client.db, accountId)).personalWorkspaceMonthlyCredits,
  ).toBeNull();
});
