#!/usr/bin/env bun
import { dbSearchPath, parseModelCatalogDocument } from "@opengeni/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

function usage(exitCode = 1): never {
  const message =
    "Usage: bun run model-catalog:upsert -- --file <catalog.json> --expected-version <nonnegative integer>\n" +
    "Requires OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL.\n";
  (exitCode === 0 ? process.stdout : process.stderr).write(message);
  process.exit(exitCode);
}

function argumentsFor(args: string[]): { file: string; expectedVersion: number } {
  if (args.includes("--help") || args.includes("-h")) usage(0);
  if (args.length !== 4) usage();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1]?.trim();
    if ((flag !== "--file" && flag !== "--expected-version") || !value || values.has(flag)) {
      usage();
    }
    values.set(flag, value);
  }
  const file = values.get("--file");
  const expectedVersionRaw = values.get("--expected-version");
  if (!file || !expectedVersionRaw || !/^(0|[1-9][0-9]*)$/u.test(expectedVersionRaw)) {
    usage();
  }
  const expectedVersion = Number(expectedVersionRaw);
  if (!Number.isSafeInteger(expectedVersion)) usage();
  return { file: resolve(file), expectedVersion };
}

export function modelCatalogDatabaseSearchPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return dbSearchPath({ dbSchema: env.OPENGENI_DB_SCHEMA?.trim() ?? "" });
}

function postgresErrorCode(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return null;
}

export async function runModelCatalogUpsert(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { file, expectedVersion } = argumentsFor(args);
  const databaseUrl =
    env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim() || env.OPENGENI_DATABASE_ADMIN_URL?.trim();
  if (!databaseUrl) usage();

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read a valid JSON catalog document: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const document = parseModelCatalogDocument(raw);
  const searchPath = modelCatalogDatabaseSearchPath(env);
  const sql = postgres(databaseUrl, {
    max: 1,
    ...(searchPath ? { connection: { search_path: searchPath } } : {}),
  });
  try {
    let result: { version: number; changed: boolean };
    try {
      result = await sql.begin(async (transaction) => {
        await transaction`
          select
            set_config('lock_timeout', '5s', true),
            set_config('statement_timeout', '30s', true)
        `;
        await transaction`
          select pg_advisory_xact_lock(
            hashtextextended('deployment-model-catalog:singleton', 0)
          )
        `;
        const [current] = await transaction<Array<{ version: number }>>`
          select version::int as version
          from deployment_model_catalog
          where singleton = true
          for update
        `;
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== expectedVersion) {
          throw new Error(
            `Model catalog version conflict: expected ${expectedVersion}, current ${currentVersion}. No changes were applied.`,
          );
        }

        if (!current) {
          const [inserted] = await transaction<Array<{ version: number }>>`
            insert into deployment_model_catalog (singleton, document, version, updated_at)
            values (true, ${transaction.json(document)}, 1, clock_timestamp())
            returning version::int as version
          `;
          if (!inserted) throw new Error("catalog insert returned no row");
          return { version: inserted.version, changed: true };
        }

        const [updated] = await transaction<Array<{ version: number }>>`
          update deployment_model_catalog
          set document = ${transaction.json(document)},
              version = version + 1,
              updated_at = clock_timestamp()
          where singleton = true
            and document is distinct from ${transaction.json(document)}
          returning version::int as version
        `;
        return updated
          ? { version: updated.version, changed: true }
          : { version: current.version, changed: false };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "55P03" || code === "57014") {
        throw new Error(
          "Model catalog upsert timed out waiting for the operator lock or completing the catalog transaction. No changes were applied.",
          { cause: error },
        );
      }
      throw error;
    }
    process.stdout.write(
      `Model catalog ${result.changed ? "updated" : "unchanged"}; version ${result.version}.\n`,
    );
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    await runModelCatalogUpsert();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
