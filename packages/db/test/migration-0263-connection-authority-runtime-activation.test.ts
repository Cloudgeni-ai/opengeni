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
  "../drizzle/0263_connection_authority_runtime_activation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0263 connection authority runtime activation", () => {
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
    expect(source).not.toMatch(/credential_encrypted\s*(?:->|#>|#>>)|decrypt/iu);
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("freezes at turn acceptance and revalidates exact physical use on PostgreSQL", async () => {
    const externalDatabaseUrl = process.env.OPENGENI_TEST_DATABASE_URL?.trim();
    const blank = externalDatabaseUrl
      ? { databaseUrl: externalDatabaseUrl, release: async () => undefined }
      : await acquireBlankTestDatabase("migration-0263-connection-authority-runtime");
    if (!blank && requireRealDatabase) {
      throw new Error(
        "[migration-0263-connection-authority-runtime] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
            text: "use the exact accepted connection",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: [delegation],
          }),
      );
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

      const raceSession = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "once acceptance race",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
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
      const raceDelegation = {
        ...delegation,
        userDelegation: {
          ...delegation.userDelegation,
          grantId: raceGrant.id,
          sessionId: raceSession.id,
          context: raceAuthority!.visibility,
          authorityEpoch: raceAuthority!.epoch,
          grantGeneration: raceGrant.generation,
        },
      };
      const acceptRaceTurn = (text: string) =>
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: raceSession.id,
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
            personalConnectionDelegations: [raceDelegation],
          }),
        );
      const raceResults = await Promise.allSettled([
        acceptRaceTurn("once contender a"),
        acceptRaceTurn("once contender b"),
      ]);
      expect(raceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raceResults.filter((result) => result.status === "rejected")).toHaveLength(1);
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
