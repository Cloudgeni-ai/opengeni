import { describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  acquireLease,
  claimProviderLossTeardown,
  consumeSandboxProviderLossReceipt,
  createDb,
  createSession,
  persistSandboxProviderLossObservation,
  withRlsContext,
} from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0240_sandbox_provider_loss_receipts.sql";

const claimTimestampOnlyColumns = ["updated_at"] as const;
const claimExactAtomicTransitionColumns = [
  "archive_capture_attempt",
  "archive_capture_deadline_at",
  "archive_capture_generation",
  "archive_capture_id",
  "archive_capture_operation_id",
  "archive_capture_provider_replay_safe",
  "archive_capture_provider_request_id",
  "archive_capture_published_at",
  "archive_capture_started_at",
  "archive_capture_takeover_safe",
  "controller_data_plane_url",
  "data_plane_url",
  "instance_id",
  "lease_epoch",
  "liveness",
  "provider_created_at",
  "provider_deadline_at",
  "reaper_hold_id",
  "reaper_hold_reason",
  "reaper_hold_until",
  "resume_backend_id",
  "resume_state",
  "rotation_reason",
  "rotation_requested_at",
  "terminal_data_plane_url",
] as const;
const claimInvariantColumns = [
  "account_id",
  "archive_generation",
  "backend",
  "created_at",
  "current_checkpoint_artifact_id",
  "expires_at",
  "id",
  "image",
  "last_meter_at",
  "last_meter_tick",
  "os",
  "previous_checkpoint_artifact_id",
  "refcount",
  "rig_version_id",
  "sandbox_group_id",
  "turn_holders",
  "viewer_holders",
  "workspace_generation",
  "workspace_id",
] as const;

async function expectSqlState(operation: PromiseLike<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  const seen = new Set<unknown>();
  let current = failure;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") {
      expect(current.code).toBe(code);
      return;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  expect(failure).toMatchObject({ code });
}

describe("0240 provider-loss receipt protocol", () => {
  test("installs the distinct claim/receipt state machine and hard fences", async () => {
    const shared = await acquireSharedTestDatabase("migration-0240-provider-loss-receipts");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("[migration-0240] PostgreSQL is required but unavailable");
      }
      return;
    }
    try {
      await migrate(shared.adminUrl);
      const [migration] = await shared.admin<Array<{ count: number }>>`
        select count(*)::integer as count
        from schema_migrations
        where name = ${migrationName}
      `;
      expect(migration?.count).toBe(1);

      const tables = await shared.admin<{ relname: string; relforcerowsecurity: boolean }[]>`
        select c.relname, c.relforcerowsecurity
        from pg_class c
        where c.relname in (
          'sandbox_provider_loss_teardown_claims',
          'sandbox_provider_loss_receipts'
        )
        order by c.relname
      `;
      expect(Array.from(tables)).toEqual([
        {
          relname: "sandbox_provider_loss_receipts",
          relforcerowsecurity: true,
        },
        {
          relname: "sandbox_provider_loss_teardown_claims",
          relforcerowsecurity: true,
        },
      ]);

      const sessionVisibilityPolicies = await shared.admin<
        { tableName: string; expression: string; checkExpression: string }[]
      >`
        select
          target.relname as "tableName",
          pg_get_expr(policy.polqual, policy.polrelid) as expression,
          pg_get_expr(policy.polwithcheck, policy.polrelid) as "checkExpression"
        from pg_policy policy
        join pg_class target on target.oid = policy.polrelid
        where target.relname in (
          'sandbox_provider_loss_teardown_claims',
          'sandbox_provider_loss_receipts'
        )
          and policy.polname = 'session_visibility_isolation'
          and policy.polpermissive = false
        order by target.relname
      `;
      expect(Array.from(sessionVisibilityPolicies)).toEqual([
        {
          tableName: "sandbox_provider_loss_receipts",
          expression: "session_reference_visible(account_id, workspace_id, session_id)",
          checkExpression: "session_reference_visible(account_id, workspace_id, session_id)",
        },
        {
          tableName: "sandbox_provider_loss_teardown_claims",
          expression: "session_reference_visible(account_id, workspace_id, session_id)",
          checkExpression: "session_reference_visible(account_id, workspace_id, session_id)",
        },
      ]);

      const columns = await shared.admin<
        { tableName: string; columnName: string; dataType: string }[]
      >`
        select table_name as "tableName", column_name as "columnName", data_type as "dataType"
        from information_schema.columns
        where table_name in (
          'sandbox_provider_loss_teardown_claims',
          'sandbox_provider_loss_receipts'
        )
          and column_name in ('claim_id', 'admission_id', 'terminate_outcome', 'consumed_at')
        order by table_name, column_name
      `;
      expect(Array.from(columns)).toEqual([
        {
          tableName: "sandbox_provider_loss_receipts",
          columnName: "admission_id",
          dataType: "uuid",
        },
        {
          tableName: "sandbox_provider_loss_receipts",
          columnName: "claim_id",
          dataType: "uuid",
        },
        {
          tableName: "sandbox_provider_loss_receipts",
          columnName: "consumed_at",
          dataType: "timestamp with time zone",
        },
        {
          tableName: "sandbox_provider_loss_receipts",
          columnName: "terminate_outcome",
          dataType: "text",
        },
        {
          tableName: "sandbox_provider_loss_teardown_claims",
          columnName: "admission_id",
          dataType: "uuid",
        },
        {
          tableName: "sandbox_provider_loss_teardown_claims",
          columnName: "consumed_at",
          dataType: "timestamp with time zone",
        },
      ]);

      const constraints = await shared.admin<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'sandbox_workspace_mutation_admissions_outcome_check',
          'sandbox_workspace_mutation_admissions_settlement_check',
          'sandbox_provider_loss_teardown_claims_identity_check',
          'sandbox_provider_loss_receipts_identity_check',
          'sandbox_provider_loss_receipts_claim_scope_fk'
        )
        order by conname
      `;
      expect(constraints.map((row) => row.name)).toEqual([
        "sandbox_provider_loss_receipts_claim_scope_fk",
        "sandbox_provider_loss_receipts_identity_check",
        "sandbox_provider_loss_teardown_claims_identity_check",
        "sandbox_workspace_mutation_admissions_outcome_check",
        "sandbox_workspace_mutation_admissions_settlement_check",
      ]);
      expect(constraints.find((row) => row.name.endsWith("outcome_check"))?.definition).toContain(
        "unknown",
      );
      expect(
        constraints.find((row) => row.name.endsWith("settlement_check"))?.definition,
      ).toContain("unknown");

      const triggers = await shared.admin<{ name: string; tableName: string }[]>`
        select trigger.tgname as name, target.relname as "tableName"
        from pg_trigger trigger
        join pg_class target on target.oid = trigger.tgrelid
        where not trigger.tgisinternal
          and trigger.tgname in (
            'sandbox_provider_loss_claim_mutation_guard',
            'sandbox_provider_loss_receipt_mutation_guard',
            'sandbox_provider_loss_claim_admission_fence',
            'sandbox_provider_loss_claim_holder_fence',
            'sandbox_provider_loss_claim_retained_process_fence',
            'sandbox_provider_loss_lease_mutation_fence',
            'sandbox_provider_loss_lease_delete_fence'
          )
        order by trigger.tgname
      `;
      expect(Array.from(triggers)).toEqual([
        {
          name: "sandbox_provider_loss_claim_admission_fence",
          tableName: "sandbox_workspace_mutation_admissions",
        },
        {
          name: "sandbox_provider_loss_claim_holder_fence",
          tableName: "sandbox_lease_holders",
        },
        {
          name: "sandbox_provider_loss_claim_mutation_guard",
          tableName: "sandbox_provider_loss_teardown_claims",
        },
        {
          name: "sandbox_provider_loss_claim_retained_process_fence",
          tableName: "sandbox_retained_processes",
        },
        {
          name: "sandbox_provider_loss_lease_delete_fence",
          tableName: "sandbox_leases",
        },
        {
          name: "sandbox_provider_loss_lease_mutation_fence",
          tableName: "sandbox_leases",
        },
        {
          name: "sandbox_provider_loss_receipt_mutation_guard",
          tableName: "sandbox_provider_loss_receipts",
        },
      ]);

      const functions = await shared.admin<
        Array<{
          name: string;
          source: string;
          appExecute: boolean;
          dispatcherExecute: boolean;
          publicExecute: boolean;
        }>
      >`
        select p.proname as name,
               pg_get_functiondef(p.oid) as source,
               has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as "appExecute",
               exists (
                 select 1
                 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 join pg_roles role on role.oid = acl.grantee
                 where role.rolname = 'opengeni_artifact_outbox_dispatcher'
                   and acl.privilege_type = 'EXECUTE'
               ) as "dispatcherExecute",
               exists (
                 select 1
                 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
               ) as "publicExecute"
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private'
          and p.proname in (
            'guard_provider_loss_claim_mutation',
            'guard_provider_loss_receipt_mutation',
            'guard_provider_loss_claim_fence',
            'guard_provider_loss_lease_mutation'
          )
        order by p.proname
      `;
      expect(functions.map((fn) => fn.name)).toEqual([
        "guard_provider_loss_claim_fence",
        "guard_provider_loss_claim_mutation",
        "guard_provider_loss_lease_mutation",
        "guard_provider_loss_receipt_mutation",
      ]);
      for (const fn of functions) {
        expect(fn.appExecute).toBe(false);
        expect(fn.dispatcherExecute).toBe(false);
        expect(fn.publicExecute).toBe(false);
        expect(fn.source).not.toContain("NEW.* IS DISTINCT FROM OLD");
      }
      const leaseMutationFunction = functions.find((fn) =>
        fn.source.includes("guard_provider_loss_lease_mutation"),
      );
      expect(leaseMutationFunction?.source).toContain("TG_OP = 'DELETE'");
      expect(leaseMutationFunction?.source).toContain("RETURN OLD");
      expect(leaseMutationFunction?.source).toContain("claim.lease_id = OLD.id");
      expect(leaseMutationFunction?.source).toContain("sandbox_provider_loss_claim_id");
      expect(leaseMutationFunction?.source).toContain("sandbox_provider_loss_transition_sha256");
      expect(leaseMutationFunction?.source).toContain("old_row := to_jsonb(OLD)");
      expect(leaseMutationFunction?.source).toContain("new_row := to_jsonb(NEW)");
      expect(leaseMutationFunction?.source).not.toContain("NEW.archive_capture_takeover_safe");
      const [transitionDigestFunction] = await shared.admin<
        Array<{ appExecute: boolean; publicExecute: boolean; source: string }>
      >`
        select
          has_function_privilege(
            'opengeni_app',
            'opengeni_private.provider_loss_transition_sha256(jsonb)',
            'EXECUTE'
          ) as "appExecute",
          exists (
            select 1
            from pg_proc function
            cross join lateral aclexplode(
              coalesce(function.proacl, acldefault('f', function.proowner))
            ) acl
            where function.oid =
              'opengeni_private.provider_loss_transition_sha256(jsonb)'::regprocedure
              and acl.grantee = 0
              and acl.privilege_type = 'EXECUTE'
          ) as "publicExecute",
          pg_get_functiondef(
            'opengeni_private.provider_loss_transition_sha256(jsonb)'::regprocedure
          ) as source
      `;
      expect(transitionDigestFunction).toMatchObject({
        appExecute: true,
        publicExecute: false,
      });
      expect(transitionDigestFunction?.source).toContain("digest(");
      expect(transitionDigestFunction?.source).toContain("SET search_path TO 'pg_catalog'");
      const leaseColumns = await shared.admin<Array<{ columnName: string }>>`
        select column_name as "columnName"
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'sandbox_leases'
        order by column_name
      `;
      expect(leaseColumns.map((column) => column.columnName)).toEqual(
        [
          ...claimTimestampOnlyColumns,
          ...claimExactAtomicTransitionColumns,
          ...claimInvariantColumns,
        ].sort(),
      );
      const mutationFunctions = functions.filter((fn) => fn.name.endsWith("_mutation"));
      expect(mutationFunctions).toHaveLength(3);
      for (const fn of mutationFunctions) {
        expect(fn.source).toContain("consumed_at");
      }
      const [leaseMutationTrigger] = await shared.admin<Array<{ definition: string }>>`
        select pg_get_triggerdef(oid) as definition
        from pg_trigger
        where tgname = 'sandbox_provider_loss_lease_mutation_fence'
          and not tgisinternal
      `;
      expect(leaseMutationTrigger?.definition).toContain("BEFORE UPDATE ON");
      expect(leaseMutationTrigger?.definition).not.toContain("UPDATE OF");
      const securityFunctions = await shared.admin<
        {
          name: string;
          securityDefiner: boolean;
          config: string[] | null;
        }[]
      >`
        select p.proname as name,
               p.prosecdef as "securityDefiner",
               p.proconfig as config
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private'
          and p.proname in ('guard_provider_loss_claim_fence', 'guard_provider_loss_lease_mutation')
        order by p.proname
      `;
      expect(securityFunctions).toHaveLength(2);
      for (const fn of securityFunctions) {
        expect(fn.securityDefiner).toBe(true);
        expect(fn.config?.some((entry) => entry.startsWith("search_path=pg_catalog,"))).toBe(true);
      }
    } finally {
      await shared.release();
    }
  }, 180_000);

  test("claims and consumes a NULL-quiesced superseded renewal exactly once", async () => {
    const shared = await acquireSharedTestDatabase("migration-0240-provider-loss-receipts-e2e");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("[migration-0240-e2e] PostgreSQL is required but unavailable");
      }
      return;
    }
    const app = createDb(shared.appUrl);
    try {
      await migrate(shared.adminUrl);
      const [account] = await shared.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0240-e2e-account') returning id`;
      const [workspace] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'migration-0240-e2e-workspace') returning id`;
      await shared.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;

      const cleanAcquire = await acquireLease(app.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sandboxGroupId: randomUUID(),
        kind: "turn",
        holderId: "provider-loss-acl-cold-to-warming",
        backend: "modal",
        leaseTtlMs: 45_000,
      });
      expect(cleanAcquire.role).toBe("spawner");
      expect(cleanAcquire.lease.liveness).toBe("warming");

      const session = await createSession(app.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initialMessage: "provider-loss e2e",
        resources: [],
        metadata: {},
        model: "test-model",
        sandboxBackend: "modal",
      });
      const turnEvent = await shared.admin<{ id: string }[]>`
        insert into session_events
          (account_id, workspace_id, session_id, sequence, type, payload)
        values
          (${account!.id}, ${workspace!.id}, ${session.id}, 1, 'user.message', ${JSON.stringify({ text: "provider-loss e2e" })}::jsonb)
        returning id`;
      await shared.admin`
        update sessions set last_sequence = 1
        where workspace_id = ${workspace!.id} and id = ${session.id}`;
      const [turn] = await shared.admin<{ id: string; execution_generation: number }[]>`
        insert into session_turns
          (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
           status, source, position, prompt, resources, tools, model, reasoning_effort,
           sandbox_backend, execution_generation, metadata, lineage)
        values
          (${account!.id}, ${workspace!.id}, ${session.id}, ${turnEvent[0]!.id},
           ${`session-${session.id}`}, 'completed', 'user', 0, 'provider-loss e2e',
           '[]'::jsonb, '[]'::jsonb, 'test-model', 'medium', 'modal', 1, '{}'::jsonb, '{}'::jsonb)
        returning id, execution_generation`;
      const attemptId = randomUUID();
      await shared.admin`
        insert into session_turn_attempts
          (id, account_id, workspace_id, session_id, turn_id, execution_generation,
           state, outcome, temporal_workflow_id, temporal_workflow_run_id,
           temporal_activity_id, verified_control_revision, mcp_approval_policies, closed_at)
        values
          (${attemptId}, ${account!.id}, ${workspace!.id}, ${session.id}, ${turn!.id},
           ${turn!.execution_generation}, 'closed', 'superseded', ${`session-${session.id}`},
           'provider-loss-e2e-run', 'provider-loss-e2e-activity', 0, '{}'::jsonb, now())`;
      const [command] = await shared.admin<{ id: string }[]>`
        insert into session_command_receipts
          (account_id, workspace_id, actor_type, actor_subject_id, action,
           target_session_id, target_turn_id, operation_key, canonical_request_hash)
        values
          (${account!.id}, ${workspace!.id}, 'human', 'provider-loss-e2e', 'session.queue.steer',
           ${session.id}, ${turn!.id}, ${randomUUID()}, 'provider-loss-e2e')
        returning id`;
      await shared.admin`
        insert into session_attempt_interruptions
          (account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision,
           state, settled_at)
        values
          (${account!.id}, ${workspace!.id}, ${session.id}, ${command!.id}, ${attemptId},
           'steer', 1, 'settled', now())`;

      const leaseId = randomUUID();
      const providerInstanceId = "modal-provider-loss-e2e";
      await shared.admin`
        insert into sandbox_leases
          (id, account_id, workspace_id, sandbox_group_id, liveness, backend,
           instance_id, lease_epoch, workspace_generation, refcount, expires_at)
        values
          (${leaseId}, ${account!.id}, ${workspace!.id}, ${session.sandboxGroupId}, 'draining',
           'modal', ${providerInstanceId}, 7, 1, 0, now() - interval '1 second')`;
      const admissionId = randomUUID();
      await shared.admin`
        insert into sandbox_workspace_mutation_admissions
          (id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
           actor_kind, actor_id, turn_id, attempt_id, execution_generation,
           holder_kind, holder_id, lease_epoch, provider_backend, provider_instance_id,
           route_kind, route_target_id, route_epoch, workspace_generation, operation)
        values
          (${admissionId}, ${account!.id}, ${workspace!.id}, ${leaseId}, ${session.sandboxGroupId},
           ${session.id}, 'turn', ${attemptId}, ${turn!.id}, ${attemptId}, ${turn!.execution_generation},
           'turn', ${`turn-attempt:${attemptId}`}, 7, 'modal', ${providerInstanceId},
           'home', null, 0, 1, 'codemodeTokenRenewal')`;

      const claimId = randomUUID();
      const claimInput = {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sandboxGroupId: session.sandboxGroupId,
        expectedEpoch: 7,
        expectedInstanceId: providerInstanceId,
        claimId,
      };
      const pendingCommandId = randomUUID();
      const [pendingInterruption] = await shared.admin<{ id: string }[]>`
        insert into session_command_receipts
          (id, account_id, workspace_id, actor_type, actor_subject_id, action,
           target_session_id, target_turn_id, operation_key, canonical_request_hash)
        values
          (${pendingCommandId}, ${account!.id}, ${workspace!.id}, 'human', 'provider-loss-pending',
           'session.queue.steer', ${session.id}, ${turn!.id}, ${randomUUID()}, 'provider-loss-pending')
        returning id`;
      const pendingAttemptInterruptionId = randomUUID();
      await shared.admin`
        insert into session_attempt_interruptions
          (id, account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision)
        values
          (${pendingAttemptInterruptionId}, ${account!.id}, ${workspace!.id}, ${session.id},
           ${pendingInterruption!.id}, ${attemptId}, 'steer', 2)`;
      expect((await claimProviderLossTeardown(app.db, claimInput)).status).toBe("not_eligible");
      await shared.admin`
        delete from session_attempt_interruptions where id = ${pendingAttemptInterruptionId}::uuid`;
      await shared.admin`
        delete from session_command_receipts where id = ${pendingCommandId}::uuid`;

      await shared.admin`
        update session_turn_attempts set state = 'running', outcome = null, closed_at = null
        where id = ${attemptId}::uuid`;
      expect((await claimProviderLossTeardown(app.db, claimInput)).status).toBe("not_eligible");
      await shared.admin`
        update session_turn_attempts set state = 'closed', outcome = 'superseded', closed_at = now()
        where id = ${attemptId}::uuid`;

      const unrelatedAdmissionId = randomUUID();
      await shared.admin`
        insert into sandbox_workspace_mutation_admissions
          (id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
           actor_kind, actor_id, holder_kind, holder_id, lease_epoch, provider_backend,
           provider_instance_id, route_kind, route_target_id, route_epoch,
           workspace_generation, operation)
        values
          (${unrelatedAdmissionId}, ${account!.id}, ${workspace!.id}, ${leaseId}, ${session.sandboxGroupId},
           ${session.id}, 'direct', ${randomUUID()}, 'direct', 'provider-loss-unrelated-open',
           7, 'modal', ${providerInstanceId}, 'home', null, 0, 2, 'provider-loss-unrelated')`;
      expect((await claimProviderLossTeardown(app.db, claimInput)).status).toBe("not_eligible");
      await shared.admin`
        delete from sandbox_workspace_mutation_admissions where id = ${unrelatedAdmissionId}::uuid`;

      const liveHolderId = randomUUID();
      await shared.admin`
        insert into sandbox_lease_holders
          (id, account_id, workspace_id, lease_id, kind, holder_id, subject_id)
        values
          (${randomUUID()}, ${account!.id}, ${workspace!.id}, ${leaseId}, 'viewer', ${liveHolderId}, ${session.id})`;
      expect((await claimProviderLossTeardown(app.db, claimInput)).status).toBe("not_eligible");
      await shared.admin`
        delete from sandbox_lease_holders
        where lease_id = ${leaseId}::uuid and holder_id = ${liveHolderId}`;

      const concurrentClaims = await Promise.all([
        claimProviderLossTeardown(app.db, claimInput),
        claimProviderLossTeardown(app.db, claimInput),
      ]);
      expect(concurrentClaims.map((result) => result.status)).toEqual(["claimed", "claimed"]);
      expect(
        await claimProviderLossTeardown(app.db, {
          ...claimInput,
          claimId: randomUUID(),
        }),
      ).toEqual({ status: "not_eligible", reason: "claim_race" });

      const receiptId = randomUUID();
      const observationInput = {
        accountId: account!.id,
        workspaceId: workspace!.id,
        claimId,
        receiptId,
        destructionCorrelationId: "modal-destruction-e2e-1",
        providerBackend: "modal" as const,
        providerInstanceId,
        terminateOutcome: "terminated" as const,
        postDestructionStatus: "not_found" as const,
        postDestructionInstanceId: providerInstanceId,
      };
      expect(
        await persistSandboxProviderLossObservation(app.db, {
          ...observationInput,
          postDestructionStatus: "terminated",
        }),
      ).toEqual({ status: "rejected", reason: "not_found_not_authoritative" });
      expect(await persistSandboxProviderLossObservation(app.db, observationInput)).toEqual({
        status: "persisted",
        receiptId,
      });
      expect(await persistSandboxProviderLossObservation(app.db, observationInput)).toEqual({
        status: "already_persisted",
        receiptId,
      });
      expect(
        await persistSandboxProviderLossObservation(app.db, {
          ...observationInput,
          receiptId: randomUUID(),
        }),
      ).toEqual({ status: "rejected", reason: "provider_identity_mismatch" });
      expect(
        await persistSandboxProviderLossObservation(app.db, {
          ...observationInput,
          destructionCorrelationId: "modal-destruction-e2e-mismatch",
        }),
      ).toEqual({ status: "rejected", reason: "provider_identity_mismatch" });
      expect(
        await persistSandboxProviderLossObservation(app.db, {
          ...observationInput,
          providerInstanceId: "modal-provider-loss-other",
          postDestructionInstanceId: "modal-provider-loss-other",
        }),
      ).toEqual({ status: "rejected", reason: "provider_identity_mismatch" });
      expect(
        await persistSandboxProviderLossObservation(app.db, {
          ...observationInput,
          terminateOutcome: "not_found",
        }),
      ).toEqual({ status: "rejected", reason: "provider_identity_mismatch" });

      await shared.admin`
        update sandbox_leases set updated_at = now() where id = ${leaseId}::uuid`;
      await shared.admin`
        update sandbox_leases set
          archive_capture_id = archive_capture_id,
          archive_capture_operation_id = archive_capture_operation_id,
          archive_capture_provider_request_id = archive_capture_provider_request_id,
          archive_capture_provider_replay_safe = archive_capture_provider_replay_safe,
          archive_capture_takeover_safe = archive_capture_takeover_safe,
          archive_capture_attempt = archive_capture_attempt,
          archive_capture_generation = archive_capture_generation,
          archive_capture_started_at = archive_capture_started_at,
          archive_capture_deadline_at = archive_capture_deadline_at,
          archive_capture_published_at = archive_capture_published_at,
          reaper_hold_id = reaper_hold_id,
          reaper_hold_until = reaper_hold_until,
          reaper_hold_reason = reaper_hold_reason,
          rotation_requested_at = rotation_requested_at,
          rotation_reason = rotation_reason
        where id = ${leaseId}::uuid`;

      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set lease_epoch = 8
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set account_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set workspace_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set sandbox_group_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set liveness = 'warm'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set refcount = 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set turn_holders = 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set viewer_holders = 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set instance_id = 'modal-provider-loss-forbidden-instance'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set backend = 'docker'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set os = 'darwin'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set image = 'provider-loss-forbidden-image'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set rig_version_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set data_plane_url = 'https://forbidden.example/data'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set terminal_data_plane_url = 'https://forbidden.example/terminal'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set controller_data_plane_url = 'https://forbidden.example/controller'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set workspace_generation = workspace_generation + 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_generation = workspace_generation
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set resume_backend_id = 'modal'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set resume_state = '{"forged":true}'::jsonb
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set provider_created_at = now()
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set provider_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set current_checkpoint_artifact_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set previous_checkpoint_artifact_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set last_meter_tick = last_meter_tick + 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set last_meter_at = now()
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set expires_at = expires_at + interval '1 minute'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set created_at = created_at - interval '1 second'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin.begin(async (tx) => {
          await tx`
            select set_config(
              'opengeni.sandbox_provider_loss_claim_id', ${claimId}, true
            )`;
          await tx`
            select set_config(
              'opengeni.sandbox_provider_loss_transition_sha256',
              opengeni_private.provider_loss_transition_sha256(
                jsonb_build_object(
                  'resumeBackendId', 'modal'::text,
                  'resumeState', '{}'::jsonb
                )
              ),
              true
            )`;
          await tx`
            update sandbox_leases set
              liveness = 'cold',
              instance_id = null,
              data_plane_url = null,
              terminal_data_plane_url = null,
              controller_data_plane_url = null,
              lease_epoch = lease_epoch + 1,
              resume_backend_id = 'modal',
              resume_state = '{}'::jsonb,
              provider_created_at = null,
              provider_deadline_at = null,
              rotation_requested_at = null,
              rotation_reason = null,
              archive_capture_id = null,
              archive_capture_operation_id = null,
              archive_capture_provider_request_id = null,
              archive_capture_provider_replay_safe = false,
              archive_capture_takeover_safe = false,
              archive_capture_attempt = null,
              archive_capture_generation = null,
              archive_capture_started_at = null,
              archive_capture_deadline_at = null,
              archive_capture_published_at = null,
              backend = 'docker',
              updated_at = now()
            where id = ${leaseId}::uuid
          `;
        }),
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_operation_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_provider_request_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_provider_replay_safe = true
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_takeover_safe = true
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_attempt = 1
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_generation = workspace_generation
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_started_at = now()
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set archive_capture_published_at = now()
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set reaper_hold_id = ${randomUUID()}::uuid
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set reaper_hold_until = now() + interval '1 minute'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set reaper_hold_reason = 'provider-loss-forbidden-hold'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set rotation_requested_at = now()
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        update sandbox_leases
        set rotation_reason = 'operator'
        where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        delete from sandbox_leases where id = ${leaseId}::uuid
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        insert into sandbox_lease_holders
          (account_id, workspace_id, lease_id, kind, holder_id, subject_id)
        values
          (${account!.id}, ${workspace!.id}, ${leaseId}, 'viewer', 'provider-loss-fenced-holder', ${session.id})
      `,
        "55000",
      );

      await expectSqlState(
        withRlsContext(app.db, { accountId: account!.id, workspaceId: workspace!.id }, async (db) =>
          db.execute(sql`
            insert into sandbox_lease_holders
              (account_id, workspace_id, lease_id, kind, holder_id, subject_id)
            values
              (${account!.id}, ${workspace!.id}, ${leaseId}::uuid, 'viewer',
               'provider-loss-app-role-fenced-holder', ${session.id}::uuid)
          `),
        ),
        "55000",
      );
      await expectSqlState(
        shared.admin`
        insert into sandbox_workspace_mutation_admissions
          (id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
           actor_kind, actor_id, holder_kind, holder_id, lease_epoch, provider_backend,
           provider_instance_id, route_kind, route_target_id, route_epoch,
           workspace_generation, operation)
        values
          (${randomUUID()}, ${account!.id}, ${workspace!.id}, ${leaseId}, ${session.sandboxGroupId},
           ${session.id}, 'direct', ${randomUUID()}, 'direct', 'provider-loss-fenced-admission',
           7, 'modal', ${providerInstanceId}, 'home', null, 0, 2, 'provider-loss-fenced')
      `,
        "55000",
      );
      await expectSqlState(
        shared.admin`
        insert into sandbox_retained_processes
          (id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
           parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
           lease_epoch, provider_backend, provider_instance_id, route_kind,
           route_target_id, route_epoch, provider_session_id)
        values
          (${randomUUID()}, ${account!.id}, ${workspace!.id}, ${session.id}, ${leaseId},
           ${session.sandboxGroupId}, ${admissionId}, 'provider-loss-fenced-process', 'direct',
           ${randomUUID()}, 7, 'modal', ${providerInstanceId}, 'home', null, 0, 1)
      `,
        "55000",
      );

      const consumeInput = {
        accountId: account!.id,
        workspaceId: workspace!.id,
        receiptId,
        claimId,
        admissionId,
        leaseId,
        leaseEpoch: 7,
        providerInstanceId,
      };
      let releaseLeaseLock!: () => void;
      let leaseLockReady!: () => void;
      const leaseLockReleased = new Promise<void>((resolve) => {
        releaseLeaseLock = resolve;
      });
      const leaseLocked = new Promise<void>((resolve) => {
        leaseLockReady = resolve;
      });
      const leaseLock = shared.admin.begin(async (tx) => {
        await tx`select id from sandbox_leases where id = ${leaseId}::uuid for update`;
        leaseLockReady();
        await leaseLockReleased;
      });
      await leaseLocked;

      const waitForLeaseLockWaiters = async (minimum: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [waiters] = await shared.admin<{ count: number }[]>`
            select count(*)::int as count
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%sandbox_leases%'
          `;
          if ((waiters?.count ?? 0) >= minimum) return;
          await Bun.sleep(10);
        }
        throw new Error(`timed out waiting for ${minimum} lease lock waiter(s)`);
      };

      const consuming = consumeSandboxProviderLossReceipt(app.db, consumeInput);
      await waitForLeaseLockWaiters(1);
      const acquiring = acquireLease(app.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sandboxGroupId: session.sandboxGroupId,
        kind: "turn",
        holderId: "provider-loss-race-acquire",
        backend: "modal",
        leaseTtlMs: 45_000,
      });
      await waitForLeaseLockWaiters(2);
      releaseLeaseLock();
      await leaseLock;

      expect(await consuming).toEqual({ status: "consumed", admissionId });
      const racedAcquire = await acquiring;
      expect(racedAcquire.role).not.toBe("spawner");
      expect(racedAcquire.role).not.toBe("rearmed");
      expect(await consumeSandboxProviderLossReceipt(app.db, consumeInput)).toEqual({
        status: "already_consumed",
        admissionId,
      });

      const [state] = await shared.admin<
        {
          provider_outcome: string | null;
          settled_at: Date | null;
          claim_consumed_at: Date | null;
          receipt_consumed_at: Date | null;
          liveness: string;
          lease_epoch: number;
        }[]
      >`
        select admission.provider_outcome, admission.settled_at,
               claim.consumed_at as claim_consumed_at,
               receipt.consumed_at as receipt_consumed_at,
               lease.liveness,
               lease.lease_epoch
        from sandbox_workspace_mutation_admissions admission
        join sandbox_provider_loss_teardown_claims claim on claim.id = ${claimId}::uuid
        join sandbox_provider_loss_receipts receipt on receipt.id = ${receiptId}::uuid
        join sandbox_leases lease on lease.id = ${leaseId}::uuid
        where admission.id = ${admissionId}::uuid`;
      expect(state).toMatchObject({ provider_outcome: "unknown" });
      expect(state?.settled_at).toBeTruthy();
      expect(state?.claim_consumed_at).toBeTruthy();
      expect(state?.receipt_consumed_at).toBeTruthy();
      expect(state).toMatchObject({ liveness: "cold", lease_epoch: 8 });

      await shared.admin`
        update sandbox_leases set
          rotation_requested_at = now(),
          rotation_reason = 'operator'
        where id = ${leaseId}::uuid`;
      const [releasedLease] = await shared.admin<
        Array<{
          rotationRequestedAt: Date | null;
          rotationReason: string | null;
        }>
      >`
        select rotation_requested_at as "rotationRequestedAt",
               rotation_reason as "rotationReason"
        from sandbox_leases
        where id = ${leaseId}::uuid`;
      expect(releasedLease?.rotationRequestedAt).toBeInstanceOf(Date);
      expect(releasedLease?.rotationReason).toBe("operator");
    } finally {
      await app.close();
      await shared.release();
    }
  }, 180_000);
});
