import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeNativeSnapshotRef } from "@opengeni/contracts";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0388_durable_rig_provider_image_cleanup.sql",
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

describe("migration 0388 durable Rig provider image cleanup", () => {
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

    const blank = await acquireBlankTestDatabase("migration-0388-rig-provider-image-cleanup");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "OPENGENI_REQUIRE_REAL_DB=1 but the migration 0388 PostgreSQL harness is unavailable",
        );
      }
      return;
    }
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await migrate(blank.databaseUrl);
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
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
