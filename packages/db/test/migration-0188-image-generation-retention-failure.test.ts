import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0188_image_generation_retention_failure.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0188 image generation retention failure", () => {
  test("is rolling and records known provider success without making it replayable", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("'retention_failed'");
    expect(source.match(/NOT VALID/g)).toHaveLength(2);
    expect(source.match(/VALIDATE CONSTRAINT/g)).toHaveLength(2);
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);

    const blank = await acquireBlankTestDatabase("migration-0188");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0188-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0188-workspace') returning id`;
      const binding = "b".repeat(64);
      const hash = "a".repeat(64);

      const [operation] = await sql<{ status: string }[]>`
        insert into image_generation_operations (
          id, account_id, workspace_id, operation_key, tool_call_id,
          provider_id, provider_binding_hash, model_id, request_digest,
          expected_artifact_id, status, provider_started_at, last_error
        ) values (
          ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id}, ${binding},
          'call_migration_0188', 'vercel-ai-gateway', ${binding},
          'openai/gpt-image-2', ${hash}, ${crypto.randomUUID()},
          'retention_failed', now(), 'object storage unavailable'
        ) returning status`;
      expect(operation?.status).toBe("retention_failed");

      let invalidState: unknown;
      try {
        await sql`
          insert into image_generation_operations (
            id, account_id, workspace_id, operation_key, tool_call_id,
            provider_id, provider_binding_hash, model_id, request_digest,
            expected_artifact_id, status
          ) values (
            ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id}, ${"c".repeat(64)},
            'invalid_migration_0188', 'vercel-ai-gateway', ${binding},
            'openai/gpt-image-2', ${hash}, ${crypto.randomUUID()}, 'retention_failed'
          )`;
      } catch (error) {
        invalidState = error;
      }
      expect(invalidState).toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
