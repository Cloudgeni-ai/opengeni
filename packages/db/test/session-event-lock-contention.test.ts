import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createEnrollment,
  createSession,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  updateWorkspaceSettings,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import {
  claimConnectedCommandOutputCollection,
  claimConnectedCommandOutputReleases,
  recordConnectedCommandOutputConsumption,
  recordConnectedCommandOutputRelease,
  returnConnectedCommandOutputCollection,
  settleConnectedCommandOutputReleaseClaim,
} from "../src/session-background-commands";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

// Real PostgreSQL concurrency is the subject: many sessions in one workspace,
// worker-shaped and API-shaped appends interleaved with admission changes and
// connected-command output custody, then crashes injected into custody writes.
setDefaultTimeout(240_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let admin: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-lock-contention");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 40 });
  admin = postgres(shared.adminUrl, { max: 4, prepare: false, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

type Running = { sessionId: string; turnId: string; attemptId: string; generation: number };
type CustodyIdentity = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  commandId: string;
  controlWorkspaceId: string;
  enrollmentId: string;
  connectionInstanceId: string;
  opId: string;
};

async function workspace() {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Lock contention",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Lock contention",
      subjectId: id,
    })
  ).workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

type Grant = Awaited<ReturnType<typeof workspace>>;

async function idleSession(grant: Grant) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "idle",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}

async function runningSession(grant: Grant): Promise<Running> {
  const session = await idleSession(grant);
  await submitTestHumanPrompt(client.db, {
    ...grant,
    sessionId: session.id,
    text: "run",
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    attemptId,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("fixture claim failed");
  return {
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    generation: claim.turn.executionGeneration,
  };
}

async function exitedCommand(grant: Grant, sessionId: string): Promise<CustodyIdentity> {
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
  });
  await admin`update enrollments set connection_instance_id = 'launch',
    connection_lease_expires_at = now() + interval '1 hour' where id = ${enrollment.id}`;
  const opId = crypto.randomUUID();
  const [row] = await admin<{ id: string }[]>`
    insert into session_background_commands (account_id, workspace_id, session_id, provider,
      state, control_workspace_id, enrollment_id, connection_instance_id, op_id, exit_code,
      settlement_reason, settled_at, reconcile_after)
    values (${grant.accountId}, ${grant.workspaceId}, ${sessionId}, 'connected_machine', 'exited',
      ${grant.workspaceId}, ${enrollment.id}, 'launch', ${opId}, 0, 'op_exit', now(),
      '2000-01-01T00:00:00Z'::timestamptz)
    returning id`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    commandId: row!.id,
    controlWorkspaceId: grant.workspaceId,
    enrollmentId: enrollment.id,
    connectionInstanceId: "launch",
    opId,
  };
}

async function controlSession(
  grant: Grant,
  sessionId: string,
  action: "pause" | "resume",
): Promise<void> {
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (tx) =>
    mutateSessionControlInTransaction(tx, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function controlWorkspace(grant: Grant, action: "pause" | "resume"): Promise<void> {
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (tx) =>
    mutateWorkspaceControlInTransaction(tx, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function sessionEvents(sessionId: string) {
  return await admin<{ sequence: string; type: string; token: string | null }[]>`
    select sequence::text as sequence, type, payload->>'token' as token
    from session_events where session_id = ${sessionId} order by session_events.sequence`;
}

test("parallel worker and API appends, admission churn and output custody keep order and exactly-once", async () => {
  const grant = await workspace();
  const running = await Promise.all(Array.from({ length: 8 }, () => runningSession(grant)));
  const idle = await Promise.all(Array.from({ length: 2 }, () => idleSession(grant)));
  const custody = await Promise.all(running.map((run) => exitedCommand(grant, run.sessionId)));
  const before = new Map<string, number>();
  for (const run of running) before.set(run.sessionId, (await sessionEvents(run.sessionId)).length);

  const accepted = new Map<string, Set<string>>();
  const record = (sessionId: string, token: string) => {
    const set = accepted.get(sessionId) ?? new Set<string>();
    set.add(token);
    accepted.set(sessionId, set);
  };
  const actors = { stop: false };
  const worker = async (run: Running) => {
    for (let step = 0; step < 6; step += 1) {
      const semantic = `w:${run.sessionId}:${step}`;
      const raw = Array.from({ length: 4 }, (_, index) => `${semantic}:d${index}`);
      const first = await appendSessionEventsForTurnAttempt(
        client.db,
        grant.workspaceId,
        run.sessionId,
        run.turnId,
        run.generation,
        run.attemptId,
        [{ type: "agent.model.request", payload: { token: semantic }, turnId: run.turnId }],
      );
      expect(first.accepted).toBe(true);
      record(run.sessionId, semantic);
      const second = await appendSessionEventsForTurnAttempt(
        client.db,
        grant.workspaceId,
        run.sessionId,
        run.turnId,
        run.generation,
        run.attemptId,
        raw.map((token) => ({
          type: "agent.message.delta",
          payload: { token, delta: token },
          turnId: run.turnId,
        })),
      );
      expect(second.accepted).toBe(true);
      for (const token of raw) record(run.sessionId, token);
    }
  };
  const api = async (index: number) => {
    let round = 0;
    while (!actors.stop) {
      const run = running[(index + round) % running.length]!;
      const token = `api:${index}:${round++}`;
      await appendSessionEvents(client.db, grant.workspaceId, run.sessionId, [
        { type: "session.title_set", payload: { title: token, token, source: "agent" } },
      ]);
      record(run.sessionId, token);
    }
  };
  const admission = async () => {
    let round = 0;
    while (!actors.stop) {
      const target = idle[round % idle.length]!;
      await controlSession(
        grant,
        target.id,
        Math.floor(round / idle.length) % 2 ? "resume" : "pause",
      );
      if (round % 3 === 0) await updateWorkspaceSettings(client.db, grant.workspaceId, {});
      round += 1;
    }
  };
  const claimWins = new Map<string, number>();
  const custodian = async (index: number) => {
    let round = 0;
    while (!actors.stop) {
      const identity = custody[(index + round++) % custody.length]!;
      const claimId = crypto.randomUUID();
      if (await claimConnectedCommandOutputCollection(client.db, { ...identity, claimId })) {
        claimWins.set(identity.commandId, (claimWins.get(identity.commandId) ?? 0) + 1);
        await returnConnectedCommandOutputCollection(client.db, { ...identity, claimId });
      }
    }
  };
  const background = [
    ...Array.from({ length: 3 }, (_, index) => api(index)),
    admission(),
    ...Array.from({ length: 4 }, (_, index) => custodian(index)),
  ];
  try {
    await Promise.all(running.map(worker));
  } finally {
    actors.stop = true;
    await Promise.all(background);
  }

  for (const run of running) {
    const rows = await sessionEvents(run.sessionId);
    rows.forEach((row, index) => expect(Number(row.sequence)).toBe(index + 1));
    const produced = rows.slice(before.get(run.sessionId)!).map((row) => row.token);
    const tokens = produced.filter((token): token is string => token !== null);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(new Set(tokens)).toEqual(accepted.get(run.sessionId) ?? new Set());
    // Worker events keep their producer order within the session.
    const workerTokens = tokens.filter((token) => token.startsWith("w:"));
    expect(workerTokens).toEqual(
      Array.from({ length: 6 }, (_step, step) => {
        const semantic = `w:${run.sessionId}:${step}`;
        return [semantic, ...Array.from({ length: 4 }, (_delta, index) => `${semantic}:d${index}`)];
      }).flat(),
    );
    const [cursor] = await admin<{ last_sequence: string; session_last: string }[]>`
      select cursor.last_sequence::text, session.last_sequence::text as session_last
      from session_event_cursors cursor join sessions session on session.id = cursor.session_id
      where cursor.session_id = ${run.sessionId}`;
    expect(Number(cursor!.last_sequence)).toBe(rows.length);
    expect(Number(cursor!.session_last)).toBeLessThanOrEqual(rows.length);
  }
  // Every command's output stayed claimable by exactly one owner at a time and
  // ends unclaimed.
  const commands = await admin<{ reconcile_claim_id: string | null }[]>`
    select reconcile_claim_id from session_background_commands
    where id in ${admin(custody.map((identity) => identity.commandId))}`;
  expect(commands.every((row) => row.reconcile_claim_id === null)).toBe(true);
  expect([...claimWins.values()].reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);

  // A workspace Pause committed during appends: every append that starts after
  // it commits is refused and stores nothing; nothing accepted is lost.
  const late = await Promise.all(Array.from({ length: 4 }, () => runningSession(grant)));
  let pausedAt = Number.POSITIVE_INFINITY;
  const outcomes: Array<{ sessionId: string; token: string; startedAt: number; ok: boolean }> = [];
  const lateWorker = async (run: Running) => {
    for (let step = 0; step < 40; step += 1) {
      const token = `late:${run.sessionId}:${step}`;
      const startedAt = performance.now();
      const result = await appendSessionEventsForTurnAttempt(
        client.db,
        grant.workspaceId,
        run.sessionId,
        run.turnId,
        run.generation,
        run.attemptId,
        [{ type: "agent.model.request", payload: { token }, turnId: run.turnId }],
      );
      outcomes.push({ sessionId: run.sessionId, token, startedAt, ok: result.accepted });
      if (!result.accepted) return;
    }
  };
  const lateRuns = late.map(lateWorker);
  await new Promise((done) => setTimeout(done, 30));
  await controlWorkspace(grant, "pause");
  pausedAt = performance.now();
  await Promise.all(lateRuns);
  expect(outcomes.some((outcome) => !outcome.ok)).toBe(true);
  for (const outcome of outcomes) {
    if (outcome.startedAt > pausedAt) expect(outcome.ok).toBe(false);
  }
  for (const run of late) {
    const tokens = (await sessionEvents(run.sessionId))
      .map((row) => row.token)
      .filter((token): token is string => token?.startsWith("late:") ?? false);
    expect(tokens).toEqual(
      outcomes
        .filter((outcome) => outcome.sessionId === run.sessionId && outcome.ok)
        .map((outcome) => outcome.token),
    );
  }
  await controlWorkspace(grant, "resume");
});

// A custody write killed at any point leaves its row exactly as before, and its
// retry takes effect exactly once.
async function crashOnce(
  identity: CustodyIdentity,
  point: "lock_wait" | "after_write",
  write: (db: ReturnType<typeof createDb>["db"]) => Promise<unknown>,
): Promise<void> {
  const victim = createDb(shared.appUrl, { max: 1 });
  const marker = `crash-${crypto.randomUUID()}`;
  let releaseHolder = () => {};
  let holder: Promise<unknown> = Promise.resolve();
  try {
    if (point === "lock_wait") {
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const released = new Promise<void>((done) => (releaseHolder = done));
      holder = admin.begin(async (sql) => {
        await sql`select id from session_background_commands where id = ${identity.commandId} for update`;
        held();
        await released;
      });
      await holding;
    } else {
      // Sleep inside the write, after the row change and before commit.
      await admin.unsafe(`
        create or replace function opengeni_test_crash_${marker.replaceAll("-", "_")}() returns trigger
        language plpgsql as $$ begin perform pg_sleep(30); return null; end $$;
      `);
      await admin.unsafe(`
        create trigger "${marker}" after update on session_background_commands
        for each row when (new.op_id = '${identity.opId}')
        execute function opengeni_test_crash_${marker.replaceAll("-", "_")}();
      `);
    }
    const pending = write(victim.db).then(
      () => "completed" as const,
      () => "failed" as const,
    );
    const waitEvent = point === "lock_wait" ? "Lock" : "Timeout";
    let pid: number | null = null;
    for (let tries = 0; tries < 400 && pid === null; tries += 1) {
      const [row] = await admin<{ pid: number }[]>`
        select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = ${waitEvent}
          and query ilike '%session_background_commands%' and pid <> pg_backend_pid()
        limit 1`;
      pid = row?.pid ?? null;
      if (pid === null) await new Promise((done) => setTimeout(done, 25));
    }
    expect(pid).not.toBeNull();
    await admin`select pg_terminate_backend(${pid})`;
    expect(await pending).toBe("failed");
  } finally {
    releaseHolder();
    await holder;
    if (point === "after_write") {
      await admin.unsafe(`drop trigger if exists "${marker}" on session_background_commands`);
      await admin.unsafe(
        `drop function if exists opengeni_test_crash_${marker.replaceAll("-", "_")}()`,
      );
    }
    await victim.close().catch(() => undefined);
  }
}

async function custodyRow(commandId: string) {
  const [row] = await admin<
    {
      reconcile_claim_id: string | null;
      output_exit_seq: string | null;
      output_consumed_at: Date | null;
      output_release_observed_at: Date | null;
      last_reconcile_outcome: string | null;
      reconcile_after: Date;
    }[]
  >`select reconcile_claim_id, output_exit_seq, output_consumed_at, output_release_observed_at,
      last_reconcile_outcome, reconcile_after
    from session_background_commands where id = ${commandId}`;
  return row!;
}

test("custody writes crashed while waiting or after writing leave the row unchanged and retry exactly once", async () => {
  const grant = await workspace();
  const run = await runningSession(grant);
  for (const point of ["lock_wait", "after_write"] as const) {
    const identity = await exitedCommand(grant, run.sessionId);
    const sequenceBefore = (await sessionEvents(run.sessionId)).length;

    // Collection claim.
    const claimId = crypto.randomUUID();
    const initial = await custodyRow(identity.commandId);
    await crashOnce(identity, point, (db) =>
      claimConnectedCommandOutputCollection(db, { ...identity, claimId }),
    );
    expect(await custodyRow(identity.commandId)).toEqual(initial);
    expect(await claimConnectedCommandOutputCollection(client.db, { ...identity, claimId })).toBe(
      true,
    );
    expect(
      await claimConnectedCommandOutputCollection(client.db, {
        ...identity,
        claimId: crypto.randomUUID(),
      }),
    ).toBe(false);

    // Collection return.
    const claimed = await custodyRow(identity.commandId);
    await crashOnce(identity, point, (db) =>
      returnConnectedCommandOutputCollection(db, { ...identity, claimId }),
    );
    expect(await custodyRow(identity.commandId)).toEqual(claimed);
    await returnConnectedCommandOutputCollection(client.db, { ...identity, claimId });
    expect((await custodyRow(identity.commandId)).reconcile_claim_id).toBeNull();

    // Consumption receipt.
    const receipt = { exitSeq: "5", attachGeneration: "1" };
    const unconsumed = await custodyRow(identity.commandId);
    await crashOnce(identity, point, (db) =>
      recordConnectedCommandOutputConsumption(db, { ...identity, receipt, exitCode: 0 }),
    );
    expect(await custodyRow(identity.commandId)).toEqual(unconsumed);
    await recordConnectedCommandOutputConsumption(client.db, { ...identity, receipt, exitCode: 0 });
    const consumed = await custodyRow(identity.commandId);
    expect(consumed.output_exit_seq).toBe("5");
    await recordConnectedCommandOutputConsumption(client.db, { ...identity, receipt, exitCode: 0 });
    expect(await custodyRow(identity.commandId)).toEqual(consumed);

    // Release-claim settlement.
    const [releaseClaim] = (
      await claimConnectedCommandOutputReleases(client.db, {
        claimId: crypto.randomUUID(),
        limit: 100,
        claimTtlMs: 60_000,
      })
    ).filter((claim) => claim.commandId === identity.commandId);
    expect(releaseClaim).toBeDefined();
    const releaseClaimed = await custodyRow(identity.commandId);
    await crashOnce(identity, point, (db) =>
      settleConnectedCommandOutputReleaseClaim(db, {
        claim: releaseClaim!,
        outcome: "published",
        retryAfterMs: 30_000,
      }),
    );
    expect(await custodyRow(identity.commandId)).toEqual(releaseClaimed);
    expect(
      await settleConnectedCommandOutputReleaseClaim(client.db, {
        claim: releaseClaim!,
        outcome: "published",
        retryAfterMs: 30_000,
      }),
    ).toBe(true);
    expect(
      await settleConnectedCommandOutputReleaseClaim(client.db, {
        claim: releaseClaim!,
        outcome: "published",
        retryAfterMs: 30_000,
      }),
    ).toBe(false);

    // Release record.
    const unreleased = await custodyRow(identity.commandId);
    await crashOnce(identity, point, (db) =>
      recordConnectedCommandOutputRelease(db, { ...identity, exitSeq: "5" }),
    );
    expect(await custodyRow(identity.commandId)).toEqual(unreleased);
    expect(
      await recordConnectedCommandOutputRelease(client.db, { ...identity, exitSeq: "5" }),
    ).toBe(true);
    expect(
      await recordConnectedCommandOutputRelease(client.db, { ...identity, exitSeq: "5" }),
    ).toBe(false);
    expect((await custodyRow(identity.commandId)).output_release_observed_at).not.toBeNull();

    // Custody never touched the session's event stream.
    expect((await sessionEvents(run.sessionId)).length).toBe(sequenceBefore);
  }
});
