import { sql } from "drizzle-orm";
import { PgDatabase, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../packages/db/src/schema";
import { acquireSharedTestDatabase } from "@opengeni/testing";

// Local restricted-role fixture only. "full" reproduces the old relational
// schema registration; "lean" uses the explicit-table configuration of createDb.
// Both execute the same transactions and SQL through the unmodified driver.
const fixture = await acquireSharedTestDatabase("db-construction-benchmark");
if (!fixture) throw new Error("Local restricted PostgreSQL fixture required");
const client = postgres(fixture.appUrl, { max: 1 });
const full = drizzle(client, { schema });
const lean = drizzle(client);
const dialect = new PgDialect();
const config = {
  fullSchema: full._.fullSchema,
  schema: full._.schema!,
  tableNamesMap: full._.tableNamesMap,
};
const samples: object[] = [];
let statements = 0;
client.options.debug = () => statements++;
try {
  for (let round = 0; round < 6; round++) {
    for (const mode of round % 2 ? ["lean", "full"] : ["full", "lean"]) {
      Bun.gc(true);
      const start = performance.now(),
        cpu = process.cpuUsage();
      const retained = [];
      for (let i = 0; i < 500; i++) {
        retained.push(
          new PgDatabase(dialect, full._.session, mode === "full" ? config : undefined),
        );
      }
      const usage = process.cpuUsage(cpu);
      samples.push({
        phase: "construct500",
        round,
        mode,
        ms: performance.now() - start,
        cpuMs: (usage.user + usage.system) / 1000,
        tables: Object.keys(config.schema).length,
        relationalBuilders: Object.keys(retained[0]!.query).length,
      });
      retained.length = 0;
      const db = mode === "full" ? full : lean;
      const txStart = performance.now(),
        txCpu = process.cpuUsage();
      statements = 0;
      for (let i = 0; i < 200; i++)
        await db.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
        });
      const txUsage = process.cpuUsage(txCpu);
      samples.push({
        phase: "transactions200",
        round,
        mode,
        ms: performance.now() - txStart,
        cpuMs: (txUsage.user + txUsage.system) / 1000,
        statements,
      });
    }
  }
  console.log(JSON.stringify({ samples }, null, 2));
} finally {
  await client.end();
  await fixture.release();
}
