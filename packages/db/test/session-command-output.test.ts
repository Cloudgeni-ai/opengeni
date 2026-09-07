import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import { appendSessionCommandOutput } from "../src/session-command-output";
import { readSessionBackgroundCommandOutput } from "../src/session-background-commands";

let shared: SharedTestDatabase;
let client: DbClient;
let accountId: string, workspaceId: string, sessionId: string, sandboxGroupId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-command-output");
  if (!acquired) throw new Error("Command output tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Output capture",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Output capture",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Output capture",
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
  const commandId = crypto.randomUUID();
  await shared.admin`insert into session_background_commands ${shared.admin({
    id: commandId,
    account_id: accountId,
    workspace_id: workspaceId,
    session_id: sessionId,
    provider: "connected_machine",
    state: "running",
    control_workspace_id: workspaceId,
    enrollment_id: crypto.randomUUID(),
    connection_instance_id: "launch",
    op_id: commandId,
  })}`;
  return { accountId, workspaceId, sessionId, commandId };
}

test("captured frames are idempotent, pageable while running, and do not observe completion", async () => {
  const identity = await connected();
  const chunk = "prefix\0" + "🙂".repeat(20_000);
  const input = { ...identity, chunkId: "op-frame:1", stream: "stdout" as const, chunk };
  const receipts = await Promise.all([
    appendSessionCommandOutput(client.db, input),
    appendSessionCommandOutput(client.db, input),
  ]);
  expect(receipts.flat()).toHaveLength(3);
  expect(receipts.flat().every((event) => event.type === "sandbox.command.output.delta")).toBe(
    true,
  );
  let cursor: string | undefined;
  let recovered = "";
  do {
    const page = await readSessionBackgroundCommandOutput(client.db, {
      ...identity,
      ...(cursor ? { cursor } : {}),
      maxOutputBytes: 65536,
    });
    expect(page.terminal).toBe(false);
    expect(page.completionObservedAt).toBeNull();
    recovered += page.chunks.map((item) => item.chunk).join("");
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  expect(recovered).toBe(chunk);
  const [count] =
    await shared.admin`select count(*)::int as n from session_events where session_id=${sessionId} and type='sandbox.command.output.delta' and payload->>'commandId'=${identity.commandId}`;
  expect(count!.n).toBe(3);
});

test("unknown and cross-session command identities cannot publish output", async () => {
  const identity = await connected();
  await expect(
    appendSessionCommandOutput(client.db, {
      ...identity,
      commandId: crypto.randomUUID(),
      chunkId: "one",
      stream: "stdout",
      chunk: "no",
    }),
  ).rejects.toThrow("retained command identity");
  await expect(
    appendSessionCommandOutput(client.db, {
      ...identity,
      sessionId: crypto.randomUUID(),
      chunkId: "one",
      stream: "stdout",
      chunk: "no",
    }),
  ).rejects.toThrow();
});

test("managed initial output persists before background adoption", async () => {
  const commandId = crypto.randomUUID(),
    leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  await shared.admin`insert into sandbox_leases ${shared.admin({ id: leaseId, account_id: accountId, workspace_id: workspaceId, sandbox_group_id: sandboxGroupId, backend: "local", expires_at: new Date(Date.now() + 60_000) })}`;
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({ account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, kind: "process", holder_id: `process:${commandId}`, subject_id: sessionId })}`;
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ id: admissionId, account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, session_id: sessionId, actor_kind: "direct", actor_id: actorId, holder_kind: "direct", holder_id: `direct:${actorId}`, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, workspace_generation: 1, operation: "terminalExec", provider_outcome: "retained" })}`;
  await shared.admin`insert into sandbox_retained_processes ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, parent_admission_id: admissionId, holder_id: `process:${commandId}`, owner_actor_kind: "direct", owner_actor_id: actorId, lease_epoch: 0, provider_backend: "local", provider_instance_id: "test-instance", route_kind: "active", route_epoch: 0, provider_session_id: 1 })}`;
  await appendSessionCommandOutput(client.db, {
    accountId,
    workspaceId,
    sessionId,
    commandId,
    chunkId: "initial",
    stream: "stdout",
    chunk: "started\n",
  });
  await shared.admin`insert into session_background_commands ${shared.admin({ id: commandId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "managed", state: "running", retained_process_id: commandId })}`;
  const page = await readSessionBackgroundCommandOutput(client.db, {
    accountId,
    workspaceId,
    sessionId,
    commandId,
  });
  expect(page.chunks.map((item) => item.chunk).join("")).toBe("started\n");
  expect(page.completionObservedAt).toBeNull();
});
