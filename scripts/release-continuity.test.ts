import { afterEach, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const migrationDirectory = join(import.meta.dir, "../packages/db/drizzle");
const temporaryDirectories: string[] = [];
let database: BlankTestDatabase | null = null;

afterEach(async () => {
  await database?.release();
  database = null;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("release continuity", () => {
  test("accepts the intentional hold-only removal of a current workspace exception", async () => {
    database = await acquireBlankTestDatabase("release-continuity-exception");
    if (!database) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("real PostgreSQL is required for release continuity proof");
      }
      return;
    }
    const sql = postgres(database.databaseUrl, { max: 1 });
    const evidenceDirectory = await mkdtemp(join(tmpdir(), "opengeni-continuity-"));
    temporaryDirectories.push(evidenceDirectory);
    const manifest = join(evidenceDirectory, "continuity.json");
    const receipt = join(evidenceDirectory, "continuity.verified.json");
    const sourceRevision = "1234567890abcdef1234567890abcdef12345678";
    try {
      const migrations = (await readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const migration of migrations.filter((file) => file < "0063_")) {
        await sql.unsafe(await readFile(join(migrationDirectory, migration), "utf8"));
      }
      const [{ accountId } = { accountId: "" }] = await sql<{ accountId: string }[]>`
        insert into managed_accounts (name) values ('continuity') returning id as "accountId"`;
      const [{ workspaceId } = { workspaceId: "" }] = await sql<{ workspaceId: string }[]>`
        insert into workspaces (account_id, name, inference_state, inference_generation)
        values (${accountId}, 'continuity', 'paused', 7) returning id as "workspaceId"`;
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id,
          control_state, workspace_run_exception_generation, metadata
        ) values (
          ${sessionId}, ${accountId}, ${workspaceId}, 'idle', 'continuity',
          'codex/gpt-5.6-sol', 'none', ${sessionId}, ${`session-${sessionId}`}, 'active', 7,
          jsonb_build_object('childNotificationsMode', 'passive', 'retained', true)
        )`;

      const captured = await runContinuity(
        ["--mode", "capture", "--manifest", manifest],
        database.databaseUrl,
        sourceRevision,
      );
      expect(captured.exitCode, captured.stderr).toBe(0);
      expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
        schemaVersion: 3,
        digestAlgorithm: "postgres-jsonb-row-sha256-chunked-v1",
        phase: "legacy",
      });

      await sql.unsafe(
        await readFile(
          join(migrationDirectory, "0063_session_control_mega_foundation.sql"),
          "utf8",
        ),
      );
      const verified = await runContinuity(
        ["--mode", "verify", "--manifest", manifest, "--receipt", receipt],
        database.databaseUrl,
        sourceRevision,
      );
      expect(verified.exitCode, verified.stderr).toBe(0);
      const result = JSON.parse(verified.stdout.trim()) as {
        currentPhase: string;
        failures: string[];
        receiptPath: string;
      };
      expect(result).toMatchObject({
        currentPhase: "canonical",
        failures: [],
        receiptPath: receipt,
      });
    } finally {
      await sql.end().catch(() => undefined);
    }
  }, 180_000);
});

async function runContinuity(
  args: string[],
  databaseUrl: string,
  sourceRevision: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "release-continuity.ts"), ...args],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENGENI_DATABASE_URL: databaseUrl,
        OPENGENI_SOURCE_REVISION: sourceRevision,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
