import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  acquireLease,
  claimSessionWorkForAttempt,
  commitWarmingToWarm,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  peekSessionWork,
  reconcileSessionAttemptQuiescence,
  releaseLeaseHolder,
  requestSessionTurnRecovery,
  type DbClient,
} from "@opengeni/db";
import {
  createSandboxTurnRuntime,
  pendingMutationsCoveredByWriterDrain,
} from "../src/activities/agent-turn/sandbox-runtime";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";
import { createTurnToolCancellationController } from "../../../packages/runtime/src/sandbox/turn-tool-cancellation";

// A worker shutdown can interrupt a turn while its platform setup is still
// waiting on a sandbox agent that stopped answering. Finalization drains the
// attempt's command fence, then gives up joining the setup. The setup's
// workspace admission must still be settled by the proof-bearing release:
// left open, it keeps the attempt's writer pending forever, so neither the
// recovery nor any later turn of the chat is ever claimed.

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("setup-admission-writer-drain");
  if (!acquired) throw new Error("PostgreSQL required for setup admission writer-drain regression");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function setupInFlightFixture() {
  const admin = shared.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('setup-writer-drain') returning id`;
  const accountId = account!.id;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}, 'setup-writer-drain') returning id`;
  const workspaceId = workspace!.id;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Set up the sandbox",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "compute",
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
    dispatchId: `setup-drain-${crypto.randomUUID()}`,
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
    backend: "compute",
    leaseTtlMs: 45_000,
  });
  const instanceId = "sbx-setup-drain";
  const committed = await commitWarmingToWarm(client.db, {
    accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
    expectedEpoch: acquired.lease.leaseEpoch,
    instanceId,
    resumeBackendId: "compute",
    resumeState: { backendId: "compute", sessionState: { sandboxId: instanceId } },
    leaseTtlMs: 45_000,
  });
  expect(committed.committed).toBe(true);
  const sandbox = {
    leaseEpoch: committed.lease!.leaseEpoch,
    established: { backendId: "compute", instanceId, session: {} },
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
  const sandboxState = {
    sandboxGroupId: session.sandboxGroupId,
    sandboxHolderId: holderId,
    resolvedSandbox: sandbox,
    attemptWritersDrained: false,
    drainedCommandFence: null as ReturnType<typeof createTurnToolCancellationController> | null,
  };
  const fence = createTurnToolCancellationController();
  const runtime = createSandboxTurnRuntime({
    input: { accountId, workspaceId, sessionId: session.id, attemptId },
    settings: testSettings(),
    db: client.db,
    objectStorage: null,
    observability: {},
    cancellationSignal: new AbortController().signal,
    activityContext: null,
    sandboxRotationController: new AbortController(),
    sandboxState,
    eventing: { toolCancellationFenceRef: { current: fence } },
    attempt: { turnId: claim.turn.id, executionGeneration: claim.turn.executionGeneration },
  } as never);
  // The agent never answers this setup's next step.
  const agentAnswer = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let execCalls = 0;
  const agentSession = {
    exec: async () => {
      execCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const startSetup = (options: Parameters<typeof runtime.runWorkspaceMutationForSandbox>[4]) =>
    runtime
      .runWorkspaceMutationForSandbox(
        sandbox as never,
        "lazyOwnedSandboxSetup",
        async () => {
          entered.resolve();
          await agentAnswer.promise;
          // Setup writes only as commands through the attempt fence.
          await fence.runSandboxCommand(agentSession as never, { cmd: "seed token" });
        },
        undefined,
        options,
      )
      .catch((error: unknown) => error);
  return {
    accountId,
    workspaceId,
    session,
    attemptId,
    holderId,
    claim,
    sandbox,
    sandboxState,
    fence,
    startSetup,
    entered,
    agentAnswer,
    execCalls: () => execCalls,
  };
}

type Fixture = Awaited<ReturnType<typeof setupInFlightFixture>>;

async function admissionRow(fixture: Fixture) {
  const [row] = await shared.admin<
    { operation: string; provider_outcome: string | null; settled_at: Date | null }[]
  >`
    select operation, provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  return row!;
}

async function turnHolders(fixture: Fixture): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from sandbox_lease_holders
    where workspace_id = ${fixture.workspaceId} and holder_id = ${fixture.holderId}`;
  return row!.count;
}

/** Finalization of a worker-shutdown interruption: drain the fence, close the
 * attempt for recovery, then release with the writer-drain proof. */
async function interruptForWorkerShutdown(fixture: Fixture, drainedFence: unknown) {
  fixture.fence.cancel(new Error("WORKER_SHUTDOWN"));
  await fixture.fence.waitForQuiescence();
  fixture.sandboxState.drainedCommandFence = drainedFence as never;
  fixture.sandboxState.attemptWritersDrained = true;
  expect(
    await requestSessionTurnRecovery(client.db, fixture.workspaceId, {
      sessionId: fixture.session.id,
      turnId: fixture.claim.turn.id,
      triggerEventId: fixture.claim.turn.triggerEventId,
      attemptId: fixture.attemptId,
      reason: "worker_shutdown",
    }),
  ).toMatchObject({ action: "recovering" });
  return await fixture.sandbox.release({ workspaceWritersQuiesced: true }).then(
    () => null,
    (error: unknown) => error,
  );
}

async function reconcile(fixture: Fixture) {
  const [attempt] = await shared.admin<
    {
      temporal_workflow_id: string;
      temporal_workflow_run_id: string;
      temporal_activity_id: string;
    }[]
  >`
    select temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id
    from session_turn_attempts where id = ${fixture.attemptId}`;
  return await reconcileSessionAttemptQuiescence(client.db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    attemptId: fixture.attemptId,
    temporalWorkflowId: attempt!.temporal_workflow_id,
    temporalWorkflowRunId: attempt!.temporal_workflow_run_id,
    temporalActivityId: attempt!.temporal_activity_id,
    // The interrupted owner's Temporal activity has completed.
    activitySettled: true,
  });
}

test("a setup interrupted by worker shutdown is settled by the drain, so the chat recovers", async () => {
  const fixture = await setupInFlightFixture();
  const setup = fixture.startSetup({ commandFence: fixture.fence });
  await fixture.entered.promise;
  expect(await admissionRow(fixture)).toMatchObject({
    operation: "lazyOwnedSandboxSetup",
    provider_outcome: null,
    settled_at: null,
  });

  // The setup is still waiting on its agent when the worker exits.
  expect(await interruptForWorkerShutdown(fixture, fixture.fence)).toBeNull();
  const settled = await admissionRow(fixture);
  expect(settled.provider_outcome).toBe("rejected");
  expect(settled.settled_at).not.toBeNull();
  expect(await turnHolders(fixture)).toBe(0);

  // Before the fix this stayed "pending" forever (writer_pending).
  expect(await peekSessionWork(client.db, fixture.workspaceId, fixture.session.id)).toMatchObject({
    kind: "cancellation-wait",
    attemptId: fixture.attemptId,
  });
  expect(await reconcile(fixture)).toMatchObject({ action: "quiesced" });
  const next = await claimSessionWorkForAttempt(client.db, fixture.workspaceId, {
    sessionId: fixture.session.id,
    workflowId: `session-${fixture.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: `setup-drain-next-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  expect(next.action).toBe("claimed");
  if (next.action === "claimed") expect(next.turn.id).toBe(fixture.claim.turn.id);

  // If the agent answers late, the cancelled fence refuses the setup's write.
  fixture.agentAnswer.resolve();
  expect(await setup).toBeInstanceOf(Error);
  expect(fixture.execCalls()).toBe(0);
}, 180_000);

test.each([
  ["has no fence", "none"],
  ["used another fence", "other"],
  ["drained no fence", "undrained"],
] as const)(
  "a setup that %s keeps its admission fenced",
  async (_label, mode) => {
    const fixture = await setupInFlightFixture();
    const setup = fixture.startSetup(
      mode === "none"
        ? {}
        : mode === "other"
          ? { commandFence: createTurnToolCancellationController() }
          : { commandFence: fixture.fence },
    );
    await fixture.entered.promise;
    const failure = await interruptForWorkerShutdown(
      fixture,
      mode === "undrained" ? null : fixture.fence,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("still outcome-unknown");
    expect(await admissionRow(fixture)).toMatchObject({ provider_outcome: null, settled_at: null });
    expect(await reconcile(fixture)).toMatchObject({ action: "pending" });
    fixture.agentAnswer.resolve();
    await setup;
  },
  180_000,
);

test("writer-drain coverage needs the exact drained fence and no unknown outcome", () => {
  const drained = createTurnToolCancellationController();
  const other = createTurnToolCancellationController();
  const covered = { operation: "lazyOwnedSandboxSetup", commandFence: drained };
  expect(pendingMutationsCoveredByWriterDrain([covered], drained)).toBe(true);
  expect(pendingMutationsCoveredByWriterDrain([], drained)).toBe(true);
  expect(pendingMutationsCoveredByWriterDrain([covered], null)).toBe(false);
  expect(pendingMutationsCoveredByWriterDrain([covered], other)).toBe(false);
  expect(
    pendingMutationsCoveredByWriterDrain([covered, { operation: "skillCheckout" }], drained),
  ).toBe(false);
  expect(
    pendingMutationsCoveredByWriterDrain(
      [{ ...covered, cause: new Error("unknown start") }],
      drained,
    ),
  ).toBe(false);
});
