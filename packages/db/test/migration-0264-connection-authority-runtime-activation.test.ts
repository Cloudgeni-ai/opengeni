import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  settleCodexCredentialLeaseLoss,
  sendAgentMessageInTransaction,
  steerAgentSessionInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0264_connection_authority_runtime_activation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migrationName = "0264_connection_authority_runtime_activation.sql";
// 0275 replaces the accepted-authority capture installed by 0264, 0299 repairs
// that membership wrapper, and 0315 extends the 0275 ledgers. Migration 0345
// patches the frozen 0275 routine, so the synthetic upgrade must withhold all
// four dependents alongside 0264 and replay all five in real filename order.
const scheduledConnectionAuthorityMigrationName = "0275_scheduled_connection_authority.sql";
const organizationMembershipLockOrderMigrationName = "0299_organization_membership_lock_order.sql";
const personalGitHubRepositorySelectionMigrationName =
  "0315_personal_github_repository_selection.sql";
const sessionTenancyFenceMigrationName = "0345_tenant_scoped_session_tenancy_fence.sql";

describe("migration 0264 connection authority runtime activation", () => {
  test("is a drained exact-attempt cutover with canonical snapshots and idempotent audit", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "turn_connection_authority_snapshots"');
    expect(source).toContain('"membership_authorization_revision" bigint');
    expect(source).toContain('"canonical_snapshot" jsonb NOT NULL');
    expect(source).toContain('"snapshot_digest" bytea NOT NULL');
    expect(source).toContain('CREATE TABLE "connection_use_audit_facts"');
    expect(source).toContain('"physical_request_id" uuid PRIMARY KEY');
    expect(source).toContain("accepted_turn_connection_authority_capture");
    expect(source).toContain("attempt.quiesced_at IS NULL");
    expect(source).toContain("attempt.authority_epoch = session_row.authority_epoch");
    expect(source).toContain("turn_value.active_attempt_id = p_attempt_id");
    expect(source).toContain(
      "membership.authorization_revision = snapshot.membership_authorization_revision",
    );
    expect(source).toContain("snapshot.canonical_snapshot::text");
    expect(source).toContain("resolve_connection_use_authority_legacy_0256");
    expect(source).toContain("p_snapshot ->> 'scope' = 'user'");
    expect(source).toContain("connection_use_once_consumption_receipts");
    expect(source).toContain("resolve_connection_use_authority_legacy_0256");
    expect(source).toContain("GRANT EXECUTE ON FUNCTION resolve_accepted_connection_use");
    expect(source).toContain("FROM pg_stat_activity");
    expect(source.match(/all opengeni_app sessions to be stopped/gu)).toHaveLength(2);
    expect(source).toContain("resolve_personal_connection_authority_selection");
    expect(source).not.toMatch(/credential_encrypted\s*(?:->|#>|#>>)|decrypt/iu);
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects a live application writer and explicit pre-activation queued authority", async () => {
    const blank = await acquireBlankTestDatabase("migration-0264-cutover-drain");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 2, onnotice: () => undefined });
    try {
      await sql`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `;
      await sql`
        insert into schema_migrations (name)
        values
          (${migrationName}),
          (${scheduledConnectionAuthorityMigrationName}),
          (${organizationMembershipLockOrderMigrationName}),
          (${personalGitHubRepositorySelectionMigrationName}),
          (${sessionTenancyFenceMigrationName})
      `;
      await migrate(blank.databaseUrl);

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('connection cutover drain') returning id
      `;
      const [origin] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'origin') returning id
      `;
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'target') returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${origin!.id}, ${account!.id}), (${target!.id}, ${account!.id})
      `;
      const subjectId = `user:${crypto.randomUUID()}`;
      await sql`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (${account!.id}, ${subjectId}, 'active', ${origin!.id})
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${target!.id}, ${subjectId})
      `;
      const connection = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; authorityId: string }>>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${origin!.id}, ${subjectId}, 'api.example.com', 'oauth2', 'ciphertext'
          ) returning id, authority_id as "authorityId"
        `;
        return row!;
      });
      const cutoverClient = createDb(blank.databaseUrl, { max: 1 });
      const session = await createSession(cutoverClient.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "pre-activation authority",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        subjectId,
      });
      await cutoverClient.close();
      const explicitDelegation = [
        {
          serverId: "example",
          connectionId: connection.id,
          ownerSubjectId: subjectId,
          providerDomain: "api.example.com",
          kind: "oauth2",
          userDelegation: {
            organizationId: account!.id,
            authorityId: connection.authorityId,
            authorityGeneration: 1,
            workspaceId: target!.id,
            sessionId: null,
            action: "connection.use",
            mode: "always",
            context: "workspace_shared",
            authorityEpoch: null,
            grantId: crypto.randomUUID(),
            grantGeneration: 1,
          },
        },
      ];
      const [preActivationTurn] = await sql<{ id: string }[]>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, sandbox_backend, source,
          initiator_kind, initiator_subject_id, initiating_human_subject_id,
          personal_connection_delegations
        ) values (
          ${account!.id}, ${target!.id}, ${session.id}, ${crypto.randomUUID()},
          ${`cutover-${crypto.randomUUID()}`}, 'queued', 1, 1, 'queued authority',
          'test-model', 'medium', 'standard', 'none', 'user',
          'subject', ${subjectId}, ${subjectId},
          ${sql.json(explicitDelegation)}::jsonb
        ) returning id
      `;
      await sql`
        delete from schema_migrations
        where name in (
          ${migrationName},
          ${scheduledConnectionAuthorityMigrationName},
          ${organizationMembershipLockOrderMigrationName},
          ${personalGitHubRepositorySelectionMigrationName},
          ${sessionTenancyFenceMigrationName}
        )
      `;
      await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });

      await sql`
        update sessions set status = 'recovering', active_turn_id = ${preActivationTurn!.id}
        where id = ${session.id}
      `;
      await sql`
        update session_turns set status = 'recovering', active_attempt_id = null
        where id = ${preActivationTurn!.id}
      `;
      await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });

      await sql`delete from session_turns where session_id = ${session.id}`;
      await sql`
        do $role$
        begin
          if not exists (select 1 from pg_roles where rolname = 'opengeni_app') then
            create role opengeni_app login password 'cutover-test';
          else
            alter role opengeni_app login password 'cutover-test';
          end if;
        end
        $role$
      `;
      await sql`grant connect on database ${sql(blank.databaseUrl.split("/").at(-1)!)} to opengeni_app`;
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "cutover-test";
      const appSql = postgres(appUrl.toString(), { max: 1 });
      try {
        await appSql`select 1`;
        await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });
      } finally {
        await appSql.end({ timeout: 1 });
      }

      await migrate(blank.databaseUrl);
      const receipts = await sql<Array<{ name: string }>>`
        select name from schema_migrations
        where name in (
          ${migrationName},
          ${scheduledConnectionAuthorityMigrationName},
          ${organizationMembershipLockOrderMigrationName},
          ${personalGitHubRepositorySelectionMigrationName},
          ${sessionTenancyFenceMigrationName}
        )
        order by name
      `;
      expect(receipts.map((receipt) => receipt.name)).toEqual([
        migrationName,
        scheduledConnectionAuthorityMigrationName,
        organizationMembershipLockOrderMigrationName,
        personalGitHubRepositorySelectionMigrationName,
        sessionTenancyFenceMigrationName,
      ]);
    } finally {
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 180_000);

  test("captures and resolves accepted authority in an embedded schema", async () => {
    const blank = await acquireBlankTestDatabase("migration-0264-embedded-authority-runtime");
    if (!blank) return;
    await migrate(blank.databaseUrl, "opengeni", {
      applicationDatabaseRoles: ["opengeni_app"],
    });
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    await sql.unsafe('set search_path = "opengeni", "opengeni_private", "public"');
    const client = createDb(blank.databaseUrl, {
      max: 2,
      searchPath: "opengeni,opengeni_private,public",
    });
    try {
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('embedded accepted authority') returning id
      `;
      const [origin] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'origin') returning id
      `;
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'target') returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${origin!.id}, ${account!.id}), (${target!.id}, ${account!.id})
      `;
      const subjectId = `user:${crypto.randomUUID()}`;
      await sql`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (${account!.id}, ${subjectId}, 'active', ${origin!.id})
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${target!.id}, ${subjectId})
      `;
      const connection = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; authorityId: string }>>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${origin!.id}, ${subjectId}, 'embedded.example.com',
            'oauth2', 'ciphertext'
          ) returning id, authority_id as "authorityId"
        `;
        return row!;
      });
      const session = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "embedded accepted authority",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        subjectId,
      });
      const [sessionAuthority] = await sql<
        Array<{ visibility: "user_private" | "workspace_shared"; epoch: number }>
      >`
        select visibility, authority_epoch::int as epoch from sessions where id = ${session.id}
      `;
      const grant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; generation: number }>>`
          select grant_id as id, grant_generation::int as generation
          from issue_self_connection_use_grant(
            ${account!.id}::uuid, ${connection.authorityId}::uuid, ${target!.id}::uuid,
            'once', ${sessionAuthority!.visibility}, ${session.id}::uuid,
            ${sessionAuthority!.visibility === "workspace_shared"}
          )
        `;
        return row!;
      });
      const delegation = {
        serverId: "embedded",
        connectionId: connection.id,
        originWorkspaceId: origin!.id,
        ownerSubjectId: subjectId,
        providerDomain: "embedded.example.com",
        kind: "oauth2" as const,
        connectionType: "mcp" as const,
        userDelegation: {
          authorityId: connection.authorityId,
          grantId: grant.id,
          organizationId: account!.id,
          workspaceId: target!.id,
          sessionId: session.id,
          action: "connection.use" as const,
          mode: "once" as const,
          context: sessionAuthority!.visibility,
          authorityEpoch: sessionAuthority!.epoch,
          authorityGeneration: 1,
          grantGeneration: grant.generation,
        },
      };
      const submitted = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        target!.id,
        subjectId,
        (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "use embedded authority",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [delegation],
          }),
      );
      const attemptId = crypto.randomUUID();
      const claim = await claimSessionWorkForAttempt(client.db, target!.id, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claim.action !== "claimed") throw new Error(`turn was not claimed: ${claim.reason}`);
      const [authorization] = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
        return await tx<Array<{ status: string; reason: string | null }>>`
          select authorization_status as status, denial_reason as reason
          from resolve_accepted_connection_use(
            ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
            ${submitted.turnId}::uuid, ${attemptId}::uuid,
            ${claim.turn.executionGeneration}, ${crypto.randomUUID()}::uuid,
            'provider_request', 'embedded', ${connection.id}::uuid,
            'embedded.example.com', 'oauth2', 'subject', ${subjectId}
          )
        `;
      });
      expect(authorization).toEqual({ status: "authorized", reason: null });
    } finally {
      await client.close();
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 180_000);

  test("freezes at turn acceptance and revalidates exact physical use on PostgreSQL", async () => {
    const externalDatabaseUrl = process.env.OPENGENI_TEST_DATABASE_URL?.trim();
    const blank = externalDatabaseUrl
      ? { databaseUrl: externalDatabaseUrl, release: async () => undefined }
      : await acquireBlankTestDatabase("migration-0264-connection-authority-runtime");
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0264-connection-authority-runtime] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    if (!blank) return;

    await migrate(blank.databaseUrl);
    const sql = postgres(blank.databaseUrl, { max: 4, onnotice: () => undefined });
    const client = createDb(blank.databaseUrl, { max: 4 });
    try {
      const [appPrivileges] = await sql<
        Array<{ snapshotsInsert: boolean; auditInsert: boolean; auditUpdate: boolean }>
      >`
        select
          has_table_privilege('opengeni_app', 'turn_connection_authority_snapshots', 'INSERT')
            as "snapshotsInsert",
          has_table_privilege('opengeni_app', 'connection_use_audit_facts', 'INSERT')
            as "auditInsert",
          has_table_privilege('opengeni_app', 'connection_use_audit_facts', 'UPDATE')
            as "auditUpdate"
      `;
      expect(appPrivileges).toEqual({
        snapshotsInsert: false,
        auditInsert: false,
        auditUpdate: false,
      });
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('accepted-connection-authority') returning id
      `;
      const [origin] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'connection-origin')
        returning id
      `;
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'connection-target')
        returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${origin!.id}, ${account!.id}), (${target!.id}, ${account!.id})
      `;
      const subjectId = `user:${crypto.randomUUID()}`;
      const [membership] = await sql<{ id: string; revision: number }[]>`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (${account!.id}, ${subjectId}, 'active', ${origin!.id})
        returning id, authorization_revision::int as revision
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${target!.id}, ${subjectId})
      `;
      const personal = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; authorityId: string; generation: number }>>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${origin!.id}, ${subjectId}, 'api.example.com',
            'oauth2', 'ciphertext-never-read-by-authority'
          ) returning id, authority_id as "authorityId",
            authority_generation::int as generation
        `;
        return row!;
      });
      const session = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "accepted authority",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        subjectId,
      });
      const [sessionAuthority] = await sql<
        Array<{ visibility: "user_private" | "workspace_shared"; epoch: number }>
      >`
        select visibility, authority_epoch::int as epoch from sessions where id = ${session.id}
      `;
      const grant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; generation: number }>>`
          select grant_id as id, grant_generation::int as generation
          from issue_self_connection_use_grant(
            ${account!.id}::uuid, ${personal.authorityId}::uuid, ${target!.id}::uuid,
            'once', ${sessionAuthority!.visibility}, ${session.id}::uuid,
            ${sessionAuthority!.visibility === "workspace_shared"}
          )
        `;
        return row!;
      });
      const delegation = {
        serverId: "example",
        connectionId: personal.id,
        originWorkspaceId: origin!.id,
        ownerSubjectId: subjectId,
        providerDomain: "api.example.com",
        kind: "oauth2" as const,
        connectionType: "mcp" as const,
        userDelegation: {
          authorityId: personal.authorityId,
          grantId: grant.id,
          organizationId: account!.id,
          workspaceId: target!.id,
          sessionId: session.id,
          action: "connection.use" as const,
          mode: "once" as const,
          context: sessionAuthority!.visibility,
          authorityEpoch: sessionAuthority!.epoch,
          authorityGeneration: 1,
          grantGeneration: grant.generation,
        },
      };
      const resolveAdmissionOrigin = async (
        requestedSubjectId: string,
        requestedAccountId = account!.id,
        requestedWorkspaceId = target!.id,
        requestedDelegation = delegation.userDelegation,
      ) =>
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${requestedAccountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${requestedWorkspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${requestedSubjectId}, true)`;
          const [row] = await tx<Array<{ originWorkspaceId: string }>>`
            select origin_workspace_id as "originWorkspaceId"
            from resolve_personal_connection_authority_selection(
              ${requestedAccountId}::uuid, ${requestedWorkspaceId}::uuid,
              ${requestedSubjectId}, ${personal.id}::uuid,
              ${JSON.stringify(requestedDelegation)}::text::jsonb
            )
          `;
          return row ?? null;
        });
      expect(await resolveAdmissionOrigin(subjectId)).toEqual({ originWorkspaceId: origin!.id });
      await expect(resolveAdmissionOrigin(`user:${crypto.randomUUID()}`)).rejects.toBeTruthy();
      await expect(resolveAdmissionOrigin(subjectId, crypto.randomUUID())).rejects.toBeTruthy();
      const rollbackRevokedAdmission = new Error("rollback revoked admission");
      let revokedAdmissionDenied = false;
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
          await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
          await tx`
            update organization_user_resource_grants
            set status = 'revoked', revoked_at = clock_timestamp()
            where id = ${grant.id}
          `;
          try {
            await tx.savepoint(async (savepoint) => {
              await savepoint`
                select * from resolve_personal_connection_authority_selection(
                  ${account!.id}::uuid, ${target!.id}::uuid, ${subjectId},
                  ${personal.id}::uuid,
                  ${JSON.stringify(delegation.userDelegation)}::text::jsonb
                )
              `;
            });
          } catch {
            revokedAdmissionDenied = true;
          }
          throw rollbackRevokedAdmission;
        });
      } catch (error) {
        if (error !== rollbackRevokedAdmission) throw error;
      }
      expect(revokedAdmissionDenied).toBe(true);
      await expect(
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "crafted excluded adapter must not bypass authority",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [
              { ...delegation, connectionType: "atlassian" as const },
            ],
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      const submittedOperationKey = crypto.randomUUID();
      const submitAcceptedOnceWork = () =>
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: submittedOperationKey,
            delivery: "send",
            text: "use the exact accepted connection",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [delegation],
          }),
        );
      const submitted = await submitAcceptedOnceWork();
      // The once grant is now consumed, but its immutable receipt allows the
      // exact transport retry to clear preflight and reach the durable command
      // receipt. A distinct accepted turn is still rejected by the trigger.
      expect(await resolveAdmissionOrigin(subjectId)).toEqual({ originWorkspaceId: origin!.id });
      const submittedReplay = await submitAcceptedOnceWork();
      expect(submittedReplay.turnId).toBe(submitted.turnId);
      expect(submittedReplay.replay).toBe(true);
      const [accepted] = await sql<
        Array<{
          connectionId: string;
          revision: number;
          acceptedTurnId: string;
        }>
      >`
        select connection_id as "connectionId",
          membership_authorization_revision::int as revision,
          canonical_snapshot #>> '{acceptedWork,turnId}' as "acceptedTurnId"
        from turn_connection_authority_snapshots
        where turn_id = ${submitted.turnId} and server_id = 'example'
      `;
      expect(accepted).toEqual({
        connectionId: personal.id,
        revision: membership!.revision,
        acceptedTurnId: submitted.turnId,
      });

      const attemptId = crypto.randomUUID();
      const claim = await claimSessionWorkForAttempt(client.db, target!.id, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claim.action !== "claimed") throw new Error(`turn was not claimed: ${claim.reason}`);
      const resolve = async (physicalRequestId: string, providerDomain = "api.example.com") =>
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
          const [row] = await tx<Array<{ status: string; reason: string | null }>>`
            select authorization_status as status, denial_reason as reason
            from resolve_accepted_connection_use(
              ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
              ${submitted.turnId}::uuid, ${attemptId}::uuid,
              ${claim.turn.executionGeneration}, ${physicalRequestId}::uuid,
              'provider_request', 'example', ${personal.id}::uuid, ${providerDomain}, 'oauth2',
              'subject', ${subjectId}
            )
          `;
          return row!;
        });
      const firstRequestId = crypto.randomUUID();
      const concurrentRequestId = crypto.randomUUID();
      expect(await Promise.all([resolve(firstRequestId), resolve(concurrentRequestId)])).toEqual([
        { status: "authorized", reason: null },
        { status: "authorized", reason: null },
      ]);
      expect(await resolve(firstRequestId)).toEqual({ status: "authorized", reason: null });
      await expect(resolve(firstRequestId, "attacker.example.com")).rejects.toMatchObject({
        code: "23505",
      });
      expect(await resolve(crypto.randomUUID())).toEqual({ status: "authorized", reason: null });
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
          await tx`
            select * from resolve_accepted_connection_use(
              ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
              ${submitted.turnId}::uuid, ${attemptId}::uuid,
              ${claim.turn.executionGeneration}, ${crypto.randomUUID()}::uuid,
              'provider_request', 'example', ${personal.id}::uuid, 'api.example.com', 'oauth2',
              'subject', ${subjectId}
            )
          `;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${crypto.randomUUID()}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
          await tx`
            select * from resolve_accepted_connection_use(
              ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
              ${submitted.turnId}::uuid, ${attemptId}::uuid,
              ${claim.turn.executionGeneration}, ${crypto.randomUUID()}::uuid,
              'provider_request', 'example', ${personal.id}::uuid, 'api.example.com', 'oauth2',
              'subject', ${subjectId}
            )
          `;
        }),
      ).rejects.toMatchObject({ code: "42501" });

      await expect(
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "must not reuse the once grant for a new turn",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [delegation],
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });

      const recovery = await settleCodexCredentialLeaseLoss(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        sessionId: session.id,
        turnId: submitted.turnId,
        attemptId,
        holderId: crypto.randomUUID(),
        generation: 1,
        expectedRedispatches: 0,
        checkpointDurable: true,
        recoveryPayload: { reason: "test" },
        failedPayload: { reason: "test" },
      });
      expect(recovery.action).toBe("recovering");
      expect(await resolve(firstRequestId)).toEqual({
        status: "denied",
        reason: "session_identity_changed",
      });
      await expect(resolve(firstRequestId, "stale-reuse.example.com")).rejects.toMatchObject({
        code: "23505",
      });
      const recoveredAttemptId = crypto.randomUUID();
      const recoveredClaim = await claimSessionWorkForAttempt(client.db, target!.id, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: recoveredAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (recoveredClaim.action !== "claimed") {
        throw new Error(`turn was not recovered: ${recoveredClaim.reason}`);
      }
      const recoveredResolve = async (physicalRequestId: string) =>
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
          const [row] = await tx<Array<{ status: string; reason: string | null }>>`
            select authorization_status as status, denial_reason as reason
            from resolve_accepted_connection_use(
              ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
              ${submitted.turnId}::uuid, ${recoveredAttemptId}::uuid,
              ${recoveredClaim.turn.executionGeneration}, ${physicalRequestId}::uuid,
              'provider_request', 'example', ${personal.id}::uuid, 'api.example.com', 'oauth2',
              'subject', ${subjectId}
            )
          `;
          return row!;
        });
      const recoveredRequestId = crypto.randomUUID();
      expect(await recoveredResolve(recoveredRequestId)).toEqual({
        status: "authorized",
        reason: null,
      });
      const resolveWithRolledBackMutation = async (
        mutation: "connection_status" | "connection_generation" | "authority_generation",
      ) => {
        let observed: { status: string; reason: string | null } | undefined;
        const rollback = new Error(`rollback-${mutation}`);
        try {
          await sql.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
            await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
            if (mutation === "connection_status") {
              await tx`update connections set status = 'needs_reauth' where id = ${personal.id}`;
            } else if (mutation === "connection_generation") {
              await tx`
                update connections set authority_generation = authority_generation + 1
                where id = ${personal.id}
              `;
            } else {
              await tx`
                update organization_user_resource_authorities
                set generation = generation + 1 where id = ${personal.authorityId}
              `;
            }
            const [row] = await tx<Array<{ status: string; reason: string | null }>>`
              select authorization_status as status, denial_reason as reason
              from resolve_accepted_connection_use(
                ${account!.id}::uuid, ${target!.id}::uuid, ${session.id}::uuid,
                ${submitted.turnId}::uuid, ${recoveredAttemptId}::uuid,
                ${recoveredClaim.turn.executionGeneration}, ${crypto.randomUUID()}::uuid,
                'provider_request', 'example', ${personal.id}::uuid, 'api.example.com', 'oauth2',
                'subject', ${subjectId}
              )
            `;
            observed = row;
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        return observed;
      };
      expect(await resolveWithRolledBackMutation("connection_status")).toEqual({
        status: "denied",
        reason: "connection_status_inactive",
      });
      expect(await resolveWithRolledBackMutation("connection_generation")).toEqual({
        status: "denied",
        reason: "connection_generation_changed",
      });
      expect(await resolveWithRolledBackMutation("authority_generation")).toEqual({
        status: "denied",
        reason: "authority_status_inactive",
      });
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        await tx`
          select * from revoke_self_connection_use_grant(
            ${account!.id}::uuid, ${grant.id}::uuid
          )
        `;
      });
      expect(await recoveredResolve(crypto.randomUUID())).toEqual({
        status: "denied",
        reason: "grant_generation_changed",
      });
      expect(await recoveredResolve(recoveredRequestId)).toEqual({
        status: "denied",
        reason: "grant_generation_changed",
      });

      await sql`
        update organization_memberships
        set authorization_revision = authorization_revision + 1
        where id = ${membership!.id}
      `;
      expect(await recoveredResolve(crypto.randomUUID())).toEqual({
        status: "denied",
        reason: "owner_membership_inactive",
      });

      const createOnceRaceFixture = async (initialMessage: string) => {
        const raceSession = await createSession(client.db, {
          accountId: account!.id,
          workspaceId: target!.id,
          initialMessage,
          resources: [],
          tools: [],
          metadata: {},
          createdBy: { kind: "subject", subjectId },
          model: "test-model",
          reasoningEffort: "medium" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "none",
          subjectId,
        });
        const [raceAuthority] = await sql<
          Array<{ visibility: "user_private" | "workspace_shared"; epoch: number }>
        >`
          select visibility, authority_epoch::int as epoch
          from sessions where id = ${raceSession.id}
        `;
        const raceGrant = await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
          await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
          const [row] = await tx<Array<{ id: string; generation: number }>>`
            select grant_id as id, grant_generation::int as generation
            from issue_self_connection_use_grant(
              ${account!.id}::uuid, ${personal.authorityId}::uuid, ${target!.id}::uuid,
              'once', ${raceAuthority!.visibility}, ${raceSession.id}::uuid,
              ${raceAuthority!.visibility === "workspace_shared"}
            )
          `;
          return row!;
        });
        return {
          session: raceSession,
          grant: raceGrant,
          delegation: {
            ...delegation,
            userDelegation: {
              ...delegation.userDelegation,
              grantId: raceGrant.id,
              sessionId: raceSession.id,
              context: raceAuthority!.visibility,
              authorityEpoch: raceAuthority!.epoch,
              grantGeneration: raceGrant.generation,
            },
          },
        };
      };
      const raceFixture = await createOnceRaceFixture("once identical acceptance race");
      const raceSession = raceFixture.session;
      const raceGrant = raceFixture.grant;
      const raceDelegation = raceFixture.delegation;
      const raceOperationKey = crypto.randomUUID();
      const acceptRaceTurn = (operationKey = raceOperationKey) =>
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: raceSession.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey,
            delivery: "send",
            text: "one exactly replayable once request",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [raceDelegation],
          }),
        );
      const raceResults = await Promise.allSettled([acceptRaceTurn(), acceptRaceTurn()]);
      expect(raceResults.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      const replayedTurnIds = raceResults.map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value.turnId;
      });
      expect(new Set(replayedTurnIds).size).toBe(1);
      const [raceProof] = await sql<Array<{ snapshots: number; receipts: number }>>`
        select
          (select count(*)::int from turn_connection_authority_snapshots
            where session_id = ${raceSession.id}) as snapshots,
          (select count(*)::int from connection_use_once_consumption_receipts
            where grant_id = ${raceGrant.id}) as receipts
      `;
      expect(raceProof).toEqual({ snapshots: 1, receipts: 1 });
      const acceptedRace = raceResults.find((result) => result.status === "fulfilled");
      if (!acceptedRace || acceptedRace.status !== "fulfilled") {
        throw new Error("once acceptance race had no winner");
      }
      await expect(acceptRaceTurn(crypto.randomUUID())).rejects.toMatchObject({
        cause: { code: "42501" },
      });

      const competingFixture = await createOnceRaceFixture("once distinct-work race");
      const acceptCompetingTurn = (text: string) =>
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: competingFixture.session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text,
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [competingFixture.delegation],
          }),
        );
      const competingResults = await Promise.allSettled([
        acceptCompetingTurn("once contender a"),
        acceptCompetingTurn("once contender b"),
      ]);
      expect(competingResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(competingResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      const [competingProof] = await sql<Array<{ snapshots: number; receipts: number }>>`
        select
          (select count(*)::int from turn_connection_authority_snapshots
            where session_id = ${competingFixture.session.id}) as snapshots,
          (select count(*)::int from connection_use_once_consumption_receipts
            where grant_id = ${competingFixture.grant.id}) as receipts
      `;
      expect(competingProof).toEqual({ snapshots: 1, receipts: 1 });

      const raceAttemptId = crypto.randomUUID();
      const raceClaim = await claimSessionWorkForAttempt(client.db, target!.id, {
        sessionId: raceSession.id,
        workflowId: `session-${raceSession.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: raceAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (raceClaim.action !== "claimed") throw new Error("once race winner was not claimed");
      const raceActor = {
        type: "agent_attempt" as const,
        sessionId: raceSession.id,
        turnId: raceClaim.turn.id,
        attemptId: raceAttemptId,
        executionGeneration: raceClaim.turn.executionGeneration,
      };
      const raceChild = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "once successor target",
        resources: [],
        tools: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        parentSessionId: raceSession.id,
      });
      await withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
        db.transaction(async (tx) => {
          await sendAgentMessageInTransaction(tx as unknown as typeof db, {
            accountId: account!.id,
            workspaceId: target!.id,
            targetSessionId: raceChild.id,
            actor: raceActor,
            operationKey: crypto.randomUUID(),
            text: "once must not propagate through Agent message",
          });
        }),
      );
      await withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
        db.transaction(async (tx) => {
          await steerAgentSessionInTransaction(tx as unknown as typeof db, {
            accountId: account!.id,
            workspaceId: target!.id,
            targetSessionId: raceChild.id,
            actor: raceActor,
            operationKey: crypto.randomUUID(),
            instruction: "once must not propagate through Agent Steer",
          });
        }),
      );
      const onceSuccessors = await sql<
        Array<{ delegations: unknown[]; connectionAuthoritySubjectId: string | null }>
      >`
        select personal_connection_delegations as delegations,
          lineage ->> 'connectionAuthoritySubjectId' as "connectionAuthoritySubjectId"
        from session_system_updates
        where session_id = ${raceChild.id}
          and kind in ('agent_message', 'agent_steer_instruction')
        order by created_at, id
      `;
      expect([...onceSuccessors]).toEqual([
        { delegations: [], connectionAuthoritySubjectId: null },
        { delegations: [], connectionAuthoritySubjectId: null },
      ]);

      await applySessionTurnSettlement(client.db, target!.id, {
        sessionId: raceSession.id,
        turnId: raceClaim.turn.id,
        triggerEventId: raceClaim.turn.triggerEventId,
        attemptId: raceAttemptId,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [],
      });
    } finally {
      await client.close();
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 120_000);
});
