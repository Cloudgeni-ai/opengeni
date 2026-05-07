import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(databaseUrl = process.env.INFRA_AGENT_DATABASE_URL ?? "postgres://infra_agents:infra_agents@127.0.0.1:5432/infra_agents"): Promise<void> {
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
