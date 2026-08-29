import { describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalogDatabaseSearchPath } from "./upsert-model-catalog";

const repoRoot = new URL("..", import.meta.url).pathname;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

function operatorTestEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // These fixtures intentionally contain only built-in models. Do not let a
    // deployment-wide policy for unrelated Gateway/OpenRouter models change
    // what the operator integration tests are validating.
    OPENGENI_MODEL_COST_POLICY_JSON: "{}",
    ...overrides,
  };
}

describe("model catalog operator CLI", () => {
  test("uses the validated dedicated-schema runtime search path", () => {
    expect(modelCatalogDatabaseSearchPath({ OPENGENI_DB_SCHEMA: "embedded_catalog" })).toBe(
      "embedded_catalog,opengeni_private,public",
    );
    expect(() => modelCatalogDatabaseSearchPath({ OPENGENI_DB_SCHEMA: "bad-schema" })).toThrow(
      "not a valid Postgres identifier",
    );
  });

  test("prints help without a stack trace or database requirement failure", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/upsert-model-catalog.ts", "--help"], {
      cwd: repoRoot,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "Usage: bun run model-catalog:upsert -- --file <catalog.json> --expected-version <nonnegative integer>",
    );
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects incomplete arguments without exposing a stack trace", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/upsert-model-catalog.ts", "--file"], {
      cwd: repoRoot,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Usage: bun run model-catalog:upsert -- --file <catalog.json> --expected-version <nonnegative integer>",
    );
    expect(result.stderr.toString()).not.toContain(" at ");
  });

  test("upserts only the deployment catalog in a configured dedicated schema", async () => {
    const shared = await acquireSharedTestDatabase("model-catalog-upsert-schema");
    if (!shared && requireRealDatabase) {
      throw new Error("model catalog operator CLI test requires real PostgreSQL");
    }
    if (!shared) return;
    const directory = await mkdtemp(join(tmpdir(), "opengeni-model-catalog-"));
    const file = join(directory, "catalog.json");
    const schema = `catalog_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await shared.admin.unsafe(`create schema "${schema}"`);
      await shared.admin.unsafe(`
        create table "${schema}".deployment_model_catalog (
          singleton boolean primary key check (singleton),
          document jsonb not null,
          version bigint not null,
          updated_at timestamptz not null
        )
      `);
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [],
          gatewayModels: [],
          openrouterModels: [],
          modelNotes: {},
        }),
      );

      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/upsert-model-catalog.ts",
          "--file",
          file,
          "--expected-version",
          "0",
        ],
        {
          cwd: repoRoot,
          env: operatorTestEnv({
            OPENGENI_MIGRATIONS_DATABASE_URL: shared.adminUrl,
            OPENGENI_DB_SCHEMA: schema,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Model catalog updated; version 1.");
      expect(result.stderr.toString()).toBe("");

      const unchanged = Bun.spawnSync(
        [
          process.execPath,
          "scripts/upsert-model-catalog.ts",
          "--expected-version",
          "1",
          "--file",
          file,
        ],
        {
          cwd: repoRoot,
          env: operatorTestEnv({
            OPENGENI_MIGRATIONS_DATABASE_URL: shared.adminUrl,
            OPENGENI_DB_SCHEMA: schema,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(unchanged.exitCode).toBe(0);
      expect(unchanged.stdout.toString()).toContain("Model catalog unchanged; version 1.");

      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna", "gpt-5.6-sol"],
          registryProviders: [],
          gatewayModels: [],
          openrouterModels: [],
          modelNotes: {},
        }),
      );
      const updated = Bun.spawnSync(
        [
          process.execPath,
          "scripts/upsert-model-catalog.ts",
          "--file",
          file,
          "--expected-version",
          "1",
        ],
        {
          cwd: repoRoot,
          env: operatorTestEnv({
            OPENGENI_MIGRATIONS_DATABASE_URL: shared.adminUrl,
            OPENGENI_DB_SCHEMA: schema,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(updated.exitCode).toBe(0);
      expect(updated.stdout.toString()).toContain("Model catalog updated; version 2.");

      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna", "gpt-5.6-terra"],
          registryProviders: [],
          gatewayModels: [],
          openrouterModels: [],
          modelNotes: {},
        }),
      );
      const stale = Bun.spawnSync(
        [
          process.execPath,
          "scripts/upsert-model-catalog.ts",
          "--file",
          file,
          "--expected-version",
          "1",
        ],
        {
          cwd: repoRoot,
          env: operatorTestEnv({
            OPENGENI_MIGRATIONS_DATABASE_URL: shared.adminUrl,
            OPENGENI_DB_SCHEMA: schema,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain(
        "Model catalog version conflict: expected 1, current 2. No changes were applied.",
      );
      expect(stale.stderr.toString()).not.toContain(" at ");

      const dedicated = await shared.admin.unsafe<
        Array<{ version: number; builtInModels: string[] }>
      >(
        `select version::int as version, document->'builtInModels' as "builtInModels" from "${schema}".deployment_model_catalog`,
      );
      const publicRows = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count from public.deployment_model_catalog
      `;
      expect(dedicated).toEqual([{ version: 2, builtInModels: ["gpt-5.6-luna", "gpt-5.6-sol"] }]);
      expect(publicRows).toEqual([{ count: 0 }]);
    } finally {
      await shared.admin.unsafe(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      await shared.release();
    }
  }, 180_000);

  test("fails cleanly instead of waiting indefinitely on the operator lock", async () => {
    const shared = await acquireSharedTestDatabase("model-catalog-upsert-lock-timeout");
    if (!shared && requireRealDatabase) {
      throw new Error("model catalog operator lock-timeout test requires real PostgreSQL");
    }
    if (!shared) return;
    const directory = await mkdtemp(join(tmpdir(), "opengeni-model-catalog-lock-"));
    const file = join(directory, "catalog.json");
    const schema = `catalog_lock_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await shared.admin.unsafe(`create schema "${schema}"`);
      await shared.admin.unsafe(`
        create table "${schema}".deployment_model_catalog (
          singleton boolean primary key check (singleton),
          document jsonb not null,
          version bigint not null,
          updated_at timestamptz not null
        )
      `);
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [],
          gatewayModels: [],
          openrouterModels: [],
          modelNotes: {},
        }),
      );

      await shared.admin.begin(async (transaction) => {
        await transaction`
          select pg_advisory_xact_lock(
            hashtextextended('deployment-model-catalog:singleton', 0)
          )
        `;
        const result = Bun.spawnSync(
          [
            process.execPath,
            "scripts/upsert-model-catalog.ts",
            "--file",
            file,
            "--expected-version",
            "0",
          ],
          {
            cwd: repoRoot,
            env: operatorTestEnv({
              OPENGENI_MIGRATIONS_DATABASE_URL: shared.adminUrl,
              OPENGENI_DB_SCHEMA: schema,
            }),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(
          "Model catalog upsert timed out waiting for the operator lock or completing the catalog transaction. No changes were applied.",
        );
        expect(result.stderr.toString()).not.toContain(" at ");
      });
    } finally {
      await shared.admin.unsafe(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      await shared.release();
    }
  }, 180_000);
});
