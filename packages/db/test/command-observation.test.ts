import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  settleRetainedProcess,
  type DbClient,
} from "../src";
import {
  observeSessionBackgroundCommandCompletion as observe,
  readSessionBackgroundCommandOutput as read,
} from "../src/session-background-commands";

let shared: SharedTestDatabase;
let client: DbClient;
let accountId: string;
let workspaceId: string;
let sessionId: string;
let sandboxGroupId: string;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-observation");
  if (!acquired) throw new Error("Command observation tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command observation",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command observation",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Command observation",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  sandboxGroupId = session.sandboxGroupId;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function connected() {
  const commandId = crypto.randomUUID(),
    enrollmentId = crypto.randomUUID();
  await shared.admin`insert into session_background_commands ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "connected_machine", state: "running", control_workspace_id: workspaceId, enrollment_id: enrollmentId, connection_instance_id: "launch", op_id: commandId })}`;
  return {
    accountId,
    workspaceId,
    sessionId,
    commandId,
    controlWorkspaceId: workspaceId,
    enrollmentId,
    connectionInstanceId: "launch",
    opId: commandId,
    outcome: "exited" as const,
    exitCode: 0,
    reason: "test_exit",
  };
}

test("migration enforces terminal-only observation and installs exact command paging index", async () => {
  const command = await connected();
  await expect(
    (async () =>
      await shared.admin`update session_background_commands set completion_observed_at=now() where id=${command.commandId}`)(),
  ).rejects.toThrow("session_background_commands_observation_check");
  const [index] =
    await shared.admin`select indexdef from pg_indexes where indexname=${"session_events_command_output_page_idx"}`;
  expect(index!.indexdef).toContain("commandId");
  expect(index!.indexdef).toContain("sequence");
  expect(index!.indexdef).toContain("sandbox.command.output.delta");
  const plan = await shared.admin.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return await tx`explain select sequence, payload from session_events where workspace_id=${workspaceId} and session_id=${sessionId} and type=${"sandbox.command.output.delta"} and payload ->> 'commandId' = ${command.commandId} and sequence >= 0 order by sequence limit 65`;
  });
  expect(JSON.stringify(plan)).toContain("session_events_command_output_page_idx");
});

test("concurrent finish and observation obey whichever terminal state was actually observed", async () => {
  for (let iteration = 0; iteration < 4; iteration++) {
    const command = await connected();
    const [, observed] = await Promise.all([
      settleConnectedMachineSessionBackgroundCommand(client.db, command),
      observe(client.db, command),
    ]);
    const [update] =
      await shared.admin`select state from session_system_updates where source_id=${command.commandId}`;
    expect(update!.state).toBe(observed?.completionObservedAt ? "superseded" : "pending");
    const terminal = await read(client.db, command);
    expect(terminal.terminal).toBe(true);
    expect(terminal.completionObservedAt).not.toBeNull();
  }
});

test("retention deletion of a partially read event produces an explicit gap", async () => {
  const command = await connected();
  const events = await appendSessionEvents(client.db, workspaceId, sessionId, [
    {
      type: "sandbox.command.output.delta",
      payload: { commandId: command.commandId, chunk: "abcdefghijk", stream: "stdout" },
    },
  ]);
  const first = await read(client.db, { ...command, maxOutputBytes: 4 });
  expect(first.hasMore).toBe(true);
  await shared.admin`delete from session_events where id=${events[0]!.id}`;
  const second = await read(client.db, { ...command, cursor: first.nextCursor });
  expect(second.retention.gaps).toContain("cursor_output_no_longer_retained");
  expect(second.retention.completeness).toBe("unknown");
});

test("running reads do not observe; terminal retained paging suppresses only pending completion", async () => {
  const command = await connected();
  expect((await observe(client.db, command))?.completionObservedAt).toBeNull();
  await appendSessionEvents(client.db, workspaceId, sessionId, [
    {
      type: "sandbox.command.output.delta",
      payload: { commandId: command.commandId, chunk: "hello 😀 world", stream: "stdout" },
    },
    {
      type: "sandbox.command.output.delta",
      payload: { commandId: crypto.randomUUID(), chunk: "must not leak", stream: "stderr" },
    },
  ]);
  const running = await read(client.db, { ...command, maxOutputBytes: 8 });
  expect(running).toMatchObject({ terminal: false, completionObservedAt: null, hasMore: true });
  expect(running.chunks.map((row) => row.chunk)).toEqual(["hello "]);
  await settleConnectedMachineSessionBackgroundCommand(client.db, command);
  const terminal = await read(client.db, { ...command, cursor: running.nextCursor });
  expect(terminal).toMatchObject({ terminal: true, state: "exited", exitCode: 0, hasMore: false });
  expect(terminal.chunks.map((row) => row.chunk)).toEqual(["😀 world"]);
  expect(terminal.completionObservedAt).not.toBeNull();
  const [update] =
    await shared.admin`select state from session_system_updates where source_id=${command.commandId}`;
  expect(update!.state).toBe("superseded");
  expect((await observe(client.db, command))?.completionObservedAt).toBe(
    terminal.completionObservedAt,
  );
});

test("command reads deny another session and account before observation", async () => {
  const command = await connected();
  await settleConnectedMachineSessionBackgroundCommand(client.db, command);
  await expect(read(client.db, { ...command, sessionId: crypto.randomUUID() })).rejects.toThrow(
    "not found",
  );
  await expect(read(client.db, { ...command, accountId: crypto.randomUUID() })).rejects.toThrow();
  const [row] =
    await shared.admin`select completion_observed_at from session_background_commands where id=${command.commandId}`;
  expect(row!.completion_observed_at).toBeNull();
});

test("already claimed notification and history remain byte-for-byte unchanged", async () => {
  const command = await connected();
  await settleConnectedMachineSessionBackgroundCommand(client.db, command);
  const historyId = crypto.randomUUID();
  await shared.admin`insert into session_history_items ${shared.admin({ id: historyId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, position: 900, item: shared.admin.json({ type: "message", role: "user", content: "claimed result" }) })}`;
  await shared.admin`update session_system_updates set state=${"delivered"},delivered_history_item_id=${historyId},delivered_at=now() where source_id=${command.commandId}`;
  const before =
    await shared.admin`select row_to_json(u) as value from session_system_updates u where source_id=${command.commandId}`;
  const history =
    await shared.admin`select row_to_json(h) as value from session_history_items h where id=${historyId}`;
  await observe(client.db, command);
  const after =
    await shared.admin`select row_to_json(u) as value from session_system_updates u where source_id=${command.commandId}`;
  const afterHistory =
    await shared.admin`select row_to_json(h) as value from session_history_items h where id=${historyId}`;
  expect(Array.from(after)).toEqual(Array.from(before));
  expect(Array.from(afterHistory)).toEqual(Array.from(history));
});

test("running read racing a blocked finish leaves the later completion pending", async () => {
  const command = await connected();
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = shared.admin.begin(async (tx) => {
    await tx`select id from sessions where id=${sessionId} for no key update`;
    locked();
    await gate;
  });
  await ready;
  const settlement = settleConnectedMachineSessionBackgroundCommand(client.db, command);
  try {
    expect((await read(client.db, command)).completionObservedAt).toBeNull();
  } finally {
    unlock();
    await holder;
  }
  await settlement;
  const [pending] =
    await shared.admin`select state from session_system_updates where source_id=${command.commandId}`;
  expect(pending!.state).toBe("pending");
  await observe(client.db, command);
  const [suppressed] =
    await shared.admin`select state from session_system_updates where source_id=${command.commandId}`;
  expect(suppressed!.state).toBe("superseded");
});

test("managed provider uses the same running and terminal loss read contract", async () => {
  const commandId = crypto.randomUUID(),
    leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  await shared.admin`insert into sandbox_leases ${shared.admin({ id: leaseId, account_id: accountId, workspace_id: workspaceId, sandbox_group_id: sandboxGroupId, backend: "local", expires_at: new Date(Date.now() + 60_000) })}`;
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({ account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, kind: "process", holder_id: `process:${commandId}`, subject_id: sessionId })}`;
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ id: admissionId, account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, session_id: sessionId, actor_kind: "direct", actor_id: actorId, holder_kind: "direct", holder_id: `direct:${actorId}`, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, workspace_generation: 1, operation: "terminalExec", provider_outcome: "retained" })}`;
  await shared.admin`insert into sandbox_retained_processes ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, parent_admission_id: admissionId, holder_id: `process:${commandId}`, owner_actor_kind: "direct", owner_actor_id: actorId, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, provider_session_id: 1 })}`;
  await shared.admin`insert into session_background_commands ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "managed", state: "running", retained_process_id: commandId })}`;
  const identity = { accountId, workspaceId, sessionId, commandId };
  expect((await read(client.db, identity)).terminal).toBe(false);
  await shared.admin`update session_background_commands set state=${"lost"},settlement_reason=${"process_gone"},settled_at=now() where id=${commandId}`;
  const result = await read(client.db, identity);
  expect(result).toMatchObject({
    state: "lost",
    exitCode: null,
    terminal: true,
    retention: { completeness: "unknown" },
  });
  expect(result.completionObservedAt).not.toBeNull();
  // Legacy/recovery terminal rows can precede the finished audit event. A
  // later settlement backfill must not recreate already observed input.
  await shared.admin.begin(async (tx) => {
    await tx`update sandbox_workspace_mutation_admissions set provider_outcome=${"resolved"},settled_at=now() where id=${admissionId}`;
    await tx`delete from sandbox_lease_holders where lease_id=${leaseId} and holder_id=${`process:${commandId}`}`;
    await tx`update sandbox_retained_processes set state=${"lost"},settlement_reason=${"process_gone"},settled_at=now() where id=${commandId}`;
  });
  const repaired = await settleRetainedProcess(client.db, {
    ...identity,
    processId: commandId,
    expected: {
      leaseId,
      sandboxGroupId,
      parentAdmissionId: admissionId,
      holderId: `process:${commandId}`,
      leaseEpoch: 0,
      providerBackend: "local",
      providerInstanceId: "test-instance",
      routeKind: "active",
      routeTargetId: null,
      routeEpoch: 0,
      providerSessionId: 1,
    },
    outcome: "lost",
    exitCode: null,
    reason: "process_gone",
    idleGraceMs: 0,
  });
  expect(repaired.backgroundCommandEvents.map((event) => event.type)).toEqual([
    "session.command.finished",
  ]);
  const updates =
    await shared.admin`select state from session_system_updates where source_id=${commandId}`;
  expect(updates).toHaveLength(0);
});
