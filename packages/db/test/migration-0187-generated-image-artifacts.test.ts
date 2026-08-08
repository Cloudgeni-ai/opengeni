import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0187_generated_image_artifacts.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0187 generated image artifacts", () => {
  test("is rolling, bounded, tenant-bound, and FORCE-RLS protected", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain('CREATE TABLE "generated_image_artifacts"');
    expect(source).toContain('CREATE TABLE "image_generation_operations"');
    expect(source).toContain('ON DELETE SET NULL ("session_id")');
    expect(source).toContain(
      'CONSTRAINT "image_generation_operations_workspace_attempt_fk"\n    FOREIGN KEY ("workspace_id", "attempt_id")\n    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE SET NULL ("attempt_id")',
    );
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);

    const blank = await acquireBlankTestDatabase("migration-0187");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0187-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0187-workspace') returning id`;
      const artifactId = crypto.randomUUID();
      const uploadId = crypto.randomUUID();
      const hash = "a".repeat(64);
      const binding = "b".repeat(64);
      const sandboxPath = `/workspace/generated-images/generated-image-${artifactId}.png`;
      await sql`
        insert into files (
          id, account_id, workspace_id, status, filename, safe_filename,
          content_type, size_bytes, sha256, bucket, object_key
        ) values (
          ${artifactId}, ${account!.id}, ${workspace!.id}, 'ready',
          ${`generated-image-${artifactId}.png`}, ${`generated-image-${artifactId}.png`},
          'image/png', 68, ${hash}, 'test', ${`test/${artifactId}`}
        )`;
      await sql`
        insert into file_uploads (
          id, account_id, workspace_id, file_id, status, expires_at, completed_at
        ) values (
          ${uploadId}, ${account!.id}, ${workspace!.id}, ${artifactId}, 'completed',
          now() + interval '1 hour', now()
        )`;
      await sql`
        insert into generated_image_artifacts (
          artifact_id, account_id, workspace_id, upload_id, settlement_key,
          tool_call_id, source_strategy, provider_id, provider_binding_hash,
          provider_item_id, status, media_type, size_bytes, sha256, width,
          height, sandbox_path, ready_at
        ) values (
          ${artifactId}, ${account!.id}, ${workspace!.id}, ${uploadId}, ${hash},
          'ig_migration_0187', 'native_hosted', 'openai', ${binding},
          'ig_migration_0187', 'ready', 'image/png', 68, ${hash}, 1, 1,
          ${sandboxPath}, now()
        )`;
      await sql`
        insert into image_generation_operations (
          id, account_id, workspace_id, operation_key, tool_call_id,
          provider_id, provider_binding_hash, model_id, request_digest,
          expected_artifact_id
        ) values (
          ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id}, ${binding},
          'call_migration_0187', 'vercel-ai-gateway', ${binding},
          'openai/gpt-image-2', ${hash}, ${crypto.randomUUID()}
        )`;

      const tables = await sql<
        Array<{ tableName: string; rlsEnabled: boolean; rlsForced: boolean }>
      >`
        select c.relname as "tableName", c.relrowsecurity as "rlsEnabled",
          c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in ('generated_image_artifacts', 'image_generation_operations')
        order by c.relname`;
      expect([...tables]).toEqual([
        { tableName: "generated_image_artifacts", rlsEnabled: true, rlsForced: true },
        { tableName: "image_generation_operations", rlsEnabled: true, rlsForced: true },
      ]);

      const invalidArtifactId = crypto.randomUUID();
      await sql`
        insert into files (
          id, account_id, workspace_id, status, filename, safe_filename,
          content_type, size_bytes, sha256, bucket, object_key
        ) values (
          ${invalidArtifactId}, ${account!.id}, ${workspace!.id}, 'ready',
          ${`generated-image-${invalidArtifactId}.png`},
          ${`generated-image-${invalidArtifactId}.png`}, 'image/png', 68,
          ${hash}, 'test', ${`test/${invalidArtifactId}`}
        )`;
      let shapeError: unknown;
      try {
        await sql`
          insert into generated_image_artifacts (
            artifact_id, account_id, workspace_id, settlement_key, tool_call_id,
            source_strategy, provider_id, provider_binding_hash, provider_item_id,
            status, media_type, size_bytes, sha256, width, height, sandbox_path
          ) values (
            ${invalidArtifactId}, ${account!.id}, ${workspace!.id}, ${"c".repeat(64)},
            'invalid-shape', 'provider_adapter', 'gateway', ${binding},
            'provider-items-are-forbidden-on-adapters', 'pending', 'image/png', 68,
            ${hash}, 1, 1,
            ${`/workspace/generated-images/generated-image-${invalidArtifactId}.png`}
          )`;
      } catch (error) {
        shapeError = error;
      }
      expect(shapeError).toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
