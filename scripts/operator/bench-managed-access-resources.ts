import { createConnection, createServer } from "node:net";
import { createDb, ensureManagedAccessForUser } from "@opengeni/db";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import type postgres from "postgres";
import { postgresWireBudget } from "./postgres-wire-budget";

// Isolated PostgreSQL, restricted application role, no model/provider calls.
// Protocol cycles and wire bytes are measured through a local proxy; timings
// include that proxy and are not end-to-end HTTP authorization latency.
const shared = await acquireSharedTestDatabase("managed-access-budget");
if (!shared) throw new Error("Real PostgreSQL required");
let budget: { statements: number; cycles: number; bytes: number; queries: string[] } | undefined;
const upstream = new URL(shared.appUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (budget) budget.cycles++;
    }),
  );
  backend.on("data", (bytes) => {
    if (budget) budget.bytes += bytes.length;
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
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const address = relay.address();
if (!address || typeof address === "string") throw new Error("Missing listener");
const url = new URL(shared.appUrl);
url.port = String(address.port);
const client = createDb(url.href, { max: 1 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
driver.options.debug = (_id, query) => {
  if (!budget) return;
  budget.statements++;
  budget.queries.push(query);
};
try {
  const identity = {
    userId: crypto.randomUUID(),
    email: "budget@example.test",
    name: "Access budget",
  };
  const expected = await ensureManagedAccessForUser(client.db, identity);
  const run = () =>
    ensureManagedAccessForUser(client.db, {
      ...identity,
      provisionFallbackOrganization: false,
      bindPendingInvitations: false,
    });
  for (let i = 0; i < 5; i++) await run();
  const samples = [];
  for (let i = 0; i < 40; i++) {
    budget = { statements: 0, cycles: 0, bytes: 0, queries: [] };
    const start = performance.now(),
      cpu = process.cpuUsage();
    const actual = await run();
    const used = process.cpuUsage(cpu);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("Access projection changed");
    samples.push({
      ...budget,
      ms: performance.now() - start,
      cpuMs: (used.user + used.system) / 1000,
    });
    budget = undefined;
  }
  console.log(JSON.stringify({ workspaceGrants: expected.workspaceGrants.length, samples }));
} finally {
  budget = undefined;
  await client.close();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  await shared.release();
}
