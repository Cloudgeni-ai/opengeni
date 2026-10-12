import { beforeAll, afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getRetainedProcess,
  settleRetainedProcess,
  type DbClient,
} from "@opengeni/db";
import { retainedProviderCommandPersistence } from "../../db/src/retained-provider-commands";
import { withRlsContext, rawRows } from "../../db/src/database";
import {
  registerNativeBrokerTransport,
  nativeBrokerTransportStore,
  type NativeBrokerTransportBinding,
} from "@opengeni/db/native-command-broker-transport";
import {
  initialNativeBrokerTransportState,
  NativeBrokerDriver,
  NativeBrokerDispatchUnknownError,
  type NativeBrokerChannel,
  readNativeBrokerBootstrap,
  initialNativeBrokerCommandSnapshot,
  projectNativeBrokerCommand,
  NativeBrokerRetainedCommand,
} from "@opengeni/runtime/sandbox";
import { encodeNativeBrokerCommandDefinition } from "../../runtime/src/sandbox/providers/native-command-broker-definition";
import { createDurableNativeBrokerTransport } from "../src/native-command-broker-transport";
import {
  encodeNativeBrokerFrame,
  NativeBrokerFrameDecoder,
} from "../../runtime/src/sandbox/providers/native-command-broker-wire";
import type { NativeBrokerOutputPage } from "../../runtime/src/sandbox/providers/native-command-broker-output";

let database: SharedTestDatabase, client: DbClient;
const key = randomBytes(32);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("native-broker-transport");
  if (!acquired) throw new Error("Native broker transport tests require isolated PostgreSQL");
  database = acquired;
  client = createDb(database.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await database?.release();
}, 60_000);

async function fixture(register = true) {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "Broker",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "Broker",
    subjectId: `test-${unique}`,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId,
    workspaceId: workspaceId!,
    initialMessage: "Broker transport fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const binding: NativeBrokerTransportBinding = {
    version: 1,
    brokerId: crypto.randomUUID(),
    accountId,
    workspaceId: workspaceId!,
    leaseId: crypto.randomUUID(),
    sandboxGroupId: session.sandboxGroupId,
    createOperationId: crypto.randomUUID(),
    createEpoch: 1,
    sandboxId: `sb-${unique}`,
    taskId: `ta-${unique}`,
    providerBindingKey: JSON.stringify({
      version: 1,
      serverUrl: "https://api.modal.test",
      workspaceName: "test",
      environment: "test",
    }),
    sourceSha: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    bootstrapEvidenceSha256: "c".repeat(64),
  };
  await database.admin`INSERT INTO sandbox_leases ${database.admin({
    id: binding.leaseId,
    account_id: accountId,
    workspace_id: workspaceId,
    sandbox_group_id: binding.sandboxGroupId,
    backend: "modal",
    liveness: "warming",
    lease_epoch: 1,
    instance_id: binding.sandboxId,
    expires_at: new Date(Date.now() + 300000),
    provider_create_attempt: database.admin.json({
      version: 1,
      operationId: binding.createOperationId,
      leaseEpoch: 1,
      providerBindingKey: binding.providerBindingKey,
      appId: "ap-test",
      providerName: `opengeni-create-${binding.createOperationId}`,
      requestSha256: "d".repeat(64),
      instanceId: binding.sandboxId,
    }),
  })}`;
  const initial = initialNativeBrokerTransportState(binding);
  if (register) await registerNativeBrokerTransport(client.db, key, binding, initial);
  const store = nativeBrokerTransportStore(client.db, key, binding);
  const service = () => createDurableNativeBrokerTransport(client.db, key, binding);
  return { binding, initial, store, service, sessionId: session.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Test-only admission/holder seed. Physical bootstrap/qualification is not
 * inferred from these rows; this exercises the canonical receipt/output/exit
 * custody using the actual native process rather than a synthetic terminal. */
async function retainNativeFixture(f: Fixture, command: ModalBrokerProviderCommand, handle = 1) {
  const b = f.binding,
    processId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  const scope = {
    accountId: b.accountId,
    workspaceId: b.workspaceId,
    sessionId: f.sessionId,
    processId,
  };
  const [birth] =
    await database.admin`update sandbox_leases set workspace_generation = workspace_generation + 1 where id=${b.leaseId} returning workspace_generation`;
  await database.admin`insert into sandbox_lease_holders ${database.admin({
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    lease_id: b.leaseId,
    kind: "process",
    holder_id: `process:${processId}`,
    subject_id: f.sessionId,
  })}`;
  await database.admin`insert into sandbox_workspace_mutation_admissions ${database.admin({
    id: admissionId,
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    lease_id: b.leaseId,
    sandbox_group_id: b.sandboxGroupId,
    session_id: f.sessionId,
    actor_kind: "direct",
    actor_id: actorId,
    holder_kind: "direct",
    holder_id: `direct:${actorId}`,
    lease_epoch: b.createEpoch,
    provider_backend: "modal",
    provider_instance_id: b.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    workspace_generation: birth!.workspace_generation,
    operation: "terminalExec",
    provider_outcome: "retained",
  })}`;
  await database.admin`insert into sandbox_retained_processes ${database.admin({
    id: processId,
    account_id: b.accountId,
    workspace_id: b.workspaceId,
    session_id: f.sessionId,
    lease_id: b.leaseId,
    sandbox_group_id: b.sandboxGroupId,
    parent_admission_id: admissionId,
    holder_id: `process:${processId}`,
    owner_actor_kind: "direct",
    owner_actor_id: actorId,
    lease_epoch: b.createEpoch,
    provider_backend: "modal",
    provider_instance_id: b.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    provider_session_id: handle,
    provider_binding_key: b.providerBindingKey,
    provider_binding: database.admin.json(JSON.parse(b.providerBindingKey)),
    provider_command: database.admin.json(command),
  })}`;
  return {
    scope,
    persistence: retainedProviderCommandPersistence(client.db, scope),
    inputAdmission: async () => {
      const childId = crypto.randomUUID();
      const [lease] = await database.admin`update sandbox_leases
        set workspace_generation = workspace_generation + 1 where id = ${b.leaseId}
        returning workspace_generation`;
      await database.admin`insert into sandbox_workspace_mutation_admissions ${database.admin({
        id: childId,
        account_id: b.accountId,
        workspace_id: b.workspaceId,
        lease_id: b.leaseId,
        sandbox_group_id: b.sandboxGroupId,
        session_id: f.sessionId,
        actor_kind: "process",
        actor_id: processId,
        holder_kind: "process",
        holder_id: `process:${processId}`,
        lease_epoch: b.createEpoch,
        provider_backend: "modal",
        provider_instance_id: b.sandboxId,
        route_kind: "active",
        route_epoch: 0,
        workspace_generation: lease!.workspace_generation,
        operation: "writeStdin",
      })}`;
      return { sessionId: f.sessionId, processId, admissionId: childId, commandId: command.execId };
    },
    settle: async (exitCode = 0) => {
      const expected = await getRetainedProcess(client.db, scope);
      if (!expected) throw new Error("Native retained fixture missing");
      return settleRetainedProcess(client.db, {
        ...scope,
        expected,
        outcome: "exited",
        exitCode,
        reason: "provider_exit_banner",
        idleGraceMs: 1000,
      });
    },
  };
}

async function stdinFixture() {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const id = crypto.randomUUID();
  const command = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    execId: id,
    pty: false,
    supervision: {
      protocol: "native-subreaper-broker-channel-v1",
      invocationId: id,
      brokerId: f.binding.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 0, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  const custody = await retainNativeFixture(f, command);
  const input = await custody.inputAdmission();
  const counter = async () => {
    const [row] =
      await database.admin`select provider_command_input_index from sandbox_retained_processes where id=${input.processId}`;
    return Number(row!.provider_command_input_index);
  };
  return { f, active, custody, input, counter };
}

test("retained stdin commits one byte reservation and one immutable request under concurrent replay", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  const bytes = Buffer.from("hello\u0000binary");
  const results = await Promise.all(
    [1, 2].map(() => f.service().reserveRetainedStdin(active.writerId, 1, input, bytes)),
  );
  expect(results.map((r) => [r.index, r.offset])).toEqual([
    [2, 0],
    [2, 0],
  ]);
  expect(results.filter((r) => r.alreadyReserved)).toHaveLength(1);
  expect(await counter()).toBe(bytes.length);
  await expect(custody.persistence.reserveInput!(1)).rejects.toThrow("atomically");
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("changed")),
  ).rejects.toThrow();
  await expect(f.service().dispatchIntent(active.writerId, 1, input.admissionId)).rejects.toThrow();
  expect(await counter()).toBe(bytes.length);
  const write = (await f.service().dispatchRetainedStdinIntent(active.writerId, 1, input))!;
  await f
    .service()
    .captureOutput("1-0", page(f, Buffer.from(accepted(f, write.input, 2)).toString(), "2-0"));
  const second = await custody.inputAdmission();
  expect(
    await f.service().reserveRetainedStdin(active.writerId, 1, second, Buffer.from("next")),
  ).toMatchObject({ index: 3, offset: bytes.length });
  expect(await counter()).toBe(bytes.length + 4);
});

test("busy channel, invalid writer and oversized stdin roll back the canonical byte offset", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  await expect(
    f.service().reserveRetainedStdin(crypto.randomUUID(), 1, input, Buffer.from("x")),
  ).rejects.toThrow();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, new Uint8Array(16384)),
  ).rejects.toThrow();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, new Uint8Array()),
  ).rejects.toThrow();
  expect(await counter()).toBe(0);
  expect(await f.service().request(input.admissionId)).toBeNull();
  await f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("first"));
  const second = await custody.inputAdmission();
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, second, Buffer.from("lost")),
  ).rejects.toThrow();
  expect(await counter()).toBe(5);
  expect(await f.service().request(second.admissionId)).toBeNull();
  await expect(
    f.store.retainedInputTransaction(second, async (tx) => {
      await tx.reserveInput(7);
      throw new Error("fixture rollback after byte reservation");
    }),
  ).rejects.toThrow();
  expect(await counter()).toBe(5);
});

test("stdin reservation requires exact session, process, command and existing child admission", async () => {
  const { f, active, input, counter } = await stdinFixture();
  const other = await stdinFixture();
  for (const changed of [
    { sessionId: other.input.sessionId },
    { processId: other.input.processId },
    { commandId: other.input.commandId },
    { admissionId: other.input.admissionId },
    { admissionId: crypto.randomUUID() },
  ])
    await expect(
      f
        .service()
        .reserveRetainedStdin(active.writerId, 1, { ...input, ...changed }, Buffer.from("x")),
    ).rejects.toThrow();
  await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='rejected' where id=${input.admissionId}`;
  await expect(
    f.service().reserveRetainedStdin(active.writerId, 1, input, Buffer.from("x")),
  ).rejects.toThrow();
  expect(await counter()).toBe(0);
  expect(await f.service().request(input.admissionId)).toBeNull();
  expect(await other.counter()).toBe(0);
});

test("cancel closes new stdin but preserves the exact already committed request for reconciliation", async () => {
  const { f, active, input, counter, custody } = await stdinFixture();
  const bytes = Buffer.from("original");
  await f.service().reserveRetainedStdin(active.writerId, 1, input, bytes);
  const before = (await f.service().dispatchRetainedStdinIntent(active.writerId, 1, input))!;
  const fresh = await custody.inputAdmission();
  await custody.persistence.requestCancellation!("explicit_stop");
  await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='rejected' where id=${input.admissionId}`;
  await database.admin`update native_command_broker_transports set writer_until=now()-interval '1 second', revision=revision+1 where id=${f.binding.brokerId}`;
  const next = crypto.randomUUID();
  expect(await f.service().claimWriter(next)).toMatchObject({ epoch: 2 });
  expect(await f.service().reserveRetainedStdin(next, 2, input, bytes)).toMatchObject({
    alreadyReserved: true,
    offset: 0,
  });
  const replay = await f.service().dispatchRetainedStdinIntent(next, 2, input);
  expect(replay).toEqual(before);
  await expect(
    f.service().reserveRetainedStdin(next, 2, fresh, Buffer.from("new")),
  ).rejects.toThrow();
  expect(await counter()).toBe(bytes.length);
});

test("stdin driver never silently repeats an unknown write and requires exact recovery scope", async () => {
  const { f, active, input, counter } = await stdinFixture();
  const writes: Uint8Array[] = [];
  const channel: NativeBrokerChannel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    async write(value) {
      writes.push(value.input);
      throw new Error("fixture unknown acknowledgement");
    },
    async *output() {},
  };
  const driver = new NativeBrokerDriver(f.service(), channel, active.writerId);
  await expect(driver.sendRetainedStdin(input, Buffer.from("once"))).rejects.toBeInstanceOf(
    NativeBrokerDispatchUnknownError,
  );
  expect(await driver.sendRetainedStdin(input, Buffer.from("once"))).toMatchObject({
    state: "reconciliation_required",
    offset: 0,
  });
  await expect(driver.replayPending()).rejects.toThrow("exact retained admission");
  await expect(
    driver.replayPending(undefined, { ...input, processId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(writes).toHaveLength(1);
  await expect(driver.replayPending(undefined, input)).rejects.toBeInstanceOf(
    NativeBrokerDispatchUnknownError,
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(await counter()).toBe(4);
});
function fence() {
  return {
    requestId: crypto.randomUUID(),
    commandId: null,
    kind: "fence" as const,
    offset: 0,
    payload: new Uint8Array(),
  };
}
function page(f: Fixture, wire: string, entryId = "1-0"): NativeBrokerOutputPage {
  return {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    requestedFileDescriptor: 1,
    entryId,
    items: [{ fileDescriptor: 1, data: wire }],
    eof: false,
  };
}
function accepted(f: Fixture, bytes: Uint8Array, sequence = 1) {
  const decoder = new NativeBrokerFrameDecoder(f.binding.brokerId);
  const request = decoder.push(bytes)[0]!;
  decoder.finish();
  return encodeNativeBrokerFrame({
    ...request,
    direction: "response",
    kind: "accepted",
    sequence,
    offset: request.sequence,
    payload: new Uint8Array(),
  });
}
async function start(f: Fixture) {
  const writerId = crypto.randomUUID();
  const writer = await f.service().claimWriter(writerId);
  const request = fence();
  await f.service().reserve(writerId, writer.epoch, request);
  const write = (await f.service().dispatchIntent(writerId, writer.epoch, request.requestId))!;
  return { writerId, writer, request, write };
}

test("registration requires exact attributed creation and never rewinds an existing journal", async () => {
  const f = await fixture(false);
  for (const changed of [
    { createOperationId: crypto.randomUUID() },
    { createEpoch: 2 },
    { sandboxId: "sb-wrong" },
    {
      providerBindingKey: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.test",
        workspaceName: "other",
        environment: "test",
      }),
    },
  ]) {
    await expect(
      registerNativeBrokerTransport(client.db, key, { ...f.binding, ...changed }, f.initial),
    ).rejects.toThrow();
  }
  await registerNativeBrokerTransport(client.db, key, f.binding, f.initial);
  await start(f);
  const before = await f.service().read();
  await registerNativeBrokerTransport(client.db, key, f.binding, f.initial);
  expect(await f.service().read()).toEqual(before);
  await expect(
    registerNativeBrokerTransport(client.db, key, f.binding, { ...f.initial, version: 2 }),
  ).rejects.toThrow();
  await expect(
    registerNativeBrokerTransport(client.db, key, { ...f.binding, taskId: "other" }, f.initial),
  ).rejects.toThrow();
});

test("control reply index commits with its accepted request/frame and rejects conflicting replay", async () => {
  const f = await fixture();
  const active = await start(f);
  await f
    .service()
    .captureOutput("0-0", page(f, Buffer.from(accepted(f, active.write.input)).toString()));
  const request = {
    ...fence(),
    kind: "control" as const,
    commandId: crypto.randomUUID(),
    payload: Buffer.from("cancel"),
  };
  await f.service().reserve(active.writerId, active.writer.epoch, request);
  const input = (await f
    .service()
    .dispatchIntent(active.writerId, active.writer.epoch, request.requestId))!;
  const reply = {
    direction: "response" as const,
    brokerId: f.binding.brokerId,
    ownerEpoch: 1,
    sequence: 3,
    requestId: request.requestId,
    commandId: request.commandId,
    kind: "error" as const,
    offset: 0,
    payload: Buffer.from('{"error":"control_unavailable"}'),
  };
  expect(await f.service().controlReply(request.requestId)).toBeNull();
  // A response before native acceptance cannot create an authority-bearing index.
  await expect(
    f
      .service()
      .captureOutput(
        "1-0",
        page(f, Buffer.from(encodeNativeBrokerFrame({ ...reply, sequence: 2 })).toString(), "2-0"),
      ),
  ).rejects.toThrow();
  expect((await f.service().read()).output.lastSequence).toBe(1);
  await f
    .service()
    .captureOutput(
      "1-0",
      page(
        f,
        Buffer.concat([accepted(f, input.input, 2), encodeNativeBrokerFrame(reply)]).toString(),
        "2-0",
      ),
    );
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
  const conflict = encodeNativeBrokerFrame({
    ...reply,
    sequence: 4,
    payload: Buffer.from('{"error":"control_pressure"}'),
  });
  await expect(
    f.service().captureOutput("2-0", page(f, Buffer.from(conflict).toString(), "3-0")),
  ).rejects.toThrow();
  expect((await f.service().read()).output.lastSequence).toBe(3);
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
  await expect(
    withRlsContext(client.db, f.binding, (tx) =>
      tx.execute(sql`DELETE FROM native_command_broker_entries
    WHERE broker_id=${f.binding.brokerId} AND kind='control_reply'`),
    ),
  ).rejects.toThrow();
  expect(await f.service().controlReply(request.requestId)).toEqual(reply);
});

test("concurrent writer claims elect one owner; stale and foreign owners cannot dispatch", async () => {
  const f = await fixture();
  const owners = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.allSettled(owners.map((id) => f.service().claimWriter(id)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = owners[results.findIndex((r) => r.status === "rejected")]!;
  await expect(f.service().reserve(loser, 1, fence())).rejects.toThrow();
});

test("concurrent registration is idempotent and a second broker cannot bind the same physical creation", async () => {
  const f = await fixture(false);
  await Promise.all(
    [1, 2].map(() => registerNativeBrokerTransport(client.db, key, f.binding, f.initial)),
  );
  expect(await f.service().read()).toEqual(f.initial);
  const different = { ...f.binding, brokerId: crypto.randomUUID() };
  await expect(
    registerNativeBrokerTransport(
      client.db,
      key,
      different,
      initialNativeBrokerTransportState(different),
    ),
  ).rejects.toThrow();
});

test("nested savepoint handles cannot return a dispatch before the actual outer commit", async () => {
  const f = await fixture();
  await withRlsContext(client.db, f.binding, async (tx) => {
    expect(() => createDurableNativeBrokerTransport(tx, key, f.binding)).toThrow("outer commit");
    await expect(registerNativeBrokerTransport(tx, key, f.binding, f.initial)).rejects.toThrow(
      "outer commit",
    );
  });
});

test("request reservation and dispatch survive client restart with exact bytes and no duplicate indices", async () => {
  const f = await fixture();
  const { writerId, request, write } = await start(f);
  expect(write.eof).toBe(false);
  expect(await f.service().reserve(writerId, 1, request)).toEqual({
    index: 1,
    alreadyReserved: true,
  });
  expect(await f.service().dispatchIntent(writerId, 1, request.requestId)).toEqual(write);
  await expect(
    f.service().reserve(writerId, 1, { ...request, payload: Buffer.from("different") }),
  ).rejects.toThrow();
  await f.service().providerAcknowledged(writerId, 1, request.requestId);
  await expect(f.service().reserve(writerId, 1, fence())).rejects.toThrow();
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(0);
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
  expect(await f.service().dispatchIntent(writerId, 1, request.requestId)).toBeNull();
});

test("failed transaction retains neither request nor advanced state", async () => {
  const f = await fixture();
  const before = await f.service().read();
  await expect(
    f.store.transaction(async (tx) => {
      await tx.insert({
        kind: "request",
        key: crypto.randomUUID(),
        sequence: 1,
        value: "secret-input",
      });
      tx.save({ bad: true });
      throw new Error("injected commit failure");
    }),
  ).rejects.toThrow("injected");
  expect(await f.service().read()).toEqual(before);
  const rows =
    await database.admin`SELECT * FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}`;
  expect(rows).toHaveLength(0);
});

test("one partial frame, cursor, immutable inbox and acceptance commit atomically", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const wire = Buffer.from(accepted(f, write.input)).toString();
  await f.service().captureOutput("0-0", page(f, wire.slice(0, 17)));
  const partial = await f.service().read();
  expect(partial.output.partialBase64).not.toBe("");
  expect(partial.input.lastAcceptedInputIndex).toBe(0);
  await expect(
    f.service().captureOutput("1-0", page(f, wire.slice(17) + "INVALID\n", "2-0")),
  ).rejects.toThrow();
  expect(await f.service().read()).toEqual(partial);
  await f.service().captureOutput("1-0", page(f, wire.slice(17), "2-0"));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
  const counts =
    await database.admin`SELECT kind,count(*)::int AS count FROM native_command_broker_entries
    WHERE broker_id = ${f.binding.brokerId} GROUP BY kind ORDER BY kind`;
  expect(counts.map((row) => [row.kind, row.count])).toEqual([
    ["frame", 1],
    ["page", 2],
    ["request", 1],
  ]);
});

test("expired writer takeover replays old pending body before its own fence", async () => {
  const f = await fixture();
  const { writerId, write, request } = await start(f);
  await database.admin`UPDATE native_command_broker_transports SET writer_until = now() - interval '1 second', revision = revision + 1 WHERE id = ${f.binding.brokerId}`;
  const successor = crypto.randomUUID();
  expect(await f.service().claimWriter(successor)).toMatchObject({ epoch: 2, live: true });
  await expect(f.service().dispatchIntent(writerId, 1, request.requestId)).rejects.toThrow();
  expect(await f.service().dispatchIntent(successor, 2, request.requestId)).toEqual(write);
  await expect(f.service().reserve(successor, 2, fence())).rejects.toThrow();
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  const next = fence();
  expect(await f.service().reserve(successor, 2, next)).toMatchObject({ index: 2 });
  const nextWrite = (await f.service().dispatchIntent(successor, 2, next.requestId))!;
  await f
    .service()
    .captureOutput("1-0", page(f, Buffer.from(accepted(f, nextWrite.input, 2)).toString(), "2-0"));
  expect((await f.service().read()).input.acceptedWriterEpoch).toBe(2);
});

test("racing output collectors cannot split or duplicate a committed page", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const output = page(f, Buffer.from(accepted(f, write.input)).toString());
  const attempts = await Promise.allSettled(
    [1, 2].map(() => f.service().captureOutput("0-0", output)),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await f.service().captureOutput("1-0", output)).toMatchObject({ capturedFrames: 0 });
  const frames = await database.admin`SELECT sequence FROM native_command_broker_entries
    WHERE broker_id = ${f.binding.brokerId} AND kind = 'frame'`;
  expect(frames).toHaveLength(1);
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
});

test("two identical input reservations consume only one durable index", async () => {
  const f = await fixture();
  const owner = crypto.randomUUID();
  await f.service().claimWriter(owner);
  const request = fence();
  const results = await Promise.all([1, 2].map(() => f.service().reserve(owner, 1, request)));
  expect(results.map((result) => result.index)).toEqual([1, 1]);
  expect(results.filter((result) => result.alreadyReserved)).toHaveLength(1);
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

test("output replay is immutable and provider EOF cannot settle a pending command", async () => {
  const f = await fixture();
  const { write, writerId } = await start(f);
  const output = page(f, Buffer.from(accepted(f, write.input)).toString());
  await f.service().captureOutput("0-0", output);
  expect(await f.service().captureOutput("1-0", output)).toMatchObject({ capturedFrames: 0 });
  await expect(
    f
      .service()
      .captureOutput("1-0", { ...output, items: [{ fileDescriptor: 1, data: "changed" }] }),
  ).rejects.toThrow();
  const command = { ...fence(), kind: "prepare" as const, commandId: crypto.randomUUID() };
  await f.service().reserve(writerId, 1, command);
  await f.service().dispatchIntent(writerId, 1, command.requestId);
  const end = { ...output, entryId: "", items: [], eof: true };
  await f.service().captureOutput("1-0", end);
  await f.service().captureOutput("1-0", end);
  expect((await f.service().read()).output).toMatchObject({
    cursor: "1-0",
    providerEof: true,
    lastSequence: 1,
  });
  expect(Object.keys(await f.service().read()).sort()).toEqual(["input", "output", "version"]);
  expect((await f.service().read()).input.pending?.phase).toBe("dispatch_intent");
  await expect(f.service().dispatchIntent(writerId, 1, command.requestId)).rejects.toThrow();
  await expect(f.service().claimWriter(writerId)).rejects.toThrow();
});

test("cross-workspace RLS, immutable receipts, ciphertext and physical identities are enforced", async () => {
  const f = await fixture();
  const other = await fixture();
  const { write } = await start(f);
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  const visible = await withRlsContext(client.db, other.binding, (tx) =>
    rawRows(
      tx,
      sql`SELECT * FROM native_command_broker_transports WHERE id = ${f.binding.brokerId}::uuid`,
    ),
  );
  expect(visible).toHaveLength(0);
  const receipts = await withRlsContext(client.db, other.binding, (tx) =>
    rawRows(
      tx,
      sql`SELECT * FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}::uuid`,
    ),
  );
  expect(receipts).toHaveLength(0);
  await expect(
    createDurableNativeBrokerTransport(client.db, key, { ...f.binding, taskId: "foreign" }).read(),
  ).rejects.toThrow();
  await expect(
    createDurableNativeBrokerTransport(client.db, randomBytes(32), f.binding).read(),
  ).rejects.toThrow();
  const raw =
    await database.admin`SELECT state_encrypted FROM native_command_broker_transports WHERE id = ${f.binding.brokerId}`;
  expect(raw[0]!.state_encrypted.startsWith("v2:")).toBe(true);
  expect(raw[0]!.state_encrypted).not.toContain("frameBase64");
  await expect(
    withRlsContext(client.db, f.binding, (tx) =>
      tx.execute(
        sql`DELETE FROM native_command_broker_entries WHERE broker_id = ${f.binding.brokerId}::uuid`,
      ),
    ),
  ).rejects.toThrow();
  await expect(
    (async () => {
      await database.admin`UPDATE native_command_broker_entries SET sha256 = ${"f".repeat(64)} WHERE broker_id = ${f.binding.brokerId}`;
    })(),
  ).rejects.toThrow("immutable");
  await expect(
    (async () => {
      await database.admin`UPDATE native_command_broker_transports SET binding = '{}'::jsonb, revision = revision+1 WHERE id = ${f.binding.brokerId}`;
    })(),
  ).rejects.toThrow();
});

test("late output remains capturable after physical replacement, but no input can be dispatched", async () => {
  const f = await fixture();
  const { writerId, request, write } = await start(f);
  // Test-only direct owner setup; production replacement remains the canonical lease path.
  await database.admin`UPDATE sandbox_leases SET provider_create_attempt = NULL, instance_id = NULL, liveness = 'cold' WHERE id = ${f.binding.leaseId}`;
  await expect(f.service().dispatchIntent(writerId, 1, request.requestId)).rejects.toThrow();
  await f.service().captureOutput("0-0", page(f, Buffer.from(accepted(f, write.input)).toString()));
  expect((await f.service().read()).input.lastAcceptedInputIndex).toBe(1);
});

test("committed frame scans are bounded, ordered, restartable and physical-scope fenced", async () => {
  const f = await fixture();
  const { write } = await start(f);
  const first = accepted(f, write.input);
  // Cross 9/10: the query must order the numeric column, not its text alias.
  const more = Array.from({ length: 14 }, (_, i) =>
    encodeNativeBrokerFrame({
      direction: "response",
      brokerId: f.binding.brokerId,
      ownerEpoch: 1,
      sequence: i + 2,
      requestId: f.binding.brokerId,
      commandId: null,
      kind: "status",
      offset: 0,
      payload: Buffer.from("{}"),
    }),
  );
  await f.service().captureOutput("0-0", page(f, Buffer.concat([first, ...more]).toString()));
  expect((await f.service().framesAfter(0, 2)).frames.map((frame) => frame.sequence)).toEqual([
    1, 2,
  ]);
  expect((await f.service().framesAfter(2, 2)).frames.map((frame) => frame.sequence)).toEqual([
    3, 4,
  ]);
  expect(await f.service().framesAfter(14, 2)).toMatchObject({
    frames: [{ sequence: 15 }],
    lastSequence: 15,
    providerEof: false,
  });
  expect((await f.service().framesAfter(15)).frames).toHaveLength(0);
  expect((await f.service().framesAfter(0)).frames.map((frame) => frame.sequence)).toEqual(
    Array.from({ length: 15 }, (_, i) => i + 1),
  );
  for (const [sequence, limit] of [
    [-1, 2],
    [16, 2],
    [0, 0],
    [0, 129],
  ])
    await expect(f.service().framesAfter(sequence!, limit!)).rejects.toThrow();
  const foreign = createDurableNativeBrokerTransport(client.db, key, {
    ...f.binding,
    workspaceId: crypto.randomUUID(),
  });
  await expect(foreign.framesAfter(0)).rejects.toThrow();
});

function driverFixture(
  f: Fixture,
  options: {
    write?: NativeBrokerChannel["write"];
    output?: NativeBrokerChannel["output"];
    writerId?: string;
  } = {},
) {
  const writes: Parameters<NativeBrokerChannel["write"]>[0][] = [];
  const channel: NativeBrokerChannel = {
    sandboxId: f.binding.sandboxId,
    taskId: f.binding.taskId,
    write:
      options.write ??
      (async (input) => {
        writes.push(input);
      }),
    output: options.output ?? async function* () {},
  };
  const writerId = options.writerId ?? crypto.randomUUID();
  return {
    channel,
    writerId,
    writes,
    driver: new NativeBrokerDriver(f.service(), channel, writerId),
  };
}

test("driver sends only after intent is durably readable and never repeats known unresolved input", async () => {
  const f = await fixture();
  const request = fence();
  let physicalCalls = 0;
  const setup = driverFixture(f, {
    write: async () => {
      physicalCalls++;
      expect(await f.service().request(request.requestId)).toMatchObject({
        phase: "dispatch_intent",
        accepted: false,
      });
    },
  });
  expect(await setup.driver.send(request)).toEqual({ state: "provider_acknowledged", index: 1 });
  expect(await setup.driver.send(request)).toEqual({ state: "reconciliation_required", index: 1 });
  expect(physicalCalls).toBe(1);
  expect((await f.service().read()).input.pending?.phase).toBe("provider_acknowledged");
});

test("unknown driver write survives restart; only explicit exact replay can send it again", async () => {
  const f = await fixture();
  const request = fence();
  const writes: Parameters<NativeBrokerChannel["write"]>[0][] = [];
  const first = driverFixture(f, {
    write: async (input) => {
      writes.push(input);
      throw new Error("lost response");
    },
  });
  await expect(first.driver.send(request)).rejects.toBeInstanceOf(NativeBrokerDispatchUnknownError);
  const next = driverFixture(f, {
    writerId: first.writerId,
    write: async (input) => {
      writes.push(input);
    },
  });
  expect(await next.driver.send(request)).toEqual({ state: "reconciliation_required", index: 1 });
  expect(writes).toHaveLength(1);
  expect(await next.driver.replayPending()).toEqual({ state: "provider_acknowledged" });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

test("driver captures acceptance before next input and reads late output after instance replacement", async () => {
  const f = await fixture();
  const request = fence();
  let output: NativeBrokerOutputPage;
  const setup = driverFixture(f, {
    write: async (input) => {
      output = page(f, Buffer.from(accepted(f, input.input)).toString());
    },
    output: async function* () {
      yield output;
    },
  });
  await setup.driver.send(request);
  await database.admin`UPDATE sandbox_leases SET provider_create_attempt = NULL, instance_id = NULL, liveness = 'cold' WHERE id = ${f.binding.leaseId}`;
  expect(await setup.driver.observe(undefined, 1)).toEqual({
    pages: 1,
    capturedFrames: 1,
    providerEof: false,
  });
  expect(await f.service().request(request.requestId)).toMatchObject({
    accepted: true,
    phase: "accepted",
  });
  await expect(setup.driver.send(fence())).rejects.toThrow();
});

test("provider page commit failure prevents requesting a successor or advancing captured cursor", async () => {
  const f = await fixture();
  const request = fence();
  let nextRequested = false,
    closed = false;
  const setup = driverFixture(f, {
    output: async function* () {
      try {
        yield page(f, "invalid\n");
        nextRequested = true;
        yield page(f, "", "2-0");
      } finally {
        closed = true;
      }
    },
  });
  await setup.driver.send(request);
  await expect(setup.driver.observe()).rejects.toThrow();
  expect(nextRequested).toBe(false);
  expect(closed).toBe(true);
  expect((await f.service().read()).output.cursor).toBe("0-0");
});

test("driver bounds pages and local overlapping writes without serializing cancellation behind a log read", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const setup = driverFixture(f, {
    write: async () => {
      entered();
      await gate;
    },
  });
  const first = setup.driver.send(fence());
  await ready;
  await expect(setup.driver.send(fence())).rejects.toThrow("already in progress");
  // Read observation is independent of the pending write.
  expect(await setup.driver.observe()).toEqual({ pages: 0, capturedFrames: 0, providerEof: false });
  release();
  await first;
  const cancel = new AbortController();
  cancel.abort(new Error("caller stopped"));
  await expect(setup.driver.send(fence(), cancel.signal)).rejects.toThrow("caller stopped");
  await expect(setup.driver.observe(undefined, 129)).rejects.toThrow("bound");
  expect((await f.service().read()).input.lastReservedInputIndex).toBe(1);
});

// Explicit native build fixture only. Normal CI exercises deterministic transport
// and real PostgreSQL above; this additionally needs the repository's static
// ELF and Linux subreaper/pidfd/PTY kernel primitives. It is not Modal admission.
test.skipIf(process.env.OPENGENI_NATIVE_BROKER_LOCAL !== "1")(
  "actual static broker and PostgreSQL journal survive lost dispatch, writer takeover and exact settlement",
  async () => {
    const artifactRoot = join(import.meta.dir, "../../../agent/native/command-supervisor");
    const manifest = JSON.parse(await readFile(join(artifactRoot, "build/artifact.json"), "utf8"));
    const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    expect(sha(await readFile(join(artifactRoot, "supervisor.c")))).toBe(manifest.sourceFileSha256);
    const elf = await readFile(join(artifactRoot, "build/opengeni-command-supervisor"));
    expect(sha(elf)).toBe(manifest.artifactSha256);
    expect(elf.length).toBe(manifest.byteSize);
    const f = await fixture();
    const directory = await mkdtemp(join(tmpdir(), "opengeni-native-broker-"));
    const child = Bun.spawn(
      [
        join(artifactRoot, "build/opengeni-command-supervisor"),
        "broker",
        "--broker-id",
        f.binding.brokerId,
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const watchdog = setTimeout(() => child.kill("SIGTERM"), 50_000);
    watchdog.unref();
    const artifactPin = {
      artifactSha256: manifest.artifactSha256,
      byteSize: manifest.byteSize,
      target: manifest.target,
    };
    const pages: NativeBrokerOutputPage[] = [];
    let wake = () => {},
      streamError: unknown,
      bytes = 0;
    const reader = (async () => {
      try {
        const input = child.stdout.getReader();
        for (;;) {
          const chunk = await input.read();
          const text = chunk.done ? "" : Buffer.from(chunk.value).toString("ascii");
          bytes += text.length;
          if (bytes > 2 * 1024 * 1024) throw new Error("Native fixture output exceeds bound");
          pages.push({ ...page(f, text, `${pages.length + 1}-0`), eof: chunk.done });
          wake();
          if (chunk.done) break;
        }
      } catch (error) {
        streamError = error;
        wake();
      }
    })();
    const diagnostics = new Response(child.stderr).text();
    let index = 0,
      uncertain = false,
      dispatchCount = 0;
    const channel: NativeBrokerChannel = {
      sandboxId: f.binding.sandboxId,
      taskId: f.binding.taskId,
      async write(input) {
        dispatchCount++;
        // Model the physically measured Modal high-water input-index contract.
        if (input.index <= index) return;
        // Simulate a genuinely unknown response before physical delivery. The
        // journal cannot know this and must keep the exact indexed bytes.
        if (uncertain) {
          uncertain = false;
          throw new Error("uncertain transport");
        }
        index = input.index;
        child.stdin.write(input.input);
        await child.stdin.flush();
      },
      async *output(cursor) {
        let offset = Number(cursor.split("-")[0]);
        for (;;) {
          while (offset >= pages.length) {
            if (streamError) throw streamError;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const next = pages[offset++]!;
          yield next;
          if (next.eof) return;
        }
      },
    };
    let writerId = crypto.randomUUID(),
      driver = new NativeBrokerDriver(f.service(), channel, writerId);
    const frames = async () => (await f.service().framesAfter(0, 128)).frames;
    async function observeUntil(predicate: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 128; attempt++) {
        if (await predicate()) return;
        await driver.observe(undefined, 1);
      }
      throw new Error("Native fixture observation bound exceeded");
    }
    async function request(
      kind: Parameters<NativeBrokerDriver["send"]>[0]["kind"],
      commandId: string | null = null,
      payload = new Uint8Array(),
      offset = 0,
      requestId = crypto.randomUUID(),
    ) {
      await driver.send({ requestId, commandId, kind, payload, offset });
      await observeUntil(async () => (await f.service().request(requestId))?.accepted === true);
      if (kind === "ack") return null;
      await observeUntil(async () =>
        (await frames()).some(
          (frame) => frame.requestId === requestId && ["status", "error"].includes(frame.kind),
        ),
      );
      const frame = (await frames()).find(
        (candidate) =>
          candidate.requestId === requestId && ["status", "error"].includes(candidate.kind),
      )!;
      expect(frame.kind).toBe("status");
      const body = JSON.parse(Buffer.from(frame.payload).toString());
      expect(body.error).toBeUndefined();
      return body;
    }
    const id = crypto.randomUUID();
    try {
      await observeUntil(async () => {
        try {
          await readNativeBrokerBootstrap(f.service(), artifactPin);
          return true;
        } catch (error) {
          const observed = await f.service().read();
          if (
            observed.output.lastSequence >= 1 + Math.ceil(manifest.byteSize / 8192) ||
            observed.output.providerEof
          )
            throw error;
          return false;
        }
      });
      const bootstrap = await readNativeBrokerBootstrap(f.service(), artifactPin);
      expect(bootstrap.commandAdmission).toBe(false);
      await request("fence");
      const definition = encodeNativeBrokerCommandDefinition({
        mode: "pipe",
        cwd: directory,
        argv: ["/bin/sh", "-c", "printf x >> once; exec cat"],
        env: [["PATH", "/usr/bin:/bin"]],
        rows: 0,
        columns: 0,
      });
      const size = Buffer.alloc(4);
      size.writeUInt32BE(definition.length);
      const launchRequestId = crypto.randomUUID();
      const retained = ModalBrokerProviderCommand.parse({
        kind: "modal-broker-v1",
        sandboxId: f.binding.sandboxId,
        taskId: f.binding.taskId,
        execId: id,
        pty: false,
        supervision: {
          protocol: "native-subreaper-broker-channel-v1",
          invocationId: id,
          brokerId: f.binding.brokerId,
          launchRequestId,
          launchEpoch: 1,
        },
        capture: { sequence: bootstrap.lastSequence, receiptAckObserved: false },
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      });
      const custody = await retainNativeFixture(f, retained);
      await request("prepare", id, size);
      await request("definition", id, definition);
      expect(await request("launch", id, new Uint8Array(), 0, launchRequestId)).toEqual({
        state: "supervisor_started",
        released: false,
      });
      uncertain = true;
      const release = {
        requestId: crypto.randomUUID(),
        commandId: id,
        kind: "control" as const,
        offset: 0,
        payload: Buffer.from("release"),
      };
      await expect(driver.send(release)).rejects.toBeInstanceOf(NativeBrokerDispatchUnknownError);
      const before = await f.service().request(release.requestId);
      await database.admin`UPDATE native_command_broker_transports SET writer_until = now() - interval '1 second', revision = revision + 1 WHERE id = ${f.binding.brokerId}`;
      writerId = crypto.randomUUID();
      driver = new NativeBrokerDriver(f.service(), channel, writerId);
      expect(await driver.claimWriter()).toMatchObject({ epoch: 2 });
      const count = dispatchCount;
      expect(await driver.send(release)).toMatchObject({ state: "reconciliation_required" });
      expect(dispatchCount).toBe(count);
      await driver.replayPending();
      await observeUntil(
        async () => (await f.service().request(release.requestId))?.accepted === true,
      );
      expect((await f.service().request(release.requestId))!.frame).toEqual(before!.frame);
      await request("fence");
      expect(await driver.send(release)).toMatchObject({ state: "accepted" });
      const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
      const stdinAdmission = await custody.inputAdmission();
      expect(await driver.sendRetainedStdin(stdinAdmission, binary)).toMatchObject({
        state: "provider_acknowledged",
        offset: 0,
      });
      await observeUntil(
        async () => (await f.service().request(stdinAdmission.admissionId))?.accepted === true,
      );
      await database.admin`update sandbox_workspace_mutation_admissions set settled_at=now(), provider_outcome='resolved' where id=${stdinAdmission.admissionId}`;
      await request("eof", id, new Uint8Array(), binary.length);
      let receipt:
        | { protocol: string; invocationId: string; receiptId: string; leaderExitCode: number }
        | undefined;
      // Status control waits in the supervisor until this observation; native
      // process exit may lag cat's stdin closure by a scheduler tick.
      for (let attempt = 0; attempt < 64 && !receipt; attempt++) {
        const result = await request("control", id, Buffer.from("status"));
        receipt = result.receipt;
      }
      expect(receipt).toMatchObject({
        protocol: "native-subreaper-broker-channel-v1",
        invocationId: id,
        leaderExitCode: 0,
      });
      // The receipt is already in committed encrypted frames before any ACK.
      expect(
        (await frames()).some((frame) =>
          Buffer.from(frame.payload).toString().includes(receipt!.receiptId),
        ),
      ).toBe(true);
      const controller = new NativeBrokerRetainedCommand(
        retained,
        custody.persistence,
        f.service(),
        driver,
      );
      const beforeAck = await controller.capture(128);
      expect(beforeAck.exitCode).toBeNull();
      expect(await custody.persistence.loadSupervisionReceipt()).toEqual(receipt!);
      await expect(custody.settle()).rejects.toThrow();
      await controller.acknowledgeReceipt();
      await observeUntil(async () =>
        (await frames()).some((frame) => frame.commandId === id && frame.kind === "exit"),
      );
      const captured = await frames();
      const end = captured.find((frame) => frame.commandId === id && frame.kind === "exit")!;
      expect(JSON.parse(Buffer.from(end.payload).toString())).toEqual({
        supervisorExitCode: 0,
        stdoutEof: true,
        stderrEof: true,
      });
      const output = Buffer.concat(
        captured
          .filter((frame) => frame.commandId === id && frame.kind === "stdout")
          .map((frame) => frame.payload),
      );
      expect(output).toEqual(Buffer.from(binary));
      expect(await readFile(join(directory, "once"), "utf8")).toBe("x");
      const launchFrame = captured.find(
        (frame) => frame.commandId === id && frame.kind === "stdout",
      )!;
      const projection = await projectNativeBrokerCommand(
        f.service(),
        initialNativeBrokerCommandSnapshot(
          {
            brokerId: f.binding.brokerId,
            commandId: id,
            launchRequestId: launchFrame.requestId,
            launchEpoch: launchFrame.ownerEpoch,
            mode: "pipe",
          },
          bootstrap.lastSequence,
        ),
        128,
      );
      expect(projection.exitCode).toBe(0);
      expect(projection.receipts).toEqual([receipt!]);
      expect(projection.snapshot).toMatchObject({
        receiptAckObserved: true,
        supervisorExitCode: 0,
      });
      expect(projection.chunks.map((chunk) => chunk.text).join("")).toBe(
        Buffer.from(binary).toString("utf8"),
      );
      // A fresh object reconstructs only canonical saved state after reconnect.
      const afterAck = await new NativeBrokerRetainedCommand(
        retained,
        custody.persistence,
        f.service(),
        driver,
      ).capture(128);
      expect(afterAck.exitCode).toBe(0);
      expect((await custody.settle()).settled).toBe(true);
      expect((await getRetainedProcess(client.db, custody.scope))?.state).toBe("exited");

      // A second real command exercises controller-owned release, durable
      // cancellation, repeated status and receipt ACK through a fresh object.
      // This local seeded fixture is not the remote 2s/35s release canary.
      const cancelId = crypto.randomUUID(),
        cancelLaunchId = crypto.randomUUID();
      const cancelLocator = ModalBrokerProviderCommand.parse({
        ...retained,
        execId: cancelId,
        supervision: {
          ...retained.supervision,
          invocationId: cancelId,
          launchRequestId: cancelLaunchId,
          launchEpoch: 2,
        },
        capture: {
          sequence: (await f.service().read()).output.lastSequence,
          receiptAckObserved: false,
        },
      });
      const cancellationCustody = await retainNativeFixture(f, cancelLocator, 2);
      const cancelDefinition = encodeNativeBrokerCommandDefinition({
        mode: "pipe",
        cwd: directory,
        argv: ["/bin/sh", "-c", "trap '' TERM; printf ready; while :; do sleep 1; done"],
        env: [["PATH", "/usr/bin:/bin"]],
        rows: 0,
        columns: 0,
      });
      const cancelSize = Buffer.alloc(4);
      cancelSize.writeUInt32BE(cancelDefinition.length);
      await request("prepare", cancelId, cancelSize);
      await request("definition", cancelId, cancelDefinition);
      await request("launch", cancelId, new Uint8Array(), 0, cancelLaunchId);
      const cancellation = new NativeBrokerRetainedCommand(
        cancelLocator,
        cancellationCustody.persistence,
        f.service(),
        driver,
      );
      await cancellation.release();
      await observeUntil(async () =>
        (await frames()).some((frame) => frame.commandId === cancelId && frame.kind === "stdout"),
      );
      await cancellation.capture(128);
      await cancellation.cancel("explicit_stop");
      expect(await cancellationCustody.persistence.cancellationRequested()).toBe(true);
      await observeUntil(async () => !(await f.service().read()).input.pending);
      let cancelledExit: number | null = null;
      for (let attempt = 0; attempt < 64; attempt++) {
        await observeUntil(async () => !(await f.service().read()).input.pending);
        const view = await new NativeBrokerRetainedCommand(
          cancelLocator,
          cancellationCustody.persistence,
          f.service(),
          driver,
        ).capture(128);
        cancelledExit = view.exitCode;
        if (cancelledExit !== null) break;
        await cancellation.status();
        const sequence = (await f.service().read()).output.lastSequence;
        await observeUntil(async () => (await f.service().read()).output.lastSequence > sequence);
      }
      expect(cancelledExit).toBe(137);
      expect((await cancellationCustody.settle(137)).settled).toBe(true);
    } finally {
      child.stdin.end();
      const stopped = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (stopped === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
      try {
        await reader;
        expect(await diagnostics).toBe("");
      } finally {
        await rm(directory, { recursive: true });
        clearTimeout(watchdog);
      }
    }
    expect(await child.exited).toBe(125);
  },
  60_000,
);
