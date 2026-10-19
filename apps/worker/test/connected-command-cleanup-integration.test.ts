import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  bootstrapWorkspace,
  commitWarmingToWarm,
  createDb,
  createEnrollment,
  createSandboxEnrollment,
  createSession,
  recordAbandonedDirectConnectedMachineCommand,
  sandboxMaintenanceDue,
  settleConnectedMachineSessionBackgroundCommand,
} from "@opengeni/db";
import {
  ControlRequest,
  ControlResponse,
  ErrorCode,
  ExecRequest,
  OpAck,
} from "@opengeni/agent-proto";
import { agentConnectionCurrent } from "@opengeni/core";
import { sql } from "drizzle-orm";
import {
  recordConnectedCommandOutputConsumption,
  recordConnectedCommandOutputRelease,
  claimConnectedCommandOutputReleases,
  requestSessionBackgroundCommandCancellation,
  settleConnectedCommandOutputReleaseClaim,
} from "@opengeni/db/session-background-commands";
import type { OpStreamConnection } from "@opengeni/events";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  NatsControlRpc,
  SelfhostedControlError,
  subjectFor,
  wakeComputeSandboxOnNoResponders,
  type ControlRpc,
  type NatsRequestConnection,
} from "@opengeni/runtime/sandbox";
import {
  reconcileConnectedMachineBackgroundCommands as reconcile,
  reconcileConnectedCommandOutputReleases as releaseOutput,
} from "../src/activities/sandbox-lease";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("connected-command-cleanup");
  if (!db) throw new Error("PostgreSQL required");
  shared = db;
  client = createDb(db.appUrl);
}, 180000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60000);

/** `count` running commands on one runner "launch": a Connected Machine, or
 * a warm compute sandbox's agent. */
async function seed(count = 25, kind: "machine" | "sandbox" = "machine") {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Cleanup",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Cleanup",
    subjectId: `subject-${id}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Cleanup",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: kind === "sandbox" ? "compute" : "none",
  });
  let enrollment: { id: string };
  if (kind === "sandbox") {
    const group = { accountId, workspaceId: workspaceId!, sandboxGroupId: session.sandboxGroupId };
    await acquireLease(client.db, {
      ...group,
      kind: "turn",
      holderId: `turn-${id}`,
      backend: "compute",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(client.db, {
      ...group,
      expectedEpoch: 0,
      instanceId: `box-${id}`,
      leaseTtlMs: 45_000,
    });
    enrollment = await createSandboxEnrollment(client.db, {
      accountId,
      workspaceId: workspaceId!,
      enrollmentId: crypto.randomUUID(),
      sandboxGroupId: session.sandboxGroupId,
      hasDisplay: false,
      workspaceRoot: "/workspace",
    });
  } else {
    enrollment = await createEnrollment(client.db, {
      accountId,
      workspaceId: workspaceId!,
      pubkey: `ed25519:${id}`,
    });
  }
  await shared.admin`update enrollments set connection_instance_id='launch',connection_lease_expires_at=now()+interval '1 hour' where id=${enrollment.id}`;
  // The sweep freezes a JavaScript millisecond due frontier. The database's
  // clock_timestamp() default is evaluated per row at finer precision, so a
  // fresh batch can straddle that frontier. Seed every fixture row as due.
  await shared.admin`insert into session_background_commands(account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,reconcile_after)
 select ${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${enrollment.id},'launch',gen_random_uuid()::text,'2000-01-01T00:00:00Z'::timestamptz from generate_series(1,${count})`;
  return session.id;
}
const settings = {
  sandboxLeaseReaperPeriodMs: 30000,
  sandboxSelfhostedControlTimeoutMs: 1000,
} as Parameters<typeof reconcile>[1];
const warnings: unknown[] = [];
const observability = {
  incrementCounter: () => {},
  warn: (...args: unknown[]) => warnings.push(args),
} as unknown as Parameters<typeof reconcile>[2];
const bus = {
  getRequestConnection: async () => null,
  publish: async () => {},
} as unknown as Parameters<typeof reconcile>[3];

test("one sweep settles more than one batch and emits each future completion only once", async () => {
  const sessionId = await seed();
  const commands =
    await shared.admin`select control_workspace_id,enrollment_id,op_id from session_background_commands where session_id=${sessionId}`;
  const identity = commands[0]!;
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    workspaceId: identity.control_workspace_id,
    agentId: identity.enrollment_id,
    connectionInstanceId: "launch",
    transport,
  });
  const subject = subjectFor(identity.control_workspace_id, identity.enrollment_id, "launch");
  for (const command of commands) {
    runner.script(command.op_id, { frames: [{ channel: "stdout", bytes: "retained output" }] });
    await runner.request(
      subject,
      {
        requestId: command.op_id,
        epoch: 0,
        op: {
          $case: "opStart",
          opStart: {
            op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["work"] }) },
            windowBytes: "65536",
            deadlineMs: "0",
            originId: sessionId,
          },
        },
      },
      { timeoutMs: 1000 },
    );
  }
  const replayBus = {
    ...bus,
    getOpStreamConnection: () => opStreamConnectionFor(transport),
  } as Parameters<typeof reconcile>[3];
  let queries = 0;
  let attaches = 0;
  const rpc: ControlRpc = {
    request: async (requestSubject, request, options) => {
      const op = request.op!;
      if (op.$case === "opQuery") queries++;
      else if (op.$case === "opAttach") attaches++;
      else throw new Error("Cleanup must only query or attach existing operations");
      return await runner.request(requestSubject, request, options);
    },
  };
  await reconcile(client.db, settings, observability, replayBus, rpc);
  expect(warnings).toEqual([]);
  expect(queries).toBe(25);
  expect(attaches).toBe(25);
  const [output] =
    await shared.admin`select count(*)::int n from session_events where session_id=${sessionId} and type='sandbox.command.output.delta'`;
  expect(output!.n).toBe(25);
  expect([...runner.runs.values()].every((run) => run.startCount === 1 && !run.finalAcked)).toBe(
    true,
  );
  const [row] =
    await shared.admin`select count(*)::int n from session_background_commands where session_id=${sessionId} and state='exited'`;
  expect(row!.n).toBe(25);
  const [updates] =
    await shared.admin`select count(*)::int n from session_system_updates where session_id=${sessionId} and kind='background_command_result'`;
  expect(updates!.n).toBe(25);
  await reconcile(client.db, settings, observability, replayBus, rpc);
  expect(queries).toBe(25);
  expect(attaches).toBe(25);
  await shared.admin`update session_background_commands set reconcile_after='2000-01-01T00:00:00Z' where session_id=${sessionId}`;
  await releaseOutput(client.db, settings, observability, replayBus, rpc);
  expect([...runner.runs.values()].every((run) => run.finalAcked)).toBe(true);
  for (const command of commands) runner.lostOps.add(command.op_id);
  await shared.admin`update session_background_commands set reconcile_after='2000-01-01T00:00:00Z' where session_id=${sessionId}`;
  await releaseOutput(client.db, settings, observability, replayBus, rpc);
  const [released] = await shared.admin`select count(*)::int n from session_background_commands
    where session_id=${sessionId} and output_release_observed_at is not null and completion_observed_at is null`;
  expect(released!.n).toBe(25);
});

/** Same async-iterator adapter as the routing integration fixture: production
 * NatsOpStreamTransport consumes frames from the canonical fake runner. */
function opStreamConnectionFor(transport: InMemoryOpStreamTransport): OpStreamConnection {
  return {
    subscribe(subject) {
      const values: Array<{ data: Uint8Array }> = [];
      const readers: Array<(result: IteratorResult<{ data: Uint8Array }>) => void> = [];
      let done = false;
      let release: (() => void) | undefined;
      void transport
        .subscribe(subject, (data) => {
          const reader = readers.shift();
          if (reader) reader({ done: false, value: { data } });
          else values.push({ data });
        })
        .then((subscription) => {
          if (done) subscription.unsubscribe();
          else release = subscription.unsubscribe;
        });
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              const value = values.shift();
              if (value) return Promise.resolve({ done: false as const, value });
              if (done) return Promise.resolve({ done: true as const, value: undefined });
              return new Promise<IteratorResult<{ data: Uint8Array }>>((resolve) =>
                readers.push(resolve),
              );
            },
          };
        },
        unsubscribe() {
          if (done) return;
          done = true;
          release?.();
          for (const reader of readers.splice(0)) reader({ done: true, value: undefined });
        },
      };
    },
    publish(subject, payload) {
      void transport.publish(subject, payload);
    },
    async flush() {},
  };
}
test("offline commands remain tracked while one sweep shares failed connection observations", async () => {
  const sessionId = await seed();
  let queries = 0;
  const rpc: ControlRpc = {
    request: async () => {
      queries++;
      throw new SelfhostedControlError({
        message: "offline",
        code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
        agentOffline: true,
        reason: null,
        retryable: true,
      });
    },
  };
  await reconcile(client.db, settings, observability, bus, rpc);
  expect(queries).toBeGreaterThan(0);
  expect(queries).toBe(1);
  const [row] =
    await shared.admin`select count(*)::int n,min(reconcile_attempts)::int attempts,max(reconcile_attempts)::int max_attempts from session_background_commands where session_id=${sessionId} and state='running'`;
  expect(row!.n).toBe(25);
  expect(row!.attempts).toBe(1);
  expect(row!.max_attempts).toBe(1);
});

async function terminalOutputFixture(
  fixtureOptions: { cancelledBeforeStart?: boolean; kind?: "machine" | "sandbox" } = {},
) {
  const sessionId = await seed(1, fixtureOptions.kind);
  const [row] =
    await shared.admin`select * from session_background_commands where session_id=${sessionId}`;
  const identity = {
    accountId: row!.account_id,
    workspaceId: row!.workspace_id,
    sessionId,
    commandId: row!.id,
    controlWorkspaceId: row!.control_workspace_id,
    enrollmentId: row!.enrollment_id,
    connectionInstanceId: row!.connection_instance_id,
    opId: row!.op_id,
  };
  await settleConnectedMachineSessionBackgroundCommand(client.db, {
    ...identity,
    outcome: "exited",
    exitCode: fixtureOptions.cancelledBeforeStart ? -1 : 0,
    reason: "op_exit",
  });
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    workspaceId: identity.controlWorkspaceId,
    agentId: identity.enrollmentId,
    connectionInstanceId: identity.connectionInstanceId,
    transport,
  });
  runner.script(identity.opId, {
    frames: [{ channel: "stdout", bytes: "durably captured output" }],
  });
  const subject = subjectFor(
    identity.controlWorkspaceId,
    identity.enrollmentId,
    identity.connectionInstanceId,
  );
  // The stop reached the runner first: it refuses the start and keeps a tombstone.
  if (fixtureOptions.cancelledBeforeStart) {
    await runner.request(
      subject,
      {
        requestId: `cancel-${identity.opId}`,
        epoch: 0,
        op: { $case: "opCancel", opCancel: { opId: identity.opId } },
      },
      { timeoutMs: 1000 },
    );
  }
  await runner.request(
    subject,
    {
      requestId: identity.opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["synthetic"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: sessionId,
        },
      },
    },
    { timeoutMs: 1000 },
  );
  const operations: string[] = [];
  const rpc: ControlRpc = {
    request: async (target, request, options) => {
      expect(target).toBe(subject);
      operations.push(request.op?.$case ?? "none");
      return runner.request(target, request, options);
    },
  };
  const connection = opStreamConnectionFor(transport);
  const outputBus = { ...bus, getOpStreamConnection: () => connection } as Parameters<
    typeof releaseOutput
  >[3];
  const due = async () => shared.admin`update session_background_commands set
    reconcile_after='2000-01-01T00:00:00Z',reconcile_claim_id=null,reconcile_claimed_at=null where id=${identity.commandId}`;
  const stored = async () =>
    (
      await shared.admin`select * from session_background_commands where id=${identity.commandId}`
    )[0]!;
  await due();
  return {
    identity,
    transport,
    runner,
    operations,
    rpc,
    connection,
    outputBus,
    due,
    stored,
  };
}

test("output capture and ACK retry survive publisher failure and a fresh reconciler without model observation", async () => {
  const fixture = await terminalOutputFixture();
  const publish = fixture.connection.publish;
  let fail = true;
  fixture.connection.publish = (subject, payload) => {
    if (fail && OpAck.decode(payload).final) throw new Error("synthetic publisher failure");
    publish(subject, payload);
  };
  // A current enrollment route is not the adopted operation's address, and a
  // successor process's OpRelease capability is not the adopted runner's.
  await shared.admin`update enrollments set connection_instance_id='successor',
    agent_capabilities=${JSON.stringify({ opRelease: true })}::jsonb where id=${fixture.identity.enrollmentId}`;
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const captured = await fixture.stored();
  expect(captured.output_exit_seq).toBe("2");
  expect(captured.output_consumed_at).toBeInstanceOf(Date);
  expect(captured.output_release_observed_at).toBeNull();
  expect(captured.completion_observed_at).toBeNull();
  expect(captured.last_reconcile_outcome).toBe("output_retry");
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(false);
  fail = false;
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect((await fixture.stored()).last_reconcile_outcome).toBe("output_ack_published");
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(true);
  fixture.runner.lostOps.add(fixture.identity.opId);
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const released = await fixture.stored();
  expect(released.output_release_observed_at).toBeInstanceOf(Date);
  expect(released.completion_observed_at).toBeNull();
  expect(released.output_unavailable_at).toBeNull();
  expect(released.output_consumed_at.getTime()).toBe(captured.output_consumed_at.getTime());
  const [events] = await shared.admin`select count(*)::int n from session_events where
    session_id=${fixture.identity.sessionId} and type='sandbox.command.output.delta'`;
  const [updates] = await shared.admin`select count(*)::int n from session_system_updates where
    session_id=${fixture.identity.sessionId} and kind='background_command_result'`;
  expect(events!.n).toBe(1);
  expect(updates!.n).toBe(1);
  expect(fixture.operations.filter((op) => op === "opStart" || op === "opCancel")).toEqual([]);
  expect(fixture.operations).not.toContain("opRelease");
  expect(fixture.runner.runs.get(fixture.identity.opId)!.startCount).toBe(1);
});

test("corrupt retained output cannot create custody or release a terminal operation", async () => {
  const fixture = await terminalOutputFixture();
  fixture.runner.runs.get(fixture.identity.opId)!.exit.digests.stdout = "corrupted";
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const row = await fixture.stored();
  expect(row.state).toBe("exited");
  expect(row.output_consumed_at).toBeNull();
  expect(row.output_exit_seq).toBeNull();
  expect(row.output_release_observed_at).toBeNull();
  expect(row.output_unavailable_at).toBeNull();
  expect(row.last_reconcile_outcome).toBe("output_retry");
  expect(fixture.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
  // Keep this intentional failed obligation out of unrelated later fixtures.
  await shared.admin`update session_background_commands set reconcile_after=now()+interval '1 day' where id=${fixture.identity.commandId}`;
});

test("a published but undelivered final ACK remains pending for a fresh reconciler", async () => {
  const fixture = await terminalOutputFixture();
  const publish = fixture.connection.publish;
  let dropFinalAck = true;
  fixture.connection.publish = (subject, payload) => {
    if (dropFinalAck && OpAck.decode(payload).final) return;
    publish(subject, payload);
  };
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect((await fixture.stored()).last_reconcile_outcome).toBe("output_ack_published");
  expect((await fixture.stored()).output_release_observed_at).toBeNull();
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(false);

  dropFinalAck = false;
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(true);
  expect((await fixture.stored()).output_release_observed_at).toBeNull();
  fixture.runner.lostOps.add(fixture.identity.opId);
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const row = await fixture.stored();
  expect(row.output_release_observed_at).toBeInstanceOf(Date);
  expect(row.completion_observed_at).toBeNull();
  // A runner without OpRelease keeps the attach, final ACK and later look.
  expect(fixture.operations).not.toContain("opRelease");
});

test("PostgreSQL capture rollback cannot authorize ACK and a later full replay remains idempotent", async () => {
  const fixture = await terminalOutputFixture();
  expect(fixture.identity.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  // This constraint exists only in the isolated migrated fixture and rejects
  // this synthetic command's output event inside its ordinary append transaction.
  await shared.admin.unsafe(`alter table session_events add constraint
    test_connected_output_capture_failure check (
      type <> 'sandbox.command.output.delta'
      or session_id <> '${fixture.identity.sessionId}'::uuid
    ) not valid`);
  try {
    await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
    const row = await fixture.stored();
    expect(row.state).toBe("exited");
    expect(row.output_consumed_at).toBeNull();
    expect(row.output_exit_seq).toBeNull();
    expect(row.output_release_observed_at).toBeNull();
    expect(row.last_reconcile_outcome).toBe("output_retry");
    expect(fixture.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
    const [events] = await shared.admin`select count(*)::int n from session_events
      where session_id=${fixture.identity.sessionId} and type='sandbox.command.output.delta'`;
    expect(events!.n).toBe(0);
  } finally {
    await shared.admin`alter table session_events drop constraint test_connected_output_capture_failure`;
  }
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect((await fixture.stored()).output_consumed_at).toBeInstanceOf(Date);
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(true);
  const [events] = await shared.admin`select count(*)::int n from session_events
    where session_id=${fixture.identity.sessionId} and type='sandbox.command.output.delta'`;
  expect(events!.n).toBe(1);
  expect(fixture.runner.runs.get(fixture.identity.opId)!.startCount).toBe(1);
  fixture.runner.lostOps.add(fixture.identity.opId);
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
});

test("the output inventory rejects null SQL bounds and claim identity", async () => {
  for (const [claimId, limit, ttl, due] of [
    [null, 1, 30000, new Date()],
    [crypto.randomUUID(), null, 30000, new Date()],
    [crypto.randomUUID(), 1, null, new Date()],
    [crypto.randomUUID(), 1, 30000, null],
  ] as const) {
    await expect(
      (async () =>
        await client.db.execute(sql`
        select * from opengeni_private.claim_connected_command_output_releases(
          ${claimId}::uuid, ${limit}::integer, ${ttl}::bigint,
          ${due?.toISOString() ?? null}::timestamptz
        )
      `))(),
    ).rejects.toMatchObject({ cause: { code: "22023" } });
  }
});

test("pre-capture native loss records unavailable output without manufacturing consumption or ACK", async () => {
  const fixture = await terminalOutputFixture();
  fixture.runner.lostOps.add(fixture.identity.opId);
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const row = await fixture.stored();
  expect(row.state).toBe("exited");
  expect(row.exit_code).toBe(0);
  expect(row.output_unavailable_at).toBeInstanceOf(Date);
  expect(row.output_consumed_at).toBeNull();
  expect(row.output_release_observed_at).toBeNull();
  expect(row.completion_observed_at).toBeNull();
  expect(fixture.operations).toEqual(["opQuery"]);
  expect(fixture.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
});

test("a command cancelled before its runner began settles its output once, without consumption or ACK", async () => {
  const fixture = await terminalOutputFixture({ cancelledBeforeStart: true });
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const row = await fixture.stored();
  expect(row.state).toBe("exited");
  expect(row.exit_code).toBe(-1);
  expect(row.output_unavailable_at).toBeInstanceOf(Date);
  expect(row.output_consumed_at).toBeNull();
  expect(row.output_release_observed_at).toBeNull();
  expect(row.last_reconcile_outcome).toBe("output_unavailable");
  expect(fixture.operations).toEqual(["opQuery"]);
  expect(fixture.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
  // Settled: a later pass has nothing left to do for it.
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect(fixture.operations).toEqual(["opQuery"]);
});

test("custody and release claims reject locator drift, divergent receipts and stale claims", async () => {
  const fixture = await terminalOutputFixture();
  const receipt = { exitSeq: "2", attachGeneration: "1" };
  await expect(
    recordConnectedCommandOutputConsumption(client.db, {
      ...fixture.identity,
      connectionInstanceId: "successor",
      exitCode: 0,
      receipt,
    }),
  ).rejects.toThrow();
  await expect(
    recordConnectedCommandOutputConsumption(client.db, {
      ...fixture.identity,
      accountId: crypto.randomUUID(),
      exitCode: 0,
      receipt,
    }),
  ).rejects.toThrow();
  expect((await fixture.stored()).output_consumed_at).toBeNull();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  await fixture.due();
  const [claim] = await claimConnectedCommandOutputReleases(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 30000,
  });
  expect(claim!.commandId).toBe(fixture.identity.commandId);
  expect(claim!.receipt?.exitSeq).toBe("2");
  await expect(
    recordConnectedCommandOutputConsumption(client.db, {
      ...fixture.identity,
      exitCode: 0,
      receipt: { ...receipt, exitSeq: "3" },
    }),
  ).rejects.toThrow("exit frontier");
  expect(
    await settleConnectedCommandOutputReleaseClaim(client.db, {
      claim: { ...claim!, claimId: crypto.randomUUID() },
      outcome: "not_retained",
      retryAfterMs: 0,
    }),
  ).toBe(false);
  expect((await fixture.stored()).output_release_observed_at).toBeNull();
  expect(
    await settleConnectedCommandOutputReleaseClaim(client.db, {
      claim: claim!,
      outcome: "not_retained",
      retryAfterMs: 0,
    }),
  ).toBe(true);
});

test("saved output is claimed before a full batch of older uncaptured results", async () => {
  const fixture = await terminalOutputFixture();
  const publish = fixture.connection.publish;
  fixture.connection.publish = (subject, payload) => {
    if (OpAck.decode(payload).final) throw new Error("synthetic publisher failure");
    publish(subject, payload);
  };
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect((await fixture.stored()).output_consumed_at).toBeInstanceOf(Date);
  expect(fixture.runner.runs.get(fixture.identity.opId)!.finalAcked).toBe(false);

  const olderSessionId = await seed(25);
  const commands = await shared.admin`select * from session_background_commands
    where session_id=${olderSessionId}`;
  for (const command of commands) {
    await settleConnectedMachineSessionBackgroundCommand(client.db, {
      accountId: command.account_id,
      workspaceId: command.workspace_id,
      sessionId: olderSessionId,
      commandId: command.id,
      controlWorkspaceId: command.control_workspace_id,
      enrollmentId: command.enrollment_id,
      connectionInstanceId: command.connection_instance_id,
      opId: command.op_id,
      outcome: "exited",
      exitCode: 0,
      reason: "op_exit",
    });
  }
  await shared.admin`update session_background_commands set
    reconcile_after='2000-01-01T00:00:00Z' where session_id=${olderSessionId}`;
  await shared.admin`update session_background_commands set
    reconcile_after='2001-01-01T00:00:00Z',reconcile_claim_id=null,reconcile_claimed_at=null
    where id=${fixture.identity.commandId}`;

  const claims = await claimConnectedCommandOutputReleases(client.db, {
    claimId: crypto.randomUUID(),
    limit: 20,
    claimTtlMs: 30000,
  });
  expect(claims).toHaveLength(20);
  expect(claims[0]!.commandId).toBe(fixture.identity.commandId);
  expect(claims[0]!.receipt?.exitSeq).toBe("2");
  expect(claims[0]!.connectionInstanceId).toBe(fixture.identity.connectionInstanceId);
  expect(claims.slice(1).every((claim) => claim.sessionId === olderSessionId)).toBe(true);
  expect(claims.slice(1).every((claim) => claim.receipt === null)).toBe(true);
  const [remaining] = await shared.admin`select count(*)::int n
    from session_background_commands where session_id=${olderSessionId}
    and reconcile_claim_id is null and output_consumed_at is null`;
  expect(remaining!.n).toBe(6);
  expect(fixture.transport.decodedAcks().some((ack) => ack.final)).toBe(false);
  await shared.admin`update session_background_commands set
    reconcile_after=now()+interval '1 day',reconcile_claim_id=null,reconcile_claimed_at=null
    where session_id in (${olderSessionId},${fixture.identity.sessionId})`;
});

/** No runner answers on the command's exact address, as NATS reports it. */
const noRunnerRpc = (): ControlRpc & { requests: () => number } => {
  let requests = 0;
  return {
    requests: () => requests,
    request: async () => {
      requests++;
      throw new SelfhostedControlError({
        message: "no responders",
        code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
        agentOffline: true,
        neverSent: true,
        reason: "agent_offline",
        retryable: false,
      });
    },
  };
};
const parkSession = async (sessionId: string) =>
  shared.admin`update session_background_commands set
    reconcile_after=now()+interval '1 day',reconcile_claim_id=null,reconcile_claimed_at=null
    where session_id=${sessionId}`;

test("output whose runner was retired settles once instead of retrying forever", async () => {
  // Uncaptured output: the runner took it with it, so it is recorded as missing.
  // The retirement rules are the running-command claim's: replaced, revoked or
  // cleanly stopped. A runner that is merely offline may come back.
  for (const change of ["replaced", "revoked", "stopped", "offline", "crashed"] as const) {
    const fixture = await terminalOutputFixture();
    const enrollmentId = fixture.identity.enrollmentId;
    if (change === "replaced") {
      // A different runner process holds the connection, live or not.
      await shared.admin`update enrollments set connection_instance_id='successor',connection_lease_expires_at=now()-interval '1 minute' where id=${enrollmentId}`;
    } else if (change === "revoked") {
      await shared.admin`update enrollments set status='revoked',revoked_at=now(),connection_instance_id=null,connection_lease_expires_at=null where id=${enrollmentId}`;
    } else if (change === "stopped") {
      await shared.admin`update enrollments set connection_instance_id=null,connection_lease_expires_at=null,went_offline_at=now(),went_offline_reason='GOING_OFFLINE_REASON_USER_STOP' where id=${enrollmentId}`;
    } else if (change === "offline") {
      await shared.admin`update enrollments set connection_lease_expires_at=now()-interval '1 minute' where id=${enrollmentId}`;
    } else {
      // Gone without saying why: it may be the same process coming back.
      await shared.admin`update enrollments set connection_instance_id=null,connection_lease_expires_at=null,went_offline_at=now(),went_offline_reason=null where id=${enrollmentId}`;
    }
    await releaseOutput(client.db, settings, observability, fixture.outputBus, noRunnerRpc());
    const row = await fixture.stored();
    expect(row.output_consumed_at).toBeNull();
    expect(row.output_release_observed_at).toBeNull();
    if (change === "offline" || change === "crashed") {
      expect(row.output_unavailable_at).toBeNull();
      expect(row.reconcile_attempts).toBe(0);
    } else {
      expect(row.output_unavailable_at).toBeInstanceOf(Date);
      expect(row.last_reconcile_outcome).toBe("output_unavailable");
    }
    await parkSession(fixture.identity.sessionId);
  }

  // Captured output whose final acknowledgement never reached the old runner:
  // nothing is retained any more, so the release is complete.
  const fixture = await terminalOutputFixture();
  const publish = fixture.connection.publish;
  fixture.connection.publish = (subject, payload) => {
    if (OpAck.decode(payload).final) throw new Error("synthetic publisher failure");
    publish(subject, payload);
  };
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  const captured = await fixture.stored();
  expect(captured.output_consumed_at).toBeInstanceOf(Date);
  expect(captured.last_reconcile_outcome).toBe("output_retry");
  await fixture.due();
  const rpc = noRunnerRpc();
  // Still the machine's live runner: silence alone keeps the retry.
  await releaseOutput(client.db, settings, observability, fixture.outputBus, rpc);
  expect((await fixture.stored()).last_reconcile_outcome).toBe("output_retry");
  expect(rpc.requests()).toBe(1);
  await fixture.due();
  await shared.admin`update enrollments set connection_instance_id='successor' where id=${fixture.identity.enrollmentId}`;
  await releaseOutput(client.db, settings, observability, fixture.outputBus, rpc);
  const released = await fixture.stored();
  expect(released.output_release_observed_at).toBeInstanceOf(Date);
  expect(released.output_unavailable_at).toBeNull();
  expect(released.last_reconcile_outcome).toBe("output_released");
  expect(released.output_consumed_at.getTime()).toBe(captured.output_consumed_at.getTime());
  await parkSession(fixture.identity.sessionId);
});

test("offline output is neither due nor claimed until reconnect, without changing custody", async () => {
  for (const captured of [false, true]) {
    const fixture = await terminalOutputFixture();
    if (captured) {
      const publish = fixture.connection.publish;
      fixture.connection.publish = (subject, payload) => {
        if (OpAck.decode(payload).final) throw new Error("synthetic publisher failure");
        publish(subject, payload);
      };
      await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
      fixture.connection.publish = publish;
      await fixture.due();
    }
    const before = await fixture.stored();
    const due = () => sandboxMaintenanceDue(client.db, { checkpointArtifactClaimTtlMs: 900000 });
    // Output is independent of completion notifications. Drain their outbox
    // so this probe measures only the remaining output obligation.
    await shared.admin`update session_system_update_outbox set status='delivered',delivered_at=now() where status='pending'`;
    for (const connection of ["expired", "null", "goodbye"] as const) {
      await shared.admin`update enrollments set
        connection_instance_id=${connection === "null" ? null : "launch"},
        connection_lease_expires_at=${connection === "null" ? null : connection === "expired" ? new Date(0) : new Date(Date.now() + 3600000)},
        went_offline_at=${connection === "goodbye" ? new Date() : null},
        went_offline_reason=null where id=${fixture.identity.enrollmentId}`;
      expect(await due()).toBe(false);
      const rpc = noRunnerRpc();
      await releaseOutput(client.db, settings, observability, fixture.outputBus, rpc);
      expect(rpc.requests()).toBe(0);
      const after = await fixture.stored();
      expect(after.reconcile_attempts).toBe(before.reconcile_attempts);
      expect(after.output_consumed_at).toEqual(before.output_consumed_at);
      expect(after.output_exit_seq).toBe(before.output_exit_seq);
      expect(after.output_release_observed_at).toBeNull();
      expect(after.output_unavailable_at).toBeNull();
    }
    await shared.admin`update enrollments set connection_instance_id='launch',
      connection_lease_expires_at=now()+interval '1 hour',went_offline_at=null, went_offline_reason=null
      where id=${fixture.identity.enrollmentId}`;
    expect(await due()).toBe(true);
    await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
    expect((await fixture.stored()).output_consumed_at).toBeInstanceOf(Date);
    await fixture.due();
    fixture.runner.lostOps.add(fixture.identity.opId);
    await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
    expect((await fixture.stored()).output_release_observed_at).toBeInstanceOf(Date);
    expect(await due()).toBe(false);
    await parkSession(fixture.identity.sessionId);
  }
});

test("Stop on a compute sandbox's command delivers the cancel once and settles it", async () => {
  // A running command on a compute sandbox is never polled (each message would
  // wake the sandbox); a Stop is the one thing that must still reach its agent.
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Compute stop",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Compute stop",
    subjectId: `subject-${id}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Compute stop",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "compute",
  });
  const enrollment = await createSandboxEnrollment(client.db, {
    accountId,
    workspaceId: workspaceId!,
    enrollmentId: crypto.randomUUID(),
    sandboxGroupId: session.sandboxGroupId,
    hasDisplay: false,
    workspaceRoot: "/workspace",
  });
  await shared.admin`update enrollments set connection_instance_id='launch',connection_lease_expires_at=now()+interval '1 hour' where id=${enrollment.id}`;
  const commandId = crypto.randomUUID();
  const opId = `op-${commandId}`;
  await shared.admin`insert into session_background_commands(id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,reconcile_after)
    values (${commandId},${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${enrollment.id},'launch',${opId},'2000-01-01T00:00:00Z'::timestamptz)`;
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    workspaceId: workspaceId!,
    agentId: enrollment.id,
    connectionInstanceId: "launch",
    transport,
  });
  runner.script(opId, { frames: [], live: true, holdUntilCancel: true });
  const subject = subjectFor(workspaceId!, enrollment.id, "launch");
  await runner.request(
    subject,
    {
      requestId: opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["sleep", "900"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: session.id,
        },
      },
    },
    { timeoutMs: 1000 },
  );
  const operations: string[] = [];
  const rpc: ControlRpc = {
    request: async (target, request, options) => {
      if (target !== subject) return await noRunnerRpc().request(target, request, options);
      operations.push(request.op?.$case ?? "none");
      return await runner.request(target, request, options);
    },
  };
  const stopBus = {
    ...bus,
    getOpStreamConnection: () => opStreamConnectionFor(transport),
  } as Parameters<typeof reconcile>[3];
  const stored = async () =>
    (await shared.admin`select * from session_background_commands where id=${commandId}`)[0]!;

  // Running: no message reaches the sandbox.
  await reconcile(client.db, settings, observability, stopBus, rpc);
  expect(operations).toEqual([]);
  expect((await stored()).reconcile_attempts).toBe(0);

  const stop = await requestSessionBackgroundCommandCancellation(client.db, {
    accountId,
    workspaceId: workspaceId!,
    sessionId: session.id,
    commandId,
    subjectId: `subject-${id}`,
  });
  expect(stop.accepted).toBe(true);
  expect(await sandboxMaintenanceDue(client.db, { checkpointArtifactClaimTtlMs: 900000 })).toBe(
    true,
  );
  await reconcile(client.db, settings, observability, stopBus, rpc);
  expect(operations[0]).toBe("opCancel");
  expect(operations).not.toContain("opStart");
  expect(operations).not.toContain("opQuery");
  const settled = await stored();
  expect(settled.state).not.toBe("running");
  expect(settled.state).not.toBe("stopping");
  expect(settled.reconcile_attempts).toBe(1);

  // Settled: later sweeps send nothing more.
  const sent = operations.length;
  await reconcile(client.db, settings, observability, stopBus, rpc);
  expect(operations.length).toBe(sent);
  await parkSession(session.id);
});

/** A workspace and chat with one command a request abandoned on `kind`'s
 * runner "launch" when its agent restarted: it is recorded with a stop request
 * bound to that exact connection and operation. */
async function abandonedCommandFixture(kind: "machine" | "sandbox") {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Abandoned",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Abandoned",
    subjectId: `subject-${id}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Abandoned",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: kind === "sandbox" ? "compute" : "none",
  });
  const enrollment =
    kind === "sandbox"
      ? await createSandboxEnrollment(client.db, {
          accountId,
          workspaceId: workspaceId!,
          enrollmentId: crypto.randomUUID(),
          sandboxGroupId: session.sandboxGroupId,
          hasDisplay: false,
          workspaceRoot: "/workspace",
        })
      : await createEnrollment(client.db, {
          accountId,
          workspaceId: workspaceId!,
          pubkey: `ed25519:${id}`,
        });
  await shared.admin`update enrollments set connection_instance_id='launch',connection_lease_expires_at=now()+interval '1 hour' where id=${enrollment.id}`;
  const commandId = crypto.randomUUID();
  const opId = `op-${commandId}`;
  const recorded = await recordAbandonedDirectConnectedMachineCommand(client.db, {
    accountId,
    workspaceId: workspaceId!,
    sessionId: session.id,
    commandId,
    controlWorkspaceId: workspaceId!,
    enrollmentId: enrollment.id,
    connectionInstanceId: "launch",
    opId,
    command: "sleep 900",
  });
  expect(recorded.state).toBe("stopping");
  const stored = async () =>
    (await shared.admin`select * from session_background_commands where id=${commandId}`)[0]!;
  const due = async () =>
    shared.admin`update session_background_commands set reconcile_after='2000-01-01T00:00:00Z'::timestamptz,reconcile_claim_id=null,reconcile_claimed_at=null where id=${commandId}`;
  return {
    accountId,
    workspaceId: workspaceId!,
    session,
    enrollment,
    commandId,
    opId,
    stored,
    due,
  };
}

test("a command abandoned when its compute sandbox's VM restarted settles through the reconciler without a wake", async () => {
  const fixture = await abandonedCommandFixture("sandbox");
  // The VM crashed and booted fresh on its disk: a new agent process holds
  // the sandbox's connection, and the old one, with its operation, is gone.
  await shared.admin`update enrollments set connection_instance_id='fresh' where id=${fixture.enrollment.id}`;
  const rpc = noRunnerRpc();
  await fixture.due();
  await reconcile(client.db, settings, observability, bus, rpc);
  const settled = await fixture.stored();
  expect(settled.state).toBe("lost");
  expect(settled.settlement_reason).toBe("op_connection_replaced");
  expect(settled.exit_code).toBeNull();
  // Nothing was sent: no message woke the sandbox for it.
  expect(rpc.requests()).toBe(0);
  await parkSession(fixture.session.id);
});

test("a command abandoned while its runner was unreachable is stopped when that exact runner answers again", async () => {
  const fixture = await abandonedCommandFixture("machine");
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    workspaceId: fixture.workspaceId,
    agentId: fixture.enrollment.id,
    connectionInstanceId: "launch",
    transport,
  });
  runner.script(fixture.opId, { frames: [], live: true, holdUntilCancel: true });
  const subject = subjectFor(fixture.workspaceId, fixture.enrollment.id, "launch");
  await runner.request(
    subject,
    {
      requestId: fixture.opId,
      epoch: 0,
      op: {
        $case: "opStart",
        opStart: {
          op: { $case: "exec", exec: ExecRequest.fromPartial({ command: ["sleep", "900"] }) },
          windowBytes: "65536",
          deadlineMs: "0",
          originId: fixture.session.id,
        },
      },
    },
    { timeoutMs: 1000 },
  );
  // Old -> new -> old: while another process held the connection, the old
  // runner kept its operation. While it does not answer, the stop waits.
  let answering = false;
  const delivered: string[] = [];
  const rpc: ControlRpc = {
    request: async (target, request, options) => {
      if (!answering || target !== subject) {
        throw new SelfhostedControlError({
          message: "timed out",
          code: ErrorCode.ERROR_CODE_TIMEOUT,
          reason: "timeout",
          retryable: true,
        });
      }
      delivered.push(request.op?.$case ?? "none");
      return await runner.request(target, request, options);
    },
  };
  const stopBus = {
    ...bus,
    getOpStreamConnection: () => opStreamConnectionFor(transport),
  } as Parameters<typeof reconcile>[3];
  await fixture.due();
  await reconcile(client.db, settings, observability, stopBus, rpc);
  expect((await fixture.stored()).state).toBe("stopping");
  expect(delivered).toEqual([]);
  // The old runner holds the connection again and answers: the stop reaches it.
  answering = true;
  await fixture.due();
  await reconcile(client.db, settings, observability, stopBus, rpc);
  expect(delivered[0]).toBe("opCancel");
  expect(delivered).not.toContain("opStart");
  const settled = await fixture.stored();
  expect(settled.state).not.toBe("running");
  expect(settled.state).not.toBe("stopping");
  await parkSession(fixture.session.id);
});

test("a request to a replaced connection ends without a wake when another process records the new one", async () => {
  // Two processes share only the database: this one holds a request for the
  // sandbox's old agent connection, and another (the gateway pod where the
  // new agent's session opened) records the new connection over its own
  // database connection.
  const fixture = await abandonedCommandFixture("sandbox");
  try {
    const oldSubject = subjectFor(fixture.workspaceId, fixture.enrollment.id, "launch");
    const wakes: string[] = [];
    const connectionCurrent = agentConnectionCurrent(client.db);
    let held = 0;
    const connection: NatsRequestConnection = {
      supportsHeaders: true,
      async request(subject, payload, opts) {
        const request = ControlRequest.decode(payload);
        if (request.op?.$case === "ping") {
          return {
            data: ControlResponse.encode(
              ControlResponse.fromPartial({
                requestId: request.requestId,
                result: { $case: "ping", ping: { nonce: request.op.ping.nonce } },
              }),
            ).finish(),
            headers: { get: (name: string) => (name === "Opengeni-Control-Replay" ? "1" : "") },
          };
        }
        if ((await connectionCurrent(subject.split(".replay.")[0]!)) === false) {
          throw Object.assign(new Error("503"), { code: "503" });
        }
        // The host holds a request for an agent that no longer answers.
        held += 1;
        await Bun.sleep(Math.min(opts.timeout, 4_000));
        throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      },
    };
    const rpc = new NatsControlRpc(async () => connection, {
      connectionCurrent,
      onNoResponders: wakeComputeSandboxOnNoResponders({
        control: {
          wake: async (sandboxId) => {
            wakes.push(sandboxId);
            return {} as never;
          },
        },
        sandboxOf: async () => "box-1",
        connectionCurrent,
      }),
    });
    const request = () =>
      rpc.request(
        oldSubject,
        ControlRequest.fromPartial({
          requestId: crypto.randomUUID(),
          op: { $case: "opCancel", opCancel: { opId: fixture.opId } },
        }),
        { timeoutMs: 30_000 },
      );
    const startedAt = Date.now();
    const inFlight = request();
    await Bun.sleep(300);
    await shared.admin`update enrollments set connection_instance_id='fresh' where id=${fixture.enrollment.id}`;
    const answer = await inFlight;
    expect(held).toBe(1);
    expect(answer.error?.code).toBe(ErrorCode.ERROR_CODE_AGENT_OFFLINE);
    // Within about a second of the new connection, not the 30 s timeout.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // A later request to the old connection reaches no responder and ends at
    // once; neither woke the idle sandbox.
    const again = await request();
    expect(again.error?.code).toBe(ErrorCode.ERROR_CODE_AGENT_OFFLINE);
    expect(held).toBe(1);
    expect(wakes).toEqual([]);
  } finally {
    await parkSession(fixture.session.id);
  }
}, 20_000);

test("the reaper sends nothing to a runner that reports its own inventory, in any pass", async () => {
  // Every compute sandbox agent reports its inventory, and so does a
  // Connected Machine whose live connection advertised op_release. Whatever
  // the output's custody, the reaper rechecks the obligation in the database
  // alone; the runner's own report, answered while it talks, collects and
  // releases it. So no pass can reach a sleeping sandbox.
  for (const [kind, captured] of [
    ["sandbox", false],
    ["sandbox", true],
    ["machine", false],
    ["machine", true],
  ] as const) {
    const fixture = await terminalOutputFixture({ kind });
    try {
      if (kind === "machine")
        await shared.admin`update enrollments set agent_capabilities=${JSON.stringify({ opRelease: true })}::jsonb where id=${fixture.identity.enrollmentId}`;
      if (captured)
        await recordConnectedCommandOutputConsumption(client.db, {
          ...fixture.identity,
          receipt: { exitSeq: "2", attachGeneration: "1" },
          exitCode: 0,
        });
      const before = await fixture.stored();
      let attempts = before.reconcile_attempts;
      for (let pass = 0; pass < 3; pass++) {
        await fixture.due();
        await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
        const row = await fixture.stored();
        expect(row.reconcile_attempts).toBe(attempts + 1);
        attempts = row.reconcile_attempts;
        expect(row.last_reconcile_outcome).toBe("output_retry");
        expect(row.reconcile_claim_id).toBeNull();
        expect(row.reconcile_after.getTime()).toBeGreaterThan(Date.now());
      }
      expect(fixture.operations).toEqual([]);
      expect(fixture.transport.decodedAcks()).toEqual([]);
      const row = await fixture.stored();
      expect(row.output_release_observed_at).toBeNull();
      expect(row.output_unavailable_at).toBeNull();
      expect(row.output_consumed_at?.getTime() ?? null).toBe(
        before.output_consumed_at?.getTime() ?? null,
      );
    } finally {
      await parkSession(fixture.identity.sessionId);
    }
  }
});

test("a retired compute sandbox's output obligation settles once, with no request", async () => {
  for (const [change, captured] of [
    ["revoked", false],
    ["revoked", true],
    ["replaced", false],
    ["replaced", true],
  ] as const) {
    const fixture = await terminalOutputFixture({ kind: "sandbox" });
    try {
      if (captured)
        await recordConnectedCommandOutputConsumption(client.db, {
          ...fixture.identity,
          receipt: { exitSeq: "2", attachGeneration: "1" },
          exitCode: 0,
        });
      if (change === "revoked")
        await shared.admin`update enrollments set status='revoked',revoked_at=now(),connection_instance_id=null,connection_lease_expires_at=null where id=${fixture.identity.enrollmentId}`;
      else
        await shared.admin`update enrollments set connection_instance_id='successor' where id=${fixture.identity.enrollmentId}`;
      await fixture.due();
      await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
      const row = await fixture.stored();
      if (captured) {
        expect(row.output_release_observed_at).toBeInstanceOf(Date);
        expect(row.output_unavailable_at).toBeNull();
        expect(row.last_reconcile_outcome).toBe("output_released");
      } else {
        expect(row.output_unavailable_at).toBeInstanceOf(Date);
        expect(row.output_release_observed_at).toBeNull();
        expect(row.last_reconcile_outcome).toBe("output_unavailable");
      }
      await fixture.due();
      await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
      expect((await fixture.stored()).reconcile_attempts).toBe(row.reconcile_attempts);
      expect(fixture.operations).toEqual([]);
    } finally {
      await parkSession(fixture.identity.sessionId);
    }
  }
});

test("a release recorded where the output was stored ends the obligation, only for its exact frontier", async () => {
  const fixture = await terminalOutputFixture();
  await recordConnectedCommandOutputConsumption(client.db, {
    ...fixture.identity,
    receipt: { exitSeq: "2", attachGeneration: "1" },
    exitCode: 0,
  });
  await fixture.due();
  const [claim] = (
    await claimConnectedCommandOutputReleases(client.db, {
      claimId: crypto.randomUUID(),
      dueBefore: new Date(),
      limit: 100,
      claimTtlMs: 60_000,
    })
  ).filter((candidate) => candidate.commandId === fixture.identity.commandId);
  expect(claim?.receipt).toEqual({ exitSeq: "2", attachGeneration: "1" });
  // Another terminal frame is not this output: nothing is recorded.
  expect(
    await recordConnectedCommandOutputRelease(client.db, { ...fixture.identity, exitSeq: "3" }),
  ).toBe(false);
  expect((await fixture.stored()).output_release_observed_at).toBeNull();
  // The runner's confirmed release is recorded once; twice changes nothing.
  expect(
    await recordConnectedCommandOutputRelease(client.db, { ...fixture.identity, exitSeq: "2" }),
  ).toBe(true);
  expect(
    await recordConnectedCommandOutputRelease(client.db, { ...fixture.identity, exitSeq: "2" }),
  ).toBe(false);
  // A claim taken before the release no longer settles anything.
  for (const outcome of ["published", "retry", "not_retained"] as const) {
    expect(
      await settleConnectedCommandOutputReleaseClaim(client.db, {
        claim: claim!,
        outcome,
        retryAfterMs: 0,
      }),
    ).toBe(false);
  }
  const row = await fixture.stored();
  expect(row.output_release_observed_at).toBeInstanceOf(Date);
  expect(row.last_reconcile_outcome).toBe("output_released");
  expect(row.reconcile_claim_id).toBeNull();
  // Nothing is left for a later pass.
  await fixture.due();
  await releaseOutput(client.db, settings, observability, fixture.outputBus, fixture.rpc);
  expect(fixture.operations).toEqual([]);
});
