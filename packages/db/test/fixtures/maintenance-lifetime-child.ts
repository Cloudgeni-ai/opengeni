import { sql } from "drizzle-orm";
import { createDb, withDatabaseMaintenanceLifetime } from "../../src/database";

const client = createDb(process.env.OPENGENI_MAINTENANCE_TEST_URL!, { max: 1 });
try {
  await withDatabaseMaintenanceLifetime(client.db, {
    signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000,
  }, async (tx) => {
    await tx.execute(sql`insert into maintenance_lifetime_probe values ('crash')`);
    await tx.execute(sql`select pg_sleep(3) /* maintenance_child_disconnect */`);
  });
} finally {
  await client.close();
}
