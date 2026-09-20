import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getRetainedProcess,
  settleRetainedProcess,
  verifyRetainedProcessMutationSettlement,
  type DbClient,
} from "../src";
import {
  captureRetainedRouterOutput,
  getRetainedProviderCommand,
  retainedProviderCommandPersistence,
  requestRetainedProcessDeadlineCancellation,
  supervisedCommandProtocolReady,
  type SupervisionReceipt,
} from "../src/retained-provider-commands";
import { readSessionBackgroundCommandOutput } from "../src/session-background-commands";

let shared: SharedTestDatabase, client: DbClient;
let accountId: string, workspaceId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("supervised-command-settlement");
  if (!acquired) throw new Error("Supervised command fencing tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Supervision",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Supervision",
    subjectId: `test-${suffix}`,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(supervised = true) {
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Supervision",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const sessionId = session.id,
    sandboxGroupId = session.sandboxGroupId;
  const processId = crypto.randomUUID(),
    leaseId = crypto.randomUUID();
  const admissionId = crypto.randomUUID(),
    actorId = crypto.randomUUID();
  const supervision = {
    protocol: "native-subreaper-v1" as const,
    invocationId: crypto.randomUUID(),
    nonce: "a".repeat(64),
    controlPath: `/tmp/opengeni-supervision/${crypto.randomUUID()}.sock`,
  };
  const command: ModalRouterProviderCommand & { supervision?: typeof supervision } = {
    kind: "modal-router-v1",
    sandboxId: "sb-test",
    taskId: "task-test",
    execId: crypto.randomUUID(),
    ...(supervised ? { supervision } : {}),
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  await shared.admin`insert into sandbox_leases ${shared.admin({ id: leaseId, account_id: accountId, workspace_id: workspaceId, sandbox_group_id: sandboxGroupId, backend: "modal", instance_id: "sb-test", expires_at: new Date(Date.now() + 60_000) })}`;
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
    lease_epoch: 0,
    provider_backend: "modal",
    provider_instance_id: "sb-test",
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
    lease_epoch: 0,
    provider_backend: "modal",
    provider_instance_id: "sb-test",
    route_kind: "active",
    route_epoch: 0,
    provider_session_id: 1,
  };
  // Exercise the real promotion shape: INSERT first, attach locator in the
  // same transaction before releasing the supervisor's user-code launch.
  await shared.admin.begin(async (tx) => {
    await tx`insert into sandbox_retained_processes ${tx(process)}`;
    await tx`update sandbox_retained_processes set provider_command = ${tx.json(command)} where id = ${processId}`;
  });
  await shared.admin`insert into session_background_commands ${shared.admin({ id: processId, account_id: accountId, workspace_id: workspaceId, session_id: sessionId, provider: "managed", state: "running", retained_process_id: processId })}`;
  const scope = { accountId, workspaceId, sessionId, processId };
  const persistence = retainedProviderCommandPersistence(client.db, scope);
  const receipt: SupervisionReceipt = {
    protocol: supervision.protocol,
    invocationId: supervision.invocationId,
    receiptId: crypto.randomUUID(),
    leaderExitCode: 7,
  };
  const child = {
    ...admission,
    id: crypto.randomUUID(),
    actor_kind: "process",
    actor_id: processId,
    holder_kind: "process",
    holder_id: `process:${processId}`,
    workspace_generation: 2,
    operation: "terminalWrite",
  };
  const settle = async (reconciliationClaimId?: string) => {
    const expected = await getRetainedProcess(client.db, scope);
    if (!expected) throw new Error("Missing fixture process");
    return settleRetainedProcess(client.db, {
      ...scope,
      expected,
      ...(reconciliationClaimId ? { reconciliationClaimId } : {}),
      outcome: "exited",
      exitCode: receipt.leaderExitCode,
      reason: "provider_exit_banner",
      idleGraceMs: 1_000,
    });
  };
  return {
    scope,
    command,
    supervision,
    receipt,
    persistence,
    process,
    child,
    leaseId,
    admissionId,
    settle,
  };
}

function terminal(command: ModalRouterProviderCommand) {
  const next = structuredClone(command);
  for (const stream of [next.streams.stdout, next.streams.stderr]) {
    stream.eof = true;
    stream.exitCode = 0; // supervisor exit is distinct from shell leader exit 7
  }
  return next;
}

// postgres.js queries are lazy thenables, not started native promises.
async function rejects(query: PromiseLike<unknown>, message?: string) {
  await expect(Promise.resolve(query)).rejects.toThrow(message);
}

test("readiness requires all three active database gates", async () => {
  expect(await supervisedCommandProtocolReady(client.db)).toBe(true);
  await shared.admin`alter table sandbox_lease_holders disable trigger supervised_command_holder_guard`;
  try {
    expect(await supervisedCommandProtocolReady(client.db)).toBe(false);
  } finally {
    await shared.admin`alter table sandbox_lease_holders enable trigger supervised_command_holder_guard`;
  }
});

test("natural terminal observation cannot settle before immutable quiescence", async () => {
  const f = await fixture();
  const end = terminal(f.command);
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: end,
    stdout: "",
    stderr: "",
  });
  await expect(f.settle()).rejects.toThrow();
  await rejects(
    shared.admin`delete from sandbox_lease_holders where lease_id = ${f.leaseId}`,
    "holder",
  );
  expect(await f.persistence.loadSupervisionReceipt()).toBeNull();
  await f.persistence.recordSupervisionReceipt(f.receipt);
  expect(await f.persistence.loadSupervisionReceipt()).toEqual(f.receipt);
  expect((await f.settle()).settled).toBe(true);
  expect((await f.settle()).settled).toBe(false);
  const [count] =
    await shared.admin`select count(*)::int as n from sandbox_lease_holders where lease_id = ${f.leaseId}`;
  expect(count!.n).toBe(0);
  // Retention cleanup remains possible AFTER canonical proof-backed settlement.
  await shared.admin`delete from session_background_commands where id=${f.scope.processId}`;
  await shared.admin`delete from sandbox_retained_processes where id=${f.scope.processId}`;
});

test("old SQL writers cannot erase identity, proof, parent admission or holder", async () => {
  const f = await fixture();
  const statements = [
    () =>
      shared.admin`update sandbox_retained_processes set state='lost', settled_at=now(), settlement_reason='provider_instance_not_found' where id=${f.scope.processId}`,
    () =>
      shared.admin`update sandbox_retained_processes set provider_command=null where id=${f.scope.processId}`,
    () =>
      shared.admin`update sandbox_retained_processes set provider_command=provider_command - 'supervision' where id=${f.scope.processId}`,
    () =>
      shared.admin`update sandbox_retained_processes set provider_command=jsonb_set(provider_command,'{supervision,invocationId}',to_jsonb(${crypto.randomUUID()}::text)) where id=${f.scope.processId}`,
    () =>
      shared.admin`update sandbox_retained_processes set provider_command=${shared.admin.json(terminal(f.command))} where id=${f.scope.processId}`,
    () => shared.admin`delete from sandbox_retained_processes where id=${f.scope.processId}`,
    () =>
      shared.admin`update sandbox_workspace_mutation_admissions set provider_outcome='resolved', settled_at=now() where id=${f.admissionId}`,
    () => shared.admin`delete from sandbox_workspace_mutation_admissions where id=${f.admissionId}`,
    () => shared.admin`delete from sandbox_lease_holders where lease_id=${f.leaseId}`,
  ];
  for (const statement of statements) await rejects(statement());
  await f.persistence.recordSupervisionReceipt(f.receipt);
  await rejects(
    shared.admin`update sandbox_retained_processes set supervision_receipt=null where id=${f.scope.processId}`,
    "immutable",
  );
  await expect(
    f.persistence.recordSupervisionReceipt({ ...f.receipt, receiptId: crypto.randomUUID() }),
  ).rejects.toThrow();
  await expect(f.settle()).rejects.toThrow(); // proof alone is not provider EOF
});

test("cancellation is monotonic across claim expiry and fences stdin and adoption", async () => {
  const f = await fixture();
  await f.persistence.requestCancellation("provider_deadline");
  await shared.admin`update sandbox_retained_processes set reconcile_claim_id=${crypto.randomUUID()}, reconcile_claimed_at=now(), reconcile_after=now()-interval '1 second' where id=${f.scope.processId}`;
  await shared.admin`update sandbox_retained_processes set reconcile_claim_id=null, reconcile_claimed_at=null where id=${f.scope.processId}`;
  expect(await f.persistence.cancellationRequested()).toBe(true);
  await f.persistence.requestCancellation("explicit_stop");
  const [row] =
    await shared.admin`select cancellation_reason from sandbox_retained_processes where id=${f.scope.processId}`;
  expect(row!.cancellation_reason).toBe("provider_deadline");
  await expect(f.persistence.reserveInput(1)).rejects.toThrow("closed");
  await rejects(
    shared.admin`update sandbox_retained_processes set provider_command_input_index=1 where id=${f.scope.processId}`,
    "closed",
  );
  await rejects(
    shared.admin`update sandbox_retained_processes set cancellation_requested_at=null, cancellation_reason=null where id=${f.scope.processId}`,
    "monotonic",
  );
  await rejects(
    shared.admin`update sandbox_retained_processes set owner_actor_id=${crypto.randomUUID()} where id=${f.scope.processId}`,
    "adopted",
  );
  await rejects(
    shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin(f.child)}`,
    "closed",
  );
});

test("already admitted input must settle before proof, and new admissions stay closed", async () => {
  const f = await fixture();
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin(f.child)}`;
  expect(await f.persistence.reserveInput(5)).toBe(0);
  await f.persistence.requestCancellation("explicit_stop");
  await expect(f.persistence.recordSupervisionReceipt(f.receipt)).rejects.toThrow();
  // The public settlement API rejects stale output only after committing the
  // physical completion. Cancellation must never strand an admitted writer.
  await expect(
    verifyRetainedProcessMutationSettlement(client.db, {
      ...f.scope,
      admission: {
        id: f.child.id,
        sessionId: f.scope.sessionId,
        leaseId: f.leaseId,
        sandboxGroupId: f.process.sandbox_group_id,
        actorKind: "process",
        actorId: f.scope.processId,
        holderKind: "process",
        holderId: f.child.holder_id,
        leaseEpoch: 0,
        providerBackend: "modal",
        providerInstanceId: "sb-test",
        routeKind: "active",
        routeTargetId: null,
        routeEpoch: 0,
        workspaceGeneration: 2,
      },
      operation: f.child.operation,
      outcome: "resolved",
    }),
  ).rejects.toThrow("closed");
  await f.persistence.recordSupervisionReceipt(f.receipt);
  await rejects(
    shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin({ ...f.child, id: crypto.randomUUID() })}`,
    "closed",
  );
});

test("two reconcilers converge on one receipt and one settlement", async () => {
  const f = await fixture();
  await Promise.all([
    f.persistence.recordSupervisionReceipt(f.receipt),
    f.persistence.recordSupervisionReceipt(f.receipt),
  ]);
  const end = terminal(f.command);
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: end,
    stdout: "",
    stderr: "",
  });
  const results = await Promise.all([f.settle(), f.settle()]);
  expect(results.filter((result) => result.settled)).toHaveLength(1);
  expect(await f.persistence.loadSupervisionReceipt()).toEqual(f.receipt);
});

test("output persistence failure cannot unlock settlement", async () => {
  const f = await fixture();
  await f.persistence.recordSupervisionReceipt(f.receipt);
  const trigger = `reject_capture_${f.scope.processId.replaceAll("-", "")}`;
  await shared.admin.unsafe(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.scope.processId}'::uuid THEN RAISE EXCEPTION 'injected output failure'; END IF; RETURN NEW; END $$`,
  );
  await shared.admin.unsafe(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE OF provider_command ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  const end = terminal(f.command);
  end.streams.stdout.byteOffset = 4;
  try {
    await expect(
      captureRetainedRouterOutput(client.db, f.scope, {
        expected: f.command,
        command: end,
        stdout: "kept",
        stderr: "",
      }),
    ).rejects.toThrow();
    expect(await getRetainedProviderCommand(client.db, f.scope)).toEqual(f.command);
    const output = await readSessionBackgroundCommandOutput(client.db, {
      ...f.scope,
      commandId: f.scope.processId,
    });
    expect(output.chunks).toHaveLength(0);
    await expect(f.settle()).rejects.toThrow();
  } finally {
    await shared.admin.unsafe(`DROP TRIGGER ${trigger} ON sandbox_retained_processes`);
    await shared.admin.unsafe(`DROP FUNCTION ${trigger}()`);
  }
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: end,
    stdout: "kept",
    stderr: "",
  });
  expect((await f.settle()).settled).toBe(true);
});

test("deadline intent uses exact original lease and never completed-turn status", async () => {
  const f = await fixture();
  expect(await requestRetainedProcessDeadlineCancellation(client.db, f.scope)).toBe(false);
  await shared.admin`update sandbox_leases set rotation_requested_at=now(), rotation_reason='provider_deadline', lease_epoch=1 where id=${f.leaseId}`;
  expect(await requestRetainedProcessDeadlineCancellation(client.db, f.scope)).toBe(false);
  await shared.admin`update sandbox_leases set lease_epoch=0, instance_id='sb-successor' where id=${f.leaseId}`;
  expect(await requestRetainedProcessDeadlineCancellation(client.db, f.scope)).toBe(false);
  await shared.admin`update sandbox_leases set instance_id='sb-test' where id=${f.leaseId}`;
  expect(await requestRetainedProcessDeadlineCancellation(client.db, f.scope)).toBe(true);
  expect(await f.persistence.cancellationRequested()).toBe(true);
});

test("legacy processes cannot be retrofitted, even after another update in the transaction", async () => {
  const f = await fixture(false);
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`update sandbox_retained_processes set last_reconcile_outcome='probe' where id=${f.scope.processId}`;
      await tx`update sandbox_retained_processes set provider_command=jsonb_set(provider_command,'{supervision}',${tx.json(f.supervision)}) where id=${f.scope.processId}`;
    }),
  ).rejects.toThrow("initial retention");
  await expect(f.persistence.recordSupervisionReceipt(f.receipt)).rejects.toThrow("unavailable");
  expect(await f.persistence.reserveInput(3)).toBe(0);
});

test("cancellation wins queued stdin reservation and adoption under the same row lock", async () => {
  const f = await fixture();
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin(f.child)}`;
  const locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const cancelling = shared.admin.begin(async (tx) => {
    await tx`update sandbox_retained_processes set cancellation_requested_at=now(), cancellation_reason='explicit_stop' where id=${f.scope.processId}`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const outcomes = Promise.allSettled([
    f.persistence.reserveInput(1),
    Promise.resolve(
      shared.admin`update sandbox_retained_processes set owner_actor_id=${crypto.randomUUID()} where id=${f.scope.processId}`,
    ),
  ]);
  release.resolve();
  await cancelling;
  expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(await f.persistence.cancellationRequested()).toBe(true);
});

test("input admission winning the row lock prevents concurrent proof settlement", async () => {
  const f = await fixture();
  const locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const admitting = shared.admin.begin(async (tx) => {
    await tx`insert into sandbox_workspace_mutation_admissions ${tx(f.child)}`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const proof = Promise.allSettled([f.persistence.recordSupervisionReceipt(f.receipt)]);
  release.resolve();
  await admitting;
  expect((await proof)[0]!.status).toBe("rejected");
  expect(await f.persistence.loadSupervisionReceipt()).toBeNull();
  await rejects(
    shared.admin`delete from sandbox_workspace_mutation_admissions where id=${f.child.id}`,
    "immutable",
  );
  await shared.admin`update sandbox_workspace_mutation_admissions set provider_outcome='rejected', settled_at=now() where id=${f.child.id}`;
  await f.persistence.recordSupervisionReceipt(f.receipt);
});

test("quiescence winning the row lock closes concurrent input admission", async () => {
  const f = await fixture();
  const locked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const proving = shared.admin.begin(async (tx) => {
    await tx`update sandbox_retained_processes set supervision_receipt=${tx.json(f.receipt)} where id=${f.scope.processId}`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const admission = Promise.allSettled([
    Promise.resolve(
      shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin(f.child)}`,
    ),
  ]);
  release.resolve();
  await proving;
  expect((await admission)[0]!.status).toBe("rejected");
  await expect(f.persistence.reserveInput(1)).rejects.toThrow("closed");
});

test("supervised stdin cannot reserve bytes without durable child authority", async () => {
  const f = await fixture();
  await expect(f.persistence.reserveInput(1)).rejects.toThrow();
  await shared.admin`insert into sandbox_workspace_mutation_admissions ${shared.admin(f.child)}`;
  const offsets = await Promise.all([f.persistence.reserveInput(2), f.persistence.reserveInput(2)]);
  expect(offsets.sort((a, b) => a - b)).toEqual([0, 2]);
  await rejects(
    shared.admin`update sandbox_retained_processes set provider_command_input_index=0 where id=${f.scope.processId}`,
    "regress",
  );
});

test("delayed authenticated provider exit after EOF still requires atomic final capture", async () => {
  const f = await fixture();
  const eof = structuredClone(f.command);
  eof.streams.stdout.eof = true;
  eof.streams.stderr.eof = true;
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: eof,
    stdout: "",
    stderr: "",
  });
  await f.persistence.recordSupervisionReceipt(f.receipt);
  await expect(f.settle()).rejects.toThrow();
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: eof,
    command: terminal(eof),
    stdout: "",
    stderr: "",
  });
  expect((await f.settle()).settled).toBe(true);
});

test("proof is invocation-bound and stale reconciler claims remain fenced", async () => {
  const f = await fixture();
  await expect(
    f.persistence.recordSupervisionReceipt({ ...f.receipt, invocationId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(await f.persistence.loadSupervisionReceipt()).toBeNull();
  const claim = crypto.randomUUID();
  await shared.admin`update sandbox_retained_processes set reconcile_claim_id=${claim}, reconcile_claimed_at=now() where id=${f.scope.processId}`;
  await f.persistence.recordSupervisionReceipt(f.receipt);
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: terminal(f.command),
    stdout: "",
    stderr: "",
  });
  await expect(f.settle(crypto.randomUUID())).rejects.toThrow("claim");
  const results = await Promise.all([f.settle(claim), f.settle(claim)]);
  expect(results.filter((result) => result.settled)).toHaveLength(1);
});

test("nonzero supervisor exit remains readable but cannot settle even with quiescence receipt", async () => {
  const f = await fixture();
  await f.persistence.recordSupervisionReceipt(f.receipt);
  const failed = terminal(f.command);
  failed.streams.stdout.exitCode = 42;
  failed.streams.stderr.exitCode = 42;
  failed.streams.stdout.byteOffset = 5;
  await captureRetainedRouterOutput(client.db, f.scope, {
    expected: f.command,
    command: failed,
    stdout: "crash",
    stderr: "",
  });
  expect(await getRetainedProviderCommand(client.db, f.scope)).toEqual(failed);
  const output = await readSessionBackgroundCommandOutput(client.db, {
    ...f.scope,
    commandId: f.scope.processId,
  });
  expect(output.chunks.map((chunk) => chunk.chunk).join("")).toBe("crash");
  await expect(f.settle()).rejects.toThrow("requires");
  await rejects(
    shared.admin`update sandbox_retained_processes set state='exited', exit_code=7, settled_at=now(), settlement_reason='provider_exit_banner' where id=${f.scope.processId}`,
    "requires",
  );
});
