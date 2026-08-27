import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  completeSelfServiceOrganizationSetup,
  createDb,
  createSessionWithIdempotencyKey,
  getPrivateSessionCreatePolicy,
  nestedPostgresSqlState,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, PROTECTED_NO_DIRECT_DML_TABLES } from "../src/runtime-posture";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;

type SetupInput = {
  authUserId: string;
  actorSubjectId: string;
  organizationName: string;
  operationId: string;
  requestFingerprint: string;
};

function setupInput(userId: string, name: string, fingerprintCharacter: string): SetupInput {
  return {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: name,
    operationId: crypto.randomUUID(),
    requestFingerprint: fingerprintCharacter.repeat(64),
  };
}

async function insertVerifiedUser(userId: string): Promise<void> {
  if (!owned) throw new Error("test database unavailable");
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Greenfield owner', ${`${userId}@example.test`}, true)`;
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0349-greenfield-activation");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error("greenfield activation real PostgreSQL fixture is unavailable");
    }
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  appClient = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 2,
    prepare: false,
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await appClient?.close().catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0349 greenfield session-tenancy activation", () => {
  test("keeps the fresh-only lifecycle owner-only and orders graph before the boundary", async () => {
    const source = readFileSync(
      new URL("../drizzle/0349_greenfield_session_tenancy_activation.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("CREATE FUNCTION activate_greenfield_session_tenancy_from_setup");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION activate_greenfield_session_tenancy_from_setup(text) FROM PUBLIC",
    );
    expect(source).toContain("account.xmin::text::bigint");
    expect(source).toContain("IF NOT adopt_existing_account THEN\n    PERFORM activate_greenfield");
    expect(source).toContain("workspace_membership_count <> 0");

    const helper = source.slice(
      source.indexOf("CREATE FUNCTION activate_greenfield_session_tenancy_from_setup"),
      source.indexOf("CREATE OR REPLACE FUNCTION complete_self_service_organization_setup"),
    );
    expect(helper.indexOf("workspace_membership_count <> 0")).toBeGreaterThan(-1);
    expect(helper.indexOf("PERFORM lock_session_tenancy_activation_boundary()")).toBeGreaterThan(
      helper.indexOf("workspace_membership_count <> 0"),
    );
    expect(helper.indexOf("INSERT INTO session_tenancy_activations")).toBeGreaterThan(
      helper.indexOf("PERFORM lock_session_tenancy_activation_boundary()"),
    );
    expect(helper.indexOf("INSERT INTO organization_private_session_settings")).toBeGreaterThan(
      helper.indexOf("INSERT INTO session_tenancy_activations"),
    );
    expect(
      helper.indexOf("INSERT INTO organization_private_session_setting_events"),
    ).toBeGreaterThan(helper.indexOf("INSERT INTO organization_private_session_settings"));
    expect(
      helper.indexOf("INSERT INTO session_tenancy_greenfield_activation_evidence"),
    ).toBeGreaterThan(helper.indexOf("INSERT INTO organization_private_session_setting_events"));
    expect(FORCE_RLS_TABLES).toContain("session_tenancy_greenfield_activation_evidence");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(
      "session_tenancy_greenfield_activation_evidence",
    );
  });

  test("proves both boundary orders, exact graph, rollback/retry, adoption exclusion, and immediate private create", async () => {
    if (!owned || !appClient || !app) return;
    const { admin, ownerRole } = owned;

    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });
    const forced = await admin<Array<{ relation: string; forced: boolean }>>`
      select relation.relname::text as relation, relation.relforcerowsecurity as forced
      from pg_class relation
      where relation.oid in (
        'session_tenancy_activations'::regclass,
        'organization_private_session_settings'::regclass,
        'organization_private_session_setting_events'::regclass,
        'session_tenancy_greenfield_activation_evidence'::regclass
      ) order by relation`;
    expect(Array.from(forced)).toEqual([
      { relation: "organization_private_session_setting_events", forced: true },
      { relation: "organization_private_session_settings", forced: true },
      { relation: "session_tenancy_activations", forced: true },
      {
        relation: "session_tenancy_greenfield_activation_evidence",
        forced: true,
      },
    ]);
    const [acl] = await admin<
      Array<{
        helper: boolean;
        evidenceSelect: boolean;
        anyActivation: boolean;
      }>
    >`
      select
        has_function_privilege(
          'opengeni_app', 'activate_greenfield_session_tenancy_from_setup(text)', 'EXECUTE'
        ) as helper,
        has_table_privilege(
          'opengeni_app', 'session_tenancy_greenfield_activation_evidence', 'SELECT'
        ) as "evidenceSelect",
        has_function_privilege(
          'opengeni_app', 'session_tenancy_any_product_activation()', 'EXECUTE'
        ) as "anyActivation"`;
    expect(acl).toEqual({
      helper: false,
      evidenceSelect: false,
      anyActivation: true,
    });
    await expectSqlState(
      () => app!.unsafe("select activate_greenfield_session_tenancy_from_setup('forged')"),
      "42501",
    );

    // Signup wins the boundary: without any committed product witness, its
    // exact graph commits but remains operator-managed and cannot be promoted
    // retroactively by a later witness.
    const beforeUserId = crypto.randomUUID();
    await insertVerifiedUser(beforeUserId);
    const beforeInput = setupInput(beforeUserId, "Before Boundary", "a");
    const before = await completeSelfServiceOrganizationSetup(appClient.db, beforeInput);
    const [beforeGraph] = await admin<
      Array<{
        memberships: number;
        workspaces: number;
        controls: number;
        workspaceMemberships: number;
        activations: number;
        evidence: number;
        settings: number;
        settingEvents: number;
      }>
    >`
      select
        (select count(*)::int from organization_memberships where account_id = ${before.organizationId}) as memberships,
        (select count(*)::int from workspaces where account_id = ${before.organizationId}) as workspaces,
        (select count(*)::int from workspace_inference_controls where account_id = ${before.organizationId}) as controls,
        (select count(*)::int from workspace_memberships where account_id = ${before.organizationId}) as "workspaceMemberships",
        (select count(*)::int from session_tenancy_activations where account_id = ${before.organizationId}) as activations,
        (select count(*)::int from session_tenancy_greenfield_activation_evidence where account_id = ${before.organizationId}) as evidence,
        (select count(*)::int from organization_private_session_settings where account_id = ${before.organizationId}) as settings,
        (select count(*)::int from organization_private_session_setting_events where account_id = ${before.organizationId}) as "settingEvents"`;
    expect(beforeGraph).toEqual({
      memberships: 1,
      workspaces: 1,
      controls: 1,
      workspaceMemberships: 0,
      activations: 0,
      evidence: 0,
      settings: 0,
      settingEvents: 0,
    });

    // Even a same-transaction trigger cannot smuggle a stale shared-access
    // shape through the fresh-only proof. The setup graph and receipt roll back
    // together, and the unchanged command succeeds once the drift seam is gone.
    await admin.unsafe(`
      CREATE FUNCTION inject_greenfield_workspace_membership() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN
        INSERT INTO workspace_memberships (
          account_id, workspace_id, subject_id, role
        ) VALUES (
          NEW.account_id, NEW.personal_workspace_id,
          'user:' || NEW.auth_user_id, 'owner'
        );
        RETURN NEW;
      END $$;
      CREATE TRIGGER inject_greenfield_workspace_membership
      AFTER INSERT ON self_service_organization_setup_receipts
      FOR EACH ROW EXECUTE FUNCTION inject_greenfield_workspace_membership()
    `);
    const driftUserId = crypto.randomUUID();
    await insertVerifiedUser(driftUserId);
    const driftInput = setupInput(driftUserId, "Reject Shared Drift", "e");
    await expectSqlState(
      () => completeSelfServiceOrganizationSetup(appClient!.db, driftInput),
      "55000",
    );
    const [driftRolledBack] = await admin<Array<{ accounts: number; receipts: number }>>`
      select
        (select count(*)::int from managed_accounts
          where external_source = 'better-auth:user' and external_id = ${driftUserId})
          as accounts,
        (select count(*)::int from self_service_organization_setup_receipts
          where auth_user_id = ${driftUserId}) as receipts`;
    expect(driftRolledBack).toEqual({ accounts: 0, receipts: 0 });
    await admin.unsafe(`
      DROP TRIGGER inject_greenfield_workspace_membership
        ON self_service_organization_setup_receipts;
      DROP FUNCTION inject_greenfield_workspace_membership()
    `);
    const driftRetry = await completeSelfServiceOrganizationSetup(appClient.db, driftInput);
    const [driftConverged] = await admin<
      Array<{ workspaceMemberships: number; activations: number }>
    >`
      select
        (select count(*)::int from workspace_memberships
          where account_id = ${driftRetry.organizationId}) as "workspaceMemberships",
        (select count(*)::int from session_tenancy_activations
          where account_id = ${driftRetry.organizationId}) as activations`;
    expect(driftConverged).toEqual({ workspaceMemberships: 0, activations: 0 });

    const witnessAccountId = crypto.randomUUID();
    await admin`
      insert into managed_accounts (id, name)
      values (${witnessAccountId}, 'Committed witness')`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest,
        activated_by, backfill_receipt_ids
      ) values (
        ${witnessAccountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)},
        'test:committed-operator-witness', array[]::uuid[]
      )`;
    const [deploymentActivated] = await app<Array<{ active: boolean }>>`
      select session_tenancy_any_product_activation() as active`;
    expect(deploymentActivated?.active).toBe(true);
    const [stillBefore] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from session_tenancy_activations
      where account_id = ${before.organizationId}`;
    expect(stillBefore?.count).toBe(0);

    // A seam failure rolls back the graph, setup receipt, activation receipt,
    // setting/event, and evidence together. The same operation then retries.
    await admin.unsafe(`
      CREATE FUNCTION fail_greenfield_activation_evidence() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'injected greenfield evidence failure' USING ERRCODE = 'P0001';
      END $$;
      CREATE TRIGGER fail_greenfield_activation_evidence
      BEFORE INSERT ON session_tenancy_greenfield_activation_evidence
      FOR EACH ROW EXECUTE FUNCTION fail_greenfield_activation_evidence()
    `);
    const rollbackUserId = crypto.randomUUID();
    await insertVerifiedUser(rollbackUserId);
    const rollbackInput = setupInput(rollbackUserId, "Rollback Greenfield", "b");
    await expectSqlState(
      () => completeSelfServiceOrganizationSetup(appClient!.db, rollbackInput),
      "P0001",
    );
    const [rolledBack] = await admin<
      Array<{
        accounts: number;
        receipts: number;
        memberships: number;
        workspaces: number;
        activations: number;
        evidence: number;
        settings: number;
        settingEvents: number;
      }>
    >`
      select
        (select count(*)::int from managed_accounts where external_source = 'better-auth:user' and external_id = ${rollbackUserId}) as accounts,
        (select count(*)::int from self_service_organization_setup_receipts where auth_user_id = ${rollbackUserId}) as receipts,
        (select count(*)::int from organization_memberships where subject_id = ${`user:${rollbackUserId}`}) as memberships,
        (select count(*)::int from workspaces where external_id like ${`%user:${rollbackUserId}`}) as workspaces,
        (select count(*)::int from session_tenancy_activations activation join managed_accounts account on account.id = activation.account_id where account.external_id = ${rollbackUserId}) as activations,
        (select count(*)::int from session_tenancy_greenfield_activation_evidence evidence where evidence.setup_auth_user_id = ${rollbackUserId}) as evidence,
        (select count(*)::int from organization_private_session_settings setting join managed_accounts account on account.id = setting.account_id where account.external_id = ${rollbackUserId}) as settings,
        (select count(*)::int from organization_private_session_setting_events event join managed_accounts account on account.id = event.account_id where account.external_id = ${rollbackUserId}) as "settingEvents"`;
    expect(rolledBack).toEqual({
      accounts: 0,
      receipts: 0,
      memberships: 0,
      workspaces: 0,
      activations: 0,
      evidence: 0,
      settings: 0,
      settingEvents: 0,
    });
    await admin.unsafe(`
      DROP TRIGGER fail_greenfield_activation_evidence
        ON session_tenancy_greenfield_activation_evidence;
      DROP FUNCTION fail_greenfield_activation_evidence()
    `);
    const retried = await completeSelfServiceOrganizationSetup(appClient.db, rollbackInput);
    expect(await completeSelfServiceOrganizationSetup(appClient.db, rollbackInput)).toEqual(
      retried,
    );
    await expectSqlState(
      () =>
        completeSelfServiceOrganizationSetup(appClient!.db, {
          ...rollbackInput,
          operationId: crypto.randomUUID(),
        }),
      "23505",
    );

    const [durable] = await admin<
      Array<{
        role: string;
        status: string;
        workspaceName: string;
        workspaceSlug: string | null;
        memberships: number;
        workspaces: number;
        controls: number;
        workspaceMemberships: number;
        version: number;
        backfillReceiptIds: string[];
        activatedBy: string;
        enabled: boolean;
        settingVersion: number;
        updatedByMembershipId: string;
        setupOperationId: string;
        privateSettingEventId: string;
        graphDigestValid: boolean;
        parityDigestValid: boolean;
      }>
    >`
      select membership.role, membership.status,
        workspace.name as "workspaceName", workspace.slug as "workspaceSlug",
        (select count(*)::int from organization_memberships where account_id = account.id) as memberships,
        (select count(*)::int from workspaces where account_id = account.id) as workspaces,
        (select count(*)::int from workspace_inference_controls where account_id = account.id) as controls,
        (select count(*)::int from workspace_memberships where account_id = account.id) as "workspaceMemberships",
        activation.activation_version as version,
        activation.backfill_receipt_ids as "backfillReceiptIds",
        activation.activated_by as "activatedBy",
        setting.enabled, setting.version::int as "settingVersion",
        setting.updated_by_membership_id as "updatedByMembershipId",
        evidence.setup_operation_id as "setupOperationId",
        evidence.private_setting_event_id as "privateSettingEventId",
        evidence.graph_digest = encode(sha256(convert_to(evidence.graph_evidence::text, 'UTF8')), 'hex') as "graphDigestValid",
        evidence.activation_parity_digest = encode(sha256(convert_to(jsonb_build_object(
          'schemaVersion', 1,
          'graphDigest', evidence.graph_digest,
          'boundaryWitnessAccountId', evidence.boundary_witness_account_id,
          'boundaryWitnessActivatedAt', evidence.boundary_witness_activated_at
        )::text, 'UTF8')), 'hex') as "parityDigestValid"
      from managed_accounts account
      join organization_memberships membership on membership.account_id = account.id
      join workspaces workspace on workspace.id = membership.personal_workspace_id
      join session_tenancy_activations activation on activation.account_id = account.id
      join organization_private_session_settings setting on setting.account_id = account.id
      join session_tenancy_greenfield_activation_evidence evidence on evidence.account_id = account.id
      where account.id = ${retried.organizationId}`;
    expect(durable).toMatchObject({
      role: "owner",
      status: "active",
      workspaceName: "Personal workspace",
      workspaceSlug: null,
      memberships: 1,
      workspaces: 1,
      controls: 1,
      workspaceMemberships: 0,
      version: 1,
      backfillReceiptIds: [],
      activatedBy: "opengeni:greenfield-organization-setup:v1",
      enabled: true,
      settingVersion: 1,
      setupOperationId: rollbackInput.operationId,
      privateSettingEventId: rollbackInput.operationId,
      graphDigestValid: true,
      parityDigestValid: true,
    });
    expect(durable?.updatedByMembershipId).toBeString();
    const [settingEvent] = await admin<
      Array<{
        requested: boolean;
        expectedVersion: number;
        result: boolean;
        resultVersion: number;
        changed: boolean;
      }>
    >`
      select requested_enabled as requested, expected_version::int as "expectedVersion",
        result_enabled as result, result_version::int as "resultVersion", changed
      from organization_private_session_setting_events
      where id = ${rollbackInput.operationId}`;
    expect(settingEvent).toEqual({
      requested: true,
      expectedVersion: 0,
      result: true,
      resultVersion: 1,
      changed: true,
    });

    const privatePolicy = await getPrivateSessionCreatePolicy(appClient.db, {
      workspaceId: retried.personalWorkspaceId,
      actorSubjectId: rollbackInput.actorSubjectId,
    });
    expect(privatePolicy).toEqual({
      personalWorkspace: true,
      platformAvailable: true,
      organizationEnabled: true,
    });

    const privateSession = await createSessionWithIdempotencyKey(appClient.db, {
      accountId: retried.organizationId,
      workspaceId: retried.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private immediately after signup",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: rollbackInput.actorSubjectId },
      subjectId: rollbackInput.actorSubjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `greenfield-private-${crypto.randomUUID()}`,
    });
    const [storedSession] = await admin<Array<{ visibility: string; ownerMembershipId: string }>>`
      select visibility, owner_organization_membership_id as "ownerMembershipId"
      from sessions where id = ${privateSession.session.id}`;
    expect(storedSession).toEqual({
      visibility: "user_private",
      ownerMembershipId: durable!.updatedByMembershipId,
    });

    // The explicit 0348 orphan-account adoption branch remains outside the
    // fresh-account lifecycle even after the deployment boundary exists.
    const adoptedUserId = crypto.randomUUID();
    const adoptedAccountId = crypto.randomUUID();
    await insertVerifiedUser(adoptedUserId);
    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${adoptedAccountId}, 'Legacy orphan', 'better-auth:user', ${adoptedUserId})`;
    const adoptedInput = setupInput(adoptedUserId, "Adopted Organization", "c");
    const adopted = await completeSelfServiceOrganizationSetup(appClient.db, adoptedInput);
    expect(adopted.organizationId).toBe(adoptedAccountId);
    const [adoptedAuthority] = await admin<
      Array<{
        activation: number;
        evidence: number;
        setting: number;
        event: number;
      }>
    >`
      select
        (select count(*)::int from session_tenancy_activations where account_id = ${adoptedAccountId}) as activation,
        (select count(*)::int from session_tenancy_greenfield_activation_evidence where account_id = ${adoptedAccountId}) as evidence,
        (select count(*)::int from organization_private_session_settings where account_id = ${adoptedAccountId}) as setting,
        (select count(*)::int from organization_private_session_setting_events where account_id = ${adoptedAccountId}) as event`;
    expect(adoptedAuthority).toEqual({
      activation: 0,
      evidence: 0,
      setting: 0,
      event: 0,
    });

    // Operator wins the boundary: signup reaches its final fence, blocks on
    // the uncommitted operator transaction, then observes the committed witness
    // and commits every authority row atomically.
    const racedUserId = crypto.randomUUID();
    await insertVerifiedUser(racedUserId);
    const racedInput = setupInput(racedUserId, "Operator Wins", "d");
    const racedWitnessId = crypto.randomUUID();
    let releaseOperator!: () => void;
    const operatorRelease = new Promise<void>((resolve) => {
      releaseOperator = resolve;
    });
    let boundaryHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      boundaryHeld = resolve;
    });
    const operator = admin.begin(async (tx) => {
      await tx`select lock_session_tenancy_activation_boundary()`;
      await tx`insert into managed_accounts (id, name) values (${racedWitnessId}, 'Raced witness')`;
      await tx`
        insert into session_tenancy_activations (
          account_id, activation_version, inventory_digest, parity_digest,
          activated_by, backfill_receipt_ids
        ) values (
          ${racedWitnessId}, 1, ${"2".repeat(64)}, ${"3".repeat(64)},
          'test:raced-operator-witness', array[]::uuid[]
        )`;
      boundaryHeld();
      await operatorRelease;
    });
    await held;
    const racedSetup = completeSelfServiceOrganizationSetup(appClient.db, racedInput);
    let observedBlocked = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await admin<Array<{ blocked: boolean }>>`
          select exists (
            select 1 from pg_stat_activity activity
            where activity.datname = current_database()
              and activity.usename = 'opengeni_app'
              and activity.wait_event = 'advisory'
              and activity.query like '%complete_self_service_organization_setup%'
          ) as blocked`;
        if (row?.blocked) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releaseOperator();
    }
    await operator;
    const raced = await racedSetup;
    expect(observedBlocked).toBe(true);
    const [racedDurable] = await admin<
      Array<{
        activation: number;
        evidence: number;
        setting: number;
        receipts: number;
      }>
    >`
      select
        (select count(*)::int from session_tenancy_activations where account_id = ${raced.organizationId}) as activation,
        (select count(*)::int from session_tenancy_greenfield_activation_evidence where account_id = ${raced.organizationId}) as evidence,
        (select count(*)::int from organization_private_session_settings where account_id = ${raced.organizationId} and enabled) as setting,
        (select count(*)::int from self_service_organization_setup_receipts where account_id = ${raced.organizationId}) as receipts`;
    expect(racedDurable).toEqual({
      activation: 1,
      evidence: 1,
      setting: 1,
      receipts: 1,
    });
  }, 300_000);
});
