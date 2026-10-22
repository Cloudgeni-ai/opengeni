import { acquireRestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb } from "../../packages/db/src/database";
import { inspectRuntimeDatabasePosture } from "../../packages/db/src/runtime-posture";
import type postgres from "postgres";
import { deepStrictEqual } from "node:assert";
import { loadRuntimePostureBaseline } from "../runtime-posture-baseline";
import { createConnection, createServer } from "node:net";
import { postgresWireBudget } from "./postgres-wire-budget";

const fixture = await acquireRestrictedRuntimeTestDatabase("posture-budget", "og_data");
if (!fixture) throw new Error("Real PostgreSQL required");
const upstream = new URL(fixture.appUrl);
let cycles = 0;
let responseBytes = 0;
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => cycles++),
  );
  backend.on("data", (chunk: Buffer) => {
    responseBytes += chunk.length;
  });
  frontend.pipe(backend);
  backend.pipe(frontend);
  const close = () => {
    frontend.destroy();
    backend.destroy();
  };
  frontend.on("error", close);
  frontend.on("close", close);
  backend.on("error", close);
  backend.on("close", close);
});
await new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", resolve);
});
const address = relay.address();
if (!address || typeof address === "string") throw new Error("No local relay");
const databaseUrl = new URL(fixture.appUrl);
databaseUrl.hostname = "127.0.0.1";
databaseUrl.port = String(address.port);
const client = createDb(databaseUrl.href, { searchPath: fixture.schema, max: 1 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
let baseline: Awaited<ReturnType<typeof loadRuntimePostureBaseline>> | null = null;
const samples: {
  operation: string;
  ms: number;
  cpuMs: number;
  statements: number;
  cycles: number;
  responseBytes: number;
}[] = [];
const queries = new Map<string, unknown[]>();
let statements = 0;
driver.options.debug = (_connection, text, parameters) => {
  statements++;
  if (text.includes("row_security_active(c.oid)") || text.includes("as trigger_callable"))
    queries.set(text, [...parameters]);
};
try {
  if (process.env.OPENGENI_BENCH_POSTURE_BASELINE)
    baseline = await loadRuntimePostureBaseline(
      process.cwd(),
      process.env.OPENGENI_BENCH_POSTURE_BASELINE,
    );
  for (let i = 0; i < 12; i++) {
    let reference: Awaited<ReturnType<typeof inspectRuntimeDatabasePosture>> | undefined;
    for (const [operation, inspect] of [
      ...(baseline ? [["baseline", baseline.module.inspectRuntimeDatabasePosture] as const] : []),
      ["current", inspectRuntimeDatabasePosture] as const,
    ]) {
      statements = 0;
      cycles = 0;
      responseBytes = 0;
      const cpu = process.cpuUsage();
      const start = performance.now();
      const result = await inspect(client.db, {
        rlsStrategy: "force",
        targetSchema: fixture.schema,
      });
      const ms = performance.now() - start;
      const elapsedCpu = process.cpuUsage(cpu);
      if (i >= 2)
        samples.push({
          operation,
          cycles,
          responseBytes,
          ms,
          cpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
          statements,
        });
      if (operation === "baseline") reference = result;
      else if (reference) {
        // The old private-table query had no ORDER BY. Compare all its row
        // fields without treating an incidental array order as a posture fact.
        const canonical = (posture: typeof result) => ({
          ...posture,
          privateTables: [...posture.privateTables].sort((a, b) => a.name.localeCompare(b.name)),
        });
        deepStrictEqual(canonical(result), canonical(reference));
      }
      if (i === 0 && operation === "current")
        console.log(
          JSON.stringify({
            inventory: {
              tables: result.tables.length,
              privateTables: result.privateTables.length,
              routines: result.targetRoutines.length,
              privateRoutines: result.privateRoutines.length,
            },
          }),
        );
    }
  }
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(
    JSON.stringify({
      samples,
      summaries: [...new Set(samples.map((x) => x.operation))].map((operation) => {
        const rows = samples.filter((x) => x.operation === operation);
        return {
          operation,
          medianMs: median(rows.map((x) => x.ms)),
          medianCpuMs: median(rows.map((x) => x.cpuMs)),
          statements: rows[0]?.statements,
          cycles: median(rows.map((x) => x.cycles)),
          responseBytes: median(rows.map((x) => x.responseBytes)),
        };
      }),
    }),
  );
  driver.options.debug = false;
  for (const [text, parameters] of queries) {
    const result = await driver.begin("read only", async (tx) =>
      tx.unsafe(
        `explain (analyze, buffers, format json) ${text}`,
        parameters as postgres.ParameterOrJSON<never>[],
      ),
    );
    console.log(JSON.stringify({ query: text, plan: result[0]["QUERY PLAN"] }));
  }
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) =>
    relay.close((error) => (error ? reject(error) : resolve())),
  );
  await fixture.release();
  await baseline?.cleanup();
}
