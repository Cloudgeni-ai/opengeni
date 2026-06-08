import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(databaseUrl = process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const migrationFiles = (await readdir(migrationsDir))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const file of migrationFiles) {
      const sqlText = await readFile(join(migrationsDir, file), "utf8");
      await sql.unsafe(sqlText);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate();
  console.log("Applied Drizzle SQL migrations.");
}
