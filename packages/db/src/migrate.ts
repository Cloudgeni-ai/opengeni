import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"): Promise<void> {
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/0000_initial.sql");
  const sqlText = await readFile(migrationPath, "utf8");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(sqlText);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate();
  console.log("Applied Drizzle SQL migrations.");
}
