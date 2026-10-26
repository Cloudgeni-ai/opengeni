import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AgentEvent,
  AgentEventAck,
  OperationCompleted,
  type InventoryOperation,
} from "@opengeni/agent-proto";
import {
  bootstrapWorkspace,
  claimEnrollmentConnection,
  createDb,
  createEnrollment,
  createSession,
  getEnrollment,
  settleClaimedConnectedMachineBackgroundCommand,
  type DbClient,
} from "@opengeni/db";
import {
  claimConnectedMachineSessionBackgroundCommands,
  classifyConnectedCommandOps,
  CONNECTED_COMMAND_CLASSIFY_LIMIT,
} from "@opengeni/db/session-background-commands";
import type { EventBus } from "@opengeni/events";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { ingestConnectedCommandCompletion } from "../src/sandbox/command-completion";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";
import { decideInventoryPage, type ReportedOperation } from "../src/sandbox/operation-inventory";

// A runner reports what it still runs or retains, on each connection and while
// it holds output nobody released; Opengeni answers in the same exchange which
// ops to end. A command row of that exact process decides by custody: output
// is ended only once Opengeni stored it, and output it never stored is
// collected instead. Without a row, the connection generation the op's OpStart
// carried decides: work from an earlier generation is ended, whatever happened
// to its chat. Nothing is sent to a runner that is not reporting.

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const db = await acquireSharedTestDatabase("operation-inventory");
  if (!db) throw new Error("PostgreSQL required");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Machine = Awaited<ReturnType<typeof seedMachine>>;

async function seedMachine() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Inventory",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Inventory",
    subjectId: `subject-${id}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Inventory",
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
    os: "linux",
    arch: "x86_64",
  });
  return { accountId, workspaceId: workspaceId!, sessionId: session.id, enrollment };
}

async function claim(machine: Machine, connectionInstanceId: string): Promise<number> {
  // A different process can claim only once the holder's lease has expired.
  await shared.admin`update enrollments set connection_lease_expires_at = now() - interval '1 second' where id = ${machine.enrollment.id} and connection_instance_id is not null and connection_instance_id <> ${connectionInstanceId}`;
  const result = await claimEnrollmentConnection(client.db, {
    workspaceId: machine.workspaceId,
    enrollmentId: machine.enrollment.id,
    credentialGeneration: machine.enrollment.credentialGeneration,
    connectionInstanceId,
    leaseMs: 60_000,
  });
  expect(result.claimed).toBe(true);
  const enrollment = await getEnrollment(client.db, machine.workspaceId, machine.enrollment.id);
  return enrollment!.connectionGeneration;
}

async function insertCommand(
  machine: Machine,
  connectionInstanceId: string,
  opId: string,
  state: "running" | "lost" | "exited" = "running",
): Promise<void> {
  if (state === "exited") {
    await insertCommand(machine, connectionInstanceId, opId);
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update session_background_commands set state = 'exited', exit_code = 0, settled_at = now() where op_id = ${opId}`;
    });
    return;
  }
  await shared.admin`insert into session_background_commands(account_id, workspace_id, session_id, provider, state, control_workspace_id, enrollment_id, connection_instance_id, op_id, reconcile_after, settlement_reason, settled_at)
    values (${machine.accountId}, ${machine.workspaceId}, ${machine.sessionId}, 'connected_machine', ${state}, ${machine.workspaceId}, ${machine.enrollment.id}, ${connectionInstanceId}, ${opId}, '2000-01-01T00:00:00Z'::timestamptz,
      ${state === "lost" ? "op_lost_unknown" : null}, ${state === "lost" ? new Date() : null})`;
}

async function commandRows(machine: Machine) {
  return await shared.admin<
    Array<Record<string, unknown>>
  >`select * from session_background_commands where enrollment_id = ${machine.enrollment.id} order by op_id`;
}

/** Settle due commands exactly as the reconciler's claim does: a runner the
 * enrollment retired leaves its commands lost by replacement. */
async function settleRetired(enrollmentId: string): Promise<number> {
  const claims = await claimConnectedMachineSessionBackgroundCommands(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 60_000,
  });
  let settled = 0;
  for (const claimed of claims) {
    if (claimed.enrollmentId !== enrollmentId) continue;
    expect(claimed.proof?.reason).toBe("op_connection_replaced");
    if (
      (await settleClaimedConnectedMachineBackgroundCommand(client.db, { claim: claimed })).settled
    )
      settled += 1;
  }
  return settled;
}

/** The op-stream connection the API answers on, capturing what it sends. */
function answerChannel() {
  const sent: Array<{ subject: string; payload: Uint8Array }> = [];
  const bus = {
    getOpStreamConnection: () => ({
      subscribe: () => {
        throw new Error("an inventory answer never subscribes");
      },
      publish: (subject: string, payload: Uint8Array) => sent.push({ subject, payload }),
    }),
  } as unknown as EventBus;
  return { bus, sent };
}

type Reported = [opId: string, generation: number, state?: "complete"];

/** One inventory page, delivered exactly as the events subscription does. */
async function report(
  machine: Machine,
  bus: EventBus,
  connectionInstanceId: string,
  operations: Reported[],
  reportId = "7",
): Promise<void> {
  const payload = AgentEvent.encode({
    agentId: "",
    event: {
      $case: "operationInventory",
      operationInventory: {
        reportId,
        page: 0,
        pages: 1,
        operations: operations.map(
          ([opId, generation, state]): InventoryOperation => ({
            opId,
            connectionGeneration: String(generation),
            complete: state === "complete",
          }),
        ),
      },
    },
  }).finish();
  await handleAgentEventPayload(
    client.db,
    undefined,
    payload,
    `agent.${machine.workspaceId}.${machine.enrollment.id}.connection.${connectionInstanceId}.events`,
    bus,
  );
}

function answers(sent: Array<{ subject: string; payload: Uint8Array }>) {
  return sent.map(({ subject, payload }) => {
    const ack = AgentEventAck.decode(payload).ack;
    if (ack?.$case !== "operationInventory") throw new Error("not an inventory answer");
    return {
      subject,
      ...ack.operationInventory,
      endOpIds: [...ack.operationInventory.endOpIds].sort(),
    };
  });
}

test("old -> new -> old: the returning runner ends what was settled or orphaned while it was replaced", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const oldInstance = crypto.randomUUID();
  const newInstance = crypto.randomUUID();
  const ack = (instance: string) =>
    `agent.${machine.workspaceId}.${machine.enrollment.id}.connection.${instance}.ack`;

  // old (generation 1): two background commands and foreground work, each
  // admitted with the generation its OpStart carried. The answer to this
  // first report is lost; nothing about the ops depends on it.
  expect(await claim(machine, oldInstance)).toBe(1);
  const orphan = `orphan-${crypto.randomUUID()}`;
  const deleted = `deleted-${crypto.randomUUID()}`;
  const foreground = `foreground-${crypto.randomUUID()}`;
  await insertCommand(machine, oldInstance, orphan);
  await insertCommand(machine, oldInstance, deleted);
  await report(machine, bus, oldInstance, [
    [orphan, 1],
    [deleted, 1],
    [foreground, 1],
  ]);
  expect(answers(sent)).toEqual([
    { subject: ack(oldInstance), reportId: "7", page: 0, endOpIds: [] },
  ]);
  sent.length = 0;

  // new (generation 2): the reconciler settles old's commands as lost
  // without reaching it, and the chat of one of them is deleted.
  expect(await claim(machine, newInstance)).toBe(2);
  expect(await settleRetired(machine.enrollment.id)).toBe(2);
  await shared.admin`delete from session_background_commands where op_id = ${deleted}`;

  // Negative controls while new holds the connection: old's report is not
  // answered (it does not hold the connection), and new's own report of its
  // current work ends nothing.
  await report(machine, bus, oldInstance, [[orphan, 1]]);
  expect(sent).toEqual([]);
  const newWork = `new-${crypto.randomUUID()}`;
  await report(machine, bus, newInstance, [[newWork, 2]]);
  expect(answers(sent)).toEqual([
    { subject: ack(newInstance), reportId: "7", page: 0, endOpIds: [] },
  ]);
  sent.length = 0;

  // old again (generation 3): what it started now is current; an op an older
  // Opengeni admitted (generation 0) is kept.
  expect(await claim(machine, oldInstance)).toBe(3);
  const current = `current-${crypto.randomUUID()}`;
  const freshForeground = `fresh-${crypto.randomUUID()}`;
  const olderOpengeni = `older-${crypto.randomUUID()}`;
  await insertCommand(machine, oldInstance, current);
  const settled = await commandRows(machine);
  await report(
    machine,
    bus,
    oldInstance,
    [
      [orphan, 1],
      [deleted, 1],
      [foreground, 1],
      [current, 3],
      [freshForeground, 3],
      [olderOpengeni, 0],
    ],
    "9",
  );
  expect(answers(sent)).toEqual([
    {
      subject: ack(oldInstance),
      reportId: "9",
      page: 0,
      endOpIds: [orphan, deleted, foreground].sort(),
    },
  ]);
  // Answering changed no settled record, also after the runner pushes the
  // completion of the op it then cancelled.
  expect(await commandRows(machine)).toEqual(settled);
  await ingestConnectedCommandCompletion(
    client.db,
    {
      workspaceId: machine.workspaceId,
      agentId: machine.enrollment.id,
      connectionInstanceId: oldInstance,
    },
    OperationCompleted.fromPartial({ opId: orphan, exit: { exitCode: -1, cancelled: true } }),
  );
  expect(await commandRows(machine)).toEqual(settled);
});

test("a plain reconnect of the same process keeps its generation, so nothing it runs is ended, however long it runs", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  const opId = `foreground-${crypto.randomUUID()}`;
  expect(await claim(machine, instance)).toBe(1);
  await shared.admin`update enrollments set connection_lease_expires_at = now() - interval '1 second' where id = ${machine.enrollment.id}`;
  expect(await claim(machine, instance)).toBe(1);
  await report(machine, bus, instance, [[opId, 1]]);
  expect(answers(sent).map((answer) => answer.endOpIds)).toEqual([[]]);
});

test("a returning runner's report makes the running commands it did not answer for due again, and only those", async () => {
  // While the machine was offline the reconciler's recovery request went
  // unanswered, and the commands were left to the runner. The runner lists
  // only operations it knows, so one whose start never reached it would
  // never complete. Its report makes them due, for the reconciler to ask once more.
  const machine = await seedMachine();
  const { bus } = answerChannel();
  const instance = crypto.randomUUID();
  expect(await claim(machine, instance)).toBe(1);
  const unknown = `never-started-${crypto.randomUUID()}`;
  const known = `running-${crypto.randomUUID()}`;
  const answeredBefore = `answered-${crypto.randomUUID()}`;
  const exited = `exited-${crypto.randomUUID()}`;
  for (const opId of [unknown, known, answeredBefore]) await insertCommand(machine, instance, opId);
  await insertCommand(machine, instance, exited, "exited");
  const later = new Date(Date.now() + 86_400_000);
  await shared.admin`update session_background_commands
    set last_reconcile_outcome = 'provider_unanswered', reconcile_after = ${later}
    where op_id in (${unknown}, ${known}, ${exited})`;
  await shared.admin`update session_background_commands
    set last_reconcile_outcome = 'provider_running', reconcile_after = ${later}
    where op_id = ${answeredBefore}`;
  await report(machine, bus, instance, [[known, 1]]);
  const rows = new Map(
    (await commandRows(machine)).map((row) => [
      row.op_id as string,
      {
        outcome: row.last_reconcile_outcome,
        due: (row.reconcile_after as Date).getTime() <= Date.now(),
      },
    ]),
  );
  expect(rows.get(unknown)).toEqual({ outcome: "runner_reported", due: true });
  expect(rows.get(known)).toEqual({ outcome: "runner_reported", due: true });
  expect(rows.get(answeredBefore)).toEqual({ outcome: "provider_running", due: false });
  expect(rows.get(exited)).toEqual({ outcome: "provider_unanswered", due: false });
  // The reconciler now claims them to ask the runner.
  const claims = await claimConnectedMachineSessionBackgroundCommands(client.db, {
    claimId: crypto.randomUUID(),
    limit: 100,
    claimTtlMs: 60_000,
  });
  expect(
    claims
      .filter((claimed) => claimed.enrollmentId === machine.enrollment.id)
      .map((claimed) => [claimed.opId, claimed.proof])
      .sort(),
  ).toEqual(
    [
      [known, null],
      [unknown, null],
    ].sort(),
  );
});

test("a foreground op's output that nobody released is kept while its generation is current, however long ago it completed", async () => {
  // The reviewer's case: a foreground op completed 900,001 ms ago (past the
  // start-resend horizon) and its release never happened. No durable record
  // shows its consumer finished, and age is not consumption (the runner no
  // longer even reports it), so it is kept; a takeover ends it.
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  const opId = `foreground-${crypto.randomUUID()}`;
  expect(await claim(machine, instance)).toBe(1);
  await report(machine, bus, instance, [[opId, 1, "complete"]]);
  expect(answers(sent).map((answer) => answer.endOpIds)).toEqual([[]]);
  sent.length = 0;
  // Another process takes the connection, then this one takes it back.
  expect(await claim(machine, crypto.randomUUID())).toBe(2);
  expect(await claim(machine, instance)).toBe(3);
  await report(machine, bus, instance, [[opId, 1, "complete"]]);
  expect(answers(sent).map((answer) => answer.endOpIds)).toEqual([[opId]]);
});

test("output Opengeni has not stored is never ended: it is collected, and ended once stored", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  expect(await claim(machine, instance)).toBe(1);
  const unstored = `unstored-${crypto.randomUUID()}`;
  const running = `running-${crypto.randomUUID()}`;
  const lost = `lost-${crypto.randomUUID()}`;
  await insertCommand(machine, instance, unstored, "exited");
  await insertCommand(machine, instance, running);
  await insertCommand(machine, instance, lost, "lost");

  // Same generation, all completed: the exited command whose output was
  // never stored is kept (its collection is attempted while the runner talks;
  // this test transport cannot replay, so nothing is stored), the running one
  // is kept, the lost one is ended.
  await report(machine, bus, instance, [
    [unstored, 1, "complete"],
    [running, 1, "complete"],
    [lost, 1, "complete"],
  ]);
  expect(answers(sent).map((answer) => answer.endOpIds)).toEqual([[lost]]);
  sent.length = 0;
  const [kept] = await shared.admin<
    Array<{ consumed: Date | null; released: Date | null; claim: string | null }>
  >`select output_consumed_at as consumed, output_release_observed_at as released, reconcile_claim_id as claim from session_background_commands where op_id = ${unstored}`;
  expect(kept).toEqual({ consumed: null, released: null, claim: null });

  // Once stored, the same report ends it and records the release.
  await shared.admin`update session_background_commands set output_consumed_at = now(), output_exit_seq = '5', output_attach_generation = '1' where op_id = ${unstored}`;
  await report(machine, bus, instance, [[unstored, 1, "complete"]]);
  expect(answers(sent).map((answer) => answer.endOpIds)).toEqual([[unstored]]);
  const [stored] = await shared.admin<
    Array<{ released: Date | null }>
  >`select output_release_observed_at as released from session_background_commands where op_id = ${unstored}`;
  expect(stored?.released).toBeInstanceOf(Date);
});

test("a malformed or oversized page, or an inactive enrollment, gets no answer", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  expect(await claim(machine, instance)).toBe(1);
  await report(machine, bus, instance, [["bad.op", 1]]);
  await report(machine, bus, instance, [["", 1]]);
  await report(
    machine,
    bus,
    instance,
    Array.from(
      { length: CONNECTED_COMMAND_CLASSIFY_LIMIT + 1 },
      (_, n): Reported => [`op-${n}`, 1],
    ),
  );
  expect(sent).toEqual([]);
  // At the limit it is answered.
  await report(
    machine,
    bus,
    instance,
    Array.from({ length: CONNECTED_COMMAND_CLASSIFY_LIMIT }, (_, n): Reported => [`op-${n}`, 1]),
  );
  expect(sent).toHaveLength(1);
  sent.length = 0;
  await shared.admin`update enrollments set status = 'revoked', revoked_at = now() where id = ${machine.enrollment.id}`;
  await report(machine, bus, instance, [["op-1", 1]]);
  expect(sent).toEqual([]);
});

test("classification is exact to the runner process and carries each command's output custody", async () => {
  const machine = await seedMachine();
  const instance = crypto.randomUUID();
  const other = crypto.randomUUID();
  const running = `running-${crypto.randomUUID()}`;
  const lost = `lost-${crypto.randomUUID()}`;
  const exited = `exited-${crypto.randomUUID()}`;
  const stored = `stored-${crypto.randomUUID()}`;
  const elsewhere = `elsewhere-${crypto.randomUUID()}`;
  await insertCommand(machine, instance, running);
  await insertCommand(machine, instance, lost, "lost");
  await insertCommand(machine, instance, exited, "exited");
  await insertCommand(machine, instance, stored, "exited");
  await shared.admin`update session_background_commands set output_consumed_at = now(), output_exit_seq = '9', output_attach_generation = '1' where op_id = ${stored}`;
  await insertCommand(machine, other, elsewhere, "lost");
  const classified = await classifyConnectedCommandOps(client.db, {
    controlWorkspaceId: machine.workspaceId,
    enrollmentId: machine.enrollment.id,
    connectionInstanceId: instance,
    opIds: [running, lost, exited, stored, elsewhere, "unknown"],
  });
  const custody = Object.fromEntries(
    [...classified].map(([opId, rows]) => [
      opId,
      rows.map((row) => ({
        state: row.state,
        exitSeq: row.outputExitSeq,
        consumed: row.outputConsumed,
        released: row.outputReleased,
        unavailable: row.outputUnavailable,
        session: row.sessionId === machine.sessionId,
      })),
    ]),
  );
  const row = (state: string, consumed = false, exitSeq: string | null = null) => [
    { state, exitSeq, consumed, released: false, unavailable: false, session: true },
  ];
  expect(custody).toEqual({
    [running]: row("running"),
    [lost]: row("lost"),
    [exited]: row("exited"),
    [stored]: row("exited", true, "9"),
  });
  await expect(
    classifyConnectedCommandOps(client.db, {
      controlWorkspaceId: machine.workspaceId,
      enrollmentId: machine.enrollment.id,
      connectionInstanceId: instance,
      opIds: Array.from({ length: CONNECTED_COMMAND_CLASSIFY_LIMIT + 1 }, (_, n) => `op-${n}`),
    }),
  ).rejects.toThrow("At most");
});

test("the decision: custody for a command, the OpStart generation for anything else, never age", () => {
  const command = (
    state: "running" | "stopping" | "exited" | "lost",
    custody: { consumed?: boolean; released?: boolean; unavailable?: boolean } = {},
  ) => ({
    opId: "",
    accountId: "a",
    workspaceId: "w",
    sessionId: "s",
    commandId: "c",
    controlWorkspaceId: "w",
    enrollmentId: "e",
    connectionInstanceId: "i",
    state,
    outputExitSeq: custody.consumed ? "4" : null,
    outputConsumed: custody.consumed ?? false,
    outputReleased: custody.released ?? false,
    outputUnavailable: custody.unavailable ?? false,
  });
  const op = (opId: string, generation: string, complete = false): ReportedOperation => ({
    opId,
    connectionGeneration: generation,
    complete,
  });
  const decide = (
    operations: ReportedOperation[],
    commands: Record<string, ReturnType<typeof command>[]> = {},
    connectionGeneration = "3",
  ) => {
    const decision = decideInventoryPage({
      operations,
      commands: new Map(Object.entries(commands)),
      connectionGeneration,
    });
    return {
      end: decision.end,
      released: decision.released.map((row) => row.commandId),
      collectCompletions: decision.collectCompletions,
      collectOutputs: decision.collectOutputs.map((row) => row.commandId),
    };
  };
  const none = { end: [], released: [], collectCompletions: [], collectOutputs: [] };

  // A command row decides by custody, whatever generation the op reports.
  expect(decide([op("x", "1")], { x: [command("running")] })).toEqual(none);
  expect(decide([op("x", "3", true)], { x: [command("stopping")] })).toEqual({
    ...none,
    collectCompletions: ["x"],
  });
  expect(decide([op("x", "3", true)], { x: [command("exited")] })).toEqual({
    ...none,
    collectOutputs: ["c"],
  });
  // Not stored: kept, whatever generation it reports.
  expect(decide([op("x", "1", true)], { x: [command("exited")] })).toEqual({
    ...none,
    collectOutputs: ["c"],
  });
  expect(decide([op("x", "3")], { x: [command("exited")] })).toEqual(none);
  expect(decide([op("x", "3", true)], { x: [command("exited", { consumed: true })] })).toEqual({
    ...none,
    end: ["x"],
    released: ["c"],
  });
  expect(
    decide([op("x", "3", true)], { x: [command("exited", { consumed: true, released: true })] }),
  ).toEqual({ ...none, end: ["x"] });
  expect(decide([op("x", "3", true)], { x: [command("exited", { unavailable: true })] })).toEqual({
    ...none,
    end: ["x"],
  });
  expect(decide([op("x", "3")], { x: [command("lost")] })).toEqual({ ...none, end: ["x"] });
  // With several rows, one in flight or one still owed its output decides.
  expect(decide([op("x", "3", true)], { x: [command("lost"), command("exited")] })).toEqual({
    ...none,
    collectOutputs: ["c"],
  });

  // Without a row: an earlier generation is ended; the current one, an older
  // Opengeni's 0 and an empty value are kept while running.
  expect(
    decide([op("earlier", "1"), op("current", "3"), op("older", "0"), op("empty", "")]).end,
  ).toEqual(["earlier"]);
  // A completed one is ended by the same rule, never for being old.
  expect(
    decide([op("current", "3", true), op("older", "0", true), op("earlier", "2", true)]).end,
  ).toEqual(["earlier"]);
  // Generations compare as 64-bit integers, not strings.
  expect(decide([op("big", "18446744073709551614")], {}, "18446744073709551615").end).toEqual([
    "big",
  ]);
  expect(decide([op("ten", "10")], {}, "9").end).toEqual([]);
  expect(decide([op("nine", "9")], {}, "10").end).toEqual(["nine"]);
});
