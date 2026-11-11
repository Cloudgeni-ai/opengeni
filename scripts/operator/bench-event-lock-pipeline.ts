import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  claimSessionWorkForAttempt,
} from "../../packages/db/src/index";
import { withWorkspaceRls } from "../../packages/db/src/database";
import { lockSessionEventWriteRows } from "../../packages/db/src/session-control";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// Disposable local diagnostic. No live service or model calls. Added delay is
// confined to this fixture's loopback relay, never a deployment control.
const base = process.env.OPENGENI_BENCH_LOCK_BASE ?? "aa8c4c90258c6dc9e0e9b1cf33957252bedadb75";
const temporary = resolve(`packages/db/src/.probe-lock-base-${crypto.randomUUID()}.ts`);
await writeFile(
  temporary,
  execFileSync("git", ["show", `${base}:packages/db/src/session-control.ts`], {
    maxBuffer: 16 * 1024 * 1024,
  }),
  { flag: "wx" },
);
const baseline = await import(pathToFileURL(temporary).href).finally(() => unlink(temporary));
const shared = await acquireSharedTestDatabase("lock-pipeline-probe");
if (!shared) throw new Error("Real PostgreSQL required");
const direct = createDb(shared.appUrl);
const id = crypto.randomUUID();
const grant = (
  await bootstrapWorkspace(direct.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Lock probe",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Lock probe",
    subjectId: id,
  })
).workspaceGrants[0]!;
const session = await createSession(direct.db, {
  accountId: grant.accountId,
  workspaceId: grant.workspaceId,
  initialMessage: "probe",
  resources: [],
  metadata: {},
  model: "scripted-model",
  reasoningEffort: "medium",
  latencyMode: "standard",
  sandboxBackend: "none",
});
await submitTestHumanPrompt(direct.db, {
  ...grant,
  sessionId: session.id,
  text: "probe",
  resources: [],
  tools: [],
  reasoningEffortFallback: "medium",
});
const attemptId = crypto.randomUUID();
const claim = await claimSessionWorkForAttempt(direct.db, grant.workspaceId, {
  sessionId: session.id,
  attemptId,
  workflowId: id,
  workflowRunId: crypto.randomUUID(),
  dispatchId: crypto.randomUUID(),
  trigger: { kind: "next" },
});
assert.equal(claim.action, "claimed");
if (claim.action !== "claimed") throw new Error("No attempt");
const upstream = new URL(shared.appUrl);
let latency = 0;
let measurement: { statements: string[]; cycles: number; waves: number; ms: number } | undefined;
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.setNoDelay(true);
  backend.setNoDelay(true);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let waitingForReply = false;
  const inspect = postgresWireBudget(() => {
    if (measurement) measurement.cycles++;
  });
  const send = (socket: typeof frontend, chunk: Buffer) => {
    if (!latency) socket.write(chunk);
    else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!socket.destroyed) socket.write(chunk);
      }, latency);
      timers.add(timer);
    }
  };
  frontend.on("data", (chunk) => {
    inspect(chunk);
    if (measurement && !waitingForReply) measurement.waves++;
    waitingForReply = true;
    send(backend, chunk);
  });
  backend.on("data", (chunk) => {
    waitingForReply = false;
    send(frontend, chunk);
  });
  const close = () => {
    for (const timer of timers) clearTimeout(timer);
    frontend.destroy();
    backend.destroy();
  };
  frontend.on("error", close);
  frontend.on("close", close);
  backend.on("error", close);
  backend.on("close", close);
});
await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
const address = relay.address();
assert(address && typeof address !== "string");
const url = new URL(shared.appUrl);
url.port = String(address.port);
const client = createDb(url.href, { max: 1 });
const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
await driver`select 1`;
driver.options.debug = (_connection, query) => measurement?.statements.push(query);
const output: unknown[] = [];
try {
  for (const delay of [0, 2]) {
    latency = delay;
    for (const sessionLock of ["no_key_update", "key_share"] as const) {
      for (const rowProjection of ["event", "full"] as const) {
        const samples: Record<string, (typeof measurement)[]> = { base: [], candidate: [] };
        for (let round = 0; round < 30; round++) {
          let expected: unknown, expectedQueries: string[] | undefined;
          for (const variant of round % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
            measurement = { statements: [], cycles: 0, waves: 0, ms: 0 };
            const start = performance.now();
            const helper =
              variant === "base" ? baseline.lockSessionEventWriteRows : lockSessionEventWriteRows;
            const result = await withWorkspaceRls(client.db, grant.workspaceId, (db) =>
              helper(db, {
                workspaceId: grant.workspaceId,
                controlLock: "share",
                sessionIds: [session.id],
                turnIds: [claim.turn.id],
                attemptIds: [attemptId],
                sessionLock,
                rowProjection,
              }),
            );
            measurement.ms = performance.now() - start;
            if (expected === undefined) {
              expected = result;
              expectedQueries = measurement.statements;
            } else {
              assert.deepEqual(result, expected);
              assert.deepEqual(measurement.statements, expectedQueries);
            }
            if (round >= 5) samples[variant]!.push(measurement);
            measurement = undefined;
          }
        }
        const median = (values: number[]) =>
          values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        output.push({
          syntheticOneWayDelayMs: delay,
          sessionLock,
          rowProjection,
          variants: Object.fromEntries(
            Object.entries(samples).map(([variant, rows]) => [
              variant,
              {
                count: rows.length,
                ms: median(rows.map((x) => x!.ms)),
                cycles: median(rows.map((x) => x!.cycles)),
                requestWaves: median(rows.map((x) => x!.waves)),
                statements: median(rows.map((x) => x!.statements.length)),
              },
            ]),
          ),
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        note: "Local synthetic paired lock-helper diagnostic; TCP request waves are approximate, not a general protocol RTT definition.",
        output,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await direct.close();
  await new Promise<void>((done) => relay.close(() => done()));
  await shared.release();
}
