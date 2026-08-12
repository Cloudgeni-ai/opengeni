import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  activateBrowserSession,
  activateComputerSession,
  bootstrapWorkspace,
  commitWarmingToWarm,
  completeComputerSessionEnd,
  ComputerSessionNotFoundError,
  ComputerSessionOperationConflictError,
  ComputerSessionStateError,
  createDb,
  createSession,
  dispatchBrowserSessionOperation,
  dispatchComputerSessionOperation,
  failComputerSessionOperation,
  findComputerSessionControlRecordByOperation,
  forceDrainOverLimitViewerOnlyBoxes,
  getBrowserSession,
  getComputerSession,
  getComputerSessionControlRecord,
  listComputerSessions,
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  prepareBrowserSessionCreate,
  prepareComputerSessionCreate,
  prepareComputerSessionEnd,
  reapStaleLeaseHolders,
  safeDatabaseErrorFacts,
  touchComputerSessionController,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("computer-sessions");
  if (!shared) {
    available = false;
    console.warn("[computer-sessions] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `computer-account-${suffix}`,
    accountName: "ComputerSession test",
    workspaceExternalSource: "test",
    workspaceExternalId: `computer-workspace-${suffix}`,
    workspaceName: "ComputerSession test",
    subjectId: `computer-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
}

function createInput(
  scope: Awaited<ReturnType<typeof fixture>>,
  operationId = crypto.randomUUID(),
) {
  return {
    ...scope,
    operationId,
    associatedSessionId: scope.sessionId,
    actorSubjectId: scope.subjectId,
    name: "Linux workspace",
    placement: { kind: "sandbox_group" as const, sandboxGroupId: scope.sandboxGroupId },
  };
}

const capabilities = {
  semanticObservation: true,
  appDiscovery: true,
  appLaunch: true,
  windowCapture: true,
  screenCapture: true,
  semanticActions: true,
  pointerInput: true,
  keyboardInput: true,
  clipboard: true,
  backgroundActions: true,
  parallelApps: true,
};

async function activeComputer(scope: Awaited<ReturnType<typeof fixture>>) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareComputerSessionCreate(client.db, createInput(scope, operationId));
  const controllerGeneration = crypto.randomUUID();
  const controller = {
    controllerId: "interaction-controller:test",
    controllerGeneration,
    placementInstanceId: "placement:test",
  };
  await dispatchComputerSessionOperation(client.db, {
    ...scope,
    operationId,
    computerSessionId: prepared.session.id,
    controllerGeneration,
    controller,
  });
  const active = await activateComputerSession(client.db, {
    ...scope,
    operationId,
    computerSessionId: prepared.session.id,
    controller,
    platform: "linux",
    adapter: "opengeni.atspi-x11.v1",
    seatId: "seat:test",
    displayId: ":97",
    capabilities,
  });
  return { ...active, controllerGeneration };
}

describe("durable ComputerSession lifecycle", () => {
  test("collapses concurrent create retries without inventing native placement facts", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const input = createInput(scope, operationId);
    const [first, second] = await Promise.all([
      prepareComputerSessionCreate(client.db, input),
      prepareComputerSessionCreate(client.db, input),
    ]);

    expect(first.session.id).toBe(second.session.id);
    expect(new Set([first.operation.replayed, second.operation.replayed])).toEqual(
      new Set([false, true]),
    );
    expect(first.session).toMatchObject({
      lifecycle: "starting",
      controller: null,
      platform: null,
      adapter: null,
      seatId: null,
      displayId: null,
      capabilities: null,
    });
    expect(
      (
        await findComputerSessionControlRecordByOperation(client.db, {
          ...scope,
          operationId,
        })
      )?.session.id,
    ).toBe(first.session.id);
    expect((await listComputerSessions(client.db, scope)).sessions).toHaveLength(1);

    await expect(
      prepareComputerSessionCreate(client.db, { ...input, name: "Different request" }),
    ).rejects.toBeInstanceOf(ComputerSessionOperationConflictError);
  });

  test("persists native activation under the exact controller fence", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const prepared = await prepareComputerSessionCreate(client.db, createInput(scope, operationId));
    expect(
      await getComputerSessionControlRecord(client.db, {
        ...scope,
        computerSessionId: prepared.session.id,
        operationId,
      }),
    ).toMatchObject({
      tokenGeneration: 1,
      sourceSessionId: scope.sessionId,
      createOperationId: operationId,
      operation: { kind: "create", state: "prepared", controllerGeneration: null },
    });

    const controllerGeneration = crypto.randomUUID();
    const controller = {
      controllerId: "interaction-controller:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    };
    expect(
      (
        await dispatchComputerSessionOperation(client.db, {
          ...scope,
          operationId,
          computerSessionId: prepared.session.id,
          controllerGeneration,
          controller,
        })
      ).state,
    ).toBe("dispatched");
    expect(
      (
        await getComputerSessionControlRecord(client.db, {
          ...scope,
          computerSessionId: prepared.session.id,
        })
      ).session,
    ).toMatchObject({ controller, platform: null });

    const activated = await activateComputerSession(client.db, {
      ...scope,
      operationId,
      computerSessionId: prepared.session.id,
      controller,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
      seatId: "seat:test",
      displayId: ":97",
      capabilities,
    });
    expect(activated.session).toMatchObject({
      lifecycle: "active",
      controller,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
      seatId: "seat:test",
      displayId: ":97",
      capabilities,
    });
    expect(activated.operation.state).toBe("completed");
    expect(
      (
        await activateComputerSession(client.db, {
          ...scope,
          operationId,
          computerSessionId: prepared.session.id,
          controller,
          platform: "linux",
          adapter: "opengeni.atspi-x11.v1",
          seatId: "seat:test",
          displayId: ":97",
          capabilities,
        })
      ).operation.replayed,
    ).toBe(true);

    await expect(
      dispatchComputerSessionOperation(client.db, {
        ...scope,
        operationId,
        computerSessionId: prepared.session.id,
        controllerGeneration: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ComputerSessionOperationConflictError);
  });

  test("settles definite and outcome-unknown create failures honestly", async () => {
    if (!available) return;
    const scope = await fixture();
    const definiteOperationId = crypto.randomUUID();
    const definite = await prepareComputerSessionCreate(
      client.db,
      createInput(scope, definiteOperationId),
    );
    const failed = await failComputerSessionOperation(client.db, {
      ...scope,
      operationId: definiteOperationId,
      computerSessionId: definite.session.id,
      error: { code: "driver_failed", message: "native helper exited", retryable: true },
    });
    expect(failed.session).toMatchObject({ lifecycle: "failed", failureCode: "driver_failed" });
    expect(failed.operation).toMatchObject({ state: "failed", error: { retryable: true } });
    expect(
      (
        await failComputerSessionOperation(client.db, {
          ...scope,
          operationId: definiteOperationId,
          computerSessionId: definite.session.id,
          error: { code: "timeout", message: "different retry", retryable: false },
        })
      ).operation,
    ).toMatchObject({
      replayed: true,
      error: { code: "driver_failed", message: "native helper exited" },
    });

    const uncertainOperationId = crypto.randomUUID();
    const uncertain = await prepareComputerSessionCreate(
      client.db,
      createInput(scope, uncertainOperationId),
    );
    const controller = {
      controllerId: "interaction-controller:test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "placement:uncertain",
    };
    await dispatchComputerSessionOperation(client.db, {
      ...scope,
      operationId: uncertainOperationId,
      computerSessionId: uncertain.session.id,
      controllerGeneration: controller.controllerGeneration,
      controller,
    });
    expect(
      (
        await failComputerSessionOperation(client.db, {
          ...scope,
          operationId: uncertainOperationId,
          computerSessionId: uncertain.session.id,
          state: "outcome_unknown",
          error: { code: "outcome_unknown", message: "reply lost", retryable: false },
        })
      ).session,
    ).toMatchObject({ lifecycle: "lost", controller });
  });

  test("serializes and replays end under the active controller generation", async () => {
    if (!available) return;
    const scope = await fixture();
    const active = await activeComputer(scope);
    const operationId = crypto.randomUUID();
    const ending = await prepareComputerSessionEnd(client.db, {
      ...scope,
      computerSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    expect(ending.session.lifecycle).toBe("ending");
    await expect(
      prepareComputerSessionEnd(client.db, {
        ...scope,
        computerSessionId: active.session.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionOperationConflictError);

    const ended = await completeComputerSessionEnd(client.db, {
      ...scope,
      computerSessionId: active.session.id,
      operationId,
      expectedControllerGeneration: active.controllerGeneration,
    });
    expect(ended.session).toMatchObject({
      lifecycle: "ended",
      controller: null,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
    });
    expect(ended.operation.state).toBe("completed");
    expect(
      (
        await completeComputerSessionEnd(client.db, {
          ...scope,
          computerSessionId: active.session.id,
          operationId,
          expectedControllerGeneration: active.controllerGeneration,
        })
      ).operation.replayed,
    ).toBe(true);
  });

  test("never resurrects a failed terminal end operation", async () => {
    if (!available) return;
    const scope = await fixture();
    const active = await activeComputer(scope);
    const operationId = crypto.randomUUID();
    await prepareComputerSessionEnd(client.db, {
      ...scope,
      computerSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    const failed = await failComputerSessionOperation(client.db, {
      ...scope,
      computerSessionId: active.session.id,
      operationId,
      error: { code: "driver_failed", message: "end rejected", retryable: false },
    });
    expect(failed).toMatchObject({
      session: { lifecycle: "failed" },
      operation: { state: "failed" },
    });

    await expect(
      completeComputerSessionEnd(client.db, {
        ...scope,
        computerSessionId: active.session.id,
        operationId,
        expectedControllerGeneration: null,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionStateError);
    expect(
      (
        await failComputerSessionOperation(client.db, {
          ...scope,
          computerSessionId: active.session.id,
          operationId,
          error: { code: "driver_failed", message: "replay", retryable: false },
        })
      ).operation,
    ).toMatchObject({ state: "failed", replayed: true });
  });

  test("enforces workspace isolation for public and controller reads", async () => {
    if (!available) return;
    const owner = await fixture();
    const outsider = await fixture();
    const computer = await prepareComputerSessionCreate(client.db, createInput(owner));
    expect((await listComputerSessions(client.db, outsider)).sessions).toHaveLength(0);
    await expect(
      getComputerSession(client.db, {
        ...outsider,
        computerSessionId: computer.session.id,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionNotFoundError);
    await expect(
      getComputerSessionControlRecord(client.db, {
        ...outsider,
        computerSessionId: computer.session.id,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionNotFoundError);
  });

  test("cascades a workspace through both resource and create-operation graphs", async () => {
    if (!available) return;
    const scope = await fixture();
    const computer = await prepareComputerSessionCreate(client.db, createInput(scope));
    const browser = await prepareBrowserSessionCreate(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      associatedSessionId: scope.sessionId,
      actorSubjectId: scope.subjectId,
      name: "Ephemeral browser",
      initialUrl: "https://example.com/",
      placement: { kind: "sandbox_group", sandboxGroupId: scope.sandboxGroupId },
      driverId: "opengeni.cdp.v1",
      engine: "chromium",
      headless: true,
      identityId: null,
      baseRevisionId: null,
      capabilities: MANAGED_BROWSER_SESSION_CAPABILITIES,
    });

    await shared!.admin`delete from workspaces where id = ${scope.workspaceId}`;
    const [remaining] = await shared!.admin<
      Array<{ computers: number; browsers: number; operations: number }>
    >`
      select
        (select count(*)::int from computer_sessions where id = ${computer.session.id}) as computers,
        (select count(*)::int from browser_sessions where id = ${browser.session.id}) as browsers,
        (select count(*)::int from interaction_operations where workspace_id = ${scope.workspaceId}) as operations`;
    expect(remaining).toEqual({ computers: 0, browsers: 0, operations: 0 });
  });

  test("rejects partial native bindings and cross-workspace associations", async () => {
    if (!available) return;
    const owner = await fixture();
    const outsider = await fixture();
    const computer = await prepareComputerSessionCreate(client.db, createInput(owner));
    const partialBindingError = await shared!.admin`
        update computer_sessions set adapter = 'partial'
        where id = ${computer.session.id}`.then(
      () => null,
      (error: unknown) => error,
    );
    expect(safeDatabaseErrorFacts(partialBindingError).constraint).toBe(
      "computer_sessions_native_binding_check",
    );
    const crossWorkspaceError = await shared!.admin`
        insert into computer_session_associations (
          account_id, workspace_id, computer_session_id, session_id,
          relationship, actor_subject_id
        ) values (
          ${owner.accountId}, ${owner.workspaceId}, ${computer.session.id},
          ${outsider.sessionId}, 'using', ${owner.subjectId}
        )`.then(
      () => null,
      (error: unknown) => error,
    );
    expect(safeDatabaseErrorFacts(crossWorkspaceError).constraint).toBe(
      "computer_session_associations_session_fk",
    );
  });

  test("reaps one stale ComputerSession without losing a live peer BrowserSession", async () => {
    if (!available) return;
    const scope = await fixture();
    const computerOperationId = crypto.randomUUID();
    const computer = await prepareComputerSessionCreate(
      client.db,
      createInput(scope, computerOperationId),
    );
    const computerHolderId = `computer-session:${computer.session.id}`;
    const acquired = await acquireLease(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sandboxGroupId: scope.sandboxGroupId,
      kind: "interaction",
      holderId: computerHolderId,
      subjectId: scope.sessionId,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    expect(
      (
        await commitWarmingToWarm(client.db, {
          ...scope,
          expectedEpoch: acquired.lease.leaseEpoch,
          instanceId: "placement:test",
          leaseTtlMs: 45_000,
        })
      ).committed,
    ).toBe(true);
    const computerGeneration = crypto.randomUUID();
    const controller = {
      controllerId: "interaction-controller:test",
      controllerGeneration: computerGeneration,
      placementInstanceId: "placement:test",
    };
    await dispatchComputerSessionOperation(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controllerGeneration: computerGeneration,
      controller,
    });
    await activateComputerSession(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controller,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
      seatId: "seat:test",
      displayId: ":97",
      capabilities,
    });

    const browserOperationId = crypto.randomUUID();
    const browser = await prepareBrowserSessionCreate(client.db, {
      ...scope,
      operationId: browserOperationId,
      associatedSessionId: scope.sessionId,
      actorSubjectId: scope.subjectId,
      name: "Peer browser",
      initialUrl: "https://example.com/",
      placement: { kind: "sandbox_group", sandboxGroupId: scope.sandboxGroupId },
      driverId: "opengeni.cdp.v1",
      engine: "chromium",
      headless: true,
      identityId: null,
      baseRevisionId: null,
      capabilities: MANAGED_BROWSER_SESSION_CAPABILITIES,
    });
    const browserHolderId = `browser-session:${browser.session.id}`;
    expect(
      (
        await acquireLease(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sandboxGroupId: scope.sandboxGroupId,
          kind: "interaction",
          holderId: browserHolderId,
          subjectId: scope.sessionId,
          backend: "modal",
          leaseTtlMs: 45_000,
        })
      ).role,
    ).toBe("attached");
    const browserGeneration = crypto.randomUUID();
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: browserOperationId,
      browserSessionId: browser.session.id,
      controllerGeneration: browserGeneration,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId: browserOperationId,
      browserSessionId: browser.session.id,
      controller: {
        controllerId: "interaction-controller:test",
        controllerGeneration: browserGeneration,
        placementInstanceId: "placement:test",
      },
      engineVersion: "151.0.7922.108",
    });

    expect(
      await touchComputerSessionController(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        controllerGeneration: computerGeneration,
      }),
    ).toBe(true);
    expect(
      await touchComputerSessionController(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        controllerGeneration: crypto.randomUUID(),
      }),
    ).toBe(false);
    await shared!.admin`
      update sandbox_lease_holders
      set last_heartbeat_at = case
        when holder_id = ${computerHolderId} then now() - interval '10 minutes'
        else now()
      end
      where workspace_id = ${scope.workspaceId} and kind = 'interaction'`;

    const reaped = await reapStaleLeaseHolders(client.db, {
      workspaceId: scope.workspaceId,
      viewerHolderTtlMs: 90_000,
      interactionHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reaped.reapedInteractions).toBe(1);
    expect(
      await getComputerSession(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
      }),
    ).toMatchObject({
      lifecycle: "lost",
      controller: null,
      failureCode: "controller_heartbeat_expired",
    });
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: browser.session.id }),
    ).toMatchObject({ lifecycle: "active", failureCode: null });
  }, 60_000);

  test("makes ComputerSession loss durable before force-draining its placement", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const computer = await prepareComputerSessionCreate(client.db, createInput(scope, operationId));
    const acquired = await acquireLease(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sandboxGroupId: scope.sandboxGroupId,
      kind: "interaction",
      holderId: `computer-session:${computer.session.id}`,
      subjectId: scope.sessionId,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    await commitWarmingToWarm(client.db, {
      ...scope,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "placement:force-drain",
      leaseTtlMs: 45_000,
    });
    const controller = {
      controllerId: "interaction-controller:test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "placement:force-drain",
    };
    await dispatchComputerSessionOperation(client.db, {
      ...scope,
      operationId,
      computerSessionId: computer.session.id,
      controllerGeneration: controller.controllerGeneration,
      controller,
    });
    await activateComputerSession(client.db, {
      ...scope,
      operationId,
      computerSessionId: computer.session.id,
      controller,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
      seatId: "seat:force-drain",
      displayId: ":98",
      capabilities,
    });

    const drained = await forceDrainOverLimitViewerOnlyBoxes(client.db, {
      workspaceId: scope.workspaceId,
      balanceMicros: 0,
      enforceBalance: true,
      maxWarmSecondsPerWorkspace: 0,
      idleGraceMs: 0,
    });
    expect(drained).toMatchObject({ overLimit: true, reason: "balance" });
    expect(drained.drained).toHaveLength(1);
    expect(
      await getComputerSession(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
      }),
    ).toMatchObject({
      lifecycle: "lost",
      controller: null,
      failureCode: "workspace_force_drained",
    });
  });
});
