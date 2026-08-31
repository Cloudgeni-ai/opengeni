import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeNativeSnapshotRef } from "@opengeni/contracts";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  assertRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  RUNTIME_FULL_DML_TABLES,
} from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0389_durable_rig_provider_image_cleanup.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const providerBinding = {
  version: 1,
  serverUrl: "https://api.modal.com",
  workspaceName: "workspace-a",
  environment: "main",
};
const providerBindingKey = JSON.stringify(providerBinding);

describe("migration 0389 durable Rig provider image cleanup", () => {
  test("persists pre-creation identity and protects registered artifacts from cleanup", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE TABLE rig_provider_image_cleanup_obligations");
    expect(source).toContain(
      "provider_backend, provider_binding_key, build_request_id, source_instance_id",
    );
    expect(source).toContain("state IN ('building', 'build_failed') AND object_id IS NULL");
    expect(source).toContain("claim_rig_provider_image_cleanup_obligations");
    expect(source).toContain("artifact.object_id = obligation.object_id");
    expect(source).toContain("artifact.state <> 'deleted'");
    expect(source).toContain("state = 'settled'");
    expect(FORCE_RLS_TABLES).toContain("rig_provider_image_cleanup_obligations");
    expect(RUNTIME_FULL_DML_TABLES).toContain("rig_provider_image_cleanup_obligations");

    const blank = await acquireBlankTestDatabase("migration-0389-rig-provider-image-cleanup");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0389 PostgreSQL harness is unavailable",
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
        throw new Error("migration 0389 test database has no shared app-role password");
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
            ${JSON.stringify(providerBinding)}::jsonb, 'app-role-crud'
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
      await sql`
        insert into rig_provider_image_cleanup_obligations (
          id, account_id, workspace_id, sandbox_group_id, source_lease_id,
          source_lease_epoch, source_instance_id, source_workspace_generation,
          provider_backend, provider_binding_key, provider_binding, build_request_id,
          object_id, state, delete_after
        ) values (
          ${obligationId}, ${crypto.randomUUID()}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, ${crypto.randomUUID()}, 4, 'sb-source', 2,
          'modal', ${providerBindingKey}, ${JSON.stringify(providerBinding)}::jsonb,
          'rig-provider-image-request', 'im-late', 'delete_pending', now()
        )
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
          ${JSON.stringify(providerBinding)}::jsonb, 'registered-request',
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
          ${JSON.stringify(providerBinding)}::jsonb, 'modal_filesystem_snapshot',
          ${protectedObjectId}, ${Buffer.from(archive).toString("base64")},
          ${archiveSha256}, ${archive.byteLength}, ${JSON.stringify(descriptor)}::jsonb,
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
    } finally {
      await appSql?.end().catch(() => undefined);
      await runtimeClient?.close().catch(() => undefined);
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
