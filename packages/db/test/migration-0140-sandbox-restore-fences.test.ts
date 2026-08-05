import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0140_sandbox_restore_and_reaper_fences.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

function checkpoint(snapshotId: string, capturedAtMs: number) {
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
  blank = await acquireBlankTestDatabase("migration-0140");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0140] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0140 (restore generation and reaper fences)", () => {
  test("keeps an adopted checkpoint bound while live writes advance and retains native exactness", async () => {
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
        insert into managed_accounts (name) values ('migration-0140-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0140-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;

      const binding = {
        version: 1,
        serverUrl: "https://modal.test",
        workspaceName: "migration-0140",
        environment: "main",
      };
      const bindingKey = JSON.stringify(binding);

      const seedCurrent = async (input: {
        provenance: "legacy_provider_adopted" | "native_capture";
        generation: number;
        instanceId: string;
      }) => {
        const leaseId = crypto.randomUUID();
        const groupId = crypto.randomUUID();
        const artifactId = crypto.randomUUID();
        const fixture = checkpoint(
          `${input.provenance}-${input.generation}`,
          1_900_000_000_000 + input.generation,
        );
        const sourceGeneration = input.provenance === "native_capture" ? input.generation : null;
        await sql.begin(async (tx) => {
          await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
          await tx`set constraints all deferred`;
          await tx`
            insert into sandbox_leases (
              id, account_id, workspace_id, sandbox_group_id, liveness,
              instance_id, backend, lease_epoch, workspace_generation,
              archive_generation, resume_backend_id, resume_state, expires_at
            ) values (
              ${leaseId}, ${account!.id}, ${workspace!.id}, ${groupId}, 'warm',
              ${input.instanceId}, 'modal', 3, ${input.generation},
              ${input.generation}, 'modal',
              ${tx.json({
                backendId: "modal",
                sessionState: {
                  workspaceArchive: fixture.archiveBase64,
                  workspaceArchiveMeta: fixture.descriptor,
                },
              })},
              now() + interval '1 hour'
            )`;
          await tx`
            insert into sandbox_checkpoint_artifacts (
              id, account_id, workspace_id, sandbox_group_id,
              source_lease_id, source_lease_epoch, source_instance_id,
              source_workspace_generation, provenance, provider_backend,
              provider_binding_key, provider_binding, object_kind, object_id,
              archive_base64, archive_sha256, archive_bytes, descriptor,
              descriptor_revision, state
            ) values (
              ${artifactId}, ${account!.id}, ${workspace!.id}, ${groupId},
              ${leaseId}, 3,
              ${input.provenance === "native_capture" ? input.instanceId : null},
              ${sourceGeneration},
              ${input.provenance}, 'modal', ${bindingKey}, ${tx.json(binding)},
              'modal_filesystem_snapshot', ${fixture.descriptor.snapshotId},
              ${fixture.archiveBase64}, ${fixture.descriptor.archiveSha256},
              ${fixture.descriptor.archiveBytes}, ${tx.json(fixture.descriptor)},
              ${fixture.descriptor.revision}, 'current'
            )`;
          await tx`
            update sandbox_leases
            set current_checkpoint_artifact_id = ${artifactId}
            where id = ${leaseId}`;
        });
        return { leaseId, artifactId, generation: input.generation };
      };

      const legacy = await seedCurrent({
        provenance: "legacy_provider_adopted",
        generation: 4,
        instanceId: "sb-legacy",
      });
      const native = await seedCurrent({
        provenance: "native_capture",
        generation: 7,
        instanceId: "sb-native",
      });

      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      await sql.unsafe(migrationSql);
      await sql`insert into schema_migrations (name) values (${migration})`;

      // A restored workspace is live state: each tool mutation advances it
      // independently of the immutable checkpoint's capture generation.
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
        await tx`
          update sandbox_leases
          set workspace_generation = workspace_generation + 1
          where id in (${legacy.leaseId}, ${native.leaseId})`;
      });
      const advanced = await sql<
        Array<{ id: string; workspace_generation: number; archive_generation: number }>
      >`
        select id, workspace_generation, archive_generation
        from sandbox_leases
        where id in (${legacy.leaseId}, ${native.leaseId})
        order by id`;
      expect(
        advanced.map((row) => ({
          id: row.id,
          workspace: row.workspace_generation,
          archive: row.archive_generation,
        })),
      ).toEqual(
        [
          { id: legacy.leaseId, workspace: 5, archive: 4 },
          { id: native.leaseId, workspace: 8, archive: 7 },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );

      // Neither provenance may silently rebind the immutable current artifact
      // by changing archive_generation while retaining the same pointer.
      for (const current of [legacy, native]) {
        await expect(
          sql.begin(async (tx) => {
            await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
            await tx`
              update sandbox_leases
              set archive_generation = archive_generation + 1
              where id = ${current.leaseId}`;
          }),
        ).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await sql.end();
    }
  }, 180_000);
});
