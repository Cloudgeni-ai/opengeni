import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  type DbClient,
} from "../src";
import {
  BACKGROUND_COMMAND_RESULT_OUTPUT_BYTES,
  claimPendingBackgroundCommandResults as claim,
  observeSessionBackgroundCommandCompletion as observe,
  readSessionBackgroundCommandOutput as read,
} from "../src/session-background-commands";
import { appendSessionCommandOutput } from "../src/session-command-output";

let shared: SharedTestDatabase;
let client: DbClient;
let accountId: string;
let workspaceId: string;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("command-completion-claim");
  if (!acquired) throw new Error("Command completion claim tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 12 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Command completion claim",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Command completion claim",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A fresh session, so pending results of other tests never mix in. */
async function session() {
  const created = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Command completion claim",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId, workspaceId, sessionId: created.id };
}

type SessionIdentity = Awaited<ReturnType<typeof session>>;

async function connected(owner: SessionIdentity, exitCode = 0) {
  const commandId = crypto.randomUUID(),
    enrollmentId = crypto.randomUUID();
  await shared.admin`insert into session_background_commands ${shared.admin({ id: commandId, account_id: owner.accountId, workspace_id: owner.workspaceId, session_id: owner.sessionId, provider: "connected_machine", state: "running", control_workspace_id: owner.workspaceId, enrollment_id: enrollmentId, connection_instance_id: "launch", op_id: commandId })}`;
  return {
    ...owner,
    commandId,
    controlWorkspaceId: owner.workspaceId,
    enrollmentId,
    connectionInstanceId: "launch",
    opId: commandId,
    outcome: "exited" as const,
    exitCode,
    reason: "test_exit",
  };
}

async function output(command: Awaited<ReturnType<typeof connected>>, chunk: string) {
  await appendSessionCommandOutput(client.db, {
    accountId: command.accountId,
    workspaceId: command.workspaceId,
    sessionId: command.sessionId,
    commandId: command.commandId,
    chunkId: crypto.randomUUID(),
    stream: "stdout",
    chunk,
  });
}

async function result(commandId: string) {
  const [row] = await shared.admin<{ state: string; payload: Record<string, unknown> }[]>`
    select state, payload from session_system_updates where source_id=${commandId}`;
  return row!;
}

const budget = { maxBytes: 16_384 };

test("the settled result carries the command's output, start and end, with the read marker", async () => {
  const owner = await session();
  const small = await connected(owner);
  await output(small, "first line\n");
  await output(small, "second line\n");
  await settleConnectedMachineSessionBackgroundCommand(client.db, small);
  expect((await result(small.commandId)).payload.output).toBe("first line\nsecond line\n");

  const silent = await connected(owner);
  await settleConnectedMachineSessionBackgroundCommand(client.db, silent);
  expect((await result(silent.commandId)).payload.output).toBe("");

  const large = await connected(owner, 2);
  for (let index = 0; index < 40; index++) {
    await output(large, `${String(index).padStart(2, "0")}:${"x".repeat(997)}\n`);
  }
  await settleConnectedMachineSessionBackgroundCommand(client.db, large);
  const text = (await result(large.commandId)).payload.output as string;
  expect(text.startsWith("00:")).toBe(true);
  expect(text.endsWith(`39:${"x".repeat(997)}\n`)).toBe(true);
  expect(text).toMatch(
    new RegExp(
      `\\[\\.\\.\\. about \\d+ bytes omitted; to read them, call command_read with cursor ${large.commandId}:\\d+:\\d+ \\.\\.\\.\\]`,
    ),
  );
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
    BACKGROUND_COMMAND_RESULT_OUTPUT_BYTES + 512,
  );
  // The settlement neither observed the command nor changed what a read returns.
  const page = await read(client.db, large);
  expect(page.terminal).toBe(true);
});

test("a claim takes pending results oldest first, observes them, and leaves nothing to deliver twice", async () => {
  const owner = await session();
  const first = await connected(owner);
  await output(first, "one\n");
  await settleConnectedMachineSessionBackgroundCommand(client.db, first);
  const second = await connected(owner, 3);
  await settleConnectedMachineSessionBackgroundCommand(client.db, second);
  const running = await connected(owner);

  const taken = await claim(client.db, { ...owner, ...budget });
  expect(taken.map((entry) => entry.commandId)).toEqual([first.commandId, second.commandId]);
  expect(taken[0]).toMatchObject({ state: "exited", exitCode: 0, output: "one\n" });
  expect(taken[0]!.summary).toContain("completed successfully");
  expect(taken[1]).toMatchObject({ state: "exited", exitCode: 3, output: "" });
  expect(taken[1]!.summary).toContain("exited with code 3");
  for (const command of [first, second]) {
    expect((await result(command.commandId)).state).toBe("superseded");
    const [row] = await shared.admin`
      select completion_observed_at from session_background_commands where id=${command.commandId}`;
    expect(row!.completion_observed_at).not.toBeNull();
  }
  expect(await claim(client.db, { ...owner, ...budget })).toEqual([]);
  // A later terminal read keeps the claim's observation; it supersedes nothing new.
  const observedAt = (await observe(client.db, first))?.completionObservedAt;
  expect((await read(client.db, first)).completionObservedAt).toBe(observedAt!);

  // A command still running has no result to take; its later result is taken once.
  await settleConnectedMachineSessionBackgroundCommand(client.db, running);
  expect((await claim(client.db, { ...owner, ...budget })).map((entry) => entry.commandId)).toEqual(
    [running.commandId],
  );
  expect(await claim(client.db, { ...owner, ...budget })).toEqual([]);
});

test("parallel claims and terminal reads deliver every result exactly once", async () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const owner = await session();
    const commands = [];
    for (let index = 0; index < 6; index++) commands.push(await connected(owner));
    // Settle and claim concurrently, with terminal reads of two commands mixed in.
    const settled = Promise.all(
      commands.map((command) => settleConnectedMachineSessionBackgroundCommand(client.db, command)),
    );
    const claims = Promise.all(
      Array.from({ length: 4 }, () => claim(client.db, { ...owner, ...budget })),
    );
    const reads = Promise.all([observe(client.db, commands[0]!), observe(client.db, commands[1]!)]);
    await settled;
    const [taken, observed] = await Promise.all([claims, reads]);
    const late = await claim(client.db, { ...owner, ...budget });
    const delivered = [...taken.flat(), ...late].map((entry) => entry.commandId);
    expect(new Set(delivered).size).toBe(delivered.length);
    for (const [index, command] of commands.entries()) {
      const row = await result(command.commandId);
      const readObserved = index < 2 && observed[index]?.completionObservedAt != null;
      if (delivered.includes(command.commandId)) {
        expect(row.state).toBe("superseded");
      } else if (readObserved) {
        // Observed by the read before or after settling: never pending.
        expect(row === undefined || row.state === "superseded").toBe(true);
      } else {
        throw new Error(`result for ${command.commandId} was neither taken nor observed`);
      }
    }
    const [pending] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from session_system_updates
      where session_id=${owner.sessionId} and state='pending'`;
    expect(pending!.count).toBe(0);
  }
});

test("a claim stays within its byte budget, always taking the first result", async () => {
  const owner = await session();
  const commands = [];
  for (let index = 0; index < 3; index++) {
    const command = await connected(owner);
    await output(command, `${index}`.repeat(3_000));
    await settleConnectedMachineSessionBackgroundCommand(client.db, command);
    commands.push(command);
  }
  const tiny = await claim(client.db, { ...owner, maxBytes: 10 });
  expect(tiny.map((entry) => entry.commandId)).toEqual([commands[0]!.commandId]);
  const two = await claim(client.db, { ...owner, maxBytes: 6_500 });
  expect(two.map((entry) => entry.commandId)).toEqual([
    commands[1]!.commandId,
    commands[2]!.commandId,
  ]);
  expect((await result(commands[2]!.commandId)).state).toBe("superseded");
});

test("a claim never takes another session's results or already delivered results", async () => {
  const owner = await session();
  const other = await session();
  const theirs = await connected(other);
  await settleConnectedMachineSessionBackgroundCommand(client.db, theirs);
  const delivered = await connected(owner);
  await settleConnectedMachineSessionBackgroundCommand(client.db, delivered);
  const historyId = crypto.randomUUID();
  await shared.admin`insert into session_history_items ${shared.admin({ id: historyId, account_id: owner.accountId, workspace_id: owner.workspaceId, session_id: owner.sessionId, position: 900, item: shared.admin.json({ type: "message", role: "user", content: "claimed result" }) })}`;
  await shared.admin`update session_system_updates set state='delivered',
    delivered_history_item_id=${historyId}, delivered_at=now()
    where source_id=${delivered.commandId}`;
  expect(await claim(client.db, { ...owner, ...budget })).toEqual([]);
  expect(await claim(client.db, { ...owner, accountId: crypto.randomUUID(), ...budget })).toEqual(
    [],
  );
  expect((await result(theirs.commandId)).state).toBe("pending");
  expect((await result(delivered.commandId)).state).toBe("delivered");
});

test("with nothing pending a claim does not wait for the session's writers", async () => {
  const owner = await session();
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = shared.admin.begin(async (tx) => {
    await tx`select id from sessions where id=${owner.sessionId} for no key update`;
    locked();
    await gate;
  });
  await ready;
  try {
    const taken = await Promise.race([
      claim(client.db, { ...owner, ...budget }),
      Bun.sleep(1_000).then(() => "blocked" as const),
    ]);
    expect(taken).toEqual([]);
  } finally {
    unlock();
    await holder;
  }
});
