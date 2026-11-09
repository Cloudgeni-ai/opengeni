#!/usr/bin/env bun
import { chatReadStack } from "../apps/api/test/fixtures/chat-read-stack";
import { writeFile } from "node:fs/promises";

const samples = Number(process.env.OPENGENI_BENCH_SAMPLES ?? 30);
const fixture = await chatReadStack();
const timings = new Map<string, number[]>();
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const start = performance.now();
    const response = await fixture.app.fetch(request);
    const path = new URL(request.url).pathname;
    const durations = timings.get(path) ?? [];
    durations.push(performance.now() - start);
    timings.set(path, durations);
    return response;
  },
});
async function read(path: string) {
  const controller = new AbortController();
  const response = await fetch(new URL(path, server.url), {
    headers: fixture.headers,
    signal: controller.signal,
  });
  if (response.status !== 200 && !(path.endsWith("/goal") && response.status === 404))
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  if (path.endsWith("/stream")) {
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
  } else await response.arrayBuffer();
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  for (let i = 0; i < 3; i++) for (const path of Object.values(fixture.paths)) await read(path);
  const rows: Record<string, unknown>[] = [];
  for (const [endpoint, path] of Object.entries(fixture.paths)) {
    const queries: number[] = [],
      transactions: number[] = [];
    timings.clear();
    for (let i = 0; i < samples; i++) {
      fixture.statements.length = 0;
      await read(path);
      queries.push(fixture.statements.length);
      transactions.push(fixture.statements.filter((q) => /^begin\b/i.test(q.trim())).length);
    }
    rows.push({
      endpoint,
      statements: median(queries),
      transactions: median(transactions),
      serverP50Ms: median(timings.get(new URL(path, server.url).pathname)!),
      sql: [...fixture.statements],
    });
  }
  timings.clear();
  fixture.statements.length = 0;
  for (let i = 0; i < samples; i++) await Promise.all(Object.values(fixture.paths).map(read));
  for (const row of rows) {
    const path = fixture.paths[row.endpoint as keyof typeof fixture.paths];
    row.burstP50Ms = median(timings.get(new URL(path, server.url).pathname)!);
  }
  const result = JSON.stringify(
    {
      samples,
      database: "PostgreSQL 17, restricted app role, FORCE RLS, pool=10, loopback",
      burstStatements: fixture.statements.length / samples,
      rows,
    },
    null,
    2,
  );
  if (process.argv[2]) await writeFile(process.argv[2], result + "\n");
  console.log(
    JSON.stringify(
      rows.map(({ sql: _sql, ...row }) => row),
      null,
      2,
    ),
  );
} finally {
  server.stop(true);
  await fixture.close();
}
