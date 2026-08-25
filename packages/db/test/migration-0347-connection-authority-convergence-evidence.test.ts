import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  backfillOrganizationConnectionAuthority,
  createDb,
  drainOrganizationMembershipBackfill,
  inspectOrganizationConnectionAuthorityConvergence,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;

function nestedErrorMessages(error: unknown): string {
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 8) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as { cause?: unknown; message?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    if (record.cause !== undefined) queue.push(record.cause);
  }
  return messages.join("\n");
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("connection-authority-convergence-0347");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("connection convergence real PostgreSQL fixture is unavailable");
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
  appClient = createDb(appUrl.toString(), { max: 3, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await appClient?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

async function insertLegacyConnection(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  provider: string;
}): Promise<string> {
  if (!owned) throw new Error("database fixture missing");
  const [connection] = await owned.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${input.accountId}, true),
      set_config('opengeni.workspace_id', ${input.workspaceId}, true),
      set_config('opengeni.subject_id', ${input.subjectId}, true)`;
    return await tx<Array<{ id: string }>>`
      insert into connections (
        account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, authority_scope
      ) values (
        ${input.accountId}, ${input.workspaceId}, ${input.subjectId}, ${input.provider},
        'api_key', 'x', 'legacy_user'
      ) returning id`;
  });
  if (!connection) throw new Error("connection fixture missing");
  return connection.id;
}

describe("migration 0347 connection authority convergence evidence", () => {
  test("uses global completion across pages and remediates only deterministic membership proof", async () => {
    if (!owned || !appClient) return;
    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    const externalSubject = `configured:${crypto.randomUUID()}`;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    await owned.admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'Connection convergence', 'better-auth:user', ${userId})`;
    await owned.admin`
      insert into auth_users (id, name, email)
      values (${userId}, 'Connection convergence owner', ${`${userId}@example.test`})`;
    await owned.admin`
      insert into workspaces (id, account_id, name)
      values (${workspaceId}, ${accountId}, 'Connection convergence shared')`;
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}, ${accountId})`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'owner')`;
    const eligibleConnectionId = await insertLegacyConnection({
      accountId,
      workspaceId,
      subjectId,
      provider: "eligible.example",
    });
    const externalConnectionId = await insertLegacyConnection({
      accountId,
      workspaceId,
      subjectId: externalSubject,
      provider: "external.example",
    });

    const firstPage = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      returned: 1,
      hasMore: true,
      remaining: { total: 2, autoRemediable: 1, manualReview: 1 },
    });
    expect(firstPage.nextCursor).toBeString();
    const secondPage = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
      limit: 1,
      afterConnectionId: firstPage.nextCursor,
    });
    expect(secondPage).toMatchObject({
      returned: 1,
      hasMore: false,
      nextCursor: null,
      remaining: { total: 2 },
    });

    const all = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
      limit: 100,
    });
    expect(all.items).toHaveLength(2);
    expect(all.items.find((item) => item.connectionId === eligibleConnectionId)).toMatchObject({
      subjectId,
      classification: "membership_backfill_eligible",
      action: "run_membership_backfill_then_connection_backfill",
    });
    expect(all.items.find((item) => item.connectionId === externalConnectionId)).toMatchObject({
      subjectId: externalSubject,
      classification: "external_subject_requires_classification",
      action: "classify_external_subject_then_migrate_via_authorized_connection_lifecycle",
    });

    const afterLastResidual = await inspectOrganizationConnectionAuthorityConvergence(
      appClient.db,
      {
        organizationId: accountId,
        limit: 1,
        afterConnectionId: all.items.at(-1)!.connectionId,
      },
    );
    expect(afterLastResidual).toMatchObject({
      items: [],
      returned: 0,
      hasMore: false,
      remaining: { total: 2 },
    });

    const otherAccountId = crypto.randomUUID();
    const otherWorkspaceId = crypto.randomUUID();
    await owned.admin`
      insert into managed_accounts (id, name) values (${otherAccountId}, 'other account')`;
    await owned.admin`
      insert into workspaces (id, account_id, name)
      values (${otherWorkspaceId}, ${otherAccountId}, 'other workspace')`;
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${otherWorkspaceId}, ${otherAccountId})`;
    const otherConnectionId = await insertLegacyConnection({
      accountId: otherAccountId,
      workspaceId: otherWorkspaceId,
      subjectId: `configured:${crypto.randomUUID()}`,
      provider: "other.example",
    });
    const foreignCursorError = await inspectOrganizationConnectionAuthorityConvergence(
      appClient.db,
      {
        organizationId: accountId,
        afterConnectionId: otherConnectionId,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(nestedErrorMessages(foreignCursorError)).toMatch(/cursor is invalid/iu);

    const visible = await withRlsContext(
      appClient.db,
      { accountId, workspaceId },
      async (db) =>
        await rawRows<{ count: number }>(
          db,
          sql`select count(*)::int as count from connections where account_id = ${accountId}`,
        ),
    );
    // No subject GUC is present, so ordinary application visibility is empty.
    // Reaching a result (rather than 42501 on the new policy predicate) proves
    // the migrate-then-provision EXECUTE convergence for normal reads.
    expect(visible).toEqual([{ count: 0 }]);

    const membership = await drainOrganizationMembershipBackfill(appClient.db, {
      organizationId: accountId,
      limit: 25,
      dryRun: false,
      runKey: `connection-membership-${crypto.randomUUID()}`,
    });
    expect(membership).toMatchObject({ drained: true, receiptStatus: "completed" });
    expect(membership.counts.provisioned).toBe(1);
    const repaired = await backfillOrganizationConnectionAuthority(appClient.db, {
      organizationId: accountId,
      limit: 100,
      dryRun: false,
    });
    expect(repaired.upgraded).toBe(1);

    const after = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
      limit: 100,
    });
    expect(after).toMatchObject({
      remaining: { total: 1, autoRemediable: 0, manualReview: 1 },
    });
    expect(after.items).toEqual([
      expect.objectContaining({
        connectionId: externalConnectionId,
        classification: "external_subject_requires_classification",
      }),
    ]);
    const [eligible] = await owned.admin<
      Array<{ scope: string; membershipId: string | null }>
    >`select authority_scope as scope,
        owner_organization_membership_id as "membershipId"
      from connections where id = ${eligibleConnectionId}`;
    expect(eligible?.scope).toBe("user");
    expect(eligible?.membershipId).toBeString();

    // Model retained corruption without teaching the repair surface a generic
    // authority rewrite: invalidating the backing authority makes the `user`
    // connection non-terminal, and the inspector must route it to incident
    // repair rather than either automated backfill.
    await owned.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update organization_user_resource_authorities
        set status = 'revoked', revoked_at = now()
        where resource_kind = 'connection' and resource_id = ${eligibleConnectionId}`;
    });
    const conflicting = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
      limit: 100,
    });
    expect(
      conflicting.items.find((item) => item.connectionId === eligibleConnectionId),
    ).toMatchObject({
      classification: "conflicting_authority_rows",
      action: "repair_conflicting_connection_authority_rows_under_incident_procedure",
    });

    const [capabilities] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from connection_authority_convergence_audit_capabilities`;
    expect(capabilities).toEqual({ count: 0 });
    const directCapabilityError = await appClient.db
      .execute(
        sql`insert into connection_authority_convergence_audit_capabilities (
          capability_id, backend_pid, transaction_id, account_id
        ) values (
          ${crypto.randomUUID()}::uuid, pg_backend_pid(), pg_current_xact_id(),
          ${accountId}::uuid
        )`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(nestedErrorMessages(directCapabilityError)).toMatch(/permission denied/iu);

    const previousToken = crypto.randomUUID();
    const restoredToken = await appClient.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.account_id', ${accountId}, true),
          set_config(
            'opengeni.connection_authority_convergence_audit_token',
            ${previousToken},
            true
          )`,
      );
      await tx.execute(
        sql`select inspect_organization_connection_authority_convergence(
          ${accountId}::uuid, 1::integer, null::uuid
        )`,
      );
      return await rawRows<{ token: string }>(
        tx,
        sql`select current_setting(
          'opengeni.connection_authority_convergence_audit_token', true
        ) as token`,
      );
    });
    expect(restoredToken).toEqual([{ token: previousToken }]);
  }, 900_000);

  test("classifies failed membership prerequisites and never reactivates terminal membership", async () => {
    if (!owned || !appClient) return;

    const cases = [
      {
        classification: "missing_login_identity",
        action: "restore_login_identity_then_recheck",
        login: false,
        accountMatches: true,
        ownerAccess: true,
      },
      {
        classification: "organization_identity_mismatch",
        action: "correct_organization_identity_through_supported_account_lifecycle_then_recheck",
        login: true,
        accountMatches: false,
        ownerAccess: true,
      },
      {
        classification: "missing_owner_workspace_membership",
        action:
          "establish_owner_workspace_membership_through_supported_membership_lifecycle_then_recheck",
        login: true,
        accountMatches: true,
        ownerAccess: false,
      },
    ] as const;

    for (const fixture of cases) {
      const userId = crypto.randomUUID();
      const accountId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const subjectId = `user:${userId}`;
      await owned.admin`
        insert into managed_accounts (id, name, external_source, external_id)
        values (
          ${accountId}, ${fixture.classification}, 'better-auth:user',
          ${fixture.accountMatches ? userId : crypto.randomUUID()}
        )`;
      if (fixture.login) {
        await owned.admin`
          insert into auth_users (id, name, email)
          values (${userId}, ${fixture.classification}, ${`${userId}@example.test`})`;
      }
      await owned.admin`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, ${fixture.classification})`;
      await owned.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await owned.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (
          ${accountId}, ${workspaceId}, ${subjectId},
          ${fixture.ownerAccess ? "owner" : "member"}
        )`;
      await insertLegacyConnection({
        accountId,
        workspaceId,
        subjectId,
        provider: `${fixture.classification}.example`,
      });
      const report = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
        organizationId: accountId,
      });
      expect(report.items).toEqual([
        expect.objectContaining({
          subjectId,
          classification: fixture.classification,
          action: fixture.action,
        }),
      ]);
      expect(report.remaining).toMatchObject({ total: 1, autoRemediable: 0, manualReview: 1 });
    }

    const userId = crypto.randomUUID();
    const subjectId = `user:${userId}`;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    await owned.admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'terminal membership', 'better-auth:user', ${userId})`;
    await owned.admin`
      insert into auth_users (id, name, email)
      values (${userId}, 'terminal owner', ${`${userId}@example.test`})`;
    await owned.admin`
      insert into workspaces (id, account_id, name)
      values (${workspaceId}, ${accountId}, 'terminal workspace')`;
    await owned.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}, ${accountId})`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}, ${workspaceId}, ${subjectId}, 'owner')`;
    await owned.admin`
      insert into organization_memberships (account_id, subject_id, status)
      values (${accountId}, ${subjectId}, 'suspended')`;
    const terminalConnectionId = await insertLegacyConnection({
      accountId,
      workspaceId,
      subjectId,
      provider: "terminal.example",
    });
    const terminalBefore = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
    });
    expect(terminalBefore.items).toEqual([
      expect.objectContaining({
        connectionId: terminalConnectionId,
        classification: "membership_lifecycle_review_required",
        action: "review_membership_lifecycle_do_not_reactivate_automatically",
      }),
    ]);

    const remediation = await drainOrganizationMembershipBackfill(appClient.db, {
      organizationId: accountId,
      limit: 25,
      dryRun: false,
      runKey: `connection-terminal-${crypto.randomUUID()}`,
    });
    expect(remediation.counts.unresolved).toBeGreaterThanOrEqual(1);
    expect(remediation.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId, reasonCode: "membership_terminal_status" }),
      ]),
    );
    const [membership] = await owned.admin<Array<{ status: string; revokedAt: Date | null }>>`
      select status, revoked_at as "revokedAt"
      from organization_memberships
      where account_id = ${accountId} and subject_id = ${subjectId}`;
    expect(membership).toEqual({ status: "suspended", revokedAt: null });
    const terminalAfter = await inspectOrganizationConnectionAuthorityConvergence(appClient.db, {
      organizationId: accountId,
    });
    expect(terminalAfter.items[0]?.classification).toBe("membership_lifecycle_review_required");
  }, 900_000);

  test("fails closed when the real database is required", () => {
    expect(requireRealDatabase || owned !== null).toBe(true);
  });
});
