import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  claimOrganizationUserSetupDelivery,
  createDb,
  createOrganizationInvitation,
  createOrganizationWorkspace,
  ensureManagedAccessForUser,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  prepareOrganizationUserSetupDelivery,
  previewOrganizationUserSetup,
  revokeOrganizationInvitation,
  settleOrganizationUserSetupDelivery,
  type DbClient,
} from "../src";
import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0351-organization-user-setup-delivery");
  if (!shared) {
    if (requireRealDatabase) throw new Error("migration 0351 requires real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
  app = postgres(shared.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await shared?.release();
}, 180_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("migration 0351 organization user setup delivery", () => {
  test("is digest-only, FORCE-RLS, execute-only, and registered in runtime posture", async () => {
    const source = readFileSync(
      new URL("../drizzle/0351_organization_user_setup_delivery.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).not.toMatch(/token_plain|bearer_plain|message_body|email_body/i);
    expect(source).toContain("token_digest text");
    expect(source).toContain("payload_digest text");
    expect(source.indexOf("organization-invitation-email:")).toBeLessThan(
      source.indexOf("organization-membership:"),
    );
    for (const table of [
      "organization_user_setup_deliveries",
      "organization_user_setup_delivery_attempts",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
    }
    for (const routine of [
      "claim_organization_user_setup_delivery(jsonb)",
      "prepare_organization_user_setup_delivery(jsonb)",
      "settle_organization_user_setup_delivery(jsonb)",
      "preview_organization_user_setup(text)",
    ]) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    if (!shared || !app) return;
    const forced = await shared.admin<Array<{ relation: string; forced: boolean }>>`
      select relation.relname::text as relation, relation.relforcerowsecurity as forced
      from pg_class relation
      where relation.oid in (
        'organization_user_setup_deliveries'::regclass,
        'organization_user_setup_delivery_attempts'::regclass
      ) order by relation`;
    expect(Array.from(forced)).toEqual([
      { relation: "organization_user_setup_deliveries", forced: true },
      { relation: "organization_user_setup_delivery_attempts", forced: true },
    ]);
    const [acl] = await shared.admin<
      Array<{ deliveriesDml: boolean; attemptsDml: boolean; claim: boolean; settle: boolean }>
    >`
      select
        has_table_privilege('opengeni_app', 'organization_user_setup_deliveries',
          'INSERT,UPDATE,DELETE,TRUNCATE') as "deliveriesDml",
        has_table_privilege('opengeni_app', 'organization_user_setup_delivery_attempts',
          'INSERT,UPDATE,DELETE,TRUNCATE') as "attemptsDml",
        has_function_privilege('opengeni_app',
          'claim_organization_user_setup_delivery(jsonb)', 'EXECUTE') as claim,
        has_function_privilege('opengeni_app',
          'settle_organization_user_setup_delivery(jsonb)', 'EXECUTE') as settle`;
    expect(acl).toEqual({
      deliveriesDml: false,
      attemptsDml: false,
      claim: true,
      settle: true,
    });
    await expectSqlState(async () => {
      await app!`delete from organization_user_setup_deliveries`;
    }, "42501");
  });

  test("freezes one safe payload, converges retries, exposes preview, and lets revocation win", async () => {
    if (!shared || !client) return;
    const ownerUserId = crypto.randomUUID();
    const ownerSubject = `user:${ownerUserId}`;
    const ownerEmail = `delivery-owner-${ownerUserId}@example.test`;
    await ensureManagedAccessForUser(client.db, {
      userId: ownerUserId,
      email: ownerEmail,
      name: "Delivery Owner",
    });
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${ownerUserId}, 'Delivery Owner', ${ownerEmail}, true)
      on conflict (id) do update set name = excluded.name, email = excluded.email`;
    const [ownerMembership] = await listSelfOrganizationMemberships(client.db, ownerSubject);
    expect(ownerMembership).toBeDefined();
    const organizationId = ownerMembership!.organizationId;
    const workspace = await createOrganizationWorkspace(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      name: "Invited Engineering",
      operationId: crypto.randomUUID(),
    });
    const invitationOperationId = crypto.randomUUID();
    const invitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: invitationOperationId,
      targetSubjectId: null,
      targetEmail: `delivery-${crypto.randomUUID()}@example.test`,
      targetName: "Invited Engineer",
      initialWorkspaceIds: [workspace.id],
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const firstOperationId = crypto.randomUUID();
    const first = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: invitation.id,
      invitationOperationId,
      operationId: firstOperationId,
    });
    expect(first.claimed).toBe(true);
    if (!first.claimed) throw new Error("first setup delivery was not claimed");
    expect(first).toMatchObject({
      recipientEmail: invitation.targetEmail,
      recipientName: "Invited Engineer",
      organizationRole: "member",
      sharedWorkspaceAccess: [
        { workspaceId: workspace.id, workspaceName: "Invited Engineering", role: "member" },
      ],
    });
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        invitationId: invitation.id,
        invitationOperationId,
        operationId: firstOperationId,
      }),
    ).toMatchObject({ claimed: false, delivery: { id: first.delivery.id, state: "pending" } });
    const tokenDigest = "a".repeat(64);
    const payloadDigest = "b".repeat(64);
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      deliveryId: first.delivery.id,
      attemptId: first.attemptId,
      claimHolderId: first.claimHolderId,
      tokenDigest,
      payloadDigest,
    });
    expect(await previewOrganizationUserSetup(client.db, tokenDigest)).toEqual({
      state: "pending",
      organizationId,
      organizationName: first.organizationName,
      targetEmail: invitation.targetEmail,
      targetName: "Invited Engineer",
      organizationRole: "member",
      sharedWorkspaceAccess: [
        { workspaceId: workspace.id, workspaceName: "Invited Engineering", role: "member" },
      ],
      expiresAt: invitation.expiresAt,
    });
    expect(
      await settleOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        deliveryId: first.delivery.id,
        attemptId: first.attemptId,
        claimHolderId: first.claimHolderId,
        outcome: "failed",
        errorClass: "provider_refused",
      }),
    ).toMatchObject({ state: "failed", attemptCount: 1, errorClass: "provider_refused" });

    const retryOperationId = crypto.randomUUID();
    const retry = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: invitation.id,
      operationId: retryOperationId,
    });
    expect(retry.claimed).toBe(true);
    if (!retry.claimed) throw new Error("retry setup delivery was not claimed");
    expect(retry.delivery.id).toBe(first.delivery.id);
    expect(retry.providerKey).toBe(first.providerKey);
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      deliveryId: retry.delivery.id,
      attemptId: retry.attemptId,
      claimHolderId: retry.claimHolderId,
      tokenDigest,
      payloadDigest,
    });
    expect(
      await settleOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        deliveryId: retry.delivery.id,
        attemptId: retry.attemptId,
        claimHolderId: retry.claimHolderId,
        outcome: "outcome_unknown",
        errorClass: "provider_ambiguous",
      }),
    ).toMatchObject({ state: "outcome_unknown", attemptCount: 2 });
    const replay = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: invitation.id,
      operationId: retryOperationId,
    });
    expect(replay).toMatchObject({ claimed: false, delivery: { state: "outcome_unknown" } });

    const raceInvitationOperationId = crypto.randomUUID();
    const raceInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: raceInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `revoked-delivery-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const race = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: raceInvitation.id,
      invitationOperationId: raceInvitationOperationId,
      operationId: crypto.randomUUID(),
    });
    if (!race.claimed) throw new Error("revocation-race delivery was not claimed");
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      deliveryId: race.delivery.id,
      attemptId: race.attemptId,
      claimHolderId: race.claimHolderId,
      tokenDigest: "c".repeat(64),
      payloadDigest: "d".repeat(64),
    });
    await revokeOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: raceInvitation.id,
      expectedRevision: raceInvitation.revision,
      operationId: crypto.randomUUID(),
    });
    expect(
      await settleOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        deliveryId: race.delivery.id,
        attemptId: race.attemptId,
        claimHolderId: race.claimHolderId,
        outcome: "sent",
        providerMessageId: "provider-message-after-revoke",
      }),
    ).toMatchObject({ state: "revoked" });
    expect(await previewOrganizationUserSetup(client.db, "c".repeat(64))).toEqual({
      state: "revoked",
    });

    const [stored] = await shared.admin<
      Array<{ tokenDigest: string; payloadDigest: string; attemptCount: number; attempts: number }>
    >`
      select delivery.token_digest as "tokenDigest",
        delivery.payload_digest as "payloadDigest",
        delivery.attempt_count as "attemptCount",
        (select count(*)::int from organization_user_setup_delivery_attempts attempt
          where attempt.delivery_id = delivery.id) as attempts
      from organization_user_setup_deliveries delivery where delivery.id = ${first.delivery.id}`;
    expect(stored).toEqual({ tokenDigest, payloadDigest, attemptCount: 2, attempts: 2 });
  });
});
