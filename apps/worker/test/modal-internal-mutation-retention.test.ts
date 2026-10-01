import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  acquireLease,
  claimSessionWorkForAttempt,
  claimWorkspaceArchiveCapture,
  commitWarmingToWarm,
  createDb,
  createSession,
  getRetainedProcess,
  initializeSessionStartAtomically,
  markWarmLeaseInstanceLost,
  readWorkspaceArchiveCapturePreflight,
  releaseLeaseHolder,
  retainedProcessSettlementIdentity,
  settleRetainedProcess,
  getSession,
  getSessionTurn,
  peekSessionWork,
  type DbClient,
} from "@opengeni/db";
import {
  isModalCommandStartOutcomeUnknownError,
  ProviderCommandStartOutcomeUnknownError,
  RoutingMutationOutcomeUnknownError,
} from "@opengeni/runtime";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { createSandboxTurnRuntime } from "../src/activities/agent-turn/sandbox-runtime";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

const { CommandStartOutcomeUnknownError } = createRequire(import.meta.resolve("@opengeni/runtime"))(
  "modal",
);

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("modal-internal-mutation-retention");
  if (!acquired) throw new Error("PostgreSQL required for internal unknown-Start regression");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function admittedInternalMutation() {
  const admin = shared.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('internal-modal-unknown') returning id`;
  const accountId = account!.id;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}, 'internal-modal-unknown') returning id`;
  const workspaceId = workspace!.id;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Set up the original sandbox once",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `internal-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Fixture claim failed: ${claim.action}`);
  const holderId = sandboxLeaseHolderIdForAttempt(attemptId);
  const acquired = await acquireLease(client.db, {
    accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
    kind: "turn",
    holderId,
    subjectId: session.id,
    backend: "modal",
    leaseTtlMs: 45_000,
  });
  const instanceId = "sb-internal-original";
  const committed = await commitWarmingToWarm(client.db, {
    accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
    expectedEpoch: acquired.lease.leaseEpoch,
    instanceId,
    resumeBackendId: "modal",
    resumeState: {
      backendId: "modal",
      sessionState: { providerState: { sandboxId: instanceId } },
    },
    leaseTtlMs: 45_000,
  });
  expect(committed.committed).toBe(true);
  const leaseEpoch = committed.lease!.leaseEpoch;
  const cancellation = new AbortController();
  const sandbox = {
    leaseEpoch,
    established: {
      backendId: "modal",
      instanceId,
      session: {
        modal: {
          profile: { serverUrl: "https://modal.test" },
          environmentName: (environment?: string) => environment ?? "",
          cpClient: {
            workspaceNameLookup: async () => ({ workspaceName: "internal-modal-test" }),
          },
        },
      },
    },
    release: async (options?: { workspaceWritersQuiesced?: boolean }) => {
      await releaseLeaseHolder(client.db, {
        accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
        kind: "turn",
        holderId,
        idleGraceMs: 0,
        ...options,
      });
    },
  };
  const runtime = createSandboxTurnRuntime({
    input: { accountId, workspaceId, sessionId: session.id, attemptId },
    settings: testSettings(),
    db: client.db,
    objectStorage: null,
    observability: {},
    cancellationSignal: cancellation.signal,
    activityContext: null,
    sandboxRotationController: new AbortController(),
    sandboxState: {
      sandboxGroupId: session.sandboxGroupId,
      sandboxHolderId: holderId,
      resolvedSandbox: sandbox,
    },
    eventing: { toolCancellationFenceRef: { current: null } },
    attempt: { turnId: claim.turn.id, executionGeneration: claim.turn.executionGeneration },
  } as never);
  return {
    accountId,
    workspaceId,
    session,
    attemptId,
    holderId,
    leaseEpoch,
    instanceId,
    claim,
    sandbox,
    runtime,
    cancellation,
    captureScope: {
      accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      expectedEpoch: leaseEpoch,
      expectedInstanceId: instanceId,
    },
  };
}

function unknownCommand(instanceId: string) {
  const execId = crypto.randomUUID();
  const sdkError = new CommandStartOutcomeUnknownError(
    "task-internal-original",
    execId,
    Object.assign(new Error("Start response unavailable after dispatch"), { code: 14 }),
  );
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: instanceId,
    taskId: "task-internal-original",
    execId,
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  // The runtime adapter's EXISTING producer contract carries the complete
  // command; the genuine SDK boundary remains its exact original cause.
  return {
    command,
    sdkError,
    error: new ProviderCommandStartOutcomeUnknownError(command, sdkError),
  };
}

test("the real retained SDK writer parks its owning turn without failure, setup replay or capture", async () => {
  const fixture = await admittedInternalMutation();
  const { error: original, command } = unknownCommand(fixture.instanceId);
  let starts = 0;
  const failure = await fixture.runtime
    .runWorkspaceMutationForSandbox(
      fixture.sandbox as never,
      "eagerOwnedSandboxSetup",
      async () => {
        starts++;
        throw original;
      },
    )
    .catch((error) => error);
  const context = createTurnContext({ settings: testSettings(), cancellationRequestedAt: null });
  Object.assign(context.attempt, {
    turnId: fixture.claim.turn.id,
    triggerEventId: fixture.claim.turn.triggerEventId,
    executionGeneration: fixture.claim.turn.executionGeneration,
    providerRecoveryCount: 5,
  });
  const result = await settleTurnFailure({
    ...context,
    error: failure,
    input: {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      attemptId: fixture.attemptId,
    },
    settings: testSettings(),
    db: client.db,
    bus: { publish: async () => undefined },
    observability: {},
    cancellationSignal: fixture.cancellation.signal,
    sandboxRotationController: new AbortController(),
    claimedResult: (value: object) => ({
      ...value,
      turnId: fixture.claim.turn.id,
      attemptId: fixture.attemptId,
    }),
    acknowledgeLostAttemptOwnership: () => undefined,
    acknowledgeRecoveryQuiescence: () => undefined,
  } as never);
  expect(result).toMatchObject({ status: "recovering", deferredUntilWake: true });
  expect(starts).toBe(1);
  expect(await getSession(client.db, fixture.workspaceId, fixture.session.id)).toMatchObject({
    status: "recovering",
  });
  expect(await getSessionTurn(client.db, fixture.workspaceId, fixture.claim.turn.id)).toMatchObject(
    {
      status: "recovering",
      activeAttemptId: null,
      metadata: {
        sandboxSetupOutcomeUnknown: { turnId: fixture.claim.turn.id, attemptId: fixture.attemptId },
      },
    },
  );
  const [retained] = await shared.admin`select provider_command from sandbox_retained_processes
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(retained!.provider_command).toEqual(command);
  const [admission] =
    await shared.admin`select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(admission).toMatchObject({ provider_outcome: "retained", settled_at: null });
  expect(
    await readWorkspaceArchiveCapturePreflight(client.db, {
      ...fixture.captureScope,
      liveness: "warm",
    }),
  ).toBeNull();
  // Physical quiescence does not falsely make the incomplete helper runnable.
  // Its real attempt receipt remains independently required by work peek.
  expect((await peekSessionWork(client.db, fixture.workspaceId, fixture.session.id)).kind).not.toBe(
    "runnable",
  );
});

test.each(["exited", "lost"] as const)(
  "internal SDK unknown retains its original writer until exact %s proof",
  async (terminal) => {
    const fixture = await admittedInternalMutation();
    const { error: original, command } = unknownCommand(fixture.instanceId);
    const execId = command.execId;
    let invocations = 0;
    const failure = await fixture.runtime
      .runWorkspaceMutationForSandbox(
        fixture.sandbox as never,
        "eagerOwnedSandboxSetup",
        async () => {
          invocations++;
          if (terminal === "lost") fixture.cancellation.abort(new Error("owner cancelled"));
          throw new Error("SDK setup failed", { cause: original });
        },
      )
      .catch((error) => error);
    expect(invocations).toBe(1);
    expect(isModalCommandStartOutcomeUnknownError(failure)).toBe(true);
    const [admission] = await shared.admin`
      select * from sandbox_workspace_mutation_admissions
      where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
    expect(admission).toMatchObject({ provider_outcome: "retained", settled_at: null });
    const [row] = await shared.admin`
      select id, provider_command from sandbox_retained_processes
      where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
    expect(row!.provider_command).toMatchObject({
      kind: "modal-router-v1",
      sandboxId: fixture.instanceId,
      taskId: "task-internal-original",
      execId,
      streams: {
        stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      },
    });
    const scope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      processId: row!.id as string,
    };
    const retained = await getRetainedProcess(client.db, scope);
    expect(retained).toMatchObject({
      state: "active",
      parentAdmissionId: admission!.id,
      providerSessionId: Number(admission!.workspace_generation),
      leaseEpoch: fixture.leaseEpoch,
      providerBackend: "modal",
      providerInstanceId: fixture.instanceId,
    });
    expect(retained!.providerBinding).toMatchObject({
      serverUrl: "https://modal.test",
      workspaceName: "internal-modal-test",
    });
    expect(
      await readWorkspaceArchiveCapturePreflight(client.db, {
        ...fixture.captureScope,
        liveness: "warm",
      }),
    ).toBeNull();
    expect(
      await claimWorkspaceArchiveCapture(client.db, {
        ...fixture.captureScope,
        liveness: "warm",
        captureId: crypto.randomUUID(),
        captureTimeoutMs: 60_000,
        minIntervalMs: 0,
        warmAttempt: {
          sessionId: fixture.session.id,
          turnId: fixture.claim.turn.id,
          attemptId: fixture.attemptId,
          holderId: fixture.holderId,
        },
      }),
    ).toMatchObject({ status: "holder_in_progress" });
    await releaseLeaseHolder(client.db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.session.sandboxGroupId,
      kind: "turn",
      holderId: fixture.holderId,
      idleGraceMs: 0,
      workspaceWritersQuiesced: true,
    });
    const [stillOpen] = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where id = ${admission!.id}`;
    expect(stillOpen).toMatchObject({ provider_outcome: "retained", settled_at: null });
    await expect(
      settleRetainedProcess(client.db, {
        ...scope,
        expected: {
          ...retainedProcessSettlementIdentity(retained!),
          providerSessionId: retained!.providerSessionId + 1,
        },
        outcome: "exited",
        exitCode: 7,
        reason: "provider_exit_banner",
        idleGraceMs: 0,
      }),
    ).rejects.toThrow("copied durable identity");
    if (terminal === "exited") {
      await settleRetainedProcess(client.db, {
        ...scope,
        expected: retainedProcessSettlementIdentity(retained!),
        outcome: "exited",
        exitCode: 7,
        reason: "provider_exit_banner",
        idleGraceMs: 0,
      });
      expect(
        await claimWorkspaceArchiveCapture(client.db, {
          ...fixture.captureScope,
          liveness: "draining",
          captureId: crypto.randomUUID(),
          captureTimeoutMs: 60_000,
          minIntervalMs: 0,
        }),
      ).toMatchObject({ status: "claimed" });
    } else {
      expect(
        await markWarmLeaseInstanceLost(client.db, {
          ...fixture.captureScope,
          expectedBackend: "modal",
          expectedInstanceId: "sb-unrelated",
          diagnostic: "provider_instance_not_found",
        }),
      ).toMatchObject({ status: "stale" });
      expect((await getRetainedProcess(client.db, scope))!.state).toBe("active");
      expect(
        await markWarmLeaseInstanceLost(client.db, {
          ...fixture.captureScope,
          expectedBackend: "modal",
          diagnostic: "provider_instance_not_found",
        }),
      ).toMatchObject({ status: "marked" });
    }
    expect(await getRetainedProcess(client.db, scope)).toMatchObject({ state: terminal });
    expect(invocations).toBe(1);
  },
  60_000,
);

test.each([
  "bare SDK",
  "wrong sandbox",
  "multiple",
  "binding failure",
  "promotion failure",
  "aggregate index getter",
  "descriptor getter",
  "nested cursor getter",
] as const)(
  "%s unknown cannot clear its admission through ordinary proof-bearing cleanup",
  async (failureKind) => {
    const fixture = await admittedInternalMutation();
    const first = unknownCommand(fixture.instanceId);
    let thrown: unknown = first.error;
    let getterReads = 0;
    if (failureKind === "bare SDK") thrown = first.sdkError;
    if (failureKind === "wrong sandbox") thrown = unknownCommand("sb-unrelated").error;
    if (failureKind === "multiple")
      thrown = new AggregateError([first.error, unknownCommand(fixture.instanceId).error]);
    if (failureKind === "aggregate index getter") {
      const errors: unknown[] = [];
      Object.defineProperty(errors, "0", {
        get: () => {
          getterReads++;
          return first.error;
        },
      });
      thrown = new AggregateError([]);
      Object.defineProperty(thrown, "errors", { value: errors });
    }
    if (failureKind === "descriptor getter" || failureKind === "nested cursor getter") {
      const target = failureKind === "descriptor getter" ? first.command : first.command.streams;
      const key = failureKind === "descriptor getter" ? "taskId" : "stdout";
      const value =
        failureKind === "descriptor getter" ? first.command.taskId : first.command.streams.stdout;
      Object.defineProperty(target, key, {
        get: () => {
          getterReads++;
          return value;
        },
      });
    }
    if (failureKind === "binding failure")
      fixture.sandbox.established.session.modal.cpClient.workspaceNameLookup = async () => {
        throw new Error("Authenticated provider namespace unavailable");
      };
    const failure = await fixture.runtime
      .runWorkspaceMutationForSandbox(
        fixture.sandbox as never,
        "eagerOwnedSandboxSetup",
        async () => {
          if (failureKind === "promotion failure") {
            // Simulate a real durable admission identity fence, not a mock DB
            // promise or forged process. Promotion must fail before locator/holder
            // publication, and cleanup must not mislabel the physical command.
            await shared.admin`update sandbox_workspace_mutation_admissions
            set operation = 'unrelatedOperation'
            where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
          }
          throw thrown;
        },
      )
      .catch((error) => error);
    expect(failure).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
    expect(getterReads).toBe(0);
    expect(isModalCommandStartOutcomeUnknownError(failure)).toBe(
      failureKind !== "aggregate index getter",
    );
    expect(failure.retainedProcess).toBeNull();
    await expect(fixture.sandbox.release({ workspaceWritersQuiesced: true })).rejects.toThrow(
      "still outcome-unknown",
    );
    const [admission] = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
    expect(admission).toMatchObject({ provider_outcome: null, settled_at: null });
    const [retained] = await shared.admin`
      select count(*)::integer as count from sandbox_retained_processes
      where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
    expect(retained!.count).toBe(0);
    expect(
      await readWorkspaceArchiveCapturePreflight(client.db, {
        ...fixture.captureScope,
        liveness: "draining",
      }),
    ).toBeNull();
    const capture = await claimWorkspaceArchiveCapture(client.db, {
      ...fixture.captureScope,
      liveness: "draining",
      captureId: crypto.randomUUID(),
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(capture.status).not.toBe("claimed");
  },
  60_000,
);

test("shared release closure cannot clear an in-flight writer before its original descriptor arrives", async () => {
  const fixture = await admittedInternalMutation();
  const reboundCopy = { ...fixture.sandbox };
  const original = unknownCommand(fixture.instanceId);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let invocations = 0;
  const pending = fixture.runtime
    .runWorkspaceMutationForSandbox(
      reboundCopy as never,
      "homeSandboxClientPreparation",
      async () => {
        invocations++;
        entered.resolve();
        await finish.promise;
        throw original.error;
      },
    )
    .catch((error) => error);
  await entered.promise;
  expect(reboundCopy.release).toBe(fixture.sandbox.release);
  await expect(fixture.sandbox.release({ workspaceWritersQuiesced: true })).rejects.toThrow(
    "still outcome-unknown",
  );
  const [inFlight] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(inFlight).toMatchObject({ provider_outcome: null, settled_at: null });
  fixture.cancellation.abort(new Error("owner cancelled after admission"));
  finish.resolve();
  const failure = await pending;
  expect(isModalCommandStartOutcomeUnknownError(failure)).toBe(true);
  expect(invocations).toBe(1);
  const [row] = await shared.admin`
    select id, provider_command from sandbox_retained_processes
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(row!.provider_command).toEqual(original.command);
  const retained = await getRetainedProcess(client.db, {
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    processId: row!.id as string,
  });
  expect(retained).toMatchObject({
    state: "active",
    ownerAttemptId: fixture.attemptId,
    ownerTurnId: fixture.claim.turn.id,
    ownerExecutionGeneration: fixture.claim.turn.executionGeneration,
    providerInstanceId: fixture.instanceId,
  });
  // The durable-but-output-fenced promotion is still a physical writer. The
  // dropped original turn holder is never recreated to authorize its output.
  const [holders] = await shared.admin`
    select count(*) filter (where kind = 'turn')::integer as turns,
      count(*) filter (where kind = 'process')::integer as processes
    from sandbox_lease_holders where lease_id = ${retained!.leaseId}`;
  expect(holders).toMatchObject({ turns: 0, processes: 1 });
  await fixture.sandbox.release({ workspaceWritersQuiesced: true });
  const [stillRetained] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(stillRetained).toMatchObject({ provider_outcome: "retained", settled_at: null });
  expect(
    await readWorkspaceArchiveCapturePreflight(client.db, {
      ...fixture.captureScope,
      liveness: "draining",
    }),
  ).toBeNull();
}, 60_000);

test("ordinary known provider rejection still settles and releases without an uncertainty guard", async () => {
  const fixture = await admittedInternalMutation();
  const known = new Error("SDK rejected before Start dispatch");
  await expect(
    fixture.runtime.runWorkspaceMutationForSandbox(
      fixture.sandbox as never,
      "eagerOwnedSandboxSetup",
      async () => {
        throw known;
      },
    ),
  ).rejects.toBe(known);
  await fixture.sandbox.release({ workspaceWritersQuiesced: true });
  const [settled] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  expect(settled!.provider_outcome).toBe("rejected");
  expect(settled!.settled_at).not.toBeNull();
}, 60_000);

test("internal retention regression uses the restricted application role and FORCE RLS", async () => {
  const app = postgres(shared.appUrl, { max: 1 });
  try {
    const [role] = await app`
      select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toMatchObject({ name: "opengeni_app", rolsuper: false, rolbypassrls: false });
    const posture = await app`
      select relname, relforcerowsecurity from pg_class
      where relname in ('sandbox_workspace_mutation_admissions', 'sandbox_retained_processes')`;
    expect(posture).toHaveLength(2);
    expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await app.end();
  }
});
