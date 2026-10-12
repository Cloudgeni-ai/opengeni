import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { ModalBrokerProviderCommand } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getRetainedProcess,
  settleRetainedProcess,
  type DbClient,
} from "../src";
import {
  nativeBrokerTransportStore,
  registerNativeBrokerTransport,
  type NativeBrokerTransportBinding,
} from "../src/native-command-broker-transport";
import {
  captureRetainedBrokerOutput,
  getRetainedProviderCommand,
  retainedProviderCommandPersistence,
  validateBrokerOutputAdvance,
  supervisedCommandProtocolReady,
} from "../src/retained-provider-commands";
import { readSessionBackgroundCommandOutput } from "../src/session-background-commands";

let shared: SharedTestDatabase, client: DbClient;
let accountId: string, workspaceId: string;
const key = randomBytes(32);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("retained-broker-output");
  if (!acquired) throw new Error("Broker retention requires real isolated PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "Broker retention",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "Broker retention",
    subjectId: `test-${unique}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(pty = false, change?: (command: ModalBrokerProviderCommand) => void) {
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Broker retained custody fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const sessionId = session.id,
    sandboxGroupId = session.sandboxGroupId;
  const processId = crypto.randomUUID(),
    leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  const providerBinding = {
    version: 1,
    serverUrl: "https://api.modal.test",
    workspaceName: "fixture",
    environment: "test",
  };
  const binding: NativeBrokerTransportBinding = {
    version: 1,
    brokerId: crypto.randomUUID(),
    accountId,
    workspaceId,
    leaseId,
    sandboxGroupId,
    createOperationId: crypto.randomUUID(),
    createEpoch: 1,
    sandboxId: `sb-${processId}`,
    taskId: `ta-${processId}`,
    providerBindingKey: JSON.stringify(providerBinding),
    sourceSha: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    bootstrapEvidenceSha256: "c".repeat(64),
  };
  await shared.admin`insert into sandbox_leases ${shared.admin({
    id: leaseId,
    account_id: accountId,
    workspace_id: workspaceId,
    sandbox_group_id: sandboxGroupId,
    backend: "modal",
    instance_id: binding.sandboxId,
    liveness: "warming",
    lease_epoch: 1,
    expires_at: new Date(Date.now() + 60000),
    provider_create_attempt: shared.admin.json({
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
  // Fixture state/frames test SQL custody, not native bootstrap authentication.
  await registerNativeBrokerTransport(client.db, key, binding, { fixtureOnly: true });
  await nativeBrokerTransportStore(client.db, key, binding).transaction(async (tx) => {
    for (let sequence = 1; sequence <= 20; sequence++)
      await tx.insert({
        kind: "frame",
        key: String(sequence),
        sequence,
        value: `fixture frame ${sequence}`,
      });
  });
  const execId = crypto.randomUUID();
  const original = ModalBrokerProviderCommand.parse({
    kind: "modal-broker-v1",
    sandboxId: binding.sandboxId,
    taskId: binding.taskId,
    execId,
    pty,
    supervision: {
      protocol: pty
        ? "native-subreaper-broker-channel-pty-v1"
        : "native-subreaper-broker-channel-v1",
      invocationId: execId,
      brokerId: binding.brokerId,
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 4, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  });
  change?.(original);
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({ account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, kind: "process", holder_id: `process:${processId}`, subject_id: sessionId })}`;
  const admission = {
    account_id: accountId,
    workspace_id: workspaceId,
    lease_id: leaseId,
    sandbox_group_id: sandboxGroupId,
    session_id: sessionId,
    actor_kind: "direct",
    actor_id: actorId,
    holder_kind: "direct",
    holder_id: `direct:${actorId}`,
    lease_epoch: 1,
    provider_backend: "modal",
    provider_instance_id: binding.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    workspace_generation: 1,
    operation: "terminalExec",
  };
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ ...admission, id: admissionId, provider_outcome: "retained" })}`;
  const process = {
    id: processId,
    account_id: accountId,
    workspace_id: workspaceId,
    session_id: sessionId,
    lease_id: leaseId,
    sandbox_group_id: sandboxGroupId,
    parent_admission_id: admissionId,
    holder_id: `process:${processId}`,
    owner_actor_kind: "direct",
    owner_actor_id: actorId,
    lease_epoch: 1,
    provider_backend: "modal",
    provider_instance_id: binding.sandboxId,
    route_kind: "active",
    route_epoch: 0,
    provider_session_id: 1,
    provider_binding_key: binding.providerBindingKey,
    provider_binding: shared.admin.json(providerBinding),
  };
  await shared.admin.begin(async (tx) => {
    await tx`insert into sandbox_retained_processes ${tx(process)}`;
    await tx`update sandbox_retained_processes set provider_command=${tx.json(original)} where id=${processId}`;
  });
  await shared.admin`insert into session_background_commands ${shared.admin({
    id: processId,
    account_id: accountId,
    workspace_id: workspaceId,
    session_id: sessionId,
    provider: "managed",
    state: "running",
    retained_process_id: processId,
  })}`;
  const scope = { accountId, workspaceId, sessionId, processId };
  const receipt = {
    protocol: original.supervision.protocol,
    invocationId: execId,
    receiptId: crypto.randomUUID(),
    leaderExitCode: 7,
  };
  const persistence = retainedProviderCommandPersistence(client.db, scope);
  const settle = async () => {
    const expected = await getRetainedProcess(client.db, scope);
    if (!expected) throw new Error("Missing fixture process");
    return settleRetainedProcess(client.db, {
      ...scope,
      expected,
      outcome: "exited",
      exitCode: 7,
      reason: "provider_exit_banner",
      idleGraceMs: 1000,
    });
  };
  return { original, scope, receipt, persistence, settle, process, binding, leaseId, admission };
}

function output(original: ModalBrokerProviderCommand, text: string, terminal = false) {
  const command = structuredClone(original);
  command.capture.sequence++;
  command.streams.stdout.byteOffset += Buffer.byteLength(text);
  if (terminal) {
    command.capture.receiptAckObserved = true;
    for (const stream of Object.values(command.streams)) {
      stream.eof = true;
      stream.exitCode = 0;
      stream.utf8Remainder = "";
    }
  }
  return { expected: original, command, stdout: text, stderr: "" };
}
async function rejects(query: PromiseLike<unknown>, message?: string) {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (message) {
    const messages: string[] = [];
    for (
      let error = caught, count = 0;
      error instanceof Error && count < 8;
      error = error.cause, count++
    )
      messages.push(error.message);
    expect(messages.join("\n")).toContain(message);
  }
}

test("broker readiness requires the new retention definition, not old PTY fences", async () => {
  expect(
    await supervisedCommandProtocolReady(client.db, "native-subreaper-broker-channel-v1"),
  ).toBe(true);
  await shared.admin`comment on function opengeni_private.supervised_command_guard() is 'native-subreaper-pty-v1'`;
  try {
    expect(await supervisedCommandProtocolReady(client.db, "native-subreaper-pty-v1")).toBe(true);
    expect(
      await supervisedCommandProtocolReady(client.db, "native-subreaper-broker-channel-v1"),
    ).toBe(false);
    expect(
      await supervisedCommandProtocolReady(client.db, "native-subreaper-broker-channel-pty-v1"),
    ).toBe(false);
  } finally {
    await shared.admin`comment on function opengeni_private.supervised_command_guard() is 'native-command-broker-retention-v1'`;
  }
});

test("broker capture is exact-session scoped and cannot expose a foreign process", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    captureRetainedBrokerOutput(
      client.db,
      { ...f.scope, sessionId: other.scope.sessionId },
      output(f.original, "foreign"),
    ),
  ).rejects.toThrow("unavailable");
  expect(await getRetainedProviderCommand(client.db, f.scope)).toEqual(f.original);
});

test.each([false, true])(
  "broker %s keeps receipt, atomic output and terminal settlement separate",
  async (pty) => {
    const f = await fixture(pty);
    await expect(f.settle()).rejects.toThrow();
    const end = output(f.original, "hello", true);
    await expect(captureRetainedBrokerOutput(client.db, f.scope, end)).rejects.toThrow(
      "ACK cannot precede",
    );
    await f.persistence.recordSupervisionReceipt(f.receipt);
    await expect(f.settle()).rejects.toThrow();
    expect((await captureRetainedBrokerOutput(client.db, f.scope, end)).captured).toBe(true);
    expect((await f.settle()).settled).toBe(true);
    const read = await readSessionBackgroundCommandOutput(client.db, {
      ...f.scope,
      commandId: f.scope.processId,
    });
    expect(read.chunks.map((chunk) => chunk.chunk).join("")).toBe("hello");
    expect(read.terminal).toBe(true);
    expect(await f.persistence.loadSupervisionReceipt()).toEqual(f.receipt);
  },
);

test("concurrent frame projections capture one page; stale reader cannot duplicate output or settle", async () => {
  const f = await fixture();
  const results = await Promise.all(
    ["small", "longer"].map((text) =>
      captureRetainedBrokerOutput(client.db, f.scope, output(f.original, text)),
    ),
  );
  expect(results.filter((result) => result.captured)).toHaveLength(1);
  const winner = results.find((result) => result.captured)!;
  expect(await getRetainedProviderCommand(client.db, f.scope)).toEqual(winner.command);
  const read = await readSessionBackgroundCommandOutput(client.db, {
    ...f.scope,
    commandId: f.scope.processId,
  });
  expect(read.chunks).toHaveLength(1);
  expect(read.terminal).toBe(false);
  await expect(f.settle()).rejects.toThrow();
});

test("direct SQL cannot move broker capture or drop unsettled blockers", async () => {
  const f = await fixture();
  const page = output(f.original, "x");
  await rejects(
    shared.admin`update sandbox_retained_processes set provider_command=${shared.admin.json(page.command)} where id=${f.scope.processId}`,
    "atomic capture",
  );
  await rejects(
    shared.admin`delete from sandbox_retained_processes where id=${f.scope.processId}`,
    "Unsettled",
  );
  await rejects(shared.admin`delete from sandbox_lease_holders where lease_id=${f.leaseId}`);
  await rejects(
    shared.admin`update sandbox_retained_processes set provider_command=null where id=${f.scope.processId}`,
    "immutable",
  );
});

test.each(["brokerId", "launchRequestId", "launchEpoch"] as const)(
  "broker immutable %s cannot be rebound",
  async (field) => {
    const f = await fixture();
    const changed = structuredClone(f.original);
    if (field === "launchEpoch") changed.supervision[field]++;
    else changed.supervision[field] = crypto.randomUUID();
    await rejects(
      shared.admin`update sandbox_retained_processes set provider_command=${shared.admin.json(changed)} where id=${f.scope.processId}`,
      "immutable",
    );
  },
);

test("initial attachment refuses missing/foreign broker, physical mismatch and router protocol substitution", async () => {
  for (const [change, error] of [
    [
      (value: ModalBrokerProviderCommand) => {
        value.supervision.brokerId = crypto.randomUUID();
      },
      "exact registered physical scope",
    ],
    [
      (value: ModalBrokerProviderCommand) => {
        value.taskId = "ta-wrong";
      },
      "exact registered physical scope",
    ],
    [
      (value: ModalBrokerProviderCommand) => {
        value.sandboxId = "sb-wrong";
      },
      "exact registered physical scope",
    ],
    [
      (value: ModalBrokerProviderCommand) => {
        Object.assign(value.supervision, { protocol: "native-subreaper-v1" });
      },
      "Invalid broker command descriptor",
    ],
  ] as const)
    await expect(fixture(false, change)).rejects.toThrow(error);
});

test("one native command cannot create two retained ownership rows", async () => {
  const f = await fixture();
  const processId = crypto.randomUUID(),
    admissionId = crypto.randomUUID();
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ ...f.admission, id: admissionId, provider_outcome: "retained", workspace_generation: 2 })}`;
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({
    account_id: f.scope.accountId,
    workspace_id: f.scope.workspaceId,
    lease_id: f.leaseId,
    kind: "process",
    holder_id: `process:${processId}`,
    subject_id: f.scope.sessionId,
  })}`;
  await rejects(
    shared.admin`insert into sandbox_retained_processes ${shared.admin({
      ...f.process,
      id: processId,
      parent_admission_id: admissionId,
      holder_id: `process:${processId}`,
      provider_session_id: 2,
      provider_command: shared.admin.json(f.original),
    })}`,
    "native_broker_retained_command_identity",
  );
});

test("capture beyond committed frames rolls back events and locator together", async () => {
  const f = await fixture();
  const page = output(f.original, "never retained");
  page.command.capture.sequence = 21;
  await rejects(captureRetainedBrokerOutput(client.db, f.scope, page), "committed initial frames");
  expect(await getRetainedProviderCommand(client.db, f.scope)).toEqual(f.original);
  const read = await readSessionBackgroundCommandOutput(client.db, {
    ...f.scope,
    commandId: f.scope.processId,
  });
  expect(read.chunks).toHaveLength(0);
});

test("capture validates cursor/ACK monotonicity, identity and terminal immutability", async () => {
  const f = await fixture();
  for (const change of [
    (page: ReturnType<typeof output>) => {
      page.command.capture.sequence = f.original.capture.sequence;
    },
    (page: ReturnType<typeof output>) => {
      page.command.streams.stdout.byteOffset = 0;
    },
    (page: ReturnType<typeof output>) => {
      page.command.execId = crypto.randomUUID();
    },
    (page: ReturnType<typeof output>) => {
      page.command.capture.sequence = -1;
    },
  ]) {
    const page = output(f.original, "x");
    change(page);
    expect(() => validateBrokerOutputAdvance(page)).toThrow();
  }
  await f.persistence.recordSupervisionReceipt(f.receipt);
  const end = output(f.original, "", true);
  await captureRetainedBrokerOutput(client.db, f.scope, end);
  const changed = output(end.command, "");
  changed.command.capture.receiptAckObserved = false;
  expect(() => validateBrokerOutputAdvance(changed)).toThrow();
  await rejects(
    f.persistence.recordSupervisionReceipt({ ...f.receipt, receiptId: crypto.randomUUID() }),
    "immutable",
  );
  await expect(
    f.persistence.recordSupervisionReceipt({ ...f.receipt, protocol: "native-subreaper-v1" }),
  ).rejects.toThrow();
});
