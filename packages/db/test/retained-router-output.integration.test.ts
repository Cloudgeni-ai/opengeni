import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import {
  captureRetainedRouterOutput,
  getRetainedProviderCommand,
  reserveRetainedProviderInput,
} from "../src/retained-provider-commands";
import { readSessionBackgroundCommandOutput } from "../src/session-background-commands";

let shared: SharedTestDatabase, client: DbClient;
let accountId: string, workspaceId: string, sessionId: string, sandboxGroupId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("retained-router-output");
  if (!acquired) throw new Error("Atomic router output tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Router capture",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Router capture",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Router capture",
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

async function fixture() {
  const processId = crypto.randomUUID(),
    leaseId = crypto.randomUUID(),
    admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  const original: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sb-test",
    taskId: "task-test",
    execId: crypto.randomUUID(),
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  await shared.admin`insert into sandbox_leases ${shared.admin({ id: leaseId, account_id: accountId, workspace_id: workspaceId, sandbox_group_id: sandboxGroupId, backend: "modal", expires_at: new Date(Date.now() + 60_000) })}`;
  await shared.admin`insert into sandbox_lease_holders ${shared.admin({ account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, kind: "process", holder_id: `process:${processId}`, subject_id: sessionId })}`;
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ id: admissionId, account_id: accountId, workspace_id: workspaceId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, session_id: sessionId, actor_kind: "direct", actor_id: actorId, holder_kind: "direct", holder_id: `direct:${actorId}`, lease_epoch: 0, provider_backend: "modal", provider_instance_id: "sb-test", route_kind: "active", route_epoch: 0, workspace_generation: 1, operation: "terminalExec", provider_outcome: "retained" })}`;
  await shared.admin`insert into sandbox_retained_processes ${shared.admin({ id: processId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, lease_id: leaseId, sandbox_group_id: sandboxGroupId, parent_admission_id: admissionId, holder_id: `process:${processId}`, owner_actor_kind: "direct", owner_actor_id: actorId, lease_epoch: 0, provider_backend: "modal", provider_instance_id: "sb-test", route_kind: "active", route_epoch: 0, provider_session_id: 1, provider_command: shared.admin.json(original) })}`;
  await shared.admin`insert into session_background_commands ${shared.admin({ id: processId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "managed", state: "running", retained_process_id: processId })}`;
  return { scope: { accountId, workspaceId, sessionId, processId }, original };
}

test("concurrent overlapping pages commit one cursor and no duplicate bytes", async () => {
  const { scope, original } = await fixture();
  const full = "hello €\0world";
  const page = (text: string) => {
    const command = structuredClone(original);
    command.streams.stdout.byteOffset = Buffer.byteLength(text);
    return { expected: original, command, stdout: text, stderr: "" };
  };
  const results = await Promise.all([
    captureRetainedRouterOutput(client.db, scope, page("hello ")),
    captureRetainedRouterOutput(client.db, scope, page(full)),
  ]);
  expect(results.filter((result) => result.captured)).toHaveLength(1);
  const current = (await getRetainedProviderCommand(
    client.db,
    scope,
  )) as ModalRouterProviderCommand;
  const final = structuredClone(current);
  final.streams.stdout.byteOffset = Buffer.byteLength(full);
  await captureRetainedRouterOutput(client.db, scope, {
    expected: current,
    command: final,
    stdout: Buffer.from(full).subarray(current.streams.stdout.byteOffset).toString(),
    stderr: "",
  });
  const output = await readSessionBackgroundCommandOutput(client.db, {
    ...scope,
    commandId: scope.processId,
  });
  expect(output.chunks.map((chunk) => chunk.chunk).join("")).toBe(full);
  expect(output.terminal).toBe(false);
  expect((await captureRetainedRouterOutput(client.db, scope, page(full))).captured).toBe(false);
});

test("a failed cursor update rolls back every output event", async () => {
  const { scope, original } = await fixture();
  // The temporary trigger is confined to this isolated test schema and exact row.
  const functionName = `reject_router_${scope.processId.replaceAll("-", "")}`;
  await shared.admin.unsafe(
    `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${scope.processId}'::uuid THEN RAISE EXCEPTION 'injected cursor failure'; END IF; RETURN NEW; END $$`,
  );
  await shared.admin.unsafe(
    `CREATE TRIGGER ${functionName} BEFORE UPDATE OF provider_command ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  );
  const command = structuredClone(original);
  command.streams.stdout.byteOffset = 4;
  try {
    await expect(
      captureRetainedRouterOutput(client.db, scope, {
        expected: original,
        command,
        stdout: "kept",
        stderr: "",
      }),
    ).rejects.toThrow();
    expect(await getRetainedProviderCommand(client.db, scope)).toEqual(original);
    const output = await readSessionBackgroundCommandOutput(client.db, {
      ...scope,
      commandId: scope.processId,
    });
    expect(output.chunks).toHaveLength(0);
  } finally {
    await shared.admin.unsafe(`DROP TRIGGER ${functionName} ON sandbox_retained_processes`);
    await shared.admin.unsafe(`DROP FUNCTION ${functionName}()`);
  }
});

test("stdin byte reservations serialize and cross-session capture is rejected", async () => {
  const { scope, original } = await fixture();
  const offsets = await Promise.all([
    reserveRetainedProviderInput(client.db, scope, 3),
    reserveRetainedProviderInput(client.db, scope, 3),
  ]);
  expect(offsets.sort((a, b) => a - b)).toEqual([0, 3]);
  await expect(
    captureRetainedRouterOutput(
      client.db,
      { ...scope, sessionId: crypto.randomUUID() },
      { expected: original, command: original, stdout: "", stderr: "" },
    ),
  ).rejects.toThrow();
});
