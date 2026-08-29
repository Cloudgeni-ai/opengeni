import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, createSession } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0262_scoped_connected_machines_and_rigs.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type Actor = { accountId: string; workspaceId: string; subjectId: string };

async function asActor<T>(
  sql: postgres.Sql,
  actor: Actor,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${actor.accountId}, true),
      set_config('opengeni.workspace_id', ${actor.workspaceId}, true),
      set_config('opengeni.subject_id', ${actor.subjectId}, true),
      set_config('opengeni.initiating_human_subject_id', ${actor.subjectId}, true)`;
    return await callback(tx);
  })) as T;
}

describe("migration 0262 scoped Connected Machines and Rigs", () => {
  test("declares explicit scope, exact-attempt admission, and pre-use revalidation", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("'organization', 'workspace', 'user'");
    expect(source).toContain("connected_machine.use");
    expect(source).toContain("session_attempt_connected_machine_authorizations");
    expect(source).toContain("resolve_session_attempt_personal_resources");
    expect(source).toContain("authorize_session_attempt_personal_machine");
    expect(source).toContain("assert_session_attempt_personal_machine");
    expect(source).toContain("scoped_compute_policy_capability_active");
    expect(source).toContain("p_require_active_sandbox boolean");
    expect(source).toContain("membership.authorization_revision");
    expect(source).toContain("grant_value.generation = authorization_row.grant_generation");
    expect(source).toContain("session_value.authority_epoch");
    expect(source).toContain("personal_resource_once_consumption_receipts");
    expect(source).toContain("connected_machine.used");
  });

  test("enforces organization, workspace, and owner visibility through PostgreSQL", async () => {
    const blank = await acquireBlankTestDatabase("migration-0262-scoped-compute");
    if (!blank && requireRealDatabase) {
      throw new Error("[migration-0262-scoped-compute] PostgreSQL is unavailable");
    }
    if (!blank) return;

    const appPassword = blank.appPassword;
    if (!appPassword) throw new Error("shared PostgreSQL app password is unavailable");
    let admin: postgres.Sql | undefined;
    let app: postgres.Sql | undefined;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(blank.databaseUrl);
      await provisionRoles(blank.databaseUrl, {
        appPassword,
        rlsStrategy: "force",
      });
      admin = postgres(blank.databaseUrl, {
        max: 2,
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
      const [account] = await admin<Array<{ id: string }>>`
        insert into managed_accounts (name) values (${`scope-${crypto.randomUUID()}`}) returning id
      `;
      const workspaceRows = await Promise.all(
        ["personal", "other personal", "workspace a", "workspace b"].map(async (name) => {
          const [row] = await admin!<Array<{ id: string }>>`
            insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id
          `;
          return row!;
        }),
      );
      const personal = workspaceRows[0]!;
      const otherPersonal = workspaceRows[1]!;
      const workspaceA = workspaceRows[2]!;
      const workspaceB = workspaceRows[3]!;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id) values
          (${personal.id}, ${account!.id}), (${otherPersonal.id}, ${account!.id}),
          (${workspaceA.id}, ${account!.id}), (${workspaceB.id}, ${account!.id})
      `;
      const [ownerMembership] = await admin<Array<{ id: string }>>`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id, authorization_revision
        ) values (${account!.id}, ${ownerSubject}, 'active', ${personal.id}, 4) returning id
      `;
      await admin`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id, authorization_revision
        ) values (${account!.id}, ${otherSubject}, 'active', ${otherPersonal.id}, 2)
      `;
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id) values
          (${account!.id}, ${workspaceA.id}, ${ownerSubject}),
          (${account!.id}, ${workspaceB.id}, ${ownerSubject}),
          (${account!.id}, ${workspaceA.id}, ${otherSubject}),
          (${account!.id}, ${workspaceB.id}, ${otherSubject})
      `;
      await admin`
        insert into session_tenancy_activations (
          account_id, activation_version, inventory_digest, parity_digest, activated_by
        ) values (${account!.id}, 1, ${"9".repeat(64)}, ${"a".repeat(64)}, '0262-test')
      `;

      const ownerA: Actor = {
        accountId: account!.id,
        workspaceId: workspaceA.id,
        subjectId: ownerSubject,
      };
      const ownerB = { ...ownerA, workspaceId: workspaceB.id };
      const otherB = { ...ownerB, subjectId: otherSubject };
      const createRig = async (scope: "organization" | "workspace" | "user", allowOrg: boolean) =>
        await asActor(app!, ownerA, async (tx) => {
          const [row] = await tx<
            Array<{
              value: { id: string; scope: string; activeVersion: { id: string } };
            }>
          >`
            select create_scoped_rig(
              ${ownerA.accountId}::uuid, ${ownerA.workspaceId}::uuid, ${scope},
              ${`${scope} rig`}, null, ${ownerSubject},
              ${tx.json({ checks: [], credentialHooks: [], defaultVariableSetIds: [] })}::jsonb,
              ${allowOrg}
            ) as value
          `;
          return row!.value;
        });
      await expect(createRig("organization", false)).rejects.toThrow(/account authority/iu);
      const organizationRig = await createRig("organization", true);
      await createRig("workspace", false);
      const personalRig = await createRig("user", false);

      const rigNames = async (actor: Actor) =>
        await asActor(app!, actor, async (tx) => {
          const rows = await tx<Array<{ value: { name: string } }>>`
            select value from list_scoped_rigs(
              ${actor.accountId}::uuid, ${actor.workspaceId}::uuid, null, null, null
            ) value
          `;
          return rows.map((row) => row.value.name);
        });
      expect(await rigNames(ownerB)).toEqual(["user rig", "organization rig"]);
      expect(await rigNames(otherB)).toEqual(["organization rig"]);
      expect(organizationRig.scope).toBe("organization");
      expect(personalRig.scope).toBe("user");

      const verificationFinishedAt = "2026-08-29T18:16:46.181Z";
      await admin`
        insert into audit_events (
          account_id, workspace_id, subject_id, action, target_type, target_id,
          metadata, occurred_at
        ) values (
          ${ownerA.accountId}, ${ownerA.workspaceId}, 'system:rig-verification',
          'rig.verification.passed', 'rig', ${organizationRig.id},
          ${admin.json({
            rigId: organizationRig.id,
            versionId: organizationRig.activeVersion.id,
            finishedAt: verificationFinishedAt,
            passed: true,
          })}::jsonb,
          ${verificationFinishedAt}::timestamptz
        )
      `;
      const organizationRigHealth = await asActor(app, ownerB, async (tx) => {
        const [row] = await tx<
          Array<{
            value: {
              activeVersionHealth: { checkHealth: string; lastVerifiedAt: string | null };
            };
          }>
        >`
          select value from list_scoped_rigs(
            ${ownerB.accountId}::uuid, ${ownerB.workspaceId}::uuid,
            ${organizationRig.id}::uuid, null, null
          ) value
        `;
        return row!.value.activeVersionHealth;
      });
      expect(organizationRigHealth.checkHealth).toBe("passing");
      expect(new Date(organizationRigHealth.lastVerifiedAt!).toISOString()).toBe(
        verificationFinishedAt,
      );

      const machine = await asActor(app, ownerA, async (tx) => {
        const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
          select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
          from finalize_scoped_enrollment(
            ${ownerA.accountId}::uuid, ${ownerA.workspaceId}::uuid, 'user',
            ${`pubkey-${crypto.randomUUID()}`}, true, false, 'macos', 'arm64',
            'Owner machine', false
          )
        `;
        return row!;
      });
      const sideMachine = await asActor(app, ownerA, async (tx) => {
        const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
          select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
          from finalize_scoped_enrollment(
            ${ownerA.accountId}::uuid, ${ownerA.workspaceId}::uuid, 'user',
            ${`side-pubkey-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64',
            'Owner side machine', false
          )
        `;
        return row!;
      });
      const listMachines = async (actor: Actor) =>
        await asActor(
          app!,
          actor,
          async (tx) =>
            await tx<Array<{ value: { id: string } }>>`
            select value from list_scoped_enrollments(
              ${actor.accountId}::uuid, ${actor.workspaceId}::uuid, null, 'active'
            ) value
          `,
        );
      expect(new Set((await listMachines(ownerB)).map((row) => row.value.id))).toEqual(
        new Set([machine.enrollmentId, sideMachine.enrollmentId]),
      );
      expect(await listMachines(otherB)).toHaveLength(0);
      expect(
        await asActor(app, ownerB, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select authorize_scoped_sandbox_attach(
              ${ownerB.accountId}::uuid, ${ownerB.workspaceId}::uuid,
              ${machine.sandboxId}::uuid
            ) as allowed
          `;
          return row!.allowed;
        }),
      ).toBe(true);

      const [machineAuthority] = await admin<Array<{ id: string }>>`
        select id from organization_user_resource_authorities
        where account_id = ${account!.id} and organization_membership_id = ${ownerMembership!.id}
          and resource_kind = 'connected_machine' and resource_id = ${machine.enrollmentId}
      `;
      const [sideMachineAuthority] = await admin<Array<{ id: string }>>`
        select id from organization_user_resource_authorities
        where account_id = ${account!.id} and organization_membership_id = ${ownerMembership!.id}
          and resource_kind = 'connected_machine' and resource_id = ${sideMachine.enrollmentId}
      `;
      const session = await createSession(db.db, {
        requestedSessionId: crypto.randomUUID(),
        accountId: account!.id,
        workspaceId: workspaceB.id,
        initialMessage: "use my personal connected machine",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: ownerSubject },
        subjectId: ownerSubject,
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "selfhosted",
        firstPartyMcpTools: [],
      });
      await admin`
        update sessions set active_sandbox_id = ${machine.sandboxId}
        where account_id = ${account!.id} and workspace_id = ${workspaceB.id}
          and id = ${session.id}
      `;
      const [sessionAuthority] = await admin<
        Array<{
          authorityEpoch: number;
          ownerMembershipId: string | null;
          visibility: "user_private" | "workspace_shared";
        }>
      >`
        select authority_epoch as "authorityEpoch",
          owner_organization_membership_id as "ownerMembershipId", visibility
        from sessions where id = ${session.id}
      `;
      expect(sessionAuthority).toEqual({
        authorityEpoch: 1,
        ownerMembershipId: ownerMembership!.id,
        visibility: "workspace_shared",
      });
      await asActor(app, ownerB, async (tx) => {
        await tx`
          select grant_id from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${machineAuthority!.id}::uuid,
            ${workspaceB.id}::uuid, 'connected_machine', 'session',
            'workspace_shared', ${session.id}::uuid, 1, true
          )
        `;
      });
      const [turn] = await admin<Array<{ id: string }>>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
          initiator_subject_id, initiating_human_subject_id
        ) values (
          ${account!.id}, ${workspaceB.id}, ${session.id}, ${crypto.randomUUID()},
          'machine-workflow', 'running', 1, 'use machine', 'test-model',
          'medium', 'standard', 'selfhosted', 'subject', ${ownerSubject}, ${ownerSubject}
        ) returning id
      `;
      const attemptId = crypto.randomUUID();
      await admin.begin(async (tx) => {
        await tx.unsafe("set local opengeni.session_inference_claim = '1'");
        await tx`
          update sessions set active_turn_id = ${turn!.id}, status = 'running'
          where account_id = ${account!.id} and workspace_id = ${workspaceB.id}
            and id = ${session.id}
        `;
        await tx`
          update session_turns set active_attempt_id = ${attemptId},
            execution_generation = 1, status = 'running'
          where account_id = ${account!.id} and workspace_id = ${workspaceB.id}
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
            ${attemptId}, ${account!.id}, ${workspaceB.id}, ${session.id}, ${turn!.id}, 1,
            'machine-workflow', 'machine-run', 'machine-activity', 1,
            ${sessionAuthority!.authorityEpoch}, ${sessionAuthority!.visibility},
            ${sessionAuthority!.ownerMembershipId}, '{}'::jsonb, '[]'::jsonb
          )
        `;
      });
      const [attemptAuthorization] = await admin<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId"
        from session_attempt_connected_machine_authorizations
        where attempt_id = ${attemptId}
      `;
      expect(attemptAuthorization).toEqual({
        enrollmentId: machine.enrollmentId,
      });
      expect(
        await asActor(app, ownerB, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select assert_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${attemptId}::uuid, 1,
              ${machine.enrollmentId}::uuid, true
            ) as allowed
          `;
          return row!.allowed;
        }),
      ).toBe(true);
      expect(
        await asActor(app, ownerB, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select assert_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${crypto.randomUUID()}::uuid, 1,
              ${machine.enrollmentId}::uuid, true
            ) as allowed
          `;
          return row!.allowed;
        }),
      ).toBe(false);
      expect(
        await asActor(app, ownerB, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select assert_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${attemptId}::uuid, 2,
              ${machine.enrollmentId}::uuid, true
            ) as allowed
          `;
          return row!.allowed;
        }),
      ).toBe(false);
      await expect(
        asActor(app, otherB, async (tx) => {
          await tx`
            select assert_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${attemptId}::uuid, 1,
              ${machine.enrollmentId}::uuid, true
            )
          `;
        }),
      ).rejects.toThrow(/no longer live/iu);
      const [foreignAccount] = await admin<Array<{ id: string }>>`
        insert into managed_accounts (name) values (${`foreign-${crypto.randomUUID()}`}) returning id
      `;
      const [foreignWorkspace] = await admin<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${foreignAccount!.id}, 'foreign') returning id
      `;
      expect(
        await asActor(
          app,
          {
            accountId: foreignAccount!.id,
            workspaceId: foreignWorkspace!.id,
            subjectId: ownerSubject,
          },
          async (tx) => {
            const [row] = await tx<Array<{ allowed: boolean }>>`
              select assert_session_attempt_personal_machine(
                ${foreignAccount!.id}::uuid, ${foreignWorkspace!.id}::uuid,
                ${session.id}::uuid, ${turn!.id}::uuid, ${attemptId}::uuid, 1,
                ${machine.enrollmentId}::uuid, true
              ) as allowed
            `;
            return row!.allowed;
          },
        ),
      ).toBe(false);
      const authorizeSideMachine = async () =>
        await asActor(app!, ownerB, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select authorize_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${attemptId}::uuid, 1,
              ${sideMachine.enrollmentId}::uuid
            ) as allowed
          `;
          return row!.allowed;
        });
      const assertSideMachine = async (workspace = ownerB) =>
        await asActor(app!, workspace, async (tx) => {
          const [row] = await tx<Array<{ allowed: boolean }>>`
            select assert_session_attempt_personal_machine(
              ${account!.id}::uuid, ${workspace.workspaceId}::uuid, ${session.id}::uuid,
              ${turn!.id}::uuid, ${attemptId}::uuid, 1,
              ${sideMachine.enrollmentId}::uuid, false
            ) as allowed
          `;
          return row!.allowed;
        });
      await expect(authorizeSideMachine()).rejects.toThrow(/explicit grant/iu);
      await asActor(app, ownerB, async (tx) => {
        await tx`
          select grant_id from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${sideMachineAuthority!.id}::uuid,
            ${workspaceB.id}::uuid, 'connected_machine', 'always',
            'user_private', null, null, true
          )
        `;
      });
      await expect(authorizeSideMachine()).rejects.toThrow(/explicit grant/iu);
      await asActor(app, ownerA, async (tx) => {
        await tx`
          select grant_id from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${sideMachineAuthority!.id}::uuid,
            ${workspaceA.id}::uuid, 'connected_machine', 'always',
            'workspace_shared', null, null, true
          )
        `;
      });
      await expect(authorizeSideMachine()).rejects.toThrow(/explicit grant/iu);
      await asActor(app, ownerB, async (tx) => {
        await tx`
          select grant_id from issue_self_user_resource_grant(
            ${account!.id}::uuid, ${sideMachineAuthority!.id}::uuid,
            ${workspaceB.id}::uuid, 'connected_machine', 'session',
            'workspace_shared', ${session.id}::uuid, 1, true
          )
        `;
      });
      expect(await authorizeSideMachine()).toBe(true);
      expect(await assertSideMachine()).toBe(true);
      const [sideAuthorization] = await admin<Array<{ grantId: string; grantGeneration: number }>>`
        select grant_id as "grantId", grant_generation as "grantGeneration"
        from session_attempt_connected_machine_authorizations
        where attempt_id = ${attemptId} and enrollment_id = ${sideMachine.enrollmentId}
      `;
      await admin`
        update organization_user_resource_grants
        set generation = generation + 1 where id = ${sideAuthorization!.grantId}
      `;
      await expect(assertSideMachine()).rejects.toThrow(/no longer live/iu);
      await admin`
        update organization_user_resource_grants
        set generation = ${sideAuthorization!.grantGeneration}, status = 'active'
        where id = ${sideAuthorization!.grantId}
      `;
      await admin`
        update organization_user_resource_grants
        set status = 'revoked', revoked_at = now() where id = ${sideAuthorization!.grantId}
      `;
      await expect(assertSideMachine()).rejects.toThrow(/no longer live/iu);
      await admin`
        update organization_user_resource_grants
        set status = 'active', revoked_at = null where id = ${sideAuthorization!.grantId}
      `;
      await expect(assertSideMachine(ownerA)).resolves.toBe(false);
      await expect(
        asActor(
          app,
          ownerA,
          async (tx) => await tx`select * from organization_user_resource_authorities limit 1`,
        ),
      ).rejects.toThrow();

      await admin`
        update enrollments set status = 'revoked', revoked_at = now(), generation = generation + 1
        where id = ${machine.enrollmentId}
      `;
      const [authority] = await admin<Array<{ generation: number; status: string }>>`
        select generation::int, status from organization_user_resource_authorities
        where account_id = ${account!.id} and organization_membership_id = ${ownerMembership!.id}
          and resource_kind = 'connected_machine' and resource_id = ${machine.enrollmentId}
      `;
      expect(authority).toEqual({ generation: 2, status: "revoked" });
      await expect(
        asActor(
          app,
          ownerB,
          async (tx) =>
            await tx`
              select assert_session_attempt_personal_machine(
                ${account!.id}::uuid, ${workspaceB.id}::uuid, ${session.id}::uuid,
                ${turn!.id}::uuid, ${attemptId}::uuid, 1,
                ${machine.enrollmentId}::uuid, true
              )
            `,
        ),
      ).rejects.toThrow(/no longer live/iu);
    } finally {
      await db?.close().catch(() => undefined);
      await app?.end({ timeout: 1 }).catch(() => undefined);
      await admin?.end({ timeout: 1 }).catch(() => undefined);
      await blank.release();
    }
  }, 300_000);
});
