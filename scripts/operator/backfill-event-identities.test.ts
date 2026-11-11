import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, createSession } from "../../packages/db/src";
import { listSessionEventSlices } from "../../packages/db/src/session-event-slices";
import {
  backfillIdentityBatch,
  inspectIdentityBackfill,
  readCheckpoint,
  runIdentityBackfill,
  saveIdentityCheckpoint,
  type IdentityCheckpoint,
} from "./backfill-event-identities";

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let workspaceId: string, accountId: string, sessionId: string, directory: string;
const options = { batchSize: 3, lockTimeoutMs: 1000, statementTimeoutMs: 10000 };
async function initial(): Promise<IdentityCheckpoint> {
  const observed = await inspectIdentityBackfill(fixture.admin);
  const at = new Date().toISOString();
  return {
    version: 1,
    database: observed.database,
    upperId: observed.upperId,
    afterId: null,
    scanned: 0,
    updated: 0,
    statementWalBytes: 0,
    batches: 0,
    startedAt: at,
    updatedAt: at,
    startWalLsn: observed.walLsn,
    done: observed.upperId === null,
  };
}
beforeAll(async () => {
  const shared = await acquireSharedTestDatabase("operator-event-identities");
  if (!shared) throw Error("Real PostgreSQL required");
  fixture = shared;
  client = createDb(shared.appUrl, { max: 1 });
  directory = await mkdtemp(join(tmpdir(), "opengeni-identity-test-"));
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Backfill",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Backfill",
    subjectId: crypto.randomUUID(),
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
  sessionId = (
    await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Fixture",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    })
  ).id;
}, 180000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 60000);

test("bounded fill preserves all event content, aliases, non-null values and retry semantics", async () => {
  const payloads = [
    { name: "named", callId: "first", call_id: "second", id: "third" },
    { call_id: "legacy" },
    { id: 42 },
    { callId: null, call_id: "fallback" },
    {},
    { callId: "x".repeat(3000) },
    { name: { nested: true }, callId: { nested: true } },
    { callId: "" },
  ];
  for (const [n, payload] of payloads.entries()) {
    await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      values(${accountId},${workspaceId},${sessionId},${n + 1},${n % 2 === 0 ? "agent.toolCall.created" : "agent.toolCall.output"},${fixture.admin.json(payload)})`;
  }
  await fixture.admin`update session_events set tool_name=null,tool_call_id=null where session_id=${sessionId}`;
  await fixture.admin`update session_events set tool_call_id='already-projected' where session_id=${sessionId} and sequence=1`;
  expect(
    (
      await fixture.admin`select count(*)::int n from session_events where session_id=${sessionId} and tool_call_id is null`
    )[0]!.n,
  ).toBe(7);
  const before =
    await fixture.admin`select (to_jsonb(e)-'tool_name'-'tool_call_id') content from session_events e where session_id=${sessionId} order by sequence`;
  const queries = [
    { callId: "already-projected" },
    { callId: "legacy" },
    { callId: "absent" },
    { callId: "x".repeat(3000) },
    { toolName: "named" },
  ];
  const pages = [];
  for (const query of queries)
    pages.push(
      await listSessionEventSlices(client.db, workspaceId, sessionId, {
        view: "tools",
        includeTypes: ["agent.toolCall.created", "agent.toolCall.output"],
        ...query,
      }),
    );
  const start = await initial();
  let state = await backfillIdentityBatch(fixture.admin, start, options);
  expect(state.scanned).toBe(3);
  const retried = await backfillIdentityBatch(fixture.admin, start, options);
  expect(retried.afterId).toBe(state.afterId);
  expect(retried.updated).toBe(0);
  while (!state.done) state = await backfillIdentityBatch(fixture.admin, state, options);
  expect(state.scanned).toBe(payloads.length);
  expect(state.statementWalBytes).toBeGreaterThan(0);
  expect(
    await fixture.admin`select (to_jsonb(e)-'tool_name'-'tool_call_id') content from session_events e where session_id=${sessionId} order by sequence`,
  ).toEqual(before);
  const rows =
    await fixture.admin`select sequence,tool_name,tool_call_id from session_events where session_id=${sessionId} order by sequence`;
  expect(rows.map((r) => r.tool_call_id)).toEqual([
    "already-projected",
    "legacy",
    "42",
    "fallback",
    null,
    "x".repeat(3000),
    '{"nested": true}',
    "",
  ]);
  expect(rows[0]!.tool_name).toBe("named");
  expect(rows[6]!.tool_name).toBe('{"nested": true}');
  for (const [i, query] of queries.entries())
    expect(
      await listSessionEventSlices(client.db, workspaceId, sessionId, {
        view: "tools",
        includeTypes: ["agent.toolCall.created", "agent.toolCall.output"],
        ...query,
      }),
    ).toEqual(pages[i]!);
  let repeat = await initial();
  while (!repeat.done) repeat = await backfillIdentityBatch(fixture.admin, repeat, options);
  expect(repeat.updated).toBe(0);
  const path = join(directory, "state.json");
  await saveIdentityCheckpoint(path, state);
  expect(readCheckpoint(JSON.parse(await readFile(path, "utf8")))).toEqual(state);
  expect(() => readCheckpoint({ ...state, afterId: "bad" })).toThrow("Invalid checkpoint");
  expect(() => readCheckpoint({ ...state, statementWalBytes: -1 })).toThrow("Invalid checkpoint");
}, 180000);

test("operator refuses tenant credentials and inspection does not modify rows or checkpoints", async () => {
  const app = postgres(fixture.appUrl, { max: 1 });
  try {
    await expect(inspectIdentityBackfill(app)).rejects.toThrow("operator connection");
  } finally {
    await app.end();
  }
  const path = join(directory, "inspect-only.json");
  await runIdentityBackfill(["--checkpoint", path], {
    OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl,
  });
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    runIdentityBackfill(["--checkpoint", path, "--batch-size", "0"], {
      OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl,
    }),
  ).rejects.toThrow("positive integer");
}, 180000);

test("lock failures do not advance, and a concurrent payload writer retains its current projection", async () => {
  const [row] =
    await fixture.admin`select id from session_events where session_id=${sessionId} and sequence=1`;
  await fixture.admin`update session_events set tool_name=null,tool_call_id=null where id=${row!.id}`;
  const start = await initial();
  let unlock!: () => void, locked!: () => void;
  const held = new Promise<void>((resolve) => (locked = resolve)),
    release = new Promise<void>((resolve) => (unlock = resolve));
  const blocking = fixture.admin.begin(async (tx) => {
    await tx`select id from session_events where id=${row!.id} for update`;
    locked();
    await release;
    // Normal payload write invokes the existing identity trigger.
    await tx`update session_events set payload='{"name":"fresh","callId":"fresh-id"}'::jsonb where id=${row!.id}`;
  });
  await held;
  try {
    await expect(
      backfillIdentityBatch(fixture.admin, start, {
        ...options,
        batchSize: 100,
        lockTimeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "55P03" });
  } finally {
    unlock();
    await blocking;
  }
  const done = await backfillIdentityBatch(fixture.admin, start, { ...options, batchSize: 100 });
  expect(done.done).toBe(true);
  const [after] =
    await fixture.admin`select tool_name,tool_call_id from session_events where id=${row!.id}`;
  expect(after).toEqual({ tool_name: "fresh", tool_call_id: "fresh-id" });
}, 180000);

test("CLI persists committed batches and resumes without resetting its frontier", async () => {
  const path = join(directory, "resume.json"),
    env = { OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl };
  await runIdentityBackfill(
    ["--apply", "--checkpoint", path, "--batch-size", "2", "--pause-ms", "0", "--max-batches", "1"],
    env,
  );
  const first = readCheckpoint(JSON.parse(await readFile(path, "utf8")));
  expect(first.scanned).toBe(2);
  expect(first.done).toBe(false);
  await runIdentityBackfill(
    ["--apply", "--checkpoint", path, "--batch-size", "2", "--pause-ms", "0"],
    env,
  );
  const last = readCheckpoint(JSON.parse(await readFile(path, "utf8")));
  expect(last.done).toBe(true);
  expect(last.scanned).toBe(8);
  expect(last.upperId).toBe(first.upperId);
}, 180000);

test("lost backend ownership refuses a batch without advancing", async () => {
  const start = await initial();
  await expect(
    backfillIdentityBatch(fixture.admin, start, { ...options, expectedBackendPid: 2147483647 }),
  ).rejects.toThrow("connection changed");
  expect(start.afterId).toBeNull();
  expect(start.scanned).toBe(0);
}, 180000);

test("standalone bundle runs with the same resumable CLI", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./backfill-event-identities.ts", import.meta.url).pathname],
    outdir: directory,
    target: "bun",
  });
  expect(built.success).toBe(true);
  const checkpoint = join(directory, "bundle-state.json");
  const processHandle = Bun.spawn(
    [
      process.execPath,
      join(directory, "backfill-event-identities.js"),
      "--apply",
      "--checkpoint",
      checkpoint,
      "--pause-ms",
      "0",
    ],
    {
      env: { ...process.env, OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).event).toBe("complete");
  expect(readCheckpoint(JSON.parse(await readFile(checkpoint, "utf8"))).done).toBe(true);
}, 180000);

test("actual startup and frontier SQL use bounded UUID index scans in both plan modes", async () => {
  const [tail] =
    await fixture.admin`select coalesce(max(sequence),0)::int as sequence from session_events where session_id=${sessionId}`;
  await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    select ${accountId}::uuid,${workspaceId}::uuid,${sessionId}::uuid,n,'agent.message.delta','{"text":"fixture"}'::jsonb
    from generate_series(${Number(tail!.sequence) + 1}::int,${Number(tail!.sequence) + 12000}::int) n`;
  await fixture.admin`analyze session_events`;
  const queries: { text: string; parameters: unknown[] }[] = [];
  const connection = postgres(fixture.adminUrl, {
    max: 1,
    prepare: false,
    debug: (_id, text, parameters) => queries.push({ text, parameters: [...parameters] }),
  });
  try {
    await inspectIdentityBackfill(connection);
    await backfillIdentityBatch(connection, await initial(), { ...options, batchSize: 128 });
    const selections = queries.filter(({ text }) =>
      /select \(select id|select id(?:::text)? from session_events/.test(text),
    );
    expect(selections).toHaveLength(2);
    const literal = (value: unknown) =>
      typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await connection.unsafe(`set plan_cache_mode=${mode}`);
      for (const [n, query] of selections.entries()) {
        await connection.unsafe(`prepare identity_frontier_probe as ${query.text}`);
        const argumentsSql = query.parameters.length
          ? `(${query.parameters.map(literal).join(",")})`
          : "";
        const result = await connection.unsafe(
          `explain(analyze,buffers,format json) execute identity_frontier_probe${argumentsSql}`,
        );
        const plan = result[0]!["QUERY PLAN"][0].Plan;
        const nodes: Record<string, any>[] = [];
        const visit = (node: Record<string, any>) => {
          nodes.push(node);
          for (const child of node.Plans ?? []) visit(child);
        };
        visit(plan);
        expect(nodes.some((node) => node["Node Type"].includes("Sort"))).toBe(false);
        const index = nodes.find((node) => node["Index Name"] === "session_events_pkey");
        expect(index).toBeDefined();
        expect(index!["Actual Rows"]).toBe(n === 0 ? 1 : 128);
        console.log(
          JSON.stringify({
            probe: "uuid-frontier",
            mode,
            selection: n,
            buffers: plan["Shared Hit Blocks"],
            rows: index!["Actual Rows"],
          }),
        );
        await connection.unsafe("deallocate identity_frontier_probe");
      }
    }
  } finally {
    await connection.end();
  }
}, 180000);

test("configured statement timeout covers initial inspection before any checkpoint write", async () => {
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = fixture.admin.begin(async (tx) => {
    await tx`lock table session_events in access exclusive mode`;
    ready.resolve();
    await release.promise;
  });
  await ready.promise;
  const path = join(directory, "inspection-timeout.json");
  try {
    await expect(
      runIdentityBackfill(
        ["--checkpoint", path, "--statement-timeout-ms", "50", "--lock-timeout-ms", "1000"],
        { OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl },
      ),
    ).rejects.toMatchObject({ code: "57014" });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    await held;
  }
}, 180000);

test("CLI retains its session lock across the driver's default connection lifetime", async () => {
  const [tail] =
    await fixture.admin`select coalesce(max(sequence),0)::int as sequence from session_events where session_id=${sessionId}`;
  await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    select ${accountId}::uuid,${workspaceId}::uuid,${sessionId}::uuid,n,'agent.message.delta','{"text":"lifetime"}'::jsonb
    from generate_series(${Number(tail!.sequence) + 1}::int,${Number(tail!.sequence) + 4}::int) n`;
  const wrapper = join(directory, "accelerated-connection-lifetime.mjs");
  const checkpoint = join(directory, "connection-lifetime.json");
  // Isolate the clock acceleration in a child: only postgres.js's default
  // 30–60 minute connection timer is shortened, not SQL or pacing timeouts.
  await writeFile(
    wrapper,
    `import { runIdentityBackfill } from ${JSON.stringify(new URL("./backfill-event-identities.ts", import.meta.url).pathname)};
const original = globalThis.setTimeout;
let rotations = 0;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 1800000 && delay <= 3600000) { rotations++; delay = 25; }
  return original(callback, delay, ...args);
};
await runIdentityBackfill(process.argv.slice(2));
console.log(JSON.stringify({ rotations }));
`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      wrapper,
      "--apply",
      "--checkpoint",
      checkpoint,
      "--batch-size",
      "1",
      "--pause-ms",
      "100",
      "--max-batches",
      "3",
    ],
    {
      env: { ...process.env, OPENGENI_MAINTENANCE_DATABASE_URL: fixture.adminUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines.at(-1)).toEqual({ rotations: 0 });
  expect(lines.filter((line) => line.event === "batch")).toHaveLength(3);
  const state = readCheckpoint(JSON.parse(await readFile(checkpoint, "utf8")));
  expect(state.batches).toBe(3);
  expect(state.scanned).toBe(3);
  expect(state.done).toBe(false);
}, 180000);
