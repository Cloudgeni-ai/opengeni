import { createConnection, createServer } from "node:net";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  reconcileAttachedBrowserInventory,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { postgresWireBudget } from "./postgres-wire-budget";

// WAL is cluster-wide: this benchmark owns its entire disposable PostgreSQL
// cluster, never an externally supplied URL. No model or external provider calls.
const services = await startTestServices({ temporal: false });
const admin = postgres(services.databaseUrl, { max: 1, onnotice: () => undefined });
let budget:
  | { statements: number; cycles: number; transactions: number; deviceUpdates: number }
  | undefined;
const upstream = new URL(services.runtimeDatabaseUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (budget) budget.cycles++;
    }),
  );
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
if (!address || typeof address === "string") throw new Error("No benchmark relay address");
const url = new URL(services.runtimeDatabaseUrl);
url.port = String(address.port);
const client = createDb(url.href, { max: 1 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_id, query) => {
  if (!budget) return;
  budget.statements++;
  if (/^begin\b/i.test(query)) budget.transactions++;
  if (/^update "attached_browser_devices"/i.test(query)) budget.deviceUpdates++;
};
const output: unknown[] = [];
try {
  await services.migrate();
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "benchmark",
    accountExternalId: identity,
    accountName: "Inventory budget",
    workspaceExternalSource: "benchmark",
    workspaceExternalId: identity,
    workspaceName: "Inventory budget",
    subjectId: "inventory-observer",
  });
  const grant = access.workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay: false,
    allowScreenControl: false,
    os: "linux",
    arch: "x86_64",
  });
  for (const profiles of [0, 1, 8, 32]) {
    const snapshot = {
      bridgeGeneration: crypto.randomUUID(),
      revision: 1,
      devices: Array.from({ length: profiles }, (_, index) => ({
        id: crypto.randomUUID(),
        name: `Profile ${index}`,
        profileLabel: `Profile ${index}`,
        browserName: "Chrome",
        browserVersion: "151.0",
        extensionVersion: "1.0.0",
        platform: "linux" as const,
        architecture: "x64" as const,
        connectionGeneration: crypto.randomUUID(),
        inventoryRevision: 1,
        tabCount: 2,
        capabilities: {
          tabInventory: true,
          debuggerAttachment: true,
          semanticObservation: true,
          screenshots: true,
          liveFrames: true,
          humanInput: true,
          diagnostics: true,
          rawCdp: false,
          linkedComputer: true,
        },
      })),
    };
    const run = () =>
      reconcileAttachedBrowserInventory(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        enrollmentId: enrollment.id,
        snapshot,
      });
    for (let warmup = 0; warmup < 6; warmup++) await run();
    const [before] = await admin`select pg_current_wal_insert_lsn()::text as lsn`;
    const samples = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      budget = { statements: 0, cycles: 0, transactions: 0, deviceUpdates: 0 };
      const cpu = process.cpuUsage();
      const started = performance.now();
      const result = await run();
      const elapsed = performance.now() - started;
      const used = process.cpuUsage(cpu);
      samples.push({
        ...budget,
        ms: elapsed,
        cpuMs: (used.user + used.system) / 1000,
        changed: result.changed,
      });
      budget = undefined;
    }
    const [wal] =
      await admin`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${before!.lsn}::pg_lsn)::float8 as bytes`;
    output.push({ profiles, walBytes: wal!.bytes, samples });
  }
  const report = JSON.stringify({ measurements: output }, null, 2);
  if (process.env.OPENGENI_BENCH_OUTPUT) await Bun.write(process.env.OPENGENI_BENCH_OUTPUT, report);
  else console.log(report);
} finally {
  budget = undefined;
  await client.close();
  await admin.end();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await services.down();
}
process.exit(0);
