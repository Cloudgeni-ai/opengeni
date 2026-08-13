import { describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

import {
  claimProviderLossTeardown,
  consumeSandboxProviderLossReceipt,
  createDb,
  createSession,
  persistSandboxProviderLossObservation,
} from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0238_sandbox_provider_loss_receipts.sql";

describe("0238 provider-loss receipt protocol", () => {
  test("installs the distinct claim/receipt state machine and hard fences", async () => {
    const shared = await acquireSharedTestDatabase("migration-0238-provider-loss-receipts");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("[migration-0238] PostgreSQL is required but unavailable");
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
        { relname: "sandbox_provider_loss_receipts", relforcerowsecurity: true },
        { relname: "sandbox_provider_loss_teardown_claims", relforcerowsecurity: true },
      ]);

      const columns = await shared.admin<{ tableName: string; columnName: string; dataType: string }[]>`
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
        { tableName: "sandbox_provider_loss_receipts", columnName: "admission_id", dataType: "uuid" },
        { tableName: "sandbox_provider_loss_receipts", columnName: "claim_id", dataType: "uuid" },
        { tableName: "sandbox_provider_loss_receipts", columnName: "consumed_at", dataType: "timestamp with time zone" },
        { tableName: "sandbox_provider_loss_receipts", columnName: "terminate_outcome", dataType: "text" },
        { tableName: "sandbox_provider_loss_teardown_claims", columnName: "admission_id", dataType: "uuid" },
        { tableName: "sandbox_provider_loss_teardown_claims", columnName: "consumed_at", dataType: "timestamp with time zone" },
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
      expect(constraints.find((row) => row.name.endsWith("settlement_check"))?.definition).toContain(
        "unknown",
      );

      const triggers = await shared.admin<{ name: string; tableName: string }[]>`
        select trigger_name as name, event_object_table as "tableName"
        from information_schema.triggers
        where trigger_name in (
          'sandbox_provider_loss_claim_mutation_guard',
          'sandbox_provider_loss_receipt_mutation_guard',
          'sandbox_provider_loss_claim_admission_fence',
          'sandbox_provider_loss_claim_holder_fence',
          'sandbox_provider_loss_claim_retained_process_fence',
          'sandbox_provider_loss_lease_mutation_fence',
          'sandbox_provider_loss_lease_delete_fence'
        )
        order by trigger_name
      `;
      expect(Array.from(triggers)).toEqual([
        { name: "sandbox_provider_loss_claim_admission_fence", tableName: "sandbox_workspace_mutation_admissions" },
        { name: "sandbox_provider_loss_claim_holder_fence", tableName: "sandbox_lease_holders" },
        { name: "sandbox_provider_loss_claim_retained_process_fence", tableName: "sandbox_retained_processes" },
        { name: "sandbox_provider_loss_lease_delete_fence", tableName: "sandbox_leases" },
        { name: "sandbox_provider_loss_claim_mutation_guard", tableName: "sandbox_provider_loss_teardown_claims" },
        { name: "sandbox_provider_loss_lease_mutation_fence", tableName: "sandbox_leases" },
        { name: "sandbox_provider_loss_receipt_mutation_guard", tableName: "sandbox_provider_loss_receipts" },
      ]);

      const functions = await shared.admin<Array<{ source: string }>>`
        select pg_get_functiondef(p.oid) as source
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private'
          and p.proname in (
            'guard_provider_loss_claim_mutation',
            'guard_provider_loss_receipt_mutation',
            'guard_provider_loss_lease_mutation'
          )
      `;
      expect(functions).toHaveLength(3);
      for (const fn of functions) {
        expect(fn.source).not.toContain("NEW.* IS DISTINCT FROM OLD");
        expect(fn.source).toContain("consumed_at");
      }
      const leaseMutationFunction = functions.find((fn) => fn.source.includes("guard_provider_loss_lease_mutation"));
      expect(leaseMutationFunction?.source).toContain("TG_OP = 'DELETE'");
      expect(leaseMutationFunction?.source).toContain("RETURN OLD");
      expect(leaseMutationFunction?.source).toContain("OLD.lease_id");
    } finally {
      await shared.release();
    }
  }, 180_000);

  test("claims and consumes a NULL-quiesced superseded renewal exactly once", async () => {
    const shared = await acquireSharedTestDatabase("migration-0238-provider-loss-receipts-e2e");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("[migration-0238-e2e] PostgreSQL is required but unavailable");
      }
      return;
    }
    const app = createDb(shared.appUrl);
    try {
      await migrate(shared.adminUrl);
      const [account] = await shared.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0238-e2e-account') returning id`;
      const [workspace] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'migration-0238-e2e-workspace') returning id`;
      await shared.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;

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
           sandbox_backend, metadata, lineage)
        values
          (${account!.id}, ${workspace!.id}, ${session.id}, ${turnEvent[0]!.id},
           ${`session-${session.id}`}, 'completed', 'user', 0, 'provider-loss e2e',
           '[]'::jsonb, '[]'::jsonb, 'test-model', 'medium', 'modal', '{}'::jsonb, '{}'::jsonb)
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
           instance_id, lease_epoch, refcount, expires_at)
        values
          (${leaseId}, ${account!.id}, ${workspace!.id}, ${session.sandboxGroupId}, 'draining',
           'modal', ${providerInstanceId}, 7, 0, now() - interval '1 second')`;
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
        delete from session_attempt_interruptions where id = ${pendingAttemptInterruptionId}::uuid;
        delete from session_command_receipts where id = ${pendingCommandId}::uuid`;

      await shared.admin`
        update session_turn_attempts set state = 'running', closed_at = null
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
        await claimProviderLossTeardown(app.db, { ...claimInput, claimId: randomUUID() }),
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

      await expect(shared.admin`
        update sandbox_leases
        set lease_epoch = 8
        where id = ${leaseId}::uuid
      `).rejects.toMatchObject({ code: "55000" });
      await expect(shared.admin`
        delete from sandbox_leases where id = ${leaseId}::uuid
      `).rejects.toMatchObject({ code: "55000" });
      await expect(shared.admin`
        insert into sandbox_lease_holders
          (account_id, workspace_id, lease_id, kind, holder_id, subject_id)
        values
          (${account!.id}, ${workspace!.id}, ${leaseId}, 'viewer', 'provider-loss-fenced-holder', ${session.id})
      `).rejects.toMatchObject({ code: "55000" });
      await expect(shared.admin`
        insert into sandbox_workspace_mutation_admissions
          (id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
           actor_kind, actor_id, holder_kind, holder_id, lease_epoch, provider_backend,
           provider_instance_id, route_kind, route_target_id, route_epoch,
           workspace_generation, operation)
        values
          (${randomUUID()}, ${account!.id}, ${workspace!.id}, ${leaseId}, ${session.sandboxGroupId},
           ${session.id}, 'direct', ${randomUUID()}, 'direct', 'provider-loss-fenced-admission',
           7, 'modal', ${providerInstanceId}, 'home', null, 0, 2, 'provider-loss-fenced')
      `).rejects.toMatchObject({ code: "55000" });
      await expect(shared.admin`
        insert into sandbox_retained_processes
          (id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
           parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
           lease_epoch, provider_backend, provider_instance_id, route_kind,
           route_target_id, route_epoch, provider_session_id)
        values
          (${randomUUID()}, ${account!.id}, ${workspace!.id}, ${session.id}, ${leaseId},
           ${session.sandboxGroupId}, ${admissionId}, 'provider-loss-fenced-process', 'direct',
           ${randomUUID()}, 7, 'modal', ${providerInstanceId}, 'home', null, 0, 1)
      `).rejects.toMatchObject({ code: "55000" });

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
      expect(await consumeSandboxProviderLossReceipt(app.db, consumeInput)).toEqual({
        status: "consumed",
        admissionId,
      });
      expect(await consumeSandboxProviderLossReceipt(app.db, consumeInput)).toEqual({
        status: "already_consumed",
        admissionId,
      });

      const [state] = await shared.admin<{
        provider_outcome: string | null;
        settled_at: Date | null;
        claim_consumed_at: Date | null;
        receipt_consumed_at: Date | null;
      }[]>`
        select admission.provider_outcome, admission.settled_at,
               claim.consumed_at as claim_consumed_at,
               receipt.consumed_at as receipt_consumed_at
        from sandbox_workspace_mutation_admissions admission
        join sandbox_provider_loss_teardown_claims claim on claim.id = ${claimId}::uuid
        join sandbox_provider_loss_receipts receipt on receipt.id = ${receiptId}::uuid
        where admission.id = ${admissionId}::uuid`;
      expect(state).toMatchObject({ provider_outcome: "unknown" });
      expect(state?.settled_at).toBeTruthy();
      expect(state?.claim_consumed_at).toBeTruthy();
      expect(state?.receipt_consumed_at).toBeTruthy();
      await shared.admin`
        update sandbox_leases
        set liveness = 'cold', instance_id = null, lease_epoch = 8
        where id = ${leaseId}::uuid`;
    } finally {
      await app.close();
      await shared.release();
    }
  }, 180_000);
});
