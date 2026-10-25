/** Exact-base/current, disposable real-PG event-page benchmark. No model calls. */
import { unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
} from "../../packages/db/src";

const base = process.argv[2];
if (!base || !/^[a-f0-9]{7,40}$/.test(base)) throw Error("Pass an exact base commit SHA");
const source = Bun.spawnSync(["git", "show", `${base}:packages/db/src/index.ts`]);
if (source.exitCode !== 0) throw Error("Cannot load exact base reader");
const path = new URL(
  `../../packages/db/src/.bench-event-metadata-${crypto.randomUUID()}.ts`,
  import.meta.url,
);
await writeFile(path, source.stdout);
const shared = await acquireSharedTestDatabase("event-metadata-benchmark").catch(async (error) => {
  await unlink(path);
  throw error;
});
if (!shared) {
  await unlink(path);
  throw Error("Real PostgreSQL required");
}
const client = createDb(shared.appUrl, { max: 1 });
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
try {
  const old = (await import(fileURLToPath(path)))
    .listSessionEventPage as typeof listSessionEventPage;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench",
    accountExternalId: crypto.randomUUID(),
    accountName: "Event metadata",
    workspaceExternalSource: "bench",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Event metadata",
    subjectId: crypto.randomUUID(),
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  for (const [count, payloadBytes] of [
    [0, 32],
    [1, 32],
    [1200, 32],
    [300, 64_000],
    [300, 512_000],
  ] as const) {
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Benchmark",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    // Raw storage isolates reader work from event-write costs. The normal
    // table triggers and application-role read policies remain enabled.
    await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      select ${accountId},${workspaceId},${session.id},n,'agent.toolCall.output',
        jsonb_build_object('name','fixture','output',repeat('x',${payloadBytes}))
      from generate_series(1,${count}) n`;
    await shared.admin`analyze session_events`;
    for (const direction of ["after", "before"] as const) {
      const times = { base: [] as number[], candidate: [] as number[] };
      const cpus = { base: [] as number[], candidate: [] as number[] };
      let expected: string | undefined;
      let pageEvents = 0;
      for (let sample = -5; sample < 30; sample++) {
        for (const variant of sample % 2 === 0
          ? (["base", "candidate"] as const)
          : (["candidate", "base"] as const)) {
          const cpu = process.cpuUsage();
          const start = performance.now();
          const page = await (variant === "base" ? old : listSessionEventPage)(
            client.db,
            workspaceId,
            session.id,
            { direction, limit: 500 },
          );
          const elapsed = performance.now() - start;
          const used = process.cpuUsage(cpu);
          const serialized = JSON.stringify(page);
          expected ??= serialized;
          if (serialized !== expected)
            throw Error(`Page mismatch: ${count}/${payloadBytes}/${direction}/${variant}`);
          pageEvents = page.events.length;
          if (sample >= 0) {
            times[variant].push(elapsed);
            cpus[variant].push((used.user + used.system) / 1000);
          }
        }
      }
      console.log(
        JSON.stringify({
          base,
          count,
          payloadBytes,
          direction,
          pageEvents,
          measuredPairs: 30,
          medianMs: { base: median(times.base), candidate: median(times.candidate) },
          processCpuMs: { base: median(cpus.base), candidate: median(cpus.candidate) },
          equal: true,
        }),
      );
    }
  }
} finally {
  await client.close();
  await shared.release();
  await unlink(path);
}
