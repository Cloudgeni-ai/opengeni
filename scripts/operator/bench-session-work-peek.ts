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
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  peekSessionWork,
} from "../../packages/db/src/index";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";
import { postgresWireBudget } from "./postgres-wire-budget";

// Exact previous implementation, not a separately maintained approximation.
// The temporary module is a mechanically copied Git object beside its imports.
// This fixture uses no external model, Temporal service or production database.
const base = process.env.OPENGENI_BENCH_PEEK_BASE ?? "fa00bb255e4533f91c6236edf9d93b9551b6db5f";
const source = execFileSync("git", ["show", `${base}:packages/db/src/index.ts`], {
  maxBuffer: 32 * 1024 * 1024,
});
const temporary = resolve(`packages/db/src/.bench-peek-base-${crypto.randomUUID()}.ts`);
await writeFile(temporary, source, { flag: "wx" });
const previous = await import(pathToFileURL(temporary).href).finally(() => unlink(temporary));
const shared = await acquireSharedTestDatabase("bench-session-work-peek");
if (!shared) throw new Error("Real PostgreSQL is required");
type Sample = { ms: number; cpuMs: number; bytes: number; statements: number; cycles: number };
let current: Sample | undefined;
const upstream = new URL(shared.appUrl);
const relay = createServer((frontend) => {
  const backend = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
  frontend.on(
    "data",
    postgresWireBudget(() => {
      if (current) current.cycles++;
    }),
  );
  frontend.pipe(backend);
  backend.on("data", (chunk: Buffer) => {
    if (current) current.bytes += chunk.length;
  });
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
await new Promise<void>((done, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", done);
});
const address = relay.address();
if (!address || typeof address === "string") throw new Error("Missing relay address");
const url = new URL(shared.appUrl);
url.port = String(address.port);
const client = createDb(url.href, { max: 1 });
(client.db as unknown as { $client: postgres.Sql }).$client.options.debug = () => {
  if (current) current.statements++;
};
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  for (const size of [32, 65_536]) {
    const key = crypto.randomUUID();
    const grant = (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: key,
        accountName: "Peek benchmark",
        workspaceExternalSource: "test",
        workspaceExternalId: key,
        workspaceName: "Peek benchmark",
        subjectId: `peek-${key}`,
      })
    ).workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "x".repeat(size),
      resources: [],
      metadata: { fixture: "x".repeat(size) },
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    for (const state of ["idle", "owned"] as const) {
      if (state === "owned") {
        await submitTestHumanPrompt(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          text: "x".repeat(size),
          resources: [],
          tools: [],
          reasoningEffortFallback: "medium",
        });
        const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
          sessionId: session.id,
          workflowId: `bench-${key}`,
          workflowRunId: crypto.randomUUID(),
          dispatchId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        assert.equal(claimed.action, "claimed");
      }
      const samples: Record<string, Sample[]> = { base: [], candidate: [] };
      for (let round = 0; round < 35; round++) {
        let expected: unknown;
        for (const name of round % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
          const read = name === "base" ? previous.peekSessionWork : peekSessionWork;
          current = { ms: 0, cpuMs: 0, bytes: 0, statements: 0, cycles: 0 };
          const start = performance.now(),
            cpu = process.cpuUsage();
          const result = await read(
            client.db,
            grant.workspaceId,
            session.id,
            true,
            grant.accountId,
          );
          const used = process.cpuUsage(cpu);
          current.ms = performance.now() - start;
          current.cpuMs = (used.user + used.system) / 1000;
          const sample = current;
          current = undefined;
          if (expected === undefined) expected = result;
          else assert.deepEqual(result, expected);
          assert.equal(result.kind, state === "idle" ? "idle" : "attempt-owned");
          if (round >= 5) samples[name]!.push(sample);
        }
      }
      console.log(
        JSON.stringify({
          base,
          size,
          state,
          measuredPairs: 30,
          medians: Object.fromEntries(
            Object.entries(samples).map(([name, values]) => [
              name,
              Object.fromEntries(
                (["ms", "cpuMs", "bytes", "statements", "cycles"] as const).map((field) => [
                  field,
                  median(values.map((value) => value[field])),
                ]),
              ),
            ]),
          ),
          scope:
            "Local restricted-role real-PG observer; exact results compared. Protocol bytes/cycles, not TCP packets, live latency or service residency.",
        }),
      );
    }
  }
} finally {
  await client.close();
  await new Promise<void>((done) => relay.close(() => done()));
  await shared.release();
}
