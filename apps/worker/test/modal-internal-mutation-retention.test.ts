import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { RunContext, type MCPServer, type Tool } from "@openai/agents";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  testSettings,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  acquireLease,
  advanceWorkspaceGeneration,
  verifyWorkspaceMutationSettlement,
  SandboxWorkspaceMutationFencedError,
  SandboxWorkspaceMutationOutputRejectedError,
  type Database,
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
  markSessionAttemptQuiesced,
  getSession,
  getSessionTurn,
  peekSessionWork,
  reconcileCompletedSandboxSetup,
  advanceWorkspaceGenerationForRetainedProcess,
  verifyRetainedProcessMutationSettlement,
  type DbClient,
} from "@opengeni/db";
import {
  buildAgentCapabilities,
  buildOpenGeniAgent,
  buildManifest,
  isModalCommandStartOutcomeUnknownError,
  ProviderCommandStartOutcomeUnknownError,
  ProviderCommandInputOutcomeUnknownError,
  ProviderCommandObservationUnavailableError,
  RoutingMutationOutcomeUnknownError,
  RoutingMutationOutputRejectedError,
  withRoutingMutationOutputRejectionFence,
} from "@opengeni/runtime";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { createSandboxTurnRuntime } from "../src/activities/agent-turn/sandbox-runtime";
import { ChannelAPartialMutationError } from "@opengeni/runtime/sandbox";
import { wrapTurnBoxWithRouting, wrapLazyTurnBoxWithRouting } from "../src/sandbox-routing";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
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
  const workflowRunId = crypto.randomUUID();
  const dispatchId = `internal-${crypto.randomUUID()}`;
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId,
    attemptId,
    dispatchId,
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
    workflowRunId,
    dispatchId,
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

function routedInternalFixture(
  fixture: Awaited<ReturnType<typeof admittedInternalMutation>>,
  settings = testSettings({ modalCommandSupervisionEnabled: false }),
) {
  return wrapTurnBoxWithRouting(
    {
      db: client.db,
      settings,
      bus: new MemoryEventBus() as never,
      opJournal: { attachGeneration: () => "1", persistSettled: async () => undefined },
    },
    {
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      workspaceMutationFence: {
        accountId: fixture.accountId,
        turnId: fixture.claim.turn.id,
        executionGeneration: fixture.claim.turn.executionGeneration,
        attemptId: fixture.attemptId,
      },
      homeLease: {
        accountId: fixture.accountId,
        sandboxGroupId: fixture.session.sandboxGroupId,
        leaseEpoch: fixture.leaseEpoch,
        instanceId: fixture.instanceId,
        backend: "modal",
      },
    },
    fixture.sandbox.established as never,
  );
}

function sdkCapabilityFunction(session: unknown, name: string, cancellation: boolean) {
  const capability = buildAgentCapabilities(
    testSettings({ modalCommandSupervisionEnabled: false }),
    [],
    {
      structuredToolTransport: false,
      ...(cancellation ? { onToolCancellationFence: () => undefined } : {}),
    },
  ).find((entry) => entry.type === (name === "apply_patch" ? "filesystem" : "shell"))!;
  return capability
    .clone()
    .bind(session as never)
    .tools()
    .find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === name,
    )!;
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

test("SDK lazy setup preserves a committed physical outcome when its holder rejects output", async () => {
  const fixture = await admittedInternalMutation();
  const settings = testSettings({ modalCommandSupervisionEnabled: false });
  const manifest = buildManifest(settings, [], {});
  let setups = 0;
  let commands = 0;
  Object.assign(fixture.sandbox.established.session, {
    state: { manifest },
    exec: async () => {
      commands++;
      return { stdout: "/workspace", exitCode: 0 };
    },
  });
  const before = await shared.admin`
    select * from session_history_items
    where session_id = ${fixture.session.id} order by position`;
  const routed = wrapLazyTurnBoxWithRouting(
    {
      db: client.db,
      settings,
      bus: new MemoryEventBus() as never,
      opJournal: { attachGeneration: () => "1", persistSettled: async () => undefined },
    },
    { workspaceId: fixture.workspaceId, sessionId: fixture.session.id },
    {
      client: { backendId: "modal" },
      backendId: "modal",
      agentDefaultManifest: manifest,
      provisioner: {
        get: async () => {
          await fixture.runtime.runWorkspaceMutationForSandbox(
            fixture.sandbox as never,
            "lazyOwnedSandboxSetup",
            async () => {
              setups++;
              // A real mutable output fence changes after provider admission.
              // Physical settlement must still commit under the restricted role.
              await shared.admin`
                delete from sandbox_lease_holders
                where lease_id = (select lease_id from sandbox_workspace_mutation_admissions
                  where session_id = ${fixture.session.id})
                  and holder_id = ${fixture.holderId}`;
            },
          );
          return fixture.sandbox as never;
        },
      },
    },
  );
  const exec = buildAgentCapabilities(settings, [], {
    onToolCancellationFence: () => undefined,
  })
    .find((capability) => capability.type === "shell")!
    .clone()
    .bind(routed.session as never)
    .tools()
    .find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === "exec_command",
    )!;
  const error = await exec
    .invoke({} as never, JSON.stringify({ cmd: "pwd", login: false, yield_time_ms: 10_000 }))
    .catch((failure) => failure);
  const admissions = await shared.admin`
    select operation, provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where session_id = ${fixture.session.id}`;
  expect(admissions).toHaveLength(1);
  expect(admissions[0]).toMatchObject({
    operation: "lazyOwnedSandboxSetup",
    provider_outcome: "resolved",
  });
  expect(admissions[0]!.settled_at).toBeInstanceOf(Date);
  expect(setups).toBe(1);
  expect(commands).toBe(0);
  expect(
    await shared.admin`
    select * from session_history_items
    where session_id = ${fixture.session.id} order by position`,
  ).toEqual(before);
  expect(error).toBeInstanceOf(Error);
  expect(agentRunFailurePayload(error)).toMatchObject({
    code: "sandbox_mutation_output_rejected",
    retryable: false,
  });
}, 60_000);

test("ordinary routed provider output remains rejected after exact physical settlement", async () => {
  const fixture = await admittedInternalMutation();
  const settings = testSettings({ modalCommandSupervisionEnabled: false });
  let commands = 0;
  Object.assign(fixture.sandbox.established.session, {
    exec: async () => {
      commands++;
      await shared.admin`
        delete from sandbox_lease_holders
        where holder_id = ${fixture.holderId}`;
      return { stdout: "must not be returned", exitCode: 0 };
    },
  });
  const routed = wrapTurnBoxWithRouting(
    {
      db: client.db,
      settings,
      bus: new MemoryEventBus() as never,
      opJournal: { attachGeneration: () => "1", persistSettled: async () => undefined },
    },
    {
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      workspaceMutationFence: {
        accountId: fixture.accountId,
        turnId: fixture.claim.turn.id,
        executionGeneration: fixture.claim.turn.executionGeneration,
        attemptId: fixture.attemptId,
      },
      homeLease: {
        accountId: fixture.accountId,
        sandboxGroupId: fixture.session.sandboxGroupId,
        leaseEpoch: fixture.leaseEpoch,
        instanceId: fixture.instanceId,
        backend: "modal",
      },
    },
    fixture.sandbox.established as never,
  );
  const error = await (
    routed.session as never as {
      exec(args: { cmd: string }): Promise<unknown>;
    }
  )
    .exec({ cmd: "touch /workspace/once" })
    .catch((failure) => failure);
  expect(error).toBeInstanceOf(RoutingMutationOutputRejectedError);
  expect(error.cause).toBeInstanceOf(SandboxWorkspaceMutationOutputRejectedError);
  expect(error.reasonCode).toBe("holder_fenced");
  expect(commands).toBe(1);
  const [admission] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where session_id = ${fixture.session.id}`;
  expect(admission!.provider_outcome).toBe("resolved");
  expect(admission!.settled_at).toBeInstanceOf(Date);
}, 60_000);

test.each([false, true])(
  "SDK patch batches stop after exact output rejection (cancellation: %s)",
  async (cancellation) => {
    const fixture = await admittedInternalMutation();
    let patches = 0;
    Object.assign(fixture.sandbox.established.session, {
      createEditor: () => ({
        createFile: async () => {
          patches++;
          await shared.admin`delete from sandbox_lease_holders
            where holder_id = ${fixture.holderId}`;
          return { status: "completed", output: "created once" };
        },
      }),
    });
    const routed = routedInternalFixture(fixture);
    const patch = sdkCapabilityFunction(routed.session, "apply_patch", cancellation);
    const input = JSON.stringify({
      operations: [
        { type: "create_file", path: "first.txt", diff: "+first" },
        { type: "create_file", path: "second.txt", diff: "+second" },
      ],
    });
    const error = await patch.invoke({} as never, input).catch((failure) => failure);
    expect(error).toBeInstanceOf(RoutingMutationOutputRejectedError);
    expect(patches).toBe(1);
    const admissions = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where session_id = ${fixture.session.id}`;
    expect(admissions).toHaveLength(1);
    expect(admissions[0]!.provider_outcome).toBe("resolved");
    expect(admissions[0]!.settled_at).toBeInstanceOf(Date);
    // A fresh invocation does not supply a replacement holder or authority.
    await patch.invoke({} as never, input).catch(() => undefined);
    expect(patches).toBe(1);
  },
  60_000,
);

test.each(["unknown", "settled"] as const)(
  "SDK mixed patch batches preserve %s-first evidence without replay",
  async (first) => {
    const fixture = await admittedInternalMutation();
    let patches = 0;
    Object.assign(fixture.sandbox.established.session, {
      createEditor: () => ({
        createFile: async () => {
          patches++;
          if (first === "unknown" && patches === 1)
            throw new ChannelAPartialMutationError(
              "One provider item applied; its batch was partial",
            );
          await shared.admin`delete from sandbox_lease_holders
            where holder_id = ${fixture.holderId}`;
          return { status: "completed" };
        },
      }),
    });
    const patch = sdkCapabilityFunction(
      routedInternalFixture(fixture).session,
      "apply_patch",
      false,
    );
    const input = JSON.stringify({
      operations: [
        { type: "create_file", path: "first.txt", diff: "+first" },
        { type: "create_file", path: "second.txt", diff: "+second" },
        { type: "create_file", path: "third.txt", diff: "+third" },
      ],
    });
    const failure = await patch.invoke({} as never, input).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(patches).toBe(first === "unknown" ? 2 : 1);
    if (first === "unknown") {
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
      expect(failure.errors[1]).toBeInstanceOf(RoutingMutationOutputRejectedError);
      expect(agentRunFailurePayload(failure).code).not.toBe("sandbox_mutation_output_rejected");
      expect(agentRunFailurePayload(failure).retryable).toBe(false);
    } else {
      // Once rejection is known, the later uncertain provider item never runs.
      expect(failure).toBeInstanceOf(RoutingMutationOutputRejectedError);
    }
    const admissions = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where session_id = ${fixture.session.id}`;
    expect(admissions).toHaveLength(patches);
    for (const admission of admissions) {
      expect(admission.provider_outcome).toBe("resolved");
      expect(admission.settled_at).toBeInstanceOf(Date);
    }
  },
  60_000,
);

test.each(["start", "input", "observation"] as const)(
  "SDK caught typed provider %s uncertainty survives a later committed output rejection",
  async (boundary) => {
    const fixture = await admittedInternalMutation();
    const { error: start, command } = unknownCommand(fixture.instanceId);
    const unknown =
      boundary === "start"
        ? start
        : boundary === "input"
          ? new ProviderCommandInputOutcomeUnknownError(
              command,
              0,
              4,
              new Error("input unavailable"),
            )
          : new ProviderCommandObservationUnavailableError(
              command,
              new Error("observation unavailable"),
            );
    let patches = 0;
    Object.assign(fixture.sandbox.established.session, {
      createEditor: () => ({
        createFile: async () => {
          patches++;
          if (patches === 1) throw unknown;
          await shared.admin`delete from sandbox_lease_holders
            where holder_id = ${fixture.holderId}`;
          return { status: "completed" };
        },
      }),
    });
    const patch = sdkCapabilityFunction(
      routedInternalFixture(fixture).session,
      "apply_patch",
      false,
    );
    const failure = await patch
      .invoke(
        {} as never,
        JSON.stringify({
          operations: [
            { type: "create_file", path: "first.txt", diff: "+first" },
            { type: "create_file", path: "second.txt", diff: "+second" },
            { type: "create_file", path: "third.txt", diff: "+third" },
          ],
        }),
      )
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(unknown);
    expect(failure.errors[1]).toBeInstanceOf(RoutingMutationOutputRejectedError);
    expect(agentRunFailurePayload(failure).code).toBe(
      boundary === "start"
        ? "sandbox_command_start_outcome_unknown"
        : boundary === "input"
          ? undefined
          : "sandbox_command_observation_unavailable",
    );
    expect(agentRunFailurePayload(failure).retryable).toBe(false);
    expect(patches).toBe(2);
    const admissions = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where session_id = ${fixture.session.id}`;
    expect(admissions).toHaveLength(2);
    expect(admissions.filter((row) => row.provider_outcome === "resolved")).toHaveLength(1);
    if (boundary === "start") {
      // Missing Start acknowledgement keeps its original admission unresolved.
      const pending = admissions.filter((row) => row.provider_outcome === null);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.settled_at).toBeNull();
    } else {
      expect(admissions.filter((row) => row.provider_outcome === "rejected")).toHaveLength(1);
      for (const admission of admissions) expect(admission.settled_at).toBeInstanceOf(Date);
    }
  },
  60_000,
);

test("SDK unknown-only patch result preserves its existing rendered inspection advice", async () => {
  const fixture = await admittedInternalMutation();
  let patches = 0;
  Object.assign(fixture.sandbox.established.session, {
    createEditor: () => ({
      createFile: async () => {
        patches++;
        throw new ChannelAPartialMutationError("One provider item applied; its batch was partial");
      },
    }),
  });
  const patch = sdkCapabilityFunction(routedInternalFixture(fixture).session, "apply_patch", false);
  const result = await patch.invoke(
    {} as never,
    JSON.stringify({
      operations: [{ type: "create_file", path: "first.txt", diff: "+first" }],
    }),
  );
  expect(result).not.toBeInstanceOf(Error);
  expect(JSON.stringify(result)).toContain("not replayed");
  expect(patches).toBe(1);
}, 60_000);

test("SDK uncaught output rejection retains an earlier rendered uncertain item", async () => {
  const fixture = await admittedInternalMutation();
  let patches = 0;
  let commands = 0;
  Object.assign(fixture.sandbox.established.session, {
    createEditor: () => ({
      createFile: async () => {
        patches++;
        throw new ChannelAPartialMutationError(
          "An applied provider item belongs to a partial batch",
        );
      },
    }),
    execCommand: async () => {
      commands++;
      await shared.admin`delete from sandbox_lease_holders
        where holder_id = ${fixture.holderId}`;
      return "committed provider output";
    },
  });
  const routed = routedInternalFixture(fixture);
  const patch = sdkCapabilityFunction(routed.session, "apply_patch", false);
  const exec = sdkCapabilityFunction(routed.session, "exec_command", false);
  const failure = await withRoutingMutationOutputRejectionFence(async () => {
    await patch.invoke(
      {} as never,
      JSON.stringify({
        operations: [{ type: "create_file", path: "first.txt", diff: "+first" }],
      }),
    );
    await exec.invoke({} as never, JSON.stringify({ cmd: "touch /workspace/once", login: false }));
  }).catch((error) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(failure.errors[1]).toBeInstanceOf(RoutingMutationOutputRejectedError);
  expect(agentRunFailurePayload(failure).code).not.toBe("sandbox_mutation_output_rejected");
  expect(agentRunFailurePayload(failure).retryable).toBe(false);
  expect(patches).toBe(1);
  expect(commands).toBe(1);
}, 60_000);

test("SDK partial provider batch keeps uncertainty beside its exact rejected receipt", async () => {
  const fixture = await admittedInternalMutation();
  let patches = 0;
  Object.assign(fixture.sandbox.established.session, {
    createEditor: () => ({
      createFile: async () => {
        patches++;
        await shared.admin`delete from sandbox_lease_holders
          where holder_id = ${fixture.holderId}`;
        throw new ChannelAPartialMutationError("First provider item applied; second was rejected");
      },
    }),
  });
  const patch = sdkCapabilityFunction(routedInternalFixture(fixture).session, "apply_patch", true);
  const failure = await patch
    .invoke(
      {} as never,
      JSON.stringify({
        operations: [
          { type: "create_file", path: "first.txt", diff: "+first" },
          { type: "create_file", path: "second.txt", diff: "+second" },
        ],
      }),
    )
    .catch((error) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors[0]).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(failure.errors[1]).toBeInstanceOf(RoutingMutationOutputRejectedError);
  expect(failure.errors[0].cause).toBe(failure.errors[1]);
  expect(patches).toBe(1);
  const [admission] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where session_id = ${fixture.session.id}`;
  expect(admission!.provider_outcome).toBe("resolved");
  expect(admission!.settled_at).toBeInstanceOf(Date);
  expect(agentRunFailurePayload(failure).code).not.toBe("sandbox_mutation_output_rejected");
  expect(agentRunFailurePayload(failure).retryable).toBe(false);
}, 60_000);

test("nested SDK rejection fences remain local to concurrent invocations", async () => {
  const rejected = await admittedInternalMutation();
  const unrelated = await admittedInternalMutation();
  let rejectedPatches = 0;
  let unrelatedPatches = 0;
  Object.assign(rejected.sandbox.established.session, {
    createEditor: () => ({
      createFile: async () => {
        rejectedPatches++;
        await shared.admin`delete from sandbox_lease_holders
          where holder_id = ${rejected.holderId}`;
        return { status: "completed" };
      },
    }),
  });
  Object.assign(unrelated.sandbox.established.session, {
    createEditor: () => ({
      createFile: async () => {
        unrelatedPatches++;
        return { status: "completed" };
      },
    }),
  });
  const rejectedPatch = sdkCapabilityFunction(
    routedInternalFixture(rejected).session,
    "apply_patch",
    true,
  );
  const unrelatedPatch = sdkCapabilityFunction(
    routedInternalFixture(unrelated).session,
    "apply_patch",
    false,
  );
  const input = JSON.stringify({
    operations: [
      { type: "create_file", path: "first.txt", diff: "+first" },
      { type: "create_file", path: "second.txt", diff: "+second" },
    ],
  });
  const [failed, completed] = await Promise.allSettled([
    withRoutingMutationOutputRejectionFence(async () => {
      await withRoutingMutationOutputRejectionFence(async () => {
        await rejectedPatch.invoke({} as never, input).catch(() => undefined);
      });
      // A nested invocation cannot replace its inherited first rejection.
      await rejectedPatch.invoke({} as never, input).catch(() => undefined);
    }),
    unrelatedPatch.invoke({} as never, input),
  ]);
  expect(failed.status).toBe("rejected");
  if (failed.status === "rejected")
    expect(failed.reason).toBeInstanceOf(RoutingMutationOutputRejectedError);
  expect(completed.status).toBe("fulfilled");
  expect(rejectedPatches).toBe(1);
  expect(unrelatedPatches).toBe(2);
}, 60_000);

test.each([false, true])(
  "SDK stdin preserves exact physically settled input rejection (cancellation: %s)",
  async (cancellation) => {
    const fixture = await admittedInternalMutation();
    let writes = 0;
    Object.assign(fixture.sandbox.established.session, {
      supportsPty: () => true,
      execCommand: async () => "Process running with session ID 71\n\nOutput:\nstarted",
      writeStdin: async () => {
        writes++;
        await shared.admin`
          delete from sandbox_lease_holders where kind = 'process'
            and lease_id = (select id from sandbox_leases
              where sandbox_group_id = ${fixture.session.sandboxGroupId})`;
        return "Process running with session ID 71\n\nOutput:\ninput applied once";
      },
    });
    const routed = routedInternalFixture(fixture);
    await (
      routed.session as never as {
        execCommand(args: { cmd: string }): Promise<string>;
      }
    ).execCommand({ cmd: "cat" });
    const stdin = sdkCapabilityFunction(routed.session, "write_stdin", cancellation);
    const error = await stdin
      .invoke(
        {} as never,
        JSON.stringify({
          session_id: 71,
          chars: "once",
          yield_time_ms: 0,
        }),
      )
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(RoutingMutationOutputRejectedError);
    expect(writes).toBe(1);
    const [physical] = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where session_id = ${fixture.session.id} and actor_kind = 'process'`;
    expect(physical!.provider_outcome).toBe("resolved");
    expect(physical!.settled_at).toBeInstanceOf(Date);
  },
  60_000,
);

async function settleSessionRetainedProcessExited(
  fixture: Awaited<ReturnType<typeof admittedInternalMutation>>,
  exitCode: number,
) {
  const [row] = await shared.admin<{ id: string }[]>`
    select id from sandbox_retained_processes
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  const scope = {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    processId: row!.id,
  };
  const process = await getRetainedProcess(client.db, scope);
  // The control-worker reaper's exact-proof reconciliation of an adopted
  // background command, racing the owning turn's in-flight stdin poll.
  const settled = await settleRetainedProcess(client.db, {
    ...scope,
    expected: retainedProcessSettlementIdentity(process!),
    outcome: "exited",
    exitCode,
    reason: "provider_exit_banner",
    idleGraceMs: 0,
  });
  expect(settled.settled).toBe(true);
  return scope;
}

test("a stdin settlement fenced by a concurrent terminal reconciliation carries durable terminal truth", async () => {
  const fixture = await admittedInternalMutation();
  Object.assign(fixture.sandbox.established.session, {
    supportsPty: () => true,
    execCommand: async () => "Process running with session ID 72\n\nOutput:\nstarted",
  });
  const routed = routedInternalFixture(fixture);
  await (
    routed.session as never as {
      execCommand(args: { cmd: string }): Promise<string>;
    }
  ).execCommand({ cmd: "./script.sh" });
  const [row] = await shared.admin<{ id: string }[]>`
    select id from sandbox_retained_processes
    where workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
  const processScope = {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    processId: row!.id,
  };
  const admission = await advanceWorkspaceGenerationForRetainedProcess(client.db, {
    ...processScope,
    operation: "writeStdin",
  });
  await settleSessionRetainedProcessExited(fixture, 1);

  const rejected = await verifyRetainedProcessMutationSettlement(client.db, {
    ...processScope,
    admission,
    operation: "writeStdin",
    outcome: "resolved",
  }).catch((error) => error);
  expect(rejected).toBeInstanceOf(SandboxWorkspaceMutationOutputRejectedError);
  expect(rejected).toMatchObject({
    code: "process_fenced",
    retainedProcessTerminal: { state: "exited", exitCode: 1 },
  });
  expect(
    (rejected as SandboxWorkspaceMutationOutputRejectedError).matchesPhysicalSettlement({
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      admission,
      operation: "writeStdin",
      outcome: "resolved",
    }),
  ).toBe(true);
  const [physical] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${admission.id}`;
  expect(physical!.provider_outcome).toBe("resolved");
  expect(physical!.settled_at).toBeInstanceOf(Date);
  expect(await getRetainedProcess(client.db, processScope)).toMatchObject({
    state: "exited",
    exitCode: 1,
  });
}, 60_000);

test.each([false, true])(
  "SDK stdin racing a terminal reconciliation returns durable exit truth without replay (cancellation: %s)",
  async (cancellation) => {
    const fixture = await admittedInternalMutation();
    let writes = 0;
    let processScope: Awaited<ReturnType<typeof settleSessionRetainedProcessExited>> | null = null;
    Object.assign(fixture.sandbox.established.session, {
      supportsPty: () => true,
      execCommand: async () => "Process running with session ID 73\n\nOutput:\nstarted",
      writeStdin: async () => {
        writes++;
        // Admission passed while the row was active; the reaper settles the
        // exit before this provider call's output is verified.
        processScope = await settleSessionRetainedProcessExited(fixture, 1);
        return "Process exited with code 1\n\nOutput:\nrejected provider bytes";
      },
    });
    const routed = routedInternalFixture(fixture);
    await (
      routed.session as never as {
        execCommand(args: { cmd: string }): Promise<string>;
      }
    ).execCommand({ cmd: "./script.sh" });
    const stdin = sdkCapabilityFunction(routed.session, "write_stdin", cancellation);
    const output = await stdin.invoke(
      {} as never,
      JSON.stringify({ session_id: 73, chars: "", yield_time_ms: 0 }),
    );
    expect(String(output)).toContain("Process exited with code 1");
    expect(String(output)).not.toContain("rejected provider bytes");
    expect(writes).toBe(1);
    const [physical] = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where session_id = ${fixture.session.id} and actor_kind = 'process'`;
    expect(physical!.provider_outcome).toBe("resolved");
    expect(physical!.settled_at).toBeInstanceOf(Date);
    expect(
      (routed.session as never as { hasRetainedProcess(id: number): boolean }).hasRetainedProcess(
        73,
      ),
    ).toBe(false);
    expect(await getRetainedProcess(client.db, processScope!)).toMatchObject({
      state: "exited",
      exitCode: 1,
    });
  },
  60_000,
);

test("actual SDK MCP fallback preserves exact real-database output rejection", async () => {
  const fixture = await admittedInternalMutation();
  let mutations = 0;
  const server: MCPServer = {
    name: "physical-settlement",
    cacheToolsList: false,
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => [
      {
        name: "materialize",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    callTool: async () => {
      await fixture.runtime.runWorkspaceMutationForSandbox(
        fixture.sandbox as never,
        "connectorAttachmentMaterialization",
        async () => {
          mutations++;
          await shared.admin`delete from sandbox_lease_holders
            where holder_id = ${fixture.holderId}`;
        },
      );
      return { content: [] };
    },
  } as MCPServer;
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
    mcpServers: [server],
  });
  const tool = (await agent.getMcpTools(new RunContext()))[0]!;
  if (tool.type !== "function") throw new Error("Expected actual SDK MCP function tool");
  const error = await tool.invoke(new RunContext(), "{}").catch((failure) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(agentRunFailurePayload(error)).toMatchObject({
    code: "sandbox_mutation_output_rejected",
    retryable: false,
  });
  expect(mutations).toBe(1);
  const [physical] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where session_id = ${fixture.session.id}`;
  expect(physical!.provider_outcome).toBe("resolved");
  expect(physical!.settled_at).toBeInstanceOf(Date);
}, 60_000);

test.each(["mismatched_admission", "commit_rollback"] as const)(
  "internal setup remains unknown when its exact settlement has %s",
  async (boundary) => {
    const fixture = await admittedInternalMutation();
    const trigger = `test_settlement_${fixture.session.id.replaceAll("-", "")}`;
    if (boundary === "commit_rollback") {
      await shared.admin.unsafe(`
        create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if NEW.session_id = '${fixture.session.id}'::uuid then
            raise exception 'test deferred physical settlement rollback';
          end if;
          return NEW;
        end $$;
        create constraint trigger ${trigger}
        after update on sandbox_workspace_mutation_admissions
        deferrable initially deferred for each row execute function ${trigger}()`);
    }
    try {
      let setups = 0;
      const failure = await fixture.runtime
        .runWorkspaceMutationForSandbox(
          fixture.sandbox as never,
          "lazyOwnedSandboxSetup",
          async () => {
            setups++;
            if (boundary === "mismatched_admission") {
              await shared.admin`
              update sandbox_workspace_mutation_admissions set operation = 'otherOperation'
              where session_id = ${fixture.session.id}`;
            } else {
              await shared.admin`
              delete from sandbox_lease_holders where holder_id = ${fixture.holderId}`;
            }
          },
        )
        .catch((error) => error);
      expect(failure).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
      expect(failure).not.toBeInstanceOf(RoutingMutationOutputRejectedError);
      expect(failure.cause).not.toBeInstanceOf(SandboxWorkspaceMutationOutputRejectedError);
      expect(setups).toBe(1);
      const [physical] = await shared.admin`
        select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
        where session_id = ${fixture.session.id}`;
      expect(physical!.provider_outcome).toBeNull();
      expect(physical!.settled_at).toBeNull();
    } finally {
      if (boundary === "commit_rollback") {
        await shared.admin.unsafe(
          `drop trigger ${trigger} on sandbox_workspace_mutation_admissions;
           drop function ${trigger}()`,
        );
      }
    }
  },
  60_000,
);

test.each(["turnId", "executionGeneration"] as const)(
  "wrong immutable %s cannot claim an exact physical settlement",
  async (field) => {
    const fixture = await admittedInternalMutation();
    const scope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.claim.turn.id,
      executionGeneration: fixture.claim.turn.executionGeneration,
      attemptId: fixture.attemptId,
      holderId: fixture.holderId,
      sandboxGroupId: fixture.session.sandboxGroupId,
      expectedEpoch: fixture.leaseEpoch,
      expectedInstanceId: fixture.instanceId,
      operation: "lazyOwnedSandboxSetup",
    };
    const admission = await advanceWorkspaceGeneration(client.db, scope);
    const wrongIdentity =
      field === "turnId"
        ? { ...scope, turnId: crypto.randomUUID() }
        : { ...scope, executionGeneration: scope.executionGeneration + 1 };
    const error = await verifyWorkspaceMutationSettlement(client.db, {
      ...wrongIdentity,
      admission,
      outcome: "resolved",
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(SandboxWorkspaceMutationFencedError);
    expect(error).not.toBeInstanceOf(SandboxWorkspaceMutationOutputRejectedError);
    const [physical] = await shared.admin`
      select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
      where id = ${admission.id}`;
    expect(physical!.provider_outcome).toBeNull();
    expect(physical!.settled_at).toBeNull();
  },
  60_000,
);

test("a savepoint cannot mint physical certainty before its outer transaction commits", async () => {
  const fixture = await admittedInternalMutation();
  const scope = {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    turnId: fixture.claim.turn.id,
    executionGeneration: fixture.claim.turn.executionGeneration,
    attemptId: fixture.attemptId,
    holderId: fixture.holderId,
    sandboxGroupId: fixture.session.sandboxGroupId,
    expectedEpoch: fixture.leaseEpoch,
    expectedInstanceId: fixture.instanceId,
    operation: "lazyOwnedSandboxSetup",
  };
  const admission = await advanceWorkspaceGeneration(client.db, scope);
  await shared.admin`
    delete from sandbox_lease_holders where holder_id = ${fixture.holderId}`;
  let rejection: unknown;
  await client.db
    .transaction(async (tx) => {
      rejection = await verifyWorkspaceMutationSettlement(tx as unknown as Database, {
        ...scope,
        admission,
        outcome: "resolved",
      }).catch((error) => error);
      throw new Error("Rollback the caller-owned fixture transaction");
    })
    .catch(() => undefined);
  expect(rejection).toBeInstanceOf(SandboxWorkspaceMutationFencedError);
  expect(rejection).not.toBeInstanceOf(SandboxWorkspaceMutationOutputRejectedError);
  const [physical] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${admission.id}`;
  expect(physical!.provider_outcome).toBeNull();
  expect(physical!.settled_at).toBeNull();
}, 60_000);

test("a physically settled partial setup batch still forbids complete-batch replay", async () => {
  const fixture = await admittedInternalMutation();
  let setups = 0;
  const failure = await fixture.runtime
    .runWorkspaceMutationForSandbox(fixture.sandbox as never, "lazyOwnedSandboxSetup", async () => {
      setups++;
      await shared.admin`
        delete from sandbox_lease_holders where holder_id = ${fixture.holderId}`;
      throw new ChannelAPartialMutationError("First setup item applied; later item rejected");
    })
    .catch((error) => error);
  expect(failure).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
  expect(failure).not.toBeInstanceOf(RoutingMutationOutputRejectedError);
  expect(setups).toBe(1);
  const [physical] = await shared.admin`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where session_id = ${fixture.session.id}`;
  expect(physical!.provider_outcome).toBe("resolved");
  expect(physical!.settled_at).toBeInstanceOf(Date);
}, 60_000);

test.each([
  ["start", "exited"],
  ["start", "lost"],
  ["observation", "exited"],
  ["observation", "lost"],
] as const)(
  "the real retained %s writer parks its owning turn even after exact %s proof",
  async (boundary, terminal) => {
    const fixture = await admittedInternalMutation();
    const { error: startUnknown, command } = unknownCommand(fixture.instanceId);
    if (boundary === "observation") command.streams.stdout.byteOffset = 17;
    const original =
      boundary === "start"
        ? startUnknown
        : new ProviderCommandObservationUnavailableError(
            command,
            Object.assign(new Error("Read unavailable after Start acknowledgement"), { code: 14 }),
          );
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
    const firstProcessId = (failure as RoutingMutationOutcomeUnknownError).retainedProcess!.id;
    const childAdmission = await advanceWorkspaceGenerationForRetainedProcess(client.db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      processId: firstProcessId,
      operation: "writeStdin",
    });
    const secondUnknown = unknownCommand(fixture.instanceId);
    const secondFailure = await fixture.runtime
      .runWorkspaceMutationForSandbox(fixture.sandbox as never, "execCommand", async () => {
        throw secondUnknown.error;
      })
      .catch((error) => error);
    const secondScope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      processId: (secondFailure as RoutingMutationOutcomeUnknownError).retainedProcess!.id,
    };
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
    expect(
      await getSessionTurn(client.db, fixture.workspaceId, fixture.claim.turn.id),
    ).toMatchObject({
      status: "recovering",
      activeAttemptId: null,
      metadata: {
        sandboxSetupOutcomeUnknown: { turnId: fixture.claim.turn.id, attemptId: fixture.attemptId },
      },
    });
    const [retained] = await shared.admin`select provider_command from sandbox_retained_processes
    where id=${firstProcessId}`;
    expect(retained!.provider_command).toEqual(command);
    const [admission] =
      await shared.admin`select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where actor_kind='turn' and operation='eagerOwnedSandboxSetup'
      and workspace_id = ${fixture.workspaceId} and session_id = ${fixture.session.id}`;
    expect(admission).toMatchObject({ provider_outcome: "retained", settled_at: null });
    expect(
      await readWorkspaceArchiveCapturePreflight(client.db, {
        ...fixture.captureScope,
        liveness: "warm",
      }),
    ).toBeNull();
    // Physical quiescence does not falsely make the incomplete helper runnable.
    // Its real attempt receipt remains independently required by work peek.
    expect(
      (await peekSessionWork(client.db, fixture.workspaceId, fixture.session.id)).kind,
    ).not.toBe("runnable");
    const processScope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      processId: (failure as RoutingMutationOutcomeUnknownError).retainedProcess!.id,
    };
    const process = await getRetainedProcess(client.db, processScope);
    expect(process).not.toBeNull();
    const setupScope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      turnId: fixture.claim.turn.id,
      attemptId: fixture.attemptId,
    };
    expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
      reconciled: false,
      events: [],
    });
    if (terminal === "exited") {
      await settleRetainedProcess(client.db, {
        ...processScope,
        expected: retainedProcessSettlementIdentity(process!),
        outcome: "exited",
        exitCode: 0,
        reason: "provider_exit_banner",
        idleGraceMs: 0,
      });
    } else {
      expect(
        await markWarmLeaseInstanceLost(client.db, {
          ...fixture.captureScope,
          expectedBackend: "modal",
          diagnostic: "provider_instance_not_found",
        }),
      ).toMatchObject({ status: "marked" });
    }
    expect((await getRetainedProcess(client.db, processScope))!.state).toBe(terminal);
    await markSessionAttemptQuiesced(client.db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.session.id,
      attemptId: fixture.attemptId,
      temporalWorkflowId: `session-${fixture.session.id}`,
      temporalWorkflowRunId: fixture.workflowRunId,
      temporalActivityId: fixture.dispatchId,
    });
    expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
      reconciled: false,
      events: [],
    });
    const secondProcess = await getRetainedProcess(client.db, secondScope);
    if (terminal === "exited") {
      await settleRetainedProcess(client.db, {
        ...secondScope,
        expected: retainedProcessSettlementIdentity(secondProcess!),
        outcome: "exited",
        exitCode: 0,
        reason: "provider_exit_banner",
        idleGraceMs: 0,
      });
    }
    // Even with every invocation exited, a child admission can be last to settle.
    expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
      reconciled: false,
      events: [],
    });
    const [wakeBefore] =
      await shared.admin`select wake_revision from session_workflow_wake_outbox where session_id=${fixture.session.id}`;
    await verifyRetainedProcessMutationSettlement(client.db, {
      ...processScope,
      admission: childAdmission,
      operation: "writeStdin",
      outcome: "rejected",
    });
    const [wakeAfter] =
      await shared.admin`select wake_revision from session_workflow_wake_outbox where session_id=${fixture.session.id}`;
    if (terminal === "exited")
      expect(Number(wakeAfter!.wake_revision)).toBeGreaterThan(Number(wakeBefore!.wake_revision));
    expect(await peekSessionWork(client.db, fixture.workspaceId, fixture.session.id)).toMatchObject(
      {
        kind: "admission-blocked",
        reason: "sandbox_setup_outcome_unknown",
        ref: { turnId: fixture.claim.turn.id, attemptId: fixture.attemptId },
      },
    );
    expect(
      await claimSessionWorkForAttempt(client.db, fixture.workspaceId, {
        sessionId: fixture.session.id,
        workflowId: `session-${fixture.session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: `no-replay-${crypto.randomUUID()}`,
        trigger: { kind: "next" },
      }),
    ).toMatchObject({ action: "unclaimed", reason: "no-work" });
    expect(starts).toBe(1);
    const before = await getSessionTurn(client.db, fixture.workspaceId, fixture.claim.turn.id);
    expect(
      await reconcileCompletedSandboxSetup(client.db, {
        ...setupScope,
        attemptId: crypto.randomUUID(),
      }),
    ).toEqual({ reconciled: false, events: [] });
    if (terminal === "exited") {
      await shared.admin`update sessions set direct_control_state='paused', direct_pause_revision=1, control_version=1 where id=${fixture.session.id}`;
      expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
        reconciled: false,
        events: [],
      });
      await shared.admin`update sessions set direct_control_state='active', direct_pause_revision=null where id=${fixture.session.id}`;
      const exhausted = {
        version: 1,
        turnId: fixture.claim.turn.id,
        attemptId: fixture.attemptId,
        reason: "sandbox_command_start_recovery_exhausted",
        setupOutcome: "not_started",
        providerRecoveryCount: 5,
      };
      await shared.admin`update session_turns set metadata=metadata || ${shared.admin.json({ sandboxSetupRecoveryExhausted: exhausted })} where id=${fixture.claim.turn.id}`;
      expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
        reconciled: false,
        events: [],
      });
      await shared.admin`update session_turns set metadata=metadata - 'sandboxSetupRecoveryExhausted' where id=${fixture.claim.turn.id}`;
    }
    const reconciled = await reconcileCompletedSandboxSetup(client.db, setupScope);
    expect(reconciled.reconciled).toBe(terminal === "exited");
    expect(reconciled.events).toHaveLength(terminal === "exited" ? 1 : 0);
    if (terminal === "exited") {
      const after = await getSessionTurn(client.db, fixture.workspaceId, fixture.claim.turn.id);
      expect(after).toMatchObject({
        status: "recovering",
        id: before!.id,
        triggerEventId: before!.triggerEventId,
        executionGeneration: before!.executionGeneration,
      });
      expect(after!.metadata).toEqual(
        Object.fromEntries(
          Object.entries(before!.metadata ?? {}).filter(
            ([key]) => key !== "sandboxSetupOutcomeUnknown",
          ),
        ),
      );
      expect((await peekSessionWork(client.db, fixture.workspaceId, fixture.session.id)).kind).toBe(
        "runnable",
      );
      expect(await reconcileCompletedSandboxSetup(client.db, setupScope)).toEqual({
        reconciled: false,
        events: [],
      });
      const [wake] =
        await shared.admin`select reason from session_workflow_wake_outbox where session_id=${fixture.session.id}`;
      expect(wake!.reason).toBe("sandbox_setup_physically_settled");
    }
  },
);

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
