/** Disposable real-PG, exact-base/current full-reader comparison. No model calls. */
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession } from "../../packages/db/src";
import { listSessionEventSlices } from "../../packages/db/src/session-event-slices";

const base = process.argv[2];
if (!base || !/^[a-f0-9]{7,40}$/.test(base)) throw Error("Pass an exact base commit SHA");
const source = Bun.spawnSync(["git", "show", `${base}:packages/db/src/session-event-slices.ts`]);
if (source.exitCode !== 0) throw Error("Cannot load exact base reader");
// Same directory preserves the reader's real relative dependencies; this
// generated source is removed even on failure and is never a tracked edit.
const path = new URL(
  `../../packages/db/src/.bench-tool-name-${crypto.randomUUID()}.ts`,
  import.meta.url,
);
await writeFile(path, source.stdout);
const shared = await acquireSharedTestDatabase("tool-name-pages-benchmark").catch(async (error) => {
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
    .listSessionEventSlices as typeof listSessionEventSlices;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench",
    accountExternalId: crypto.randomUUID(),
    accountName: "Tool pages",
    workspaceExternalSource: "bench",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Tool pages",
    subjectId: crypto.randomUUID(),
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  for (const count of [0, 1, 12000])
    for (const legacy of [false, true]) {
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
      await shared.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      select ${accountId},${workspaceId},${session.id},n,'agent.toolCall.created',
      jsonb_build_object('name',case when n > ${Math.max(0, count - 12)} then 'target' else 'other_'||(n%41) end,
      'callId','call-'||n,'arguments',repeat('x',128)) from generate_series(1,${count}) n`;
      if (legacy)
        await shared.admin`update session_events set tool_name=null where session_id=${session.id} and sequence%20=0`;
      await shared.admin`analyze session_events`;
      for (const toolName of ["target", "absent"]) {
        const times = { base: [] as number[], candidate: [] as number[] };
        const cpus = { base: [] as number[], candidate: [] as number[] };
        let expected: string | undefined;
        for (let sample = -5; sample < 30; sample++)
          for (const variant of sample % 2 === 0
            ? (["base", "candidate"] as const)
            : (["candidate", "base"] as const)) {
            const cpu = process.cpuUsage(),
              start = performance.now();
            const page = await (variant === "base" ? old : listSessionEventSlices)(
              client.db,
              workspaceId,
              session.id,
              { view: "tools", toolName, includeArguments: true, limit: 8 },
            );
            const elapsed = performance.now() - start,
              used = process.cpuUsage(cpu);
            const value = JSON.stringify(page);
            expected ??= value;
            if (value !== expected)
              throw Error(`Full-page difference: ${count}/${legacy}/${toolName}/${variant}`);
            if (sample >= 0) {
              times[variant].push(elapsed);
              cpus[variant].push((used.user + used.system) / 1000);
            }
          }
        console.log(
          JSON.stringify({
            base,
            count,
            legacy,
            toolName,
            samples: 30,
            equalPages: true,
            medianMs: { base: median(times.base), candidate: median(times.candidate) },
            clientCpuMs: { base: median(cpus.base), candidate: median(cpus.candidate) },
          }),
        );
      }
    }
} finally {
  await client.close();
  await shared.release();
  await unlink(path);
}
