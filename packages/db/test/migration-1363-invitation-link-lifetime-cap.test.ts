/**
 * Migration 1363: organization invitations, and so their account setup links,
 * last at most 48 hours after creation. Longer requests are capped, not
 * refused, and invitations that already exist keep their expiry.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

import {
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
} from "../src/index";

setDefaultTimeout(120_000);

const HOUR = 3_600_000;

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-1349-invitation-lifetime");
  if (!acquired) throw new Error("invitation lifetime tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function organization() {
  const userId = `invitation-lifetime-${crypto.randomUUID()}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Invitation lifetime owner",
  });
  return {
    organizationId: provisioned.organizationMemberships[0]!.organizationId,
    owner: `user:${userId}`,
  };
}

async function invite(org: { organizationId: string; owner: string }, lifetimeMs: number) {
  const email = `invitee-${crypto.randomUUID()}@example.test`;
  return await createOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: email,
    role: "member",
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
  });
}

async function stored(invitationId: string) {
  const [row] = await shared.admin<{ expires_at: Date; created_at: Date }[]>`
    select expires_at, created_at from organization_membership_invitations
    where id = ${invitationId}`;
  return row!;
}

test("a longer invitation is capped at 48 hours after creation, not refused", async () => {
  const org = await organization();
  const invitation = await invite(org, 7 * 24 * HOUR);
  const row = await stored(invitation.id);
  expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(48 * HOUR);
  // The caller sees the expiry that applies.
  expect(Date.parse(invitation.expiresAt)).toBe(row.expires_at.getTime());
});

test("an invitation within 48 hours keeps the expiry it asked for", async () => {
  const org = await organization();
  const requested = Date.now() + 24 * HOUR;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: org.organizationId,
    actorSubjectId: org.owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: null,
    targetEmail: `invitee-${crypto.randomUUID()}@example.test`,
    role: "member",
    expiresAt: new Date(requested).toISOString(),
  });
  expect((await stored(invitation.id)).expires_at.getTime()).toBe(requested);
});

test("an existing longer invitation keeps its expiry; only a new expiry is capped", async () => {
  const org = await organization();
  const invitation = await invite(org, HOUR);
  const legacyExpiry = new Date(Date.now() + 20 * 24 * HOUR);
  // Stand in for a row written before the migration, with triggers bypassed.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update organization_membership_invitations set expires_at = ${legacyExpiry}
      where id = ${invitation.id}`;
  });

  // Ordinary updates of the row, even ones naming expires_at, leave it alone.
  await shared.admin`update organization_membership_invitations
    set expires_at = expires_at, revision = revision + 1 where id = ${invitation.id}`;
  const kept = await stored(invitation.id);
  expect(kept.expires_at.getTime()).toBe(legacyExpiry.getTime());

  // Moving the expiry is capped like a new invitation.
  await shared.admin`update organization_membership_invitations
    set expires_at = ${new Date(Date.now() + 10 * 24 * HOUR)} where id = ${invitation.id}`;
  const moved = await stored(invitation.id);
  expect(moved.expires_at.getTime() - moved.created_at.getTime()).toBe(48 * HOUR);
});
