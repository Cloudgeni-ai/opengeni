import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0138_sandbox_checkpoint_artifacts_and_deadlines.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

function modalCheckpointFixture(snapshotId: string, capturedAtMs: number) {
  const bytes = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({
      snapshot_id: snapshotId,
      workspace_persistence: "snapshot_filesystem",
    })}`,
  );
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    archiveBase64: bytes.toString("base64"),
    descriptor: {
      version: 2,
      kind: "provider_snapshot",
      revision: `wa2:${capturedAtMs}:${archiveSha256}`,
      archiveSha256,
      archiveBytes: bytes.length,
      capturedAt: new Date(capturedAtMs).toISOString(),
      provider: "modal_snapshot_filesystem",
      snapshotId,
      workspacePersistence: "snapshot_filesystem",
    },
  };
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0137");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0137] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0138 (checkpoint artifacts and finite provider deadlines)", () => {
  test("migrates populated leases, fences references, rotates holders, and GC-claims only unreferenced objects", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0137-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0137-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const leaseId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      const secondLeaseId = crypto.randomUUID();
      const secondGroupId = crypto.randomUUID();
      const coldOrphanLeaseId = crypto.randomUUID();
      const coldOrphanGroupId = crypto.randomUUID();
      const orphanSessionId = crypto.randomUUID();
      const orphanTurnId = crypto.randomUUID();
      const orphanAttemptId = crypto.randomUUID();
      const liveSessionId = crypto.randomUUID();
      const liveTurnId = crypto.randomUUID();
      const liveAttemptId = crypto.randomUUID();
      const legacy = modalCheckpointFixture("im-legacy", 1_700_000_000_000);
      const descriptor = legacy.descriptor;
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, archive_generation, resume_backend_id,
          resume_state, expires_at
        ) values (
          ${leaseId}, ${account!.id}, ${workspace!.id}, ${groupId}, 'warm', 3,
          1, 1, 'sb-legacy', 'modal', 4, 0, 0, 'modal',
          ${sql.json({
            backendId: "modal",
            sessionState: {
              workspaceArchive: legacy.archiveBase64,
              workspaceArchiveMeta: descriptor,
            },
          })},
          now() + interval '1 hour'
        )`;
      await sql`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
        ) values
          (${account!.id}, ${workspace!.id}, ${leaseId}, 'turn', 'turn-1', now()),
          (${account!.id}, ${workspace!.id}, ${leaseId}, 'direct', 'direct-1', now()),
          (${account!.id}, ${workspace!.id}, ${leaseId}, 'viewer', 'viewer-1', now())`;
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
        ) values
          (
            ${orphanSessionId}, ${account!.id}, ${workspace!.id}, 'failed',
            'orphan holder fixture', 'test-model', 'modal', ${groupId},
            ${`session-${orphanSessionId}`},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          ),
          (
            ${liveSessionId}, ${account!.id}, ${workspace!.id}, 'running',
            'live holder fixture', 'test-model', 'modal', ${groupId},
            ${`session-${liveSessionId}`},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          )`;
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values
          (
            ${orphanTurnId}, ${account!.id}, ${workspace!.id}, ${orphanSessionId},
            ${crypto.randomUUID()}, ${`session-${orphanSessionId}`}, 'failed',
            'user', 1, 'orphan holder fixture', '[]'::jsonb, '[]'::jsonb,
            'test-model', 'low', 'modal', '{}'::jsonb, '{}'::jsonb, 1
          ),
          (
            ${liveTurnId}, ${account!.id}, ${workspace!.id}, ${liveSessionId},
            ${crypto.randomUUID()}, ${`session-${liveSessionId}`}, 'running',
            'user', 1, 'live holder fixture', '[]'::jsonb, '[]'::jsonb,
            'test-model', 'low', 'modal', '{}'::jsonb, '{}'::jsonb, 1
          )`;
      await sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id,
          execution_generation, state, outcome, temporal_workflow_id,
          temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, mcp_approval_policies, closed_at,
          quiesced_at
        ) values
          (
            ${orphanAttemptId}, ${account!.id}, ${workspace!.id},
            ${orphanSessionId}, ${orphanTurnId}, 1, 'closed',
            'interrupted_recoverable', ${`session-${orphanSessionId}`},
            ${crypto.randomUUID()}, '2', 0, '{}'::jsonb, now(), now()
          ),
          (
            ${liveAttemptId}, ${account!.id}, ${workspace!.id},
            ${liveSessionId}, ${liveTurnId}, 1, 'running', null,
            ${`session-${liveSessionId}`}, ${crypto.randomUUID()}, '2',
            0, '{}'::jsonb, null, null
          )`;
      await sql`
        update session_turns set active_attempt_id = ${liveAttemptId}
        where id = ${liveTurnId}`;
      await sql.begin(async (tx) => {
        await tx`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id, subject_id,
            last_heartbeat_at
          ) values
            (
              ${account!.id}, ${workspace!.id}, ${leaseId}, 'turn',
              ${`turn-attempt:${orphanAttemptId}`}, ${orphanSessionId}, now()
            ),
            (
              ${account!.id}, ${workspace!.id}, ${leaseId}, 'turn',
              ${`turn-attempt:${liveAttemptId}`}, ${liveSessionId}, now()
            )`;
        await tx`
          update sandbox_leases
          set refcount = 5, turn_holders = 3
          where id = ${leaseId}`;
      });
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, archive_generation, resume_backend_id,
          resume_state, expires_at
        ) values (
          ${secondLeaseId}, ${account!.id}, ${workspace!.id}, ${secondGroupId}, 'warm', 0,
          0, 0, 'sb-legacy-two', 'modal', 2, 0, 0, 'modal', null,
          now() + interval '1 hour'
        )`;
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, archive_generation, resume_backend_id,
          resume_state, expires_at
        ) values (
          ${coldOrphanLeaseId}, ${account!.id}, ${workspace!.id},
          ${coldOrphanGroupId}, 'cold', 1, 1, 0, null, 'modal', 8, 0, 0,
          null, null, now() - interval '1 hour'
        )`;
      await sql`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, subject_id,
          last_heartbeat_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${coldOrphanLeaseId}, 'turn',
          ${`turn-attempt:${orphanAttemptId}`}, ${orphanSessionId}, now()
        )`;

      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
      expect(migrationSql).toContain("requires all opengeni_app sessions to be stopped");
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const liveApp = postgres(appUrl.toString(), { max: 1 });
      let liveWriterRejected: unknown;
      try {
        await liveApp`select 1`;
        await sql.unsafe(migrationSql);
      } catch (error) {
        liveWriterRejected = error;
      } finally {
        await liveApp.end();
      }
      expect(String(liveWriterRejected)).toContain(
        "requires all opengeni_app sessions to be stopped",
      );
      await sql.unsafe(migrationSql);

      const [migrated] = await sql<
        Array<{
          deadlineDue: boolean;
          rls: boolean;
          forced: boolean;
          legacySlots: number;
          retainedBindingColumns: number;
          terminalProviderProofAllowed: boolean;
          orphanAttemptHolders: number;
          liveAttemptHolders: number;
          repairedLiveness: string;
          repairedRefcount: number;
          repairedTurnHolders: number;
          coldOrphanLiveness: string;
          coldOrphanRefcount: number;
          coldOrphanTurnHolders: number;
        }>
      >`
        select
          provider_deadline_at <= now() as "deadlineDue",
          liveness as "repairedLiveness",
          refcount as "repairedRefcount",
          turn_holders as "repairedTurnHolders",
          (select relrowsecurity from pg_class
            where oid = 'sandbox_checkpoint_artifacts'::regclass) as rls,
          (select relforcerowsecurity from pg_class
            where oid = 'sandbox_checkpoint_artifacts'::regclass) as forced,
          (select count(*)::int
            from opengeni_private.list_legacy_modal_checkpoint_slots(100)) as "legacySlots",
          (select count(*)::int from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'sandbox_retained_processes'
              and column_name in ('provider_binding_key', 'provider_binding'))
            as "retainedBindingColumns",
          position(
            'provider_instance_terminated' in (
              select pg_get_constraintdef(oid)
              from pg_constraint
              where conrelid = 'sandbox_retained_processes'::regclass
                and conname = 'sandbox_retained_processes_reconcile_proof_check'
            )
          ) > 0 as "terminalProviderProofAllowed",
          (select count(*)::int
            from sandbox_lease_holders
            where holder_id = ${`turn-attempt:${orphanAttemptId}`})
            as "orphanAttemptHolders",
          (select count(*)::int
            from sandbox_lease_holders
            where holder_id = ${`turn-attempt:${liveAttemptId}`})
            as "liveAttemptHolders",
          (select liveness from sandbox_leases where id = ${coldOrphanLeaseId})
            as "coldOrphanLiveness",
          (select refcount from sandbox_leases where id = ${coldOrphanLeaseId})
            as "coldOrphanRefcount",
          (select turn_holders from sandbox_leases where id = ${coldOrphanLeaseId})
            as "coldOrphanTurnHolders"
        from sandbox_leases where id = ${leaseId}`;
      expect(migrated).toEqual({
        deadlineDue: true,
        rls: true,
        forced: true,
        legacySlots: 1,
        retainedBindingColumns: 2,
        terminalProviderProofAllowed: true,
        orphanAttemptHolders: 0,
        liveAttemptHolders: 1,
        repairedLiveness: "warm",
        repairedRefcount: 4,
        repairedTurnHolders: 2,
        coldOrphanLiveness: "cold",
        coldOrphanRefcount: 0,
        coldOrphanTurnHolders: 0,
      });
      const checkpointFunctions = [
        "validate_sandbox_checkpoint_refs",
        "validate_sandbox_checkpoint_artifact_refs",
        "enforce_sandbox_checkpoint_artifact_immutability",
        "claim_sandbox_checkpoint_artifacts",
        "settle_sandbox_checkpoint_artifact",
        "prune_deleted_sandbox_checkpoint_artifacts",
        "list_legacy_modal_checkpoint_slots",
        "request_due_sandbox_rotations",
        "sandbox_checkpoint_artifact_inventory",
        "sandbox_rotation_backlog",
      ];
      const [functionAcl] = await sql<Array<{ publicExecutable: number; appExecutable: number }>>`
        select
          count(*) filter (
            where exists (
              select 1
              from aclexplode(coalesce(
                procedure.proacl,
                acldefault('f', procedure.proowner)
              )) acl
              where acl.grantee = 0
                and acl.privilege_type = 'EXECUTE'
            )
          )::int as "publicExecutable",
          count(*) filter (
            where procedure.proname = any(${[
              "claim_sandbox_checkpoint_artifacts",
              "settle_sandbox_checkpoint_artifact",
              "prune_deleted_sandbox_checkpoint_artifacts",
              "list_legacy_modal_checkpoint_slots",
              "request_due_sandbox_rotations",
              "sandbox_checkpoint_artifact_inventory",
              "sandbox_rotation_backlog",
            ]})
              and has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE')
          )::int as "appExecutable"
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'opengeni_private'
          and procedure.proname = any(${checkpointFunctions})
      `;
      expect(functionAcl).toEqual({
        publicExecutable: 0,
        // Every operator/runtime entrypoint is callable by opengeni_app. Its
        // broader role-provisioning posture may also grant trigger functions;
        // PostgreSQL still forbids invoking a trigger function directly.
        appExecutable: 7,
      });

      const invalidOperatorCalls = [
        `select * from opengeni_private.claim_sandbox_checkpoint_artifacts(
          null, 1, 60000
        )`,
        `select * from opengeni_private.claim_sandbox_checkpoint_artifacts(
          gen_random_uuid(), null, 60000
        )`,
        `select * from opengeni_private.claim_sandbox_checkpoint_artifacts(
          gen_random_uuid(), 1, null
        )`,
        `select opengeni_private.settle_sandbox_checkpoint_artifact(
          null, gen_random_uuid(), true, null, 1000
        )`,
        `select opengeni_private.settle_sandbox_checkpoint_artifact(
          gen_random_uuid(), null, true, null, 1000
        )`,
        `select opengeni_private.settle_sandbox_checkpoint_artifact(
          gen_random_uuid(), gen_random_uuid(), null, null, 1000
        )`,
        `select opengeni_private.settle_sandbox_checkpoint_artifact(
          gen_random_uuid(), gen_random_uuid(), true, null, null
        )`,
        `select opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(
          null, 1
        )`,
        `select opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(
          86400000, null
        )`,
        `select * from opengeni_private.list_legacy_modal_checkpoint_slots(null)`,
        `select opengeni_private.request_due_sandbox_rotations(null, 1)`,
        `select opengeni_private.request_due_sandbox_rotations(0, null)`,
      ];
      for (const query of invalidOperatorCalls) {
        let invalidArgument: unknown;
        try {
          await sql.unsafe(query);
        } catch (error) {
          invalidArgument = error;
        }
        expect((invalidArgument as { code?: string } | undefined)?.code).toBe("22023");
      }

      const bindingKey = JSON.stringify({
        version: 1,
        serverUrl: "https://modal.test",
        workspaceName: "test-workspace",
        environment: "main",
      });
      const current = modalCheckpointFixture("im-current", 1_700_000_000_001);
      let noncanonicalBindingRejected: unknown;
      try {
        await sql`
          insert into sandbox_checkpoint_artifacts (
            account_id, workspace_id, sandbox_group_id, source_lease_id,
            source_lease_epoch, source_instance_id, source_workspace_generation,
            provenance, provider_backend, provider_binding_key, provider_binding, object_kind,
            object_id, archive_base64, archive_sha256, archive_bytes, descriptor,
            descriptor_revision
          ) values (
            ${account!.id}, ${workspace!.id}, ${groupId}, ${leaseId}, 4,
            'sb-legacy', 0, 'native_capture', 'modal',
            ${JSON.stringify({
              environment: "main",
              workspaceName: "test-workspace",
              serverUrl: "https://modal.test",
              version: 1,
            })},
            ${sql.json(JSON.parse(bindingKey))}, 'modal_filesystem_snapshot',
            'im-noncanonical', ${current.archiveBase64},
            ${current.descriptor.archiveSha256}, ${current.descriptor.archiveBytes},
            ${sql.json({ ...current.descriptor, snapshotId: "im-noncanonical" })},
            ${current.descriptor.revision}
          )`;
      } catch (error) {
        noncanonicalBindingRejected = error;
      }
      expect(String(noncanonicalBindingRejected)).toContain(
        "sandbox_checkpoint_artifacts_provider_check",
      );

      const currentArtifactId = crypto.randomUUID();
      await sql`
        insert into sandbox_checkpoint_artifacts (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provenance, provider_backend, provider_binding_key, provider_binding, object_kind,
          object_id, archive_base64, archive_sha256, archive_bytes, descriptor,
          descriptor_revision, created_at
        ) values (
          ${currentArtifactId}, ${account!.id}, ${workspace!.id}, ${groupId},
          ${leaseId}, 4, 'sb-legacy', 0, 'native_capture', 'modal', ${bindingKey},
          ${sql.json(JSON.parse(bindingKey))}, 'modal_filesystem_snapshot',
          'im-current', ${current.archiveBase64},
          ${current.descriptor.archiveSha256}, ${current.descriptor.archiveBytes},
          ${sql.json(current.descriptor)}, ${current.descriptor.revision},
          now() - interval '1 hour'
        )`;
      await sql.begin(async (tx) => {
        await tx`update sandbox_checkpoint_artifacts
          set state = 'current', published_at = now() where id = ${currentArtifactId}`;
        await tx`update sandbox_leases
          set current_checkpoint_artifact_id = ${currentArtifactId},
              archive_generation = 0,
              resume_state = ${tx.json({
                backendId: "modal",
                sessionState: {
                  workspaceArchive: current.archiveBase64,
                  workspaceArchiveMeta: current.descriptor,
                },
              })}
          where id = ${leaseId}`;
      });
      let invalidArtifactTransition: unknown;
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
          await tx`update sandbox_checkpoint_artifacts
            set state = 'previous' where id = ${currentArtifactId}`;
        });
      } catch (error) {
        invalidArtifactTransition = error;
      }
      expect(String(invalidArtifactTransition)).toContain(
        "checkpoint artifact state does not match its exact lease reference",
      );
      const [stillCurrent] = await sql<Array<{ state: string }>>`
        select state from sandbox_checkpoint_artifacts where id = ${currentArtifactId}`;
      expect(stillCurrent?.state).toBe("current");
      let immutableReceiptRejected: unknown;
      try {
        await sql`update sandbox_checkpoint_artifacts
          set source_instance_id = 'sb-rewritten' where id = ${currentArtifactId}`;
      } catch (error) {
        immutableReceiptRejected = error;
      }
      expect(String(immutableReceiptRejected)).toContain(
        "checkpoint artifact identity and receipt fields are immutable",
      );
      let detachedReceiptRejected: unknown;
      try {
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
          await tx`update sandbox_leases
            set resume_state = jsonb_set(
              resume_state,
              '{sessionState,workspaceArchive}',
              to_jsonb('detached-receipt'::text)
            )
            where id = ${leaseId}`;
        });
      } catch (error) {
        detachedReceiptRejected = error;
      }
      expect(String(detachedReceiptRejected)).toContain(
        "current checkpoint artifact does not match its exact lease scope",
      );

      const gcArtifactId = crypto.randomUUID();
      const gc = modalCheckpointFixture("im-gc", 1_700_000_000_002);
      await sql`
        insert into sandbox_checkpoint_artifacts (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provenance, provider_backend, provider_binding_key, provider_binding, object_kind,
          object_id, archive_base64, archive_sha256, archive_bytes, descriptor,
          descriptor_revision, created_at
        ) values (
          ${gcArtifactId}, ${account!.id}, ${workspace!.id}, ${groupId},
          ${leaseId}, 4, 'sb-legacy', 0, 'native_capture', 'modal', ${bindingKey},
          ${sql.json(JSON.parse(bindingKey))}, 'modal_filesystem_snapshot',
          'im-gc', ${gc.archiveBase64},
          ${gc.descriptor.archiveSha256}, ${gc.descriptor.archiveBytes},
          ${sql.json(gc.descriptor)}, ${gc.descriptor.revision},
          now() - interval '1 hour'
        )`;
      const claimId = crypto.randomUUID();
      const claims = await sql<Array<{ id: string }>>`
        select id from opengeni_private.claim_sandbox_checkpoint_artifacts(
          ${claimId}, 100, 60000
        )`;
      expect(claims.map((row) => row.id)).toEqual([gcArtifactId]);
      const [settled] = await sql<Array<{ settled: boolean }>>`
        select opengeni_private.settle_sandbox_checkpoint_artifact(
          ${gcArtifactId}, ${claimId}, true, null, 1000
        ) as settled`;
      expect(settled?.settled).toBe(true);

      // A previously requested lease is outside this invocation's p_limit. Its
      // viewer and denormalized counts must not be touched by the new batch.
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
        await tx`
          update sandbox_leases set
            rotation_requested_at = now(),
            rotation_reason = 'operator',
            refcount = 1,
            viewer_holders = 1
          where id = ${secondLeaseId}`;
        await tx`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
          ) values (
            ${account!.id}, ${workspace!.id}, ${secondLeaseId},
            'viewer', 'already-requested-viewer', now()
          )`;
      });
      const [requested] = await sql<Array<{ requested: number }>>`
        select opengeni_private.request_due_sandbox_rotations(3600000, 1) as requested`;
      expect(requested?.requested).toBe(1);
      const [firstBatch] = await sql<Array<{ requested: number }>>`
        select count(*)::int as requested
        from sandbox_leases where rotation_requested_at is not null`;
      expect(firstBatch?.requested).toBe(2);
      const [untouchedPriorBatch] = await sql<
        Array<{ holders: number; refcount: number; viewers: number }>
      >`
        select
          (select count(*)::int from sandbox_lease_holders
            where lease_id = ${secondLeaseId}) as holders,
          refcount,
          viewer_holders as viewers
        from sandbox_leases where id = ${secondLeaseId}`;
      expect(untouchedPriorBatch).toEqual({ holders: 1, refcount: 1, viewers: 1 });
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
        await tx`
          update sandbox_leases set
            rotation_requested_at = null,
            rotation_reason = null
          where id = ${secondLeaseId}`;
      });
      const [secondRequested] = await sql<Array<{ requested: number }>>`
        select opengeni_private.request_due_sandbox_rotations(3600000, 1) as requested`;
      expect(secondRequested?.requested).toBe(1);
      const holders = await sql<Array<{ kind: string }>>`
        select kind from sandbox_lease_holders where lease_id = ${leaseId} order by kind`;
      expect(holders.map((row) => row.kind)).toEqual(["direct", "turn", "turn"]);
      const [rotating] = await sql<
        Array<{ reason: string; refcount: number; turnHolders: number; viewerHolders: number }>
      >`
        select rotation_reason as reason, refcount, turn_holders as "turnHolders",
          viewer_holders as "viewerHolders"
        from sandbox_leases where id = ${leaseId}`;
      expect(rotating).toEqual({
        reason: "provider_deadline",
        refcount: 3,
        turnHolders: 2,
        viewerHolders: 0,
      });
      const inventory = await sql<Array<{ state: string; count: number }>>`
        select state, count::int from opengeni_private.sandbox_checkpoint_artifact_inventory()`;
      expect(inventory.map(({ state, count }) => ({ state, count }))).toEqual([
        { state: "current", count: 1 },
        { state: "deleted", count: 1 },
      ]);
      const [backlog] = await sql<
        Array<{
          requested: number;
          overdue: number;
          turnBlocked: number;
          directBlocked: number;
          processBlocked: number;
        }>
      >`
        select requested::int, overdue::int,
          turn_blocked::int as "turnBlocked",
          direct_blocked::int as "directBlocked",
          process_blocked::int as "processBlocked"
        from opengeni_private.sandbox_rotation_backlog()`;
      expect(backlog).toEqual({
        requested: 2,
        overdue: 2,
        turnBlocked: 1,
        directBlocked: 1,
        processBlocked: 0,
      });
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
        await tx`update sandbox_checkpoint_artifacts
          set deleted_at = now() - interval '31 days' where id = ${gcArtifactId}`;
      });
      const [pruned] = await sql<Array<{ pruned: number }>>`
        select opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(
          ${30 * 24 * 60 * 60_000}, 500
        ) as pruned`;
      expect(pruned?.pruned).toBe(1);
      const [remaining] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from sandbox_checkpoint_artifacts`;
      expect(remaining?.count).toBe(1);

      // Parent deletion intentionally leaves the provider receipt behind. Once
      // it is unreferenced and older than the grace window, global GC must
      // reclaim even a row whose last durable state was current.
      await sql`delete from workspaces where id = ${workspace!.id}`;
      const orphanClaimId = crypto.randomUUID();
      const orphanClaims = await sql<Array<{ id: string }>>`
        select id from opengeni_private.claim_sandbox_checkpoint_artifacts(
          ${orphanClaimId}, 1, 60000
        )`;
      expect(orphanClaims.map((row) => row.id)).toEqual([currentArtifactId]);

      // Stale-claim recovery itself is bounded. With two expired claims and
      // p_limit=1, exactly one old claim may be replaced by this invocation.
      const staleClaimIds = [crypto.randomUUID(), crypto.randomUUID()];
      const staleArtifactIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const stale = modalCheckpointFixture(`im-stale-${index}`, 1_700_000_100_000 + index);
        const artifactId = crypto.randomUUID();
        staleArtifactIds.push(artifactId);
        await sql`
          insert into sandbox_checkpoint_artifacts (
            id, account_id, workspace_id, sandbox_group_id, source_lease_id,
            source_lease_epoch, source_instance_id, source_workspace_generation,
            provenance, provider_backend, provider_binding_key, provider_binding, object_kind,
            object_id, archive_base64, archive_sha256, archive_bytes, descriptor,
            descriptor_revision, state, delete_claim_id, delete_claimed_at, created_at
          ) values (
            ${artifactId}, ${account!.id}, ${workspace!.id}, ${groupId},
            ${leaseId}, 4, 'sb-stale', 0, 'native_capture', 'modal', ${bindingKey},
            ${sql.json(JSON.parse(bindingKey))}, 'modal_filesystem_snapshot',
            ${stale.descriptor.snapshotId}, ${stale.archiveBase64},
            ${stale.descriptor.archiveSha256}, ${stale.descriptor.archiveBytes},
            ${sql.json(stale.descriptor)}, ${stale.descriptor.revision},
            'deleting', ${staleClaimIds[index]!}, now() - interval '1 hour',
            now() - interval '1 hour'
          )`;
      }
      const replacementClaimId = crypto.randomUUID();
      await sql`
        select id from opengeni_private.claim_sandbox_checkpoint_artifacts(
          ${replacementClaimId}, 1, 60000
        )`;
      const [oldClaimsRemaining] = await sql<Array<{ count: number }>>`
        select count(*)::int as count
        from sandbox_checkpoint_artifacts
        where id in (${staleArtifactIds[0]!}, ${staleArtifactIds[1]!})
          and delete_claim_id in (${staleClaimIds[0]!}, ${staleClaimIds[1]!})`;
      expect(oldClaimsRemaining?.count).toBe(1);
    } finally {
      await sql.end();
    }
  }, 180_000);
});
