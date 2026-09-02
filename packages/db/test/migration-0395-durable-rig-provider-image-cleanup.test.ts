import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalDockerProviderImageBinding,
  canonicalModalCheckpointProviderBinding,
  encodeNativeSnapshotRef,
} from "@opengeni/contracts";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb } from "../src/database";
import {
  markRigProviderImageCleanupObligationBuildFailed,
  markRigProviderImageCleanupObligationOutcomeUnknown,
  recordRigProviderImageCleanupObject,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  assertRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  RUNTIME_FULL_DML_TABLES,
} from "../src/runtime-posture";
import { rigProviderImageCleanupObligationStateValues } from "../src/schema";

const migrationUrl = new URL(
  "../drizzle/0395_durable_rig_provider_image_cleanup.sql",
  import.meta.url,
);
const schemaUrl = new URL("../src/schema.ts", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const providerIdentity = canonicalModalCheckpointProviderBinding({
  version: 1,
  serverUrl: "https://api.modal.com",
  workspaceName: "workspace-a",
  environment: "main",
});
if (!providerIdentity) {
  throw new Error("migration 0395 fixture has an invalid Modal provider binding");
}
const providerBinding = providerIdentity.binding;
const providerBindingKey = providerIdentity.key;
const dockerProviderIdentity = canonicalDockerProviderImageBinding({
  version: 1,
  endpoint: "unix:///var/run/docker.sock",
  daemonId: "daemon-a",
});
if (!dockerProviderIdentity) {
  throw new Error("migration 0395 fixture has an invalid Docker provider binding");
}
const dockerProviderBinding = dockerProviderIdentity.binding;
const dockerProviderBindingKey = dockerProviderIdentity.key;

describe("migration 0395 durable Rig provider image cleanup", () => {
  test("persists pre-creation identity and protects registered artifacts from cleanup", async () => {
    const source = await Bun.file(migrationUrl).text();
    const schemaSource = (await Bun.file(schemaUrl).text()).replace(/\s+/gu, " ");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE TABLE rig_provider_image_cleanup_obligations");
    expect(source).toContain(
      "provider_backend, provider_binding_key, build_request_id, source_instance_id",
    );
    expect(source).toContain("CONSTRAINT rig_provider_image_cleanup_backend_check");
    expect(source).toContain("CONSTRAINT rig_provider_image_cleanup_binding_shape_check");
    expect(source).toContain("CONSTRAINT rig_provider_image_cleanup_binding_key_check");
    expect(source).toContain("CONSTRAINT rig_provider_image_cleanup_object_check");
    expect(source).toContain("provider_backend IN ('modal', 'docker')");
    expect(source).toContain("provider_backend = 'docker'");
    expect(source).toContain("provider_image.value ->> 'imageId' = obligation.object_id");
    expect(source).toContain("lease.id = obligation.source_lease_id");
    expect(source).toContain("pg_catalog.now() - interval '15 minutes'");
    expect(schemaSource).toContain('"rig_provider_image_cleanup_backend_check"');
    expect(schemaSource).toContain('"rig_provider_image_cleanup_binding_shape_check"');
    expect(schemaSource).toContain('"rig_provider_image_cleanup_binding_key_check"');
    expect(schemaSource).toContain('"rig_provider_image_cleanup_object_check"');
    expect(source).toContain(
      "state IN ('building', 'outcome_unknown', 'build_failed') AND object_id IS NULL",
    );
    expect([...rigProviderImageCleanupObligationStateValues]).toEqual([
      "building",
      "outcome_unknown",
      "build_failed",
      "delete_pending",
      "deleting",
      "delete_failed",
      "settled",
      "deleted",
    ]);
    expect(schemaSource).toContain(
      "'building', 'outcome_unknown', 'build_failed', 'delete_pending', 'deleting', 'delete_failed', 'settled', 'deleted'",
    );
    expect(schemaSource).toContain(
      "in ('building', 'outcome_unknown', 'build_failed') and ${table.objectId} is null",
    );
    expect(source).toContain("claim_rig_provider_image_cleanup_obligations");
    expect(source).toContain("artifact.object_id = obligation.object_id");
    expect(source).toContain("artifact.state <> 'deleted'");
    expect(source).toContain("state = 'settled'");
    expect(FORCE_RLS_TABLES).toContain("rig_provider_image_cleanup_obligations");
    expect(RUNTIME_FULL_DML_TABLES).toContain("rig_provider_image_cleanup_obligations");

    const blank = await acquireBlankTestDatabase("migration-0392-rig-provider-image-cleanup");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0395 PostgreSQL harness is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1 });
    let runtimeClient: ReturnType<typeof createDb> | null = null;
    let appSql: postgres.Sql | null = null;
    try {
      await migrate(blank.databaseUrl);
      if (!blank.appPassword) {
        throw new Error("migration 0395 test database has no shared app-role password");
      }
      await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "force",
        appRole: "opengeni_app",
        appPassword: blank.appPassword,
      });
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = blank.appPassword;
      runtimeClient = createDb(appUrl.toString(), { max: 1, rlsStrategy: "force" });
      await assertRuntimeDatabasePosture(runtimeClient.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
      });
      appSql = postgres(appUrl.toString(), { max: 1 });
      const appAccountId = crypto.randomUUID();
      const appWorkspaceId = crypto.randomUUID();
      const appObligationId = crypto.randomUUID();
      await appSql.begin(async (tx) => {
        const [privileges] = await tx<Array<{ full_dml: boolean }>>`
          select has_table_privilege(
            current_user,
            'public.rig_provider_image_cleanup_obligations',
            'SELECT,INSERT,UPDATE,DELETE'
          ) as full_dml
        `;
        expect(privileges?.full_dml).toBe(true);
        await tx`
          select
            set_config('opengeni.account_id', ${appAccountId}, true),
            set_config('opengeni.workspace_id', ${appWorkspaceId}, true)
        `;
        await tx`
          insert into rig_provider_image_cleanup_obligations (
            id, account_id, workspace_id, sandbox_group_id, source_lease_id,
            source_lease_epoch, source_instance_id, source_workspace_generation,
            provider_backend, provider_binding_key, provider_binding, build_request_id
          ) values (
            ${appObligationId}, ${appAccountId}, ${appWorkspaceId}, ${crypto.randomUUID()},
            ${crypto.randomUUID()}, 1, 'sb-app-role', 1, 'modal', ${providerBindingKey},
            ${tx.json(providerBinding)}::jsonb, 'app-role-crud'
          )
        `;
        const selected = await tx<Array<{ id: string }>>`
          select id from rig_provider_image_cleanup_obligations
          where id = ${appObligationId}
        `;
        expect([...selected]).toEqual([{ id: appObligationId }]);
        await tx`
          update rig_provider_image_cleanup_obligations
          set last_delete_error = 'app-role-update'
          where id = ${appObligationId}
        `;
        const [updated] = await tx<Array<{ last_delete_error: string | null }>>`
          select last_delete_error from rig_provider_image_cleanup_obligations
          where id = ${appObligationId}
        `;
        expect(updated?.last_delete_error).toBe("app-role-update");
        await tx`
          delete from rig_provider_image_cleanup_obligations
          where id = ${appObligationId}
        `;
        const [deleted] = await tx<Array<{ remaining: number }>>`
          select count(*)::int as remaining
          from rig_provider_image_cleanup_obligations
          where id = ${appObligationId}
        `;
        expect(deleted?.remaining).toBe(0);
      });
      const obligationId = crypto.randomUUID();
      const claimId = crypto.randomUUID();
      const cleanupAccountId = crypto.randomUUID();
      const cleanupWorkspaceId = crypto.randomUUID();
      await sql`
        insert into rig_provider_image_cleanup_obligations (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provider_backend, provider_binding_key, provider_binding, build_request_id
        ) values (
          ${obligationId}, ${cleanupAccountId}, ${cleanupWorkspaceId},
          ${crypto.randomUUID()}, ${crypto.randomUUID()}, 4, 'sb-source', 2,
          'modal', ${providerBindingKey}, ${sql.json(providerBinding)}::jsonb,
          'rig-provider-image-request'
        )
      `;
      const outcomeUnknownMarked = await markRigProviderImageCleanupObligationOutcomeUnknown(
        runtimeClient.db,
        {
          accountId: cleanupAccountId,
          workspaceId: cleanupWorkspaceId,
          obligationId,
          buildRequestId: "rig-provider-image-request",
          providerBindingKey,
          error: "Modal snapshot transport closed after admission",
        },
      );
      expect(outcomeUnknownMarked).toBe(true);
      const [outcomeUnknownRow] = await sql<
        Array<{ state: string; last_delete_error: string | null }>
      >`
        select state, last_delete_error
        from rig_provider_image_cleanup_obligations
        where id = ${obligationId}
      `;
      expect(outcomeUnknownRow).toEqual({
        state: "outcome_unknown",
        last_delete_error: "Modal snapshot transport closed after admission",
      });
      const buildFailedMarked = await markRigProviderImageCleanupObligationBuildFailed(
        runtimeClient.db,
        {
          accountId: cleanupAccountId,
          workspaceId: cleanupWorkspaceId,
          obligationId,
          buildRequestId: "rig-provider-image-request",
          providerBindingKey,
          error: "Modal snapshot permission denied",
        },
      );
      expect(buildFailedMarked).toBe(true);
      const [buildFailedRow] = await sql<
        Array<{ state: string; last_delete_error: string | null }>
      >`
        select state, last_delete_error
        from rig_provider_image_cleanup_obligations
        where id = ${obligationId}
      `;
      expect(buildFailedRow).toEqual({
        state: "build_failed",
        last_delete_error: "Modal snapshot permission denied",
      });
      const lateObjectRecorded = await recordRigProviderImageCleanupObject(runtimeClient.db, {
        accountId: cleanupAccountId,
        workspaceId: cleanupWorkspaceId,
        obligationId,
        buildRequestId: "rig-provider-image-request",
        providerBindingKey,
        objectId: "im-late",
      });
      expect(lateObjectRecorded).toBe(true);
      const [recordedRow] = await sql<Array<{ object_id: string; state: string }>>`
        select object_id, state
        from rig_provider_image_cleanup_obligations
        where id = ${obligationId}
      `;
      expect(recordedRow).toEqual({ object_id: "im-late", state: "delete_pending" });
      await sql`
        update rig_provider_image_cleanup_obligations
        set delete_after = now()
        where id = ${obligationId}
      `;
      const claimed = await sql<
        Array<{ id: string; object_id: string; delete_attempts: number }>
      >`select id, object_id, delete_attempts
        from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${claimId}::uuid, 10, 60000::bigint
        )`;
      expect([...claimed]).toEqual([
        { id: obligationId, object_id: "im-late", delete_attempts: 1 },
      ]);

      const [settled] = await sql<Array<{ settled: boolean }>>`
        select opengeni_private.settle_rig_provider_image_cleanup_obligation(
          ${obligationId}::uuid, ${claimId}::uuid, true, null, 1000::bigint
        ) as settled
      `;
      expect(settled?.settled).toBe(true);
      const [row] = await sql<Array<{ state: string; deleted_at: Date | null }>>`
        select state, deleted_at
        from rig_provider_image_cleanup_obligations
        where id = ${obligationId}
      `;
      expect(row?.state).toBe("deleted");
      expect(row?.deleted_at).toBeInstanceOf(Date);

      const protectedObligationId = crypto.randomUUID();
      const protectedObjectId = "im-registered-before-restart";
      const archive = encodeNativeSnapshotRef({
        provider: "modal_snapshot_filesystem",
        snapshotId: protectedObjectId,
        workspacePersistence: "snapshot_filesystem",
      });
      const archiveSha256 = createHash("sha256").update(archive).digest("hex");
      const capturedAt = "2026-08-31T12:00:00.000Z";
      const descriptor = {
        version: 2,
        kind: "provider_snapshot",
        revision: `wa2:${Date.parse(capturedAt)}:${archiveSha256}`,
        archiveSha256,
        archiveBytes: archive.byteLength,
        capturedAt,
        provider: "modal_snapshot_filesystem",
        snapshotId: protectedObjectId,
        workspacePersistence: "snapshot_filesystem",
      };
      const accountId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const sandboxGroupId = crypto.randomUUID();
      const sourceLeaseId = crypto.randomUUID();
      await sql`
        insert into rig_provider_image_cleanup_obligations (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provider_backend, provider_binding_key, provider_binding, build_request_id,
          object_id, state, delete_after
        ) values (
          ${protectedObligationId}, ${accountId}, ${workspaceId}, ${sandboxGroupId},
          ${sourceLeaseId}, 5, 'sb-protected', 3, 'modal', ${providerBindingKey},
          ${sql.json(providerBinding)}::jsonb, 'registered-request',
          ${protectedObjectId}, 'delete_pending', now()
        )
      `;
      await sql`
        insert into sandbox_checkpoint_artifacts (
          account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provenance, provider_backend, provider_binding_key, provider_binding,
          object_kind, object_id, archive_base64, archive_sha256, archive_bytes,
          descriptor, descriptor_revision, state
        ) values (
          ${accountId}, ${workspaceId}, ${sandboxGroupId}, ${sourceLeaseId}, 5,
          'sb-protected', 3, 'native_capture', 'modal', ${providerBindingKey},
          ${sql.json(providerBinding)}::jsonb, 'modal_filesystem_snapshot',
          ${protectedObjectId}, ${Buffer.from(archive).toString("base64")},
          ${archiveSha256}, ${archive.byteLength}, ${sql.json(descriptor)}::jsonb,
          ${descriptor.revision}, 'candidate'
        )
      `;
      const protectedClaims = await sql<Array<{ id: string }>>`
        select id from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${crypto.randomUUID()}::uuid, 10, 60000::bigint
        )
      `;
      expect([...protectedClaims]).toEqual([]);
      const [protectedRow] = await sql<Array<{ state: string }>>`
        select state from rig_provider_image_cleanup_obligations
        where id = ${protectedObligationId}
      `;
      expect(protectedRow?.state).toBe("settled");

      const dockerAccountId = crypto.randomUUID();
      const dockerWorkspaceId = crypto.randomUUID();
      const dockerRigId = crypto.randomUUID();
      const dockerVersionId = crypto.randomUUID();
      const dockerObligationId = crypto.randomUUID();
      const dockerSourceLeaseId = crypto.randomUUID();
      const dockerImageId = `sha256:${"d".repeat(64)}`;
      await sql`
        insert into managed_accounts (id, name)
        values (${dockerAccountId}, 'Docker cleanup account')
      `;
      await sql`
        insert into workspaces (id, account_id, name)
        values (${dockerWorkspaceId}, ${dockerAccountId}, 'Docker cleanup workspace')
      `;
      await sql`
        insert into rigs (id, account_id, workspace_id, name)
        values (${dockerRigId}, ${dockerAccountId}, ${dockerWorkspaceId}, 'Docker cleanup rig')
      `;
      await sql`set session_replication_role = replica`;
      try {
        await sql`
          insert into rig_versions (
            id, account_id, workspace_id, rig_id, version, provider_images
          ) values (
            ${dockerVersionId}, ${dockerAccountId}, ${dockerWorkspaceId}, ${dockerRigId}, 1,
            ${sql.json({
              docker: {
                backend: "docker",
                status: "ready",
                imageId: dockerImageId,
                buildRequestId: "docker-ready-request",
              },
            })}::jsonb
          )
        `;
      } finally {
        await sql`set session_replication_role = origin`;
      }
      await sql`
        insert into rig_provider_image_cleanup_obligations (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provider_backend, provider_binding_key, provider_binding, build_request_id,
          object_id, state, delete_after
        ) values (
          ${dockerObligationId}, ${dockerAccountId}, ${dockerWorkspaceId},
          ${crypto.randomUUID()}, ${dockerSourceLeaseId}, 3, 'docker-source', 0,
          'docker', ${dockerProviderBindingKey},
          ${sql.json(dockerProviderBinding)}::jsonb, 'docker-ready-request',
          ${dockerImageId}, 'delete_pending', now()
        )
      `;

      const protectedDockerClaims = await sql<Array<{ id: string }>>`
        select id from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${crypto.randomUUID()}::uuid, 10, 60000::bigint
        )
      `;
      expect([...protectedDockerClaims]).toEqual([]);
      const [settledDocker] = await sql<Array<{ state: string }>>`
        select state from rig_provider_image_cleanup_obligations
        where id = ${dockerObligationId}
      `;
      expect(settledDocker?.state).toBe("settled");

      await sql`delete from rig_versions where id = ${dockerVersionId}`;
      await sql`
        update rig_provider_image_cleanup_obligations
        set settled_at = now() - interval '1 hour'
        where id = ${dockerObligationId}
      `;
      const dockerClaimId = crypto.randomUUID();
      const reclaimedDocker = await sql<
        Array<{ id: string; provider_backend: string; object_id: string; delete_attempts: number }>
      >`
        select id, provider_backend, object_id, delete_attempts
        from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${dockerClaimId}::uuid, 10, 60000::bigint
        )
      `;
      expect([...reclaimedDocker]).toEqual([
        {
          id: dockerObligationId,
          provider_backend: "docker",
          object_id: dockerImageId,
          delete_attempts: 1,
        },
      ]);
      const [dockerRetrySettled] = await sql<Array<{ settled: boolean }>>`
        select opengeni_private.settle_rig_provider_image_cleanup_obligation(
          ${dockerObligationId}::uuid, ${dockerClaimId}::uuid, false,
          'image is referenced by another repository', 60000::bigint
        ) as settled
      `;
      expect(dockerRetrySettled?.settled).toBe(true);
      const [dockerRetry] = await sql<Array<{ state: string; last_delete_error: string | null }>>`
        select state, last_delete_error
        from rig_provider_image_cleanup_obligations
        where id = ${dockerObligationId}
      `;
      expect(dockerRetry).toEqual({
        state: "delete_failed",
        last_delete_error: "image is referenced by another repository",
      });

      const sourceProtectedObligationId = crypto.randomUUID();
      const sourceProtectedLeaseId = crypto.randomUUID();
      const sourceProtectedGroupId = crypto.randomUUID();
      const sourceProtectedImageId = `sha256:${"e".repeat(64)}`;
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, instance_id,
          backend, lease_epoch, expires_at
        ) values (
          ${sourceProtectedLeaseId}, ${dockerAccountId}, ${dockerWorkspaceId},
          ${sourceProtectedGroupId}, 'warm', 'docker-live-source', 'docker', 7,
          now() + interval '1 hour'
        )
      `;
      await sql`
        insert into rig_provider_image_cleanup_obligations (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provider_backend, provider_binding_key, provider_binding, build_request_id,
          object_id, state, delete_after
        ) values (
          ${sourceProtectedObligationId}, ${dockerAccountId}, ${dockerWorkspaceId},
          ${sourceProtectedGroupId}, ${sourceProtectedLeaseId}, 7, 'docker-live-source', 0,
          'docker', ${dockerProviderBindingKey},
          ${sql.json(dockerProviderBinding)}::jsonb, 'docker-source-protected-request',
          ${sourceProtectedImageId}, 'delete_pending', now()
        )
      `;
      const sourceProtectedClaims = await sql<Array<{ id: string }>>`
        select id from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${crypto.randomUUID()}::uuid, 10, 60000::bigint
        )
      `;
      expect([...sourceProtectedClaims]).toEqual([]);
      await sql`
        update sandbox_leases set liveness = 'cold', instance_id = null
        where id = ${sourceProtectedLeaseId}
      `;
      const sourceReleasedClaimId = crypto.randomUUID();
      const sourceReleasedClaims = await sql<Array<{ id: string; object_id: string }>>`
        select id, object_id
        from opengeni_private.claim_rig_provider_image_cleanup_obligations(
          ${sourceReleasedClaimId}::uuid, 10, 60000::bigint
        )
      `;
      expect([...sourceReleasedClaims]).toEqual([
        { id: sourceProtectedObligationId, object_id: sourceProtectedImageId },
      ]);
      const [sourceReleasedSettled] = await sql<Array<{ settled: boolean }>>`
        select opengeni_private.settle_rig_provider_image_cleanup_obligation(
          ${sourceProtectedObligationId}::uuid, ${sourceReleasedClaimId}::uuid,
          true, null, 1000::bigint
        ) as settled
      `;
      expect(sourceReleasedSettled?.settled).toBe(true);
    } finally {
      await appSql?.end().catch(() => undefined);
      await runtimeClient?.close().catch(() => undefined);
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
