import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  completeSelfServiceOrganizationSetup,
  createAdditionalManagedOrganization,
  createDb,
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
  owned = await acquireOwnerMigratedTestDatabase("migration-0398-additional-organization");
  if (!owned) {
    if (requireRealDatabase) throw new Error("additional organization PostgreSQL unavailable");
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

describe("migration 0399 additional managed organization creation", () => {
  test("keeps the new lifecycle separate, owner-mediated, and FORCE-RLS protected", async () => {
    const source = readFileSync(
      new URL("../drizzle/0399_additional_managed_organization_creation.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("CREATE FUNCTION create_additional_managed_organization");
    expect(source).toContain(
      "CREATE FUNCTION activate_session_tenancy_from_additional_organization",
    );
    expect(source).not.toContain("CREATE OR REPLACE FUNCTION create_managed_organization");
    expect(source).not.toContain(
      "CREATE OR REPLACE FUNCTION complete_self_service_organization_setup",
    );
    expect(source).toContain("account.xmin::text::bigint = pg_catalog.pg_current_xact_id()");
    expect(source).toContain("workspace_membership_count <> 1");
    expect(source).toContain("'additional-organization-creation-subject:' || p_subject_id");
    expect(source).toContain("created_organization_count >= additional_organization_limit");
    expect(FORCE_RLS_TABLES).toContain("additional_organization_creation_receipts");
    expect(FORCE_RLS_TABLES).toContain(
      "session_tenancy_additional_organization_activation_evidence",
    );
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("additional_organization_creation_receipts");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(
      "session_tenancy_additional_organization_activation_evidence",
    );
  });

  test("creates two isolated organizations for one login with exact replay and activation", async () => {
    if (!owned || !appClient || !app) return;
    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Multi-org owner', ${`${userId}@example.test`}, true)`;

    await completeSelfServiceOrganizationSetup(appClient.db, {
      authUserId: userId,
      actorSubjectId: subjectId,
      organizationName: "Original organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
    });

    const witnessAccountId = crypto.randomUUID();
    await owned.admin`
      insert into managed_accounts (id, name)
      values (${witnessAccountId}, 'Committed activation witness')`;
    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest,
        activated_by, backfill_receipt_ids
      ) values (
        ${witnessAccountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)},
        'test:additional-organization-witness', array[]::uuid[]
      )`;

    const input = {
      subjectId,
      subjectLabel: "Multi-org owner",
      name: "Product team",
      workspaceName: "Launch room",
      operationId: crypto.randomUUID(),
    };
    const [left, right] = await Promise.all([
      createAdditionalManagedOrganization(appClient.db, input),
      createAdditionalManagedOrganization(appClient.db, input),
    ]);
    expect(right).toEqual(left);
    expect(left.organization.name).toBe("Product team");
    expect(left.workspaceId).not.toBe(left.personalWorkspaceId);

    const [graph] = await owned.admin<
      Array<{
        memberships: number;
        workspaces: number;
        controls: number;
        workspaceMemberships: number;
        ownerRole: string;
        sharedRole: string;
        sharedName: string;
        personalName: string;
        activation: number;
        evidence: number;
        settingEnabled: boolean;
        receiptResult: unknown;
      }>
    >`
      select
        (select count(*)::int from organization_memberships where account_id = ${left.organization.id}) as memberships,
        (select count(*)::int from workspaces where account_id = ${left.organization.id}) as workspaces,
        (select count(*)::int from workspace_inference_controls where account_id = ${left.organization.id}) as controls,
        (select count(*)::int from workspace_memberships where account_id = ${left.organization.id}) as "workspaceMemberships",
        owner_membership.role as "ownerRole",
        shared_membership.role as "sharedRole",
        shared_workspace.name as "sharedName",
        personal_workspace.name as "personalName",
        (select count(*)::int from session_tenancy_activations where account_id = ${left.organization.id}) as activation,
        (select count(*)::int from session_tenancy_additional_organization_activation_evidence where account_id = ${left.organization.id}) as evidence,
        private_setting.enabled as "settingEnabled",
        receipt.result as "receiptResult"
      from additional_organization_creation_receipts receipt
      join organization_memberships owner_membership
        on owner_membership.id = receipt.organization_membership_id
      join workspaces shared_workspace on shared_workspace.id = receipt.shared_workspace_id
      join workspaces personal_workspace on personal_workspace.id = receipt.personal_workspace_id
      join workspace_memberships shared_membership
        on shared_membership.account_id = receipt.account_id
        and shared_membership.workspace_id = receipt.shared_workspace_id
        and shared_membership.subject_id = receipt.actor_subject_id
      join organization_private_session_settings private_setting
        on private_setting.account_id = receipt.account_id
      where receipt.operation_id = ${input.operationId}`;
    expect(graph).toMatchObject({
      memberships: 1,
      workspaces: 2,
      controls: 2,
      workspaceMemberships: 1,
      ownerRole: "owner",
      sharedRole: "admin",
      sharedName: "Launch room",
      personalName: "Personal workspace",
      activation: 1,
      evidence: 1,
      settingEnabled: true,
    });
    expect(graph?.receiptResult).toMatchObject({
      organizationId: left.organization.id,
      workspaceId: left.workspaceId,
      personalWorkspaceId: left.personalWorkspaceId,
    });

    await expectSqlState(
      () =>
        createAdditionalManagedOrganization(appClient!.db, {
          ...input,
          workspaceName: "Different input",
        }),
      "23505",
    );

    const second = await createAdditionalManagedOrganization(appClient.db, {
      ...input,
      name: "Research team",
      workspaceName: "Research",
      operationId: crypto.randomUUID(),
    });
    expect(second.organization.id).not.toBe(left.organization.id);
    const [membershipCount] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from organization_memberships
      where subject_id = ${subjectId} and status = 'active'`;
    expect(membershipCount?.count).toBe(3);

    for (let index = 3; index <= 9; index += 1) {
      await createAdditionalManagedOrganization(appClient.db, {
        ...input,
        name: `Team ${index}`,
        workspaceName: `Workspace ${index}`,
        operationId: crypto.randomUUID(),
      });
    }
    const competing = await Promise.allSettled(
      ["Ten A", "Ten B"].map((name) =>
        createAdditionalManagedOrganization(appClient!.db, {
          ...input,
          name,
          workspaceName: name,
          operationId: crypto.randomUUID(),
        }),
      ),
    );
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = competing.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(nestedPostgresSqlState(rejected?.reason)).toBe("54000");

    const [quota] = await owned.admin<Array<{ receipts: number; accounts: number }>>`
      select
        (select count(*)::int from additional_organization_creation_receipts
          where actor_subject_id = ${subjectId}) as receipts,
        (select count(*)::int from managed_accounts
          where external_source = 'opengeni:additional-organization'
            and id in (
              select account_id from additional_organization_creation_receipts
              where actor_subject_id = ${subjectId}
            )) as accounts`;
    expect(quota).toEqual({ receipts: 10, accounts: 10 });
    expect(await createAdditionalManagedOrganization(appClient.db, input)).toEqual(left);

    const outsiderId = crypto.randomUUID();
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${outsiderId}, 'Not onboarded', ${`${outsiderId}@example.test`}, true)`;
    await expectSqlState(
      () =>
        createAdditionalManagedOrganization(appClient!.db, {
          subjectId: `user:${outsiderId}`,
          subjectLabel: "Not onboarded",
          name: "Bypass attempt",
          workspaceName: "General",
          operationId: crypto.randomUUID(),
        }),
      "42501",
    );
  }, 300_000);
});
