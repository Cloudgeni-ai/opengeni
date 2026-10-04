import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
} from "@opengeni/db";
import { ErrorCode, ExecRequest, OpAck } from "@opengeni/agent-proto";
import { sql } from "drizzle-orm";
import {
  recordConnectedCommandOutputConsumption,
  claimConnectedCommandOutputReleases,
  settleConnectedCommandOutputReleaseClaim,
} from "@opengeni/db/session-background-commands";
import type { OpStreamConnection } from "@opengeni/events";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  SelfhostedControlError,
  subjectFor,
  type ControlRpc,
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

async function seed(count = 25) {
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
    sandboxBackend: "none",
  });
  const enrollment = await createEnrollment(client.db, {
    accountId,
    workspaceId: workspaceId!,
    pubkey: `ed25519:${id}`,
  });
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

async function terminalOutputFixture() {
  const sessionId = await seed(1);
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
    exitCode: 0,
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
  return { identity, transport, runner, operations, rpc, connection, outputBus, due, stored };
}

test("output capture and ACK retry survive publisher failure and a fresh reconciler without model observation", async () => {
  const fixture = await terminalOutputFixture();
  const publish = fixture.connection.publish;
  let fail = true;
  fixture.connection.publish = (subject, payload) => {
    if (fail && OpAck.decode(payload).final) throw new Error("synthetic publisher failure");
    publish(subject, payload);
  };
  // A current enrollment route is not the adopted operation's address.
  await shared.admin`update enrollments set connection_instance_id='successor' where id=${fixture.identity.enrollmentId}`;
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
