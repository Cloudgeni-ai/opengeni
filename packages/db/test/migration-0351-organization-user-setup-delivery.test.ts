import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  acceptOrganizationInvitation,
  claimOrganizationUserSetupDelivery,
  createDb,
  createOrganizationInvitation,
  createOrganizationWorkspace,
  ensureManagedAccessForUser,
  getOrganizationInvitationForAdministration,
  listOrganizationInvitations,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  prepareOrganizationUserSetupDelivery,
  previewOrganizationUserSetup,
  revokeOrganizationInvitation,
  settleOrganizationUserSetupDelivery,
  updateOrganizationMember,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;
const providerIdempotencyScope = "test-provider-v1:account-0351";
const providerIdempotencyRetentionSeconds = 86_400;

beforeAll(async () => {
  shared = await acquireOwnerMigratedTestDatabase(
    "migration-0351-organization-user-setup-delivery",
  );
  if (!shared) {
    if (requireRealDatabase) throw new Error("migration 0351 requires real PostgreSQL");
    return;
  }
  await migrate(shared.ownerUrl);
  await provisionRoles(shared.adminUrl, {
    appPassword: shared.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(shared.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = shared.appPassword;
  client = createDb(appUrl.toString(), { max: 8, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), { max: 2, prepare: false, onnotice: () => undefined });
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
    const prepareSource = source.slice(
      source.indexOf("CREATE FUNCTION prepare_organization_user_setup_delivery"),
      source.indexOf("CREATE FUNCTION settle_organization_user_setup_delivery"),
    );
    expect(prepareSource.indexOf("organization_membership_invitations candidate")).toBeLessThan(
      prepareSource.indexOf("organization_user_setup_deliveries candidate"),
    );
    expect(prepareSource).not.toContain("ensure_organization_user_setup_intent");
    expect(source).toContain(
      "organization setup delivery is already claimed' USING ERRCODE = '55000'",
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
      "get_organization_invitation_for_administration(uuid, text, uuid)",
    ]) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    if (!shared || !app) return;
    const [ownerIdentity] = await shared.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${shared.ownerRole}`;
    expect(ownerIdentity).toEqual({ superuser: false, bypassRls: false });
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
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds: 60,
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
    ).toMatchObject({
      state: "failed",
      attemptCount: 1,
      errorClass: "provider_refused",
      retryState: "available",
    });

    const administratorSubject = `user:${crypto.randomUUID()}`;
    const administratorInvitationOperationId = crypto.randomUUID();
    const administratorInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: administratorInvitationOperationId,
      targetSubjectId: administratorSubject,
      targetEmail: `delivery-administrator-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const acceptedAdministrator = await acceptOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      operationId: crypto.randomUUID(),
      invitationId: administratorInvitation.id,
      expectedRevision: administratorInvitation.revision,
    });
    const administrator = await updateOrganizationMember(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      membershipId: acceptedAdministrator.membership.id,
      transition: {
        kind: "change_role",
        role: "admin",
        expectedAuthorizationRevision: acceptedAdministrator.membership.authorizationRevision,
        operationId: crypto.randomUUID(),
      },
    });
    expect(administrator).toMatchObject({ subjectId: administratorSubject, role: "admin" });

    const retryOperationId = crypto.randomUUID();
    const retry = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: invitation.id,
      operationId: retryOperationId,
    });
    expect(retry.claimed).toBe(true);
    if (!retry.claimed) throw new Error("retry setup delivery was not claimed");
    expect(retry.delivery.id).toBe(first.delivery.id);
    expect(retry.providerKey).toBe(first.providerKey);
    await expectSqlState(
      () =>
        prepareOrganizationUserSetupDelivery(client!.db, {
          organizationId,
          actorSubjectId: administratorSubject,
          deliveryId: retry.delivery.id,
          attemptId: retry.attemptId,
          claimHolderId: retry.claimHolderId,
          tokenDigest,
          payloadDigest: "9".repeat(64),
          providerIdempotencyScope,
          providerIdempotencyRetentionSeconds,
        }),
      "23505",
    );
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      deliveryId: retry.delivery.id,
      attemptId: retry.attemptId,
      claimHolderId: retry.claimHolderId,
      tokenDigest,
      payloadDigest,
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds,
    });
    const [freshFence] = await shared.admin<
      Array<{ scope: string; currentAttemptWindow: boolean }>
    >`
      select provider_idempotency_scope as scope,
        provider_retry_safe_until > clock_timestamp() + interval '23 hours'
          as "currentAttemptWindow"
      from organization_user_setup_deliveries where id = ${first.delivery.id}`;
    expect(freshFence).toEqual({
      scope: providerIdempotencyScope,
      currentAttemptWindow: true,
    });
    expect(
      await settleOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        deliveryId: retry.delivery.id,
        attemptId: retry.attemptId,
        claimHolderId: retry.claimHolderId,
        outcome: "outcome_unknown",
        errorClass: "provider_ambiguous",
      }),
    ).toMatchObject({ state: "outcome_unknown", attemptCount: 2, retryState: "available" });
    const replay = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: invitation.id,
      operationId: retryOperationId,
    });
    expect(replay).toMatchObject({ claimed: false, delivery: { state: "outcome_unknown" } });
    const preProviderMismatchOperationId = crypto.randomUUID();
    const preProviderMismatch = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: invitation.id,
      operationId: preProviderMismatchOperationId,
    });
    if (!preProviderMismatch.claimed)
      throw new Error("ambiguous pre-provider retry was not claimed");
    await expectSqlState(
      () =>
        prepareOrganizationUserSetupDelivery(client!.db, {
          organizationId,
          actorSubjectId: administratorSubject,
          deliveryId: preProviderMismatch.delivery.id,
          attemptId: preProviderMismatch.attemptId,
          claimHolderId: preProviderMismatch.claimHolderId,
          tokenDigest,
          payloadDigest: "8".repeat(64),
          providerIdempotencyScope,
          providerIdempotencyRetentionSeconds,
        }),
      "23505",
    );
    await expectSqlState(
      () =>
        prepareOrganizationUserSetupDelivery(client!.db, {
          organizationId,
          actorSubjectId: administratorSubject,
          deliveryId: preProviderMismatch.delivery.id,
          attemptId: preProviderMismatch.attemptId,
          claimHolderId: preProviderMismatch.claimHolderId,
          tokenDigest,
          payloadDigest,
          providerIdempotencyScope: "other-provider-v1:other-account",
          providerIdempotencyRetentionSeconds,
        }),
      "23505",
    );
    await shared.admin`
      update organization_user_setup_deliveries
      set claim_expires_at = clock_timestamp() - interval '1 second'
      where id = ${first.delivery.id}`;
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: invitation.id,
        operationId: preProviderMismatchOperationId,
      }),
    ).toMatchObject({
      claimed: false,
      delivery: {
        state: "outcome_unknown",
        errorClass: "prior_provider_outcome_unresolved",
        retryState: "available",
      },
    });
    const [preservedAmbiguity] = await shared.admin<
      Array<{ unresolved: boolean; result: string; providerStarted: boolean }>
    >`
      select delivery.unresolved_provider_outcome_at is not null as unresolved,
        attempt.result,
        attempt.provider_started_at is not null as "providerStarted"
      from organization_user_setup_deliveries delivery
      join organization_user_setup_delivery_attempts attempt
        on attempt.id = ${preProviderMismatch.attemptId}
      where delivery.id = ${first.delivery.id}`;
    expect(preservedAmbiguity).toEqual({
      unresolved: true,
      result: "failed",
      providerStarted: false,
    });
    const [providerWindow] = await shared.admin<
      Array<{ retryWindowStartedAt: string; retrySafeUntil: string }>
    >`
      update organization_user_setup_deliveries
      set provider_retry_window_started_at = clock_timestamp() - interval '23 hours 59 minutes',
        provider_retry_safe_until = clock_timestamp() + interval '1 minute'
      where id = ${first.delivery.id}
      returning provider_retry_window_started_at::text as "retryWindowStartedAt",
        provider_retry_safe_until::text as "retrySafeUntil"`;
    const withinProviderWindowOperationId = crypto.randomUUID();
    const withinProviderWindow = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: invitation.id,
      operationId: withinProviderWindowOperationId,
    });
    expect(withinProviderWindow).toMatchObject({ claimed: true, delivery: { attemptCount: 4 } });
    if (!withinProviderWindow.claimed)
      throw new Error("safe provider-window retry was not claimed");
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      deliveryId: withinProviderWindow.delivery.id,
      attemptId: withinProviderWindow.attemptId,
      claimHolderId: withinProviderWindow.claimHolderId,
      tokenDigest,
      payloadDigest,
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds,
    });
    const [afterSafePrepare] = await shared.admin<
      Array<{ retryWindowStartedAt: string; retrySafeUntil: string }>
    >`
      select provider_retry_window_started_at::text as "retryWindowStartedAt",
        provider_retry_safe_until::text as "retrySafeUntil"
      from organization_user_setup_deliveries where id = ${first.delivery.id}`;
    expect(afterSafePrepare).toEqual(providerWindow);
    await settleOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      deliveryId: withinProviderWindow.delivery.id,
      attemptId: withinProviderWindow.attemptId,
      claimHolderId: withinProviderWindow.claimHolderId,
      outcome: "outcome_unknown",
      errorClass: "provider_ambiguous",
    });
    await shared.admin`
      update organization_user_setup_deliveries
      set provider_retry_safe_until = clock_timestamp() - interval '1 second'
      where id = ${first.delivery.id}`;
    expect(
      await getOrganizationInvitationForAdministration(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: invitation.id,
      }),
    ).toMatchObject({
      delivery: { state: "outcome_unknown", retryState: "reconciliation_required" },
    });
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: invitation.id,
        operationId: withinProviderWindowOperationId,
      }),
    ).toMatchObject({
      claimed: false,
      delivery: { state: "outcome_unknown", retryState: "reconciliation_required" },
    });
    await expectSqlState(
      () =>
        claimOrganizationUserSetupDelivery(client!.db, {
          organizationId,
          actorSubjectId: administratorSubject,
          invitationId: invitation.id,
          operationId: crypto.randomUUID(),
        }),
      "55000",
    );

    const crashInvitationOperationId = crypto.randomUUID();
    const crashInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crashInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `crashed-delivery-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const crashOperationId = crypto.randomUUID();
    const beforeCrashRecovery = await listOrganizationInvitations(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      limit: 100,
    });
    expect(
      beforeCrashRecovery.invitations.find((candidate) => candidate.id === crashInvitation.id),
    ).toMatchObject({ delivery: null });
    const crashed = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: crashInvitation.id,
      operationId: crashOperationId,
    });
    if (!crashed.claimed) throw new Error("crash delivery was not claimed");
    const [creatorBinding] = await shared.admin<Array<{ createdByMembershipId: string }>>`
      select created_by_membership_id as "createdByMembershipId"
      from organization_user_setup_deliveries where id = ${crashed.delivery.id}`;
    expect(creatorBinding?.createdByMembershipId).toBe(ownerMembership!.id);
    await shared.admin`
      update organization_user_setup_deliveries
      set claim_expires_at = clock_timestamp() - interval '1 second'
      where id = ${crashed.delivery.id}`;
    const projectedCrash = await listOrganizationInvitations(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      limit: 100,
    });
    expect(
      projectedCrash.invitations.find((candidate) => candidate.id === crashInvitation.id),
    ).toMatchObject({
      delivery: { state: "failed", errorClass: "claim_expired_before_provider" },
    });
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: crashInvitation.id,
        operationId: crashOperationId,
      }),
    ).toMatchObject({
      claimed: false,
      delivery: { state: "failed", errorClass: "claim_expired_before_provider" },
    });
    const [expiredAttempt] = await shared.admin<Array<{ result: string; errorClass: string }>>`
      select result, error_class as "errorClass"
      from organization_user_setup_delivery_attempts
      where id = ${crashed.attemptId}`;
    expect(expiredAttempt).toEqual({
      result: "failed",
      errorClass: "claim_expired_before_provider",
    });
    const crashRecovery = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: crashInvitation.id,
      operationId: crypto.randomUUID(),
    });
    expect(crashRecovery).toMatchObject({ claimed: true, delivery: { attemptCount: 2 } });
    if (!crashRecovery.claimed) throw new Error("crash recovery was not claimed");
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      deliveryId: crashRecovery.delivery.id,
      attemptId: crashRecovery.attemptId,
      claimHolderId: crashRecovery.claimHolderId,
      tokenDigest: "e".repeat(64),
      payloadDigest: "f".repeat(64),
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds,
    });
    expect(
      await settleOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        deliveryId: crashRecovery.delivery.id,
        attemptId: crashRecovery.attemptId,
        claimHolderId: crashRecovery.claimHolderId,
        outcome: "failed",
        errorClass: "provider_refused",
      }),
    ).toMatchObject({ state: "failed", attemptCount: 2 });

    const expiredInvitationOperationId = crypto.randomUUID();
    const expiredInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: expiredInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `expired-claim-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const expiredClaimOperationId = crypto.randomUUID();
    const expiredClaim = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: expiredInvitation.id,
      invitationOperationId: expiredInvitationOperationId,
      operationId: expiredClaimOperationId,
    });
    if (!expiredClaim.claimed) throw new Error("expiring invitation was not claimed");
    await shared.admin`
      update organization_membership_invitations
      set expires_at = clock_timestamp() - interval '1 second'
      where id = ${expiredInvitation.id}`;
    await shared.admin`
      update organization_user_setup_deliveries
      set claim_expires_at = clock_timestamp() - interval '1 second'
      where id = ${expiredClaim.delivery.id}`;
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: expiredInvitation.id,
        operationId: expiredClaimOperationId,
      }),
    ).toMatchObject({
      claimed: false,
      delivery: { state: "failed", errorClass: "claim_expired_before_provider" },
    });
    const [expiredTerminalLease] = await shared.admin<
      Array<{ claimHolderId: string | null; result: string; settled: boolean }>
    >`
      select delivery.claim_holder_id as "claimHolderId", attempt.result,
        attempt.settled_at is not null as settled
      from organization_user_setup_deliveries delivery
      join organization_user_setup_delivery_attempts attempt
        on attempt.id = ${expiredClaim.attemptId}
      where delivery.id = ${expiredClaim.delivery.id}`;
    expect(expiredTerminalLease).toEqual({
      claimHolderId: null,
      result: "failed",
      settled: true,
    });

    const acceptedTargetSubject = `user:${crypto.randomUUID()}`;
    const acceptedDuringDeliveryOperationId = crypto.randomUUID();
    const acceptedDuringDelivery = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: acceptedDuringDeliveryOperationId,
      targetSubjectId: acceptedTargetSubject,
      targetEmail: `accepted-during-delivery-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const acceptedClaimOperationId = crypto.randomUUID();
    const acceptedClaim = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: acceptedDuringDelivery.id,
      invitationOperationId: acceptedDuringDeliveryOperationId,
      operationId: acceptedClaimOperationId,
    });
    if (!acceptedClaim.claimed) throw new Error("accepted invitation was not claimed");
    await prepareOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      deliveryId: acceptedClaim.delivery.id,
      attemptId: acceptedClaim.attemptId,
      claimHolderId: acceptedClaim.claimHolderId,
      tokenDigest: "3".repeat(64),
      payloadDigest: "4".repeat(64),
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds,
    });
    await acceptOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: acceptedTargetSubject,
      operationId: crypto.randomUUID(),
      invitationId: acceptedDuringDelivery.id,
      expectedRevision: acceptedDuringDelivery.revision,
    });
    await shared.admin`
      update organization_user_setup_deliveries
      set claim_expires_at = clock_timestamp() - interval '1 second'
      where id = ${acceptedClaim.delivery.id}`;
    expect(
      await claimOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        invitationId: acceptedDuringDelivery.id,
        operationId: acceptedClaimOperationId,
      }),
    ).toMatchObject({
      claimed: false,
      delivery: {
        state: "outcome_unknown",
        errorClass: "provider_started_claim_expired",
      },
    });
    const [acceptedTerminalLease] = await shared.admin<
      Array<{ claimHolderId: string | null; result: string; unresolved: boolean }>
    >`
      select delivery.claim_holder_id as "claimHolderId", attempt.result,
        delivery.unresolved_provider_outcome_at is not null as unresolved
      from organization_user_setup_deliveries delivery
      join organization_user_setup_delivery_attempts attempt
        on attempt.id = ${acceptedClaim.attemptId}
      where delivery.id = ${acceptedClaim.delivery.id}`;
    expect(acceptedTerminalLease).toEqual({
      claimHolderId: null,
      result: "outcome_unknown",
      unresolved: true,
    });

    const lockRaceInvitationOperationId = crypto.randomUUID();
    const lockRaceInvitation = await createOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: lockRaceInvitationOperationId,
      targetSubjectId: null,
      targetEmail: `lock-race-delivery-${crypto.randomUUID()}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const lockRace = await claimOrganizationUserSetupDelivery(client.db, {
      organizationId,
      actorSubjectId: administratorSubject,
      invitationId: lockRaceInvitation.id,
      invitationOperationId: lockRaceInvitationOperationId,
      operationId: crypto.randomUUID(),
    });
    if (!lockRace.claimed) throw new Error("lock-race delivery was not claimed");
    await shared.admin`
      create or replace function opengeni_private.test_0351_delay_invitation_update()
      returns trigger language plpgsql set search_path = pg_catalog as $body$
      begin
        perform pg_catalog.pg_sleep(0.25);
        return new;
      end
      $body$`;
    await shared.admin`
      create trigger test_0351_delay_invitation_update
      before update of status on organization_membership_invitations
      for each row execute function opengeni_private.test_0351_delay_invitation_update()`;
    try {
      const revokePromise = revokeOrganizationInvitation(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        invitationId: lockRaceInvitation.id,
        expectedRevision: lockRaceInvitation.revision,
        operationId: crypto.randomUUID(),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const preparePromise = prepareOrganizationUserSetupDelivery(client.db, {
        organizationId,
        actorSubjectId: administratorSubject,
        deliveryId: lockRace.delivery.id,
        attemptId: lockRace.attemptId,
        claimHolderId: lockRace.claimHolderId,
        tokenDigest: "1".repeat(64),
        payloadDigest: "2".repeat(64),
        providerIdempotencyScope,
        providerIdempotencyRetentionSeconds,
      });
      const [revokedResult, preparedResult] = await Promise.allSettled([
        revokePromise,
        preparePromise,
      ]);
      expect(revokedResult.status).toBe("fulfilled");
      expect(preparedResult.status).toBe("rejected");
      expect(
        preparedResult.status === "rejected" ? nestedPostgresSqlState(preparedResult.reason) : null,
      ).toBe("55000");
    } finally {
      await shared.admin`
        drop trigger if exists test_0351_delay_invitation_update
        on organization_membership_invitations`;
      await shared.admin`
        drop function if exists opengeni_private.test_0351_delay_invitation_update()`;
    }

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
      providerIdempotencyScope,
      providerIdempotencyRetentionSeconds,
    });
    await revokeOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: ownerSubject,
      invitationId: raceInvitation.id,
      expectedRevision: raceInvitation.revision,
      operationId: crypto.randomUUID(),
    });
    const [revokedLease] = await shared.admin<
      Array<{
        claimHolderId: string | null;
        claimExpiresAt: string | null;
        result: string | null;
        settled: boolean;
      }>
    >`
      select delivery.claim_holder_id as "claimHolderId",
        delivery.claim_expires_at::text as "claimExpiresAt",
        attempt.result,
        attempt.settled_at is not null as settled
      from organization_user_setup_deliveries delivery
      join organization_user_setup_delivery_attempts attempt
        on attempt.id = ${race.attemptId}
      where delivery.id = ${race.delivery.id}`;
    expect(revokedLease).toEqual({
      claimHolderId: null,
      claimExpiresAt: null,
      result: "revoked",
      settled: true,
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
    expect(stored).toEqual({ tokenDigest, payloadDigest, attemptCount: 4, attempts: 4 });
  });
});
