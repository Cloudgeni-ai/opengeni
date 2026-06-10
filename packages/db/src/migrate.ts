import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni"): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Serialize concurrent migrate() runs; the session-level lock is released
    // when the connection closes.
    await sql`SELECT pg_advisory_lock(727458)`;
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
    const appliedRows = await sql`SELECT "name" FROM "schema_migrations"`;
    const applied = new Set(appliedRows.map((row) => row.name as string));
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sqlText = await readFile(join(migrationsDir, file), "utf8");
      await sql.unsafe(sqlText);
      await sql`INSERT INTO "schema_migrations" ("name") VALUES (${file}) ON CONFLICT DO NOTHING`;
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate();
  console.log("Applied Drizzle SQL migrations.");
}
