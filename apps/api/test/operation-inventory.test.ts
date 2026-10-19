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
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { ingestConnectedCommandCompletion } from "../src/sandbox/command-completion";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";
import { unrecognisedOperations } from "../src/sandbox/operation-inventory";

// A runner process whose connection another process took keeps running what
// it ran: Opengeni settled those commands without reaching it. When the same
// process holds the connection again (old -> new -> old), it reports what it
// still runs or retains, and the answer to that report names what Opengeni no
// longer recognises, whatever happened to the chats in between. Nothing is
// recorded and nothing is sent unless the runner reports.

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
  state: "running" | "lost" = "running",
): Promise<void> {
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

/** One inventory page, delivered exactly as the events subscription does. */
async function report(
  machine: Machine,
  bus: EventBus,
  connectionInstanceId: string,
  operations: Array<[opId: string, generation: number]>,
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
          ([opId, generation]): InventoryOperation => ({
            opId,
            connectionGeneration: String(generation),
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
      stopOpIds: ack.operationInventory.stopOpIds.toSorted(),
    };
  });
}

test("old -> new -> old: the returning runner's report is answered with what Opengeni settled while it was replaced", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const oldInstance = crypto.randomUUID();
  const newInstance = crypto.randomUUID();
  const ack = (instance: string) =>
    `agent.${machine.workspaceId}.${machine.enrollment.id}.connection.${instance}.ack`;

  // old (generation 1): two background commands and foreground work.
  expect(await claim(machine, oldInstance)).toBe(1);
  const orphan = `orphan-${crypto.randomUUID()}`;
  const deleted = `deleted-${crypto.randomUUID()}`;
  const foreground = `foreground-${crypto.randomUUID()}`;
  await insertCommand(machine, oldInstance, orphan);
  await insertCommand(machine, oldInstance, deleted);
  await report(machine, bus, oldInstance, [
    [orphan, 0],
    [deleted, 0],
    [foreground, 0],
  ]);
  expect(answers(sent)).toEqual([
    {
      subject: ack(oldInstance),
      reportId: "7",
      page: 0,
      connectionGeneration: "1",
      stopOpIds: [],
    },
  ]);
  sent.length = 0;

  // new (generation 2): the reconciler settles old's commands as lost
  // without reaching it, and the chat of one of them is deleted.
  expect(await claim(machine, newInstance)).toBe(2);
  expect(await settleRetired(machine.enrollment.id)).toBe(2);
  await shared.admin`delete from session_background_commands where op_id = ${deleted}`;

  // Negative controls while new holds the connection: old's report is not
  // answered (it does not hold the connection), and new's own report of the
  // same ids stops nothing (they are not its commands and it is current).
  await report(machine, bus, oldInstance, [[orphan, 1]]);
  expect(sent).toEqual([]);
  await report(machine, bus, newInstance, [[orphan, 0]]);
  expect(answers(sent)).toEqual([
    {
      subject: ack(newInstance),
      reportId: "7",
      page: 0,
      connectionGeneration: "2",
      stopOpIds: [],
    },
  ]);
  sent.length = 0;

  // old again (generation 3): a command it started now is current.
  expect(await claim(machine, oldInstance)).toBe(3);
  const current = `current-${crypto.randomUUID()}`;
  const freshForeground = `fresh-${crypto.randomUUID()}`;
  const unlearned = `unlearned-${crypto.randomUUID()}`;
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
      [unlearned, 0],
    ],
    "9",
  );
  expect(answers(sent)).toEqual([
    {
      subject: ack(oldInstance),
      reportId: "9",
      page: 0,
      connectionGeneration: "3",
      stopOpIds: [orphan, deleted, foreground].toSorted(),
    },
  ]);
  // Answering changed no record: the settled ones stay as they were, also
  // after the runner pushes the completion of the op it then cancelled.
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

test("a plain reconnect of the same process keeps its generation, so nothing it runs is stopped", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  const opId = `foreground-${crypto.randomUUID()}`;
  expect(await claim(machine, instance)).toBe(1);
  await shared.admin`update enrollments set connection_lease_expires_at = now() - interval '1 second' where id = ${machine.enrollment.id}`;
  expect(await claim(machine, instance)).toBe(1);
  await report(machine, bus, instance, [[opId, 1]]);
  expect(answers(sent).map((answer) => [answer.connectionGeneration, answer.stopOpIds])).toEqual([
    ["1", []],
  ]);
});

test("a malformed or oversized page, or an inactive enrollment, gets no answer", async () => {
  const machine = await seedMachine();
  const { bus, sent } = answerChannel();
  const instance = crypto.randomUUID();
  expect(await claim(machine, instance)).toBe(1);
  await report(machine, bus, instance, [["bad.op", 0]]);
  await report(machine, bus, instance, [["", 0]]);
  await report(
    machine,
    bus,
    instance,
    Array.from({ length: CONNECTED_COMMAND_CLASSIFY_LIMIT + 1 }, (_, n) => [`op-${n}`, 0]),
  );
  expect(sent).toEqual([]);
  // At the limit it is answered.
  await report(
    machine,
    bus,
    instance,
    Array.from({ length: CONNECTED_COMMAND_CLASSIFY_LIMIT }, (_, n) => [`op-${n}`, 0]),
  );
  expect(sent).toHaveLength(1);
  sent.length = 0;
  await shared.admin`update enrollments set status = 'revoked', revoked_at = now() where id = ${machine.enrollment.id}`;
  await report(machine, bus, instance, [["op-1", 0]]);
  expect(sent).toEqual([]);
});

test("classification is exact to the runner process and says whether each command is settled", async () => {
  const machine = await seedMachine();
  const instance = crypto.randomUUID();
  const other = crypto.randomUUID();
  const running = `running-${crypto.randomUUID()}`;
  const lost = `lost-${crypto.randomUUID()}`;
  const exited = `exited-${crypto.randomUUID()}`;
  const elsewhere = `elsewhere-${crypto.randomUUID()}`;
  await insertCommand(machine, instance, running);
  await insertCommand(machine, instance, lost, "lost");
  await insertCommand(machine, instance, exited, "lost");
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_background_commands set state = 'exited', exit_code = 0, settlement_reason = null where op_id = ${exited}`;
  });
  await insertCommand(machine, other, elsewhere, "lost");
  const classified = await classifyConnectedCommandOps(client.db, {
    controlWorkspaceId: machine.workspaceId,
    enrollmentId: machine.enrollment.id,
    connectionInstanceId: instance,
    opIds: [running, lost, exited, elsewhere, "unknown"],
  });
  expect(Object.fromEntries(classified)).toEqual({
    [running]: { terminal: false },
    [lost]: { terminal: true },
    [exited]: { terminal: true },
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

test("what to stop: settled commands, and row-less work from an earlier generation", () => {
  const decide = (
    operations: Array<[string, string]>,
    commands: Record<string, boolean>,
    connectionGeneration = "3",
  ) =>
    unrecognisedOperations({
      operations: operations.map(([opId, generation]) => ({
        opId,
        connectionGeneration: generation,
      })),
      commands: new Map(Object.entries(commands).map(([opId, terminal]) => [opId, { terminal }])),
      connectionGeneration,
    });
  // A command row decides, whatever generation the runner reports.
  expect(decide([["settled", "3"]], { settled: true })).toEqual(["settled"]);
  expect(decide([["live", "1"]], { live: false })).toEqual([]);
  // Without a row: an earlier generation is stopped, the current one and an
  // unlearned one are kept.
  expect(
    decide(
      [
        ["earlier", "1"],
        ["current", "3"],
        ["unlearned", "0"],
        ["empty", ""],
      ],
      {},
    ),
  ).toEqual(["earlier"]);
  // Generations compare as 64-bit integers, not strings.
  expect(decide([["big", "18446744073709551615"]], {}, "18446744073709551615")).toEqual([]);
  expect(decide([["ten", "10"]], {}, "9")).toEqual(["ten"]);
});
