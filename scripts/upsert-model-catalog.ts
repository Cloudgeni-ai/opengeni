#!/usr/bin/env bun
import { parseModelCatalogDocument } from "@opengeni/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

function usage(exitCode = 1): never {
  const message =
    "Usage: bun run model-catalog:upsert -- --file <catalog.json>\n" +
    "Requires OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_ADMIN_URL.\n";
  (exitCode === 0 ? process.stdout : process.stderr).write(message);
  process.exit(exitCode);
}

function fileArgument(args: string[]): string {
  if (args.includes("--help") || args.includes("-h")) usage(0);
  const index = args.indexOf("--file");
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || args.length !== 2) usage();
  return resolve(value);
}

const file = fileArgument(process.argv.slice(2));
const databaseUrl =
  process.env.OPENGENI_MIGRATIONS_DATABASE_URL?.trim() ||
  process.env.OPENGENI_DATABASE_ADMIN_URL?.trim();
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
const sql = postgres(databaseUrl, { max: 1 });
try {
  const [result] = await sql<Array<{ version: number; changed: boolean }>>`
    with changed as (
      insert into deployment_model_catalog (singleton, document, version, updated_at)
      values (true, ${sql.json(document)}, 1, clock_timestamp())
      on conflict (singleton) do update
      set document = excluded.document,
          version = deployment_model_catalog.version + 1,
          updated_at = clock_timestamp()
      where deployment_model_catalog.document is distinct from excluded.document
      returning version::int as version, true as changed
    )
    select version, changed from changed
    union all
    select version::int as version, false as changed
    from deployment_model_catalog
    where singleton = true and not exists (select 1 from changed)
    limit 1
  `;
  if (!result) throw new Error("catalog upsert returned no row");
  process.stdout.write(
    `Model catalog ${result.changed ? "updated" : "unchanged"}; version ${result.version}.\n`,
  );
} finally {
  await sql.end();
}
