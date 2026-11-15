import assert from "node:assert/strict";
import { createConnection, createServer, type Server } from "node:net";
import postgres from "postgres";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createEnrollment,
  createSession,
  mutateSessionControlInTransaction,
  recordPendingSessionToolCallResult,
  registerPendingSessionToolCall,
  saveRunState,
  updateWorkspaceSettings,
  withWorkspaceSessionActivityRls,
} from "../../packages/db/src/index";
import {
  claimConnectedCommandOutputCollection,
  returnConnectedCommandOutputCollection,
} from "../../packages/db/src/session-background-commands";
import { submitTestHumanPrompt } from "../../test/integration/helpers/session-control";

// Disposable local contention diagnostic for the session-event write path.
// Many sessions in ONE workspace run model-step-shaped append sequences in
// parallel through the real product helpers, while API-shaped writers append
// to the same sessions and an admission actor takes the exclusive workspace
// control prefix (session Pause/Resume on idle sessions, settings updates).
// No model, sandbox or live service is used. Report: client latency, total
// PostgreSQL execution time (pg_stat_statements) and sampled lock waits.
const sessions = Number(process.env.BENCH_SESSIONS ?? 12);
const steps = Number(process.env.BENCH_STEPS ?? 6);
const oneWayDelayMs = Number(process.env.BENCH_ONE_WAY_DELAY_MS ?? 0.5);
const controlIntervalMs = Number(process.env.BENCH_CONTROL_INTERVAL_MS ?? 50);
const apiWriters = Number(process.env.BENCH_API_WRITERS ?? 4);
const apiIntervalMs = Number(process.env.BENCH_API_INTERVAL_MS ?? 20);
const poolSize = Number(process.env.BENCH_POOL ?? 40);
// Connected-command output custody sweep: claim and return one exited
// command's output collection per running session, round robin.
const custodyIntervalMs = Number(process.env.BENCH_CUSTODY_INTERVAL_MS ?? 0);
const custodyWorkers = Number(process.env.BENCH_CUSTODY_WORKERS ?? 2);
const label = process.env.BENCH_LABEL ?? "run";

const shared = await acquireSharedTestDatabase(`session-event-contention-${label}`);
if (!shared) throw new Error("Real PostgreSQL required");
const admin = postgres(shared.adminUrl, { max: 2, prepare: false, onnotice: () => {} });
const pgss = await admin`
  select exists (select 1 from pg_available_extensions where name = 'pg_stat_statements') as ok`.then(
  async ([row]) => {
    if (!row?.ok) return false;
    await admin`create extension if not exists pg_stat_statements`;
    try {
      await admin`select pg_stat_statements_reset()`;
      return true;
    } catch {
      return false;
    }
  },
);

// Loopback relay that delays every chunk, so lock hold times include realistic
// client/server round trips instead of loopback microseconds.
function delayedRelay(target: URL): Promise<{ server: Server; url: string }> {
  const server = createServer((frontend) => {
    const backend = createConnection({ host: target.hostname, port: Number(target.port) });
    frontend.setNoDelay(true);
    backend.setNoDelay(true);
    const pipe = (from: typeof frontend, to: typeof frontend) => {
      from.on("data", (chunk) => {
        if (oneWayDelayMs <= 0) to.write(chunk);
        else setTimeout(() => !to.destroyed && to.write(chunk), oneWayDelayMs);
      });
    };
    pipe(frontend, backend);
    pipe(backend, frontend);
    const close = () => {
      frontend.destroy();
      backend.destroy();
    };
    for (const socket of [frontend, backend]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      const url = new URL(target.href);
      url.port = String(address.port);
      done({ server, url: url.href });
    }),
  );
}

const direct = createDb(shared.appUrl, { max: 8 });
const relay = await delayedRelay(new URL(shared.appUrl));
const app = createDb(relay.url, { max: poolSize });
const db = app.db;

const id = crypto.randomUUID();
const grant = (
  await bootstrapWorkspace(direct.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Contention bench",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Contention bench",
    subjectId: id,
  })
).workspaceGrants[0]!;
const workspaceId = grant.workspaceId!;

type Running = { sessionId: string; turnId: string; attemptId: string; generation: number };
async function startRunning(): Promise<Running> {
  const session = await createSession(direct.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "bench",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await submitTestHumanPrompt(direct.db, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    sessionId: session.id,
    text: "bench",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(direct.db, workspaceId, {
    sessionId: session.id,
    attemptId,
    workflowId: `bench-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  assert.equal(claim.action, "claimed");
  if (claim.action !== "claimed") throw new Error("not claimed");
  return {
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    generation: claim.turn.executionGeneration,
  };
}

const running = await Promise.all(Array.from({ length: sessions }, () => startRunning()));
const idle = await Promise.all(
  Array.from({ length: 2 }, () =>
    createSession(direct.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "idle",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    }),
  ),
);

const enrollment = await createEnrollment(direct.db, {
  accountId: grant.accountId,
  workspaceId,
  pubkey: `ed25519:${crypto.randomUUID()}`,
});
await admin`update enrollments set connection_instance_id = 'launch',
  connection_lease_expires_at = now() + interval '1 hour' where id = ${enrollment.id}`;
const custody = await Promise.all(
  running.map(async (run) => {
    const opId = crypto.randomUUID();
    const [row] = await admin<{ id: string }[]>`
      insert into session_background_commands (account_id, workspace_id, session_id, provider,
        state, control_workspace_id, enrollment_id, connection_instance_id, op_id, exit_code,
        settlement_reason, settled_at, reconcile_after)
      values (${grant.accountId}, ${workspaceId}, ${run.sessionId}, 'connected_machine', 'exited',
        ${workspaceId}, ${enrollment.id}, 'launch', ${opId}, 0, 'op_exit', now(), now())
      returning id`;
    return {
      accountId: grant.accountId,
      workspaceId,
      sessionId: run.sessionId,
      commandId: row!.id,
      controlWorkspaceId: workspaceId,
      enrollmentId: enrollment.id,
      connectionInstanceId: "launch",
      opId,
    };
  }),
);

const latencies = new Map<string, number[]>();
async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    const list = latencies.get(name) ?? [];
    list.push(performance.now() - started);
    latencies.set(name, list);
  }
}

async function modelTurn(run: Running): Promise<void> {
  const append = (
    name: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ) =>
    timed(name, async () => {
      const result = await appendSessionEventsForTurnAttempt(
        db,
        workspaceId,
        run.sessionId,
        run.turnId,
        run.generation,
        run.attemptId,
        events.map((event) => ({ ...event, turnId: run.turnId })),
      );
      assert.equal(result.accepted, true);
    });
  const identity = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    executionGeneration: run.generation,
    attemptId: run.attemptId,
  };
  for (let step = 0; step < steps; step += 1) {
    await append("append.semantic", [{ type: "agent.model.request", payload: { step } }]);
    for (let delta = 0; delta < 4; delta += 1) {
      await append(
        "append.raw",
        Array.from({ length: 5 }, (_, index) => ({
          type: "agent.message.delta",
          payload: { delta: `s${step}d${delta}i${index}` },
        })),
      );
    }
    const callId = `call-${run.sessionId}-${step}`;
    await timed("tool.register", () =>
      registerPendingSessionToolCall(db, {
        ...identity,
        callId,
        callType: "function_call",
        callItem: { type: "function_call", callId, name: "exec_command", arguments: {} },
      }),
    );
    await append("append.semantic", [
      { type: "agent.toolCall.created", payload: { id: callId, name: "exec_command" } },
    ]);
    await timed("tool.result", () =>
      recordPendingSessionToolCallResult(db, {
        ...identity,
        callId,
        resultItem: { type: "function_call_result", callId, output: "ok" },
      }),
    );
    await append("append.semantic", [
      { type: "agent.toolCall.output", payload: { id: callId, output: "ok" } },
    ]);
    await append("append.semantic", [
      {
        type: "agent.model.usage",
        payload: { sourceKey: `${run.attemptId}:${step}`, inputTokens: 1, outputTokens: 1 },
      },
    ]);
    await timed("fence.full", () =>
      saveRunState(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: run.sessionId,
        turnId: run.turnId,
        expectedExecutionGeneration: run.generation,
        expectedAttemptId: run.attemptId,
        serializedRunState: JSON.stringify({ step, pad: "x".repeat(2_000) }),
        pendingApprovals: [],
      }),
    );
  }
}

const flags = { stop: false, sampling: true };
async function apiWriter(index: number): Promise<void> {
  let round = 0;
  while (!flags.stop) {
    const target = running[(index + round++) % running.length]!;
    await timed("api.append", () =>
      appendSessionEvents(db, workspaceId, target.sessionId, [
        { type: "session.title_set", payload: { title: `api ${index}:${round}`, source: "agent" } },
      ]),
    );
    await new Promise((done) => setTimeout(done, apiIntervalMs));
  }
}

async function admissionActor(): Promise<void> {
  let round = 0;
  while (!flags.stop) {
    const target = idle[round % idle.length]!;
    const action = Math.floor(round / idle.length) % 2 === 0 ? "pause" : "resume";
    round += 1;
    await timed("control.session", () =>
      withWorkspaceSessionActivityRls(db, workspaceId, (tx) =>
        mutateSessionControlInTransaction(tx, {
          accountId: grant.accountId,
          workspaceId,
          sessionId: target.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          action,
        }),
      ),
    );
    if (round % 4 === 0) {
      await timed("control.settings", () =>
        updateWorkspaceSettings(db, workspaceId, {}).catch(() => undefined),
      );
    }
    await new Promise((done) => setTimeout(done, controlIntervalMs));
  }
}

async function custodyWorker(index: number): Promise<void> {
  let round = 0;
  while (!flags.stop) {
    const identity = custody[(index + round++ * custodyWorkers) % custody.length]!;
    const claimId = crypto.randomUUID();
    const claimed = await timed("custody.claim", () =>
      claimConnectedCommandOutputCollection(db, { ...identity, claimId }),
    );
    if (claimed)
      await timed("custody.return", () =>
        returnConnectedCommandOutputCollection(db, { ...identity, claimId }),
      );
    await new Promise((done) => setTimeout(done, custodyIntervalMs));
  }
}

// Lock-wait sampler: every 5 ms, count backends of this database waiting on a
// heavyweight lock, split by lock kind. Sum(count) * interval approximates the
// total lock-wait time.
const sampler = postgres(shared.adminUrl, { max: 1, prepare: false });
const waitSamples = new Map<string, number>();
let samplerTicks = 0;
const samplerIntervalMs = 5;
const samplerLoop = (async () => {
  while (flags.sampling) {
    const rows = await sampler<{ kind: string; count: number }[]>`
      select coalesce(wait_event, 'other') as kind, count(*)::int as count
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      group by 1`;
    samplerTicks += 1;
    for (const row of rows) waitSamples.set(row.kind, (waitSamples.get(row.kind) ?? 0) + row.count);
    await new Promise((done) => setTimeout(done, samplerIntervalMs));
  }
})();

if (pgss) await admin`select pg_stat_statements_reset()`;
const startedAt = performance.now();
const background = [
  ...Array.from({ length: apiWriters }, (_, index) => apiWriter(index)),
  ...(controlIntervalMs > 0 ? [admissionActor()] : []),
  ...(custodyIntervalMs > 0
    ? Array.from({ length: custodyWorkers }, (_, index) => custodyWorker(index))
    : []),
];
await Promise.all(running.map((run) => modelTurn(run)));
const wallMs = performance.now() - startedAt;
flags.stop = true;
await Promise.all(background);
const samplerWallMs = performance.now() - startedAt;
flags.sampling = false;
await samplerLoop;

// Ordering and exactly-once: per session, contiguous sequences and every
// producer event exactly once.
for (const run of running) {
  const rows = await admin<{ sequence: string; type: string }[]>`
    select sequence::text as sequence, type from session_events
    where session_id = ${run.sessionId} order by session_events.sequence`;
  if (process.env.BENCH_DEBUG)
    console.error(rows.map((row) => `${row.sequence}:${row.type}`).join(" "));
  rows.forEach((row, index) => assert.equal(Number(row.sequence), index + 1));
  const deltas = rows.filter((row) => row.type === "agent.message.delta").length;
  assert.equal(deltas, steps * 4 * 5);
}

const statements = pgss
  ? await admin<
      { query: string; calls: string; total_ms: number; mean_ms: number }[]
    >`select left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as query, calls::text,
        round(total_exec_time::numeric, 1)::float as total_ms,
        round(mean_exec_time::numeric, 2)::float as mean_ms
      from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())
      order by total_exec_time desc limit 40`
  : [];
const [totals] = pgss
  ? await admin<{ total_ms: number; calls: string }[]>`
      select round(sum(total_exec_time)::numeric, 1)::float as total_ms, sum(calls)::text as calls
      from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())`
  : [];
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(2),
  );
};
const report = JSON.stringify(
  {
    label,
    sessions,
    steps,
    oneWayDelayMs,
    wallMs: Math.round(wallMs),
    dbExecMs: totals?.total_ms ?? null,
    dbCalls: totals ? Number(totals.calls) : null,
    lockWaitMsByKind: Object.fromEntries(
      [...waitSamples].map(([kind, count]) => [
        kind,
        Math.round(count * (samplerWallMs / Math.max(1, samplerTicks))),
      ]),
    ),
    ops: Object.fromEntries(
      [...latencies].map(([name, values]) => [
        name,
        { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) },
      ]),
    ),
    topStatements: statements,
  },
  null,
  2,
);
if (process.env.BENCH_OUT) await Bun.write(process.env.BENCH_OUT, report);
else console.log(report);

await sampler.end();
await admin.end();
await app.close();
await direct.close();
await new Promise<void>((done) => relay.server.close(() => done()));
await shared.release();
process.exit(0);
