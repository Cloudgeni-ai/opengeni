import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL("../drizzle/0254_scoped_variable_set_authority.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type ActorScope = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

type VariableSetSummary = {
  id: string;
  name: string;
  scope: "organization" | "workspace" | "user";
};

async function withActorScope<T>(
  sql: postgres.Sql,
  scope: ActorScope,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${scope.accountId}, true),
      set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
      set_config('opengeni.subject_id', ${scope.subjectId}, true),
      set_config('opengeni.initiating_human_subject_id', ${scope.subjectId}, true)`;
    return await callback(tx);
  })) as T;
}

async function listScopedVariableSets(
  sql: postgres.Sql,
  scope: ActorScope,
): Promise<VariableSetSummary[]> {
  return await withActorScope(sql, scope, async (tx) => {
    const rows = await tx<Array<{ value: VariableSetSummary }>>`
      select value from list_scoped_variable_sets(
        ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, null, null, null
      ) value
    `;
    return rows.map((row) => row.value);
  });
}

describe("migration 0254 scoped variable-set authority", () => {
  test("is rolling, derives user ownership, and keeps authority tables capability-only", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("'organization', 'workspace', 'user'");
    expect(source).toContain("CREATE OR REPLACE FUNCTION %1$I.create_scoped_variable_set");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = %1$I, pg_catalog");
    expect(source).toContain("current_setting('opengeni.subject_id', true)");
    expect(source).toContain("membership.subject_id = caller_subject");
    expect(source).toContain("membership.status = 'active'");
    expect(source).toContain("membership.revoked_at IS NULL");
    expect(source).toContain("IF membership_id IS NULL THEN");
    expect(source).toContain("a NULL membership id can never match a user-owned");
    expect(source).toContain("workspace_membership.subject_id = caller_subject");
    expect(source).toContain("RETURN NULL;");
    expect(source).not.toMatch(/p_owner|owner_subject|p_membership/iu);
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app",
    );
    expect(source).toContain('ADD COLUMN "generation" bigint NOT NULL DEFAULT 1');
    expect(source).toContain("ADD COLUMN \"status\" text NOT NULL DEFAULT 'active'");
    expect(source).toContain("variable_set_authority_capabilities");
    expect(source).toContain("list_scoped_variable_sets");
    expect(source).toContain("mutate_scoped_variable_set");
    expect(source).toContain("read_scoped_variable_set_secret");
    expect(source).toContain("materialize_scoped_variable_set_for_attempt");
    expect(source).toContain("materialize_scoped_variable_set_for_session");
    expect(source).toContain("resolve_session_attempt_personal_resources");
    expect(source).toContain("variable_set.materialized");
    expect(source).toContain("metadata_codec_version");
    expect(source).toContain("'queued', 'running', 'requires_action'");
    expect(source).toContain(
      "DELETE FROM workspace_variable_sets\n        WHERE id = variable_set_row.id",
    );
    expect(source).toContain(
      "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_sets",
    );
    expect(source).toContain(
      "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_set_variables",
    );
    expect(source).not.toMatch(/value_encrypted[^\n]*audit_events/iu);
  });

  test("enforces organization and personal authority through restricted PostgreSQL capabilities", async () => {
    const blank = await acquireBlankTestDatabase("migration-0254-scoped-variable-set-authority");
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0254-scoped-variable-set-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    if (!blank) return;

    const appPassword = `app-${crypto.randomUUID()}`;
    let admin: postgres.Sql | undefined;
    let app: postgres.Sql | undefined;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(blank.databaseUrl);
      await provisionRoles(blank.databaseUrl, { appPassword, rlsStrategy: "force" });
      admin = postgres(blank.databaseUrl, {
        max: 4,
        prepare: false,
        onnotice: () => undefined,
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = appPassword;
      app = postgres(appUrl.toString(), {
        max: 2,
        prepare: false,
        onnotice: () => undefined,
      });
      db = createDb(blank.databaseUrl, { max: 1 });

      const ownerSubject = `human:${crypto.randomUUID()}`;
      const otherSubject = `human:${crypto.randomUUID()}`;
      const outsiderSubject = `human:${crypto.randomUUID()}`;
      const [account, outsideAccount] = await Promise.all([
        admin<Array<{ id: string }>>`
          insert into managed_accounts (name)
          values (${`scoped-variable-sets-${crypto.randomUUID()}`}) returning id
        `.then((rows) => rows[0]!),
        admin<Array<{ id: string }>>`
          insert into managed_accounts (name)
          values (${`outside-variable-sets-${crypto.randomUUID()}`}) returning id
        `.then((rows) => rows[0]!),
      ]);
      const [ownerPersonal, otherPersonal, workspaceA, workspaceB, outsidePersonal] =
        await Promise.all([
          admin<Array<{ id: string }>>`
            insert into workspaces (account_id, name)
            values (${account.id}, 'owner personal') returning id
          `.then((rows) => rows[0]!),
          admin<Array<{ id: string }>>`
            insert into workspaces (account_id, name)
            values (${account.id}, 'other personal') returning id
          `.then((rows) => rows[0]!),
          admin<Array<{ id: string }>>`
            insert into workspaces (account_id, name)
            values (${account.id}, 'workspace a') returning id
          `.then((rows) => rows[0]!),
          admin<Array<{ id: string }>>`
            insert into workspaces (account_id, name)
            values (${account.id}, 'workspace b') returning id
          `.then((rows) => rows[0]!),
          admin<Array<{ id: string }>>`
            insert into workspaces (account_id, name)
            values (${outsideAccount.id}, 'outside personal') returning id
          `.then((rows) => rows[0]!),
        ]);
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values
          (${ownerPersonal.id}, ${account.id}),
          (${otherPersonal.id}, ${account.id}),
          (${workspaceA.id}, ${account.id}),
          (${workspaceB.id}, ${account.id}),
          (${outsidePersonal.id}, ${outsideAccount.id})
      `;
      const [ownerMembership, otherMembership] = await Promise.all([
        admin<Array<{ id: string }>>`
          insert into organization_memberships (
            account_id, subject_id, status, personal_workspace_id, authorization_revision
          ) values (${account.id}, ${ownerSubject}, 'active', ${ownerPersonal.id}, 7)
          returning id
        `.then((rows) => rows[0]!),
        admin<Array<{ id: string }>>`
          insert into organization_memberships (
            account_id, subject_id, status, personal_workspace_id, authorization_revision
          ) values (${account.id}, ${otherSubject}, 'active', ${otherPersonal.id}, 3)
          returning id
        `.then((rows) => rows[0]!),
      ]);
      await admin`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id, authorization_revision
        ) values (
          ${outsideAccount.id}, ${outsiderSubject}, 'active', ${outsidePersonal.id}, 1
        )
      `;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values
          (${account.id}, ${workspaceA.id}, ${ownerSubject}),
          (${account.id}, ${workspaceB.id}, ${ownerSubject}),
          (${account.id}, ${workspaceA.id}, ${otherSubject}),
          (${account.id}, ${workspaceB.id}, ${otherSubject})
      `;

      const ownerWorkspaceA: ActorScope = {
        accountId: account.id,
        workspaceId: workspaceA.id,
        subjectId: ownerSubject,
      };
      const ownerWorkspaceB: ActorScope = {
        accountId: account.id,
        workspaceId: workspaceB.id,
        subjectId: ownerSubject,
      };
      const otherPersonalScope: ActorScope = {
        accountId: account.id,
        workspaceId: otherPersonal.id,
        subjectId: otherSubject,
      };
      const otherWorkspaceB: ActorScope = {
        accountId: account.id,
        workspaceId: workspaceB.id,
        subjectId: otherSubject,
      };
      const outsideScope: ActorScope = {
        accountId: outsideAccount.id,
        workspaceId: outsidePersonal.id,
        subjectId: outsiderSubject,
      };

      const createScoped = async (
        scope: ActorScope,
        authorityScope: "organization" | "user",
        name: string,
        allowOrganization: boolean,
      ) =>
        await withActorScope(app!, scope, async (tx) => {
          const [created] = await tx<
            Array<{ variableSetId: string; authorityScope: string; generation: number }>
          >`
            select variable_set_id as "variableSetId",
              authority_scope as "authorityScope", generation
            from create_scoped_variable_set(
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
              ${authorityScope}, ${name}, null,
              ${tx.json([{ name: "TOKEN", valueEncrypted: `ciphertext:${name}` }])}::jsonb,
              ${allowOrganization}
            )
          `;
          return created!;
        });

      await expect(
        createScoped(ownerWorkspaceA, "organization", "org-denied", false),
      ).rejects.toThrow(/requires account authority/iu);
      const organizationSet = await createScoped(
        ownerWorkspaceA,
        "organization",
        "organization shared",
        true,
      );
      const ownerSet = await createScoped(ownerWorkspaceA, "user", "owner personal set", false);
      const otherSet = await createScoped(otherPersonalScope, "user", "other personal set", false);
      await createScoped(outsideScope, "organization", "outside organization", true);

      for (const scope of [ownerWorkspaceA, ownerWorkspaceB]) {
        expect((await listScopedVariableSets(app, scope)).map((row) => row.name)).toEqual([
          "owner personal set",
          "organization shared",
        ]);
      }
      expect((await listScopedVariableSets(app, otherWorkspaceB)).map((row) => row.name)).toEqual([
        "other personal set",
        "organization shared",
      ]);
      expect((await listScopedVariableSets(app, outsideScope)).map((row) => row.name)).toEqual([
        "outside organization",
      ]);
      await expect(
        withActorScope(
          app,
          ownerWorkspaceA,
          async (tx) =>
            await tx`select value from list_scoped_variable_sets(
            ${outsideAccount.id}::uuid, ${outsidePersonal.id}::uuid, null, null, null
          ) value`,
        ),
      ).rejects.toThrow(/scope mismatch/iu);

      const mutate = async (
        scope: ActorScope,
        variableSetId: string,
        name: string,
        allowOrganization: boolean,
      ) =>
        await withActorScope(app!, scope, async (tx) => {
          const [result] = await tx<Array<{ value: { variableSet: VariableSetSummary | null } }>>`
            select mutate_scoped_variable_set(
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid,
              ${variableSetId}::uuid, 'update', ${name}, true,
              null, false, null, null, ${allowOrganization}
            ) as value
          `;
          return result!.value;
        });
      await expect(
        mutate(ownerWorkspaceB, organizationSet.variableSetId, "org not admin", false),
      ).rejects.toThrow(/query returned no rows|requires account authority/iu);
      expect(
        (await mutate(ownerWorkspaceB, organizationSet.variableSetId, "organization renamed", true))
          .variableSet?.name,
      ).toBe("organization renamed");
      await expect(
        mutate(otherWorkspaceB, ownerSet.variableSetId, "other user mutation", false),
      ).rejects.toThrow(/query returned no rows/iu);
      expect(otherSet.authorityScope).toBe("user");

      const [ownerAuthority] = await admin<
        Array<{ authorityId: string; authorityGeneration: number; authorityStatus: string }>
      >`
        select id as "authorityId", generation::int as "authorityGeneration",
          status as "authorityStatus"
        from organization_user_resource_authorities
        where account_id = ${account.id} and resource_kind = 'variable_set'
          and resource_id = ${ownerSet.variableSetId}
      `;
      expect(ownerAuthority).toMatchObject({
        authorityGeneration: 1,
        authorityStatus: "active",
      });
      const ownerAuthorityView = await withActorScope(
        app,
        ownerWorkspaceB,
        async (tx) =>
          await tx<
            Array<{
              authorityId: string;
              authorityGeneration: number;
              authorityStatus: string;
              grantId: string | null;
            }>
          >`
          select authority_id as "authorityId",
            authority_generation::int as "authorityGeneration",
            authority_status as "authorityStatus", grant_id as "grantId"
          from list_self_user_resource_authorities(${account.id}::uuid)
        `,
      );
      expect(
        ownerAuthorityView.find((row) => row.authorityId === ownerAuthority!.authorityId),
      ).toEqual({
        authorityId: ownerAuthority!.authorityId,
        authorityGeneration: 1,
        authorityStatus: "active",
        grantId: null,
      });

      const prepareAttempt = async (label: string) => {
        const session = await createSession(db!.db, {
          requestedSessionId: crypto.randomUUID(),
          accountId: account.id,
          workspaceId: workspaceB.id,
          initialMessage: label,
          resources: [],
          metadata: {},
          createdBy: { kind: "subject", subjectId: ownerSubject },
          subjectId: ownerSubject,
          model: "test-model",
          sandboxBackend: "modal",
          variableSetId: ownerSet.variableSetId,
          firstPartyMcpTools: [],
        });
        const [sessionAuthority] = await admin!<
          Array<{
            visibility: "user_private" | "workspace_shared";
            authorityEpoch: number;
            ownerMembershipId: string | null;
          }>
        >`
          select visibility, authority_epoch as "authorityEpoch",
            owner_organization_membership_id as "ownerMembershipId"
          from sessions
          where account_id = ${account.id} and workspace_id = ${workspaceB.id}
            and id = ${session.id}
        `;
        expect(sessionAuthority).toEqual({
          visibility: "workspace_shared",
          authorityEpoch: 1,
          ownerMembershipId: ownerMembership.id,
        });
        const [grant] = await withActorScope(
          app!,
          ownerWorkspaceB,
          async (tx) =>
            await tx<Array<{ grantId: string; grantGeneration: number; grantStatus: string }>>`
            select grant_id as "grantId", grant_generation::int as "grantGeneration",
              grant_status as "grantStatus"
            from issue_self_user_resource_grant(
              ${account.id}::uuid, ${ownerAuthority!.authorityId}::uuid,
              ${workspaceB.id}::uuid, 'variable_set.use', 'session',
              'workspace_shared', ${session.id}::uuid, true
            )
          `,
        );
        const [turn] = await admin!<Array<{ id: string }>>`
          insert into session_turns (
            account_id, workspace_id, session_id, trigger_event_id,
            temporal_workflow_id, status, position, prompt, model,
            reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
            initiator_subject_id, initiating_human_subject_id
          ) values (
            ${account.id}, ${workspaceB.id}, ${session.id}, ${crypto.randomUUID()},
            ${`workflow-${label}`}, 'running', 1, ${label}, 'test-model',
            'medium', 'standard', 'modal', 'subject', ${ownerSubject}, ${ownerSubject}
          ) returning id
        `;
        const attemptId = crypto.randomUUID();
        await admin!.begin(async (tx) => {
          await tx.unsafe("set local opengeni.session_inference_claim = '1'");
          await tx`
            update sessions set active_turn_id = ${turn!.id}, status = 'running'
            where account_id = ${account.id} and workspace_id = ${workspaceB.id}
              and id = ${session.id}
          `;
          await tx`
            update session_turns set active_attempt_id = ${attemptId},
              execution_generation = 1, status = 'running'
            where account_id = ${account.id} and workspace_id = ${workspaceB.id}
              and session_id = ${session.id} and id = ${turn!.id}
          `;
          await tx`
            insert into session_turn_attempts (
              id, account_id, workspace_id, session_id, turn_id, execution_generation,
              temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
              verified_control_revision, authority_epoch, authority_visibility,
              authority_owner_organization_membership_id, mcp_approval_policies,
              connector_action_policies
            ) values (
              ${attemptId}, ${account.id}, ${workspaceB.id}, ${session.id}, ${turn!.id}, 1,
              ${`workflow-${label}`}, ${`run-${label}`}, ${`activity-${label}`},
              1, ${sessionAuthority!.authorityEpoch}, ${sessionAuthority!.visibility},
              ${sessionAuthority!.ownerMembershipId},
              '{}'::jsonb, '[]'::jsonb
            )
          `;
        });
        return { sessionId: session.id, turnId: turn!.id, attemptId, grant: grant! };
      };

      const materialize = async (attempt: {
        sessionId: string;
        turnId: string;
        attemptId: string;
      }) =>
        await withActorScope(app!, ownerWorkspaceB, async (tx) =>
          Array.from(
            await tx<
              Array<{
                variableSetId: string;
                authorityScope: string;
                variableName: string;
                valueEncrypted: string;
              }>
            >`
                select variable_set_id as "variableSetId",
                  authority_scope as "authorityScope", variable_name as "variableName",
                  value_encrypted as "valueEncrypted"
                from materialize_scoped_variable_set_for_attempt(
                  ${account.id}::uuid, ${workspaceB.id}::uuid,
                  ${attempt.sessionId}::uuid, ${attempt.turnId}::uuid,
                  ${attempt.attemptId}::uuid, 1, ${ownerSet.variableSetId}::uuid
                )
              `,
          ),
        );

      const staleAttempt = await prepareAttempt("stale-grant");
      expect(await materialize(staleAttempt)).toEqual([
        {
          variableSetId: ownerSet.variableSetId,
          authorityScope: "user",
          variableName: "TOKEN",
          valueEncrypted: "ciphertext:owner personal set",
        },
      ]);
      await admin`
        update organization_user_resource_grants
        set generation = generation + 1, updated_at = clock_timestamp()
        where id = ${staleAttempt.grant.grantId}
      `;
      await expect(materialize(staleAttempt)).rejects.toThrow(/snapshot is no longer live/iu);

      const revokedAttempt = await prepareAttempt("revoked-grant");
      expect(await materialize(revokedAttempt)).toHaveLength(1);
      await withActorScope(app, ownerWorkspaceB, async (tx) => {
        const [revoked] = await tx<Array<{ grantStatus: string; grantGeneration: number }>>`
          select grant_status as "grantStatus", grant_generation::int as "grantGeneration"
          from revoke_self_user_resource_grant(
            ${account.id}::uuid, ${revokedAttempt.grant.grantId}::uuid
          )
        `;
        expect(revoked).toEqual({ grantStatus: "revoked", grantGeneration: 2 });
      });
      await expect(materialize(revokedAttempt)).rejects.toThrow(/snapshot is no longer live/iu);

      const deleteSet = await createScoped(ownerWorkspaceA, "user", "delete personal set", false);
      const [deleteAuthority] = await admin<
        Array<{ authorityId: string; authorityStatus: string }>
      >`
        select id as "authorityId", status as "authorityStatus"
        from organization_user_resource_authorities
        where account_id = ${account.id} and resource_kind = 'variable_set'
          and resource_id = ${deleteSet.variableSetId}
      `;
      expect(deleteAuthority).toMatchObject({ authorityStatus: "active" });
      const [deleteGrant] = await withActorScope(
        app,
        ownerWorkspaceB,
        async (tx) =>
          await tx<Array<{ grantId: string }>>`
          select grant_id as "grantId"
          from issue_self_user_resource_grant(
            ${account.id}::uuid, ${deleteAuthority!.authorityId}::uuid,
            ${workspaceB.id}::uuid, 'variable_set.use', 'always',
            'workspace_shared', null, true
          )
        `,
      );
      await expect(
        withActorScope(
          app,
          otherWorkspaceB,
          async (tx) =>
            await tx`select mutate_scoped_variable_set(
            ${account.id}::uuid, ${workspaceB.id}::uuid, ${deleteSet.variableSetId}::uuid,
            'revoke', null, false, null, false, null, null, false
          )`,
        ),
      ).rejects.toThrow(/query returned no rows/iu);
      const [deleted] = await withActorScope(
        app,
        ownerWorkspaceB,
        async (tx) =>
          await tx<Array<{ value: { variableSet: null } }>>`
          select mutate_scoped_variable_set(
            ${account.id}::uuid, ${workspaceB.id}::uuid, ${deleteSet.variableSetId}::uuid,
            'revoke', null, false, null, false, null, null, false
          ) as value
        `,
      );
      expect(deleted!.value.variableSet).toBeNull();
      expect(
        (await listScopedVariableSets(app, ownerWorkspaceB)).some(
          (row) => row.id === deleteSet.variableSetId,
        ),
      ).toBe(false);
      const deletionEvidence = await withActorScope(
        app,
        ownerWorkspaceB,
        async (tx) =>
          await tx<
            Array<{
              authorityId: string;
              authorityGeneration: number;
              authorityStatus: string;
              grantId: string | null;
              grantGeneration: number | null;
              grantStatus: string | null;
            }>
          >`
          select authority_id as "authorityId",
            authority_generation::int as "authorityGeneration",
            authority_status as "authorityStatus", grant_id as "grantId",
            grant_generation::int as "grantGeneration", grant_status as "grantStatus"
          from list_self_user_resource_authorities(${account.id}::uuid)
        `,
      );
      expect(
        deletionEvidence.find(
          (row) =>
            row.authorityId === deleteAuthority!.authorityId &&
            row.grantId === deleteGrant!.grantId,
        ),
      ).toMatchObject({
        authorityId: deleteAuthority!.authorityId,
        authorityGeneration: 2,
        authorityStatus: "revoked",
        grantGeneration: 2,
        grantStatus: "revoked",
      });
      expect(ownerMembership.id).not.toBe(otherMembership.id);
    } finally {
      await db?.close().catch(() => undefined);
      await app?.end({ timeout: 5 }).catch(() => undefined);
      await admin?.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 300_000);
});
