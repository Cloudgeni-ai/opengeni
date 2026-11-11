import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  activateBrowserSession,
  acceptSessionApprovalDecision,
  applySessionTurnSettlement,
  bindBrowserSessionNetworkRouteAuthority,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  claimSiteAuthMaintenance,
  confirmSiteAuthMaintenanceSessionInTransaction,
  createDb,
  createInteractionIntervention,
  createNetworkRoute,
  createSession,
  createSiteAuthConnection,
  completeExternalAuth,
  dispatchBrowserSessionOperation,
  dispatchExternalAuth,
  expireSessionInteractionIntervention,
  findBrowserSessionControlRecordByOperation,
  getAuthRun,
  getExternalAuthInteractiveContext,
  getInteractionIntervention,
  getInteractionInterventionResumeForEvent,
  getSession,
  getExternalAuthPreparation,
  initializeSessionStartAtomically,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
  listInteractionInterventions,
  listNetworkRoutes,
  listSiteAuthConnections,
  peekSessionWork,
  prepareExternalAuth,
  prepareBrowserSessionCreate,
  reportAuthRun,
  resolveInteractionIntervention,
  startAuthRun,
  submitHumanPromptInTransaction,
  updateNetworkRoute,
  updateSiteAuthConnection,
  verifyAuthRun,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-auth");
  if (!shared) {
    available = false;
    console.warn("[browser-auth] postgres unavailable, skipping");
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
    accountExternalId: `browser-auth-account-${suffix}`,
    accountName: "Browser auth test",
    workspaceExternalSource: "test",
    workspaceExternalId: `browser-auth-workspace-${suffix}`,
    workspaceName: "Browser auth test",
    subjectId: `user:browser-auth-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: grant.subjectId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
}

async function insertPersonalConnectionFixture(input: {
  scope: Awaited<ReturnType<typeof fixture>>;
  connectionId: string;
  providerDomain: string;
  credentialEncrypted: string;
  version?: number;
}) {
  const { scope } = input;
  await shared!.admin.begin(async (tx) => {
    await tx`
      select
        set_config('opengeni.account_id', ${scope.accountId}, true),
        set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
        set_config('opengeni.subject_id', ${scope.actorSubjectId}, true)
    `;
    await tx`
      insert into connections (
        id, account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, status, version, created_by_subject_id, updated_by_subject_id
      ) values (
        ${input.connectionId}, ${scope.accountId}, ${scope.workspaceId},
        ${scope.actorSubjectId}, ${input.providerDomain}, 'api_key',
        ${input.credentialEncrypted}, 'active', ${input.version ?? 1},
        ${scope.actorSubjectId}, ${scope.actorSubjectId}
      )
    `;
  });
}

function directRoute(operationId = crypto.randomUUID()) {
  return {
    operationId,
    name: `Direct ${operationId.slice(0, 8)}`,
    configuration: { kind: "direct" as const },
    consistency: {
      dns: "placement" as const,
      expectedPublicIp: null,
      expectedRegion: null,
      locale: null,
      timezone: null,
      geolocation: null,
      webRtc: "default" as const,
      stability: "session" as const,
    },
  };
}

async function activeBrowser(scope: Awaited<ReturnType<typeof fixture>>) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    ...scope,
    operationId,
    associatedSessionId: scope.sessionId,
    name: `Auth browser ${operationId.slice(0, 8)}`,
    initialUrl: "https://example.com/login",
    placement: {
      kind: "sandbox_group" as const,
      sandboxGroupId: scope.sandboxGroupId,
    },
    driverId: "opengeni.cdp.v1",
    engine: "chromium" as const,
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  await activateBrowserSession(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.0",
  });
  return { browserSessionId: prepared.session.id, controllerGeneration };
}

async function claimTurn(scope: Awaited<ReturnType<typeof fixture>>) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    scope.workspaceId,
    scope.actorSubjectId,
    (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.actorSubjectId,
        actor: { type: "human", subjectId: scope.actorSubjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Open the protected page",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Could not claim test turn: ${claim.reason}`);
  return { attemptId, turn: claim.turn };
}

function siteAuth(operationId = crypto.randomUUID()) {
  return {
    operationId,
    name: `Example ${operationId.slice(0, 8)}`,
    accountLabel: "test@example.com",
    origins: ["https://example.com"],
    loginUrl: "https://example.com/login",
    verificationUrlPrefixes: ["https://example.com/app"],
    authorities: [
      {
        id: "kernel-managed",
        kind: "external_provider" as const,
        label: "Kernel managed sign-in",
        adapterId: "kernel",
        connectionId: "kernel-connection-1",
        credential: null,
      },
    ],
    methods: [
      {
        id: "kernel-managed",
        kind: "external" as const,
        label: "Managed sign-in",
        authorityIds: ["kernel-managed"],
      },
    ],
    preferredIdentityId: null,
    preferredPlacement: null,
    preferredNetworkRouteId: null,
    healthPolicy: {
      mode: "on_use" as const,
      intervalSeconds: null,
      automaticRepair: false,
    },
  };
}

describe("browser auth and network resources", () => {
  test("keeps route mutations idempotent, version-fenced, and independently discoverable", async () => {
    if (!available) return;
    const scope = await fixture();
    const request = directRoute();
    const created = await createNetworkRoute(client.db, {
      ...scope,
      ...request,
    });
    expect(created).toMatchObject({
      replayed: false,
      operationId: request.operationId,
    });
    expect(await createNetworkRoute(client.db, { ...scope, ...request })).toMatchObject({
      route: { id: created.route.id },
      replayed: true,
    });
    await expect(
      createNetworkRoute(client.db, {
        ...scope,
        ...request,
        name: `${request.name} changed`,
      }),
    ).rejects.toBeInstanceOf(InteractionResourceConflictError);

    const updated = await updateNetworkRoute(client.db, {
      ...scope,
      routeId: created.route.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      name: "Direct preferred",
    });
    expect(updated.route).toMatchObject({
      name: "Direct preferred",
      version: 2,
    });
    await expect(
      updateNetworkRoute(client.db, {
        ...scope,
        routeId: created.route.id,
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        status: "archived",
      }),
    ).rejects.toBeInstanceOf(InteractionResourceConflictError);
    expect((await listNetworkRoutes(client.db, scope)).routes).toHaveLength(1);

    const browserOperationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, {
      ...scope,
      operationId: browserOperationId,
      associatedSessionId: scope.sessionId,
      name: "Routed browser",
      initialUrl: "https://example.com",
      placement: {
        kind: "sandbox_group",
        sandboxGroupId: scope.sandboxGroupId,
      },
      driverId: "opengeni.cdp.v1",
      engine: "chromium",
      headless: true,
      identityId: null,
      baseRevisionId: null,
      networkRouteId: created.route.id,
    });
    const beforeBinding = await findBrowserSessionControlRecordByOperation(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      operationId: browserOperationId,
    });
    expect(beforeBinding?.networkRouteAuthority).toMatchObject({
      routeId: created.route.id,
      routeVersion: 2,
      credentialVersion: null,
      authorityDigest: null,
      configuration: { kind: "direct" },
    });
    const bound = await bindBrowserSessionNetworkRouteAuthority(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      browserSessionId: prepared.session.id,
      operationId: browserOperationId,
      routeVersion: 2,
      credentialVersion: null,
      authorityDigest: `route.${"a".repeat(43)}`,
    });
    expect(bound).toMatchObject({
      routeVersion: 2,
      authorityDigest: `route.${"a".repeat(43)}`,
    });
    const changedForFutureSessions = await updateNetworkRoute(client.db, {
      ...scope,
      routeId: created.route.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 2,
      name: "Future route configuration",
    });
    expect(changedForFutureSessions.route.version).toBe(3);
    expect(
      (
        await findBrowserSessionControlRecordByOperation(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          operationId: browserOperationId,
        })
      )?.networkRouteAuthority,
    ).toMatchObject({
      routeVersion: 2,
      authorityDigest: `route.${"a".repeat(43)}`,
    });

    const managed = await createNetworkRoute(client.db, {
      ...scope,
      actorSubjectId: scope.actorSubjectId,
      operationId: crypto.randomUUID(),
      name: `Kernel route ${crypto.randomUUID()}`,
      configuration: {
        kind: "managed",
        providerId: "kernel",
        routeId: "kernel-proxy-4",
        egressClass: "isp",
        region: "NO",
        credential: null,
      },
      consistency: {
        dns: "provider",
        expectedPublicIp: null,
        expectedRegion: "NO",
        locale: "nb-NO",
        timezone: "Europe/Oslo",
        geolocation: null,
        webRtc: "disable_non_proxied_udp",
        stability: "sticky",
      },
    });
    const externalOperationId = crypto.randomUUID();
    const external = await prepareBrowserSessionCreate(client.db, {
      ...scope,
      operationId: externalOperationId,
      associatedSessionId: scope.sessionId,
      name: "Kernel browser",
      initialUrl: "https://example.com",
      placement: { kind: "external_provider", providerId: "kernel", placementId: "default" },
      driverId: "opengeni.external.cdp.v1",
      engine: "external",
      headless: true,
      identityId: null,
      baseRevisionId: null,
      networkRouteId: managed.route.id,
    });
    expect(
      (
        await findBrowserSessionControlRecordByOperation(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          operationId: externalOperationId,
        })
      )?.networkRouteAuthority,
    ).toMatchObject({
      routeId: managed.route.id,
      configuration: { kind: "managed", providerId: "kernel" },
      consistency: { dns: "provider", stability: "sticky" },
    });
    expect(external.session.placement).toEqual({
      kind: "external_provider",
      providerId: "kernel",
      placementId: "default",
    });
    const mismatchedOperationId = crypto.randomUUID();
    await expect(
      prepareBrowserSessionCreate(client.db, {
        ...scope,
        operationId: mismatchedOperationId,
        associatedSessionId: scope.sessionId,
        name: "Wrong provider browser",
        initialUrl: null,
        placement: {
          kind: "external_provider",
          providerId: "browserbase",
          placementId: "default",
        },
        driverId: "opengeni.external.cdp.v1",
        engine: "external",
        headless: true,
        identityId: null,
        baseRevisionId: null,
        networkRouteId: managed.route.id,
      }),
    ).rejects.toThrow("another external browser provider");
    expect(
      await findBrowserSessionControlRecordByOperation(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        operationId: mismatchedOperationId,
      }),
    ).toBeNull();
  });

  test("freezes visible connection authority without persisting credential values", async () => {
    if (!available) return;
    const scope = await fixture();
    const connectionId = crypto.randomUUID();
    await insertPersonalConnectionFixture({
      scope,
      connectionId,
      providerDomain: "example.com",
      credentialEncrypted: "encrypted-never-read-here",
    });
    const operationId = crypto.randomUUID();
    const base = siteAuth(operationId);
    const credentialAuthority = {
      id: "connection",
      kind: "external_provider" as const,
      label: "Saved connection",
      adapterId: "kernel",
      connectionId: "kernel-connection-1",
      credential: {
        connectionId,
        connectionSubjectId: scope.actorSubjectId,
        providerDomain: "example.com",
      },
    };
    const created = await createSiteAuthConnection(client.db, {
      ...scope,
      ...base,
      authorities: [credentialAuthority],
      methods: [{ ...base.methods[0]!, authorityIds: ["connection"] }],
    });
    expect(JSON.stringify(created)).not.toContain("encrypted-never-read-here");
    expect(
      await createSiteAuthConnection(client.db, {
        ...scope,
        ...base,
        authorities: [credentialAuthority],
        methods: [{ ...base.methods[0]!, authorityIds: ["connection"] }],
      }),
    ).toMatchObject({ replayed: true });

    const renamed = await updateSiteAuthConnection(client.db, {
      ...scope,
      actorSubjectId: "agent:workspace",
      siteAuthConnectionId: created.connection.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      accountLabel: "Renamed without secret reauthorization",
    });
    expect(renamed.connection).toMatchObject({
      accountLabel: "Renamed without secret reauthorization",
      version: 2,
    });
    expect((await listSiteAuthConnections(client.db, scope)).connections).toHaveLength(1);

    await expect(
      createSiteAuthConnection(client.db, {
        ...scope,
        actorSubjectId: "agent:workspace",
        ...siteAuth(),
        authorities: [credentialAuthority],
        methods: [{ ...base.methods[0]!, authorityIds: ["connection"] }],
      }),
    ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);
  });

  test("rejects a preferred auth route that its browser placement cannot realize", async () => {
    if (!available) return;
    const scope = await fixture();
    const route = await createNetworkRoute(client.db, {
      ...scope,
      actorSubjectId: scope.actorSubjectId,
      operationId: crypto.randomUUID(),
      name: `Kernel auth route ${crypto.randomUUID()}`,
      configuration: {
        kind: "managed",
        providerId: "kernel",
        routeId: "kernel-proxy-4",
        egressClass: "isp",
        region: "NO",
        credential: null,
      },
      consistency: {
        dns: "provider",
        expectedPublicIp: null,
        expectedRegion: "NO",
        locale: null,
        timezone: null,
        geolocation: null,
        webRtc: "default",
        stability: "sticky",
      },
    });
    await expect(
      createSiteAuthConnection(client.db, {
        ...scope,
        ...siteAuth(),
        preferredNetworkRouteId: route.route.id,
      }),
    ).rejects.toThrow("external browser provider placement");
    const configured = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
      preferredPlacement: {
        kind: "external_provider",
        providerId: "kernel",
        placementId: "default",
      },
      preferredNetworkRouteId: route.route.id,
    });
    expect(configured.connection).toMatchObject({
      preferredPlacement: {
        kind: "external_provider",
        providerId: "kernel",
        placementId: "default",
      },
      preferredNetworkRouteId: route.route.id,
    });

    await expect(
      updateNetworkRoute(client.db, {
        ...scope,
        routeId: route.route.id,
        operationId: crypto.randomUUID(),
        expectedVersion: route.route.version,
        status: "archived",
      }),
    ).rejects.toThrow("selected by an active site auth connection");
    await expect(
      updateNetworkRoute(client.db, {
        ...scope,
        routeId: route.route.id,
        operationId: crypto.randomUUID(),
        expectedVersion: route.route.version,
        configuration: {
          kind: "managed",
          providerId: "browserbase",
          routeId: "default",
          egressClass: "residential",
          region: "NO",
          credential: null,
        },
      }),
    ).rejects.toThrow("belongs to another external browser provider");

    const archivedConnection = await updateSiteAuthConnection(client.db, {
      ...scope,
      siteAuthConnectionId: configured.connection.id,
      operationId: crypto.randomUUID(),
      expectedVersion: configured.connection.version,
      status: "archived",
    });
    const archivedRoute = await updateNetworkRoute(client.db, {
      ...scope,
      routeId: route.route.id,
      operationId: crypto.randomUUID(),
      expectedVersion: route.route.version,
      status: "archived",
    });
    await expect(
      updateSiteAuthConnection(client.db, {
        ...scope,
        siteAuthConnectionId: archivedConnection.connection.id,
        operationId: crypto.randomUUID(),
        expectedVersion: archivedConnection.connection.version,
        status: "active",
      }),
    ).rejects.toThrow("Preferred network route is archived");
    expect(archivedRoute.route.status).toBe("archived");
  });

  test("runs exact-target auth and resumes it through one durable intervention", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
    });
    const browser = await activeBrowser(scope);
    const startOperationId = crypto.randomUUID();
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: startOperationId,
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-1",
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      methodId: "kernel-managed",
      authorityId: "kernel-managed",
    });
    expect(started.run).toMatchObject({ state: "discovering", version: 1 });
    expect(
      await startAuthRun(client.db, {
        ...scope,
        ...browser,
        operationId: startOperationId,
        siteAuthConnectionId: auth.connection.id,
        targetId: "target-1",
        expectedTargetGeneration: "target-generation-1",
        expectedDocumentGeneration: "document-generation-1",
        methodId: "kernel-managed",
        authorityId: "kernel-managed",
      }),
    ).toMatchObject({ replayed: true });

    const waiting = await reportAuthRun(client.db, {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      state: "awaiting_external_action",
      externalAction: { kind: "push", label: "Approve the sign-in on your phone", expiresAt: null },
    });
    expect(waiting.run).toMatchObject({ state: "awaiting_external_action", version: 2 });

    const interventionOperationId = crypto.randomUUID();
    const intervention = await createInteractionIntervention(client.db, {
      ...scope,
      operationId: interventionOperationId,
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-1",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      kind: "manual_login",
      reason: "Please finish signing in in this exact tab.",
      authRunId: started.run.id,
      expiresInSeconds: 900,
      originatingSessionId: scope.sessionId,
    });
    expect(intervention.intervention).toMatchObject({
      status: "open",
      version: 1,
    });
    expect(
      await createInteractionIntervention(client.db, {
        ...scope,
        operationId: interventionOperationId,
        resourceKind: "browser_session",
        resourceId: browser.browserSessionId,
        targetId: "target-1",
        expectedControllerGeneration: browser.controllerGeneration,
        expectedTargetGeneration: "target-generation-1",
        expectedDocumentGeneration: "document-generation-1",
        kind: "manual_login",
        reason: "Please finish signing in in this exact tab.",
        authRunId: started.run.id,
        expiresInSeconds: 900,
        originatingSessionId: scope.sessionId,
      }),
    ).toMatchObject({ replayed: true });
    expect((await listInteractionInterventions(client.db, scope)).interventions).toHaveLength(1);

    const resolved = await resolveInteractionIntervention(client.db, {
      ...scope,
      interventionId: intervention.intervention.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      outcome: "completed",
    });
    expect(resolved.intervention).toMatchObject({
      status: "completed",
      version: 2,
    });
    expect(await getAuthRun(client.db, { ...scope, authRunId: started.run.id })).toMatchObject({
      state: "working",
      interventionId: null,
      version: 4,
    });
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId: intervention.intervention.id,
      }),
    ).toMatchObject({ status: "completed" });
  });

  test("advances external auth durably and rebinds the run after provider profile load", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
    });
    const browser = await activeBrowser(scope);
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-external-old",
      expectedTargetGeneration: "target-generation-external-old",
      expectedDocumentGeneration: "document-generation-external-old",
      methodId: "kernel-managed",
      authorityId: "kernel-managed",
    });
    const startOperationId = crypto.randomUUID();
    const startRequest = {
      operationId: startOperationId,
      expectedVersion: started.run.version,
      action: "start" as const,
    };
    expect(
      await getExternalAuthPreparation(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...startRequest,
      }),
    ).toBeNull();
    expect(
      await prepareExternalAuth(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...startRequest,
      }),
    ).toMatchObject({
      authority: {
        kind: "external_provider",
        adapterId: "kernel",
        connectionId: "kernel-connection-1",
      },
      operationState: "prepared",
    });
    expect(
      await dispatchExternalAuth(client.db, {
        ...scope,
        authRunId: started.run.id,
        operationId: startOperationId,
      }),
    ).toBe("dispatched");
    const waiting = await completeExternalAuth(client.db, {
      ...scope,
      authRunId: started.run.id,
      operationId: startOperationId,
      result: {
        state: "needs_human",
        externalAction: {
          kind: "human",
          label: "Finish signing in securely",
          expiresAt: null,
        },
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: false,
      },
      intervention: {
        originatingSessionId: scope.sessionId,
        expiresInSeconds: 900,
      },
    });
    expect(waiting).toMatchObject({
      status: "needs_human",
      replayed: false,
      run: {
        state: "awaiting_external_action",
        version: 2,
      },
    });
    expect(
      await getExternalAuthInteractiveContext(client.db, {
        ...scope,
        authRunId: started.run.id,
        operationId: crypto.randomUUID(),
        expectedVersion: waiting.run.version,
      }),
    ).toMatchObject({
      run: { id: started.run.id, state: "awaiting_external_action" },
      authority: { adapterId: "kernel", connectionId: "kernel-connection-1" },
    });
    expect(waiting.run.interventionId).toBeString();
    expect(
      await prepareExternalAuth(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...startRequest,
      }),
    ).toMatchObject({ response: { replayed: true, status: "needs_human" } });

    const competing = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-external-competing",
      expectedTargetGeneration: "target-generation-external-competing",
      expectedDocumentGeneration: "document-generation-external-competing",
      methodId: "kernel-managed",
      authorityId: "kernel-managed",
    });
    const competingOperationId = crypto.randomUUID();
    await prepareExternalAuth(client.db, {
      ...scope,
      authRunId: competing.run.id,
      operationId: competingOperationId,
      expectedVersion: competing.run.version,
      action: "poll",
    });
    await dispatchExternalAuth(client.db, {
      ...scope,
      authRunId: competing.run.id,
      operationId: competingOperationId,
    });

    const pollOperationId = crypto.randomUUID();
    const pollRequest = {
      operationId: pollOperationId,
      expectedVersion: waiting.run.version,
      action: "poll" as const,
    };
    await prepareExternalAuth(client.db, {
      ...scope,
      authRunId: started.run.id,
      ...pollRequest,
    });
    await dispatchExternalAuth(client.db, {
      ...scope,
      authRunId: started.run.id,
      operationId: pollOperationId,
    });
    const authenticated = await completeExternalAuth(client.db, {
      ...scope,
      authRunId: started.run.id,
      operationId: pollOperationId,
      result: {
        state: "authenticated",
        externalAction: null,
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: true,
      },
      target: {
        id: "target-external-new",
        targetGeneration: "target-generation-external-new",
        documentGeneration: "document-generation-external-new",
      },
    });
    expect(authenticated).toMatchObject({
      status: "ready_to_verify",
      replayed: false,
      run: {
        state: "working",
        targetId: "target-external-new",
        targetGeneration: "target-generation-external-new",
        documentGeneration: "document-generation-external-new",
        interventionId: null,
        version: 3,
      },
    });
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId: waiting.run.interventionId!,
      }),
    ).toMatchObject({ status: "completed", version: 2 });
    expect(
      await prepareExternalAuth(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...pollRequest,
      }),
    ).toMatchObject({ response: { replayed: true, status: "ready_to_verify" } });
    expect(await getAuthRun(client.db, { ...scope, authRunId: competing.run.id })).toMatchObject({
      state: "failed",
      failureCode: "browser_profile_reconfigured",
      settledAt: expect.any(String),
    });
    const operations = await shared!.admin<
      Array<{
        operation_id: string;
        metadata: unknown;
        result: unknown;
        state: string;
        error_code: string | null;
      }>
    >`select operation_id, metadata, result, state, error_code
      from interaction_resource_operations
      where operation_id in (${pollOperationId}, ${competingOperationId})
      order by operation_id`;
    expect(
      operations.find((operation) => operation.operation_id === competingOperationId),
    ).toMatchObject({
      state: "failed",
      error_code: "browser_profile_reconfigured",
    });
    const operation = operations.find((entry) => entry.operation_id === pollOperationId);
    expect(JSON.stringify(operation)).not.toContain("hosted_url");
  });

  test("keeps model-owned expiry attached to the exact approval across re-freeze", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const claimed = await claimTurn(scope);
    const toolCallId = "interaction-human-call";
    const ordinaryApprovalId = "ordinary-approval-call";
    const interventionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const request = {
      operation: "request" as const,
      resourceKind: "browser_session" as const,
      resourceId: browser.browserSessionId,
      targetId: "target-human-wait",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-human-wait",
      expectedDocumentGeneration: "document-generation-human-wait",
      kind: "mfa" as const,
      reason: "Complete MFA in this exact tab.",
      expiresInSeconds: 30,
    };
    const initial = await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: claimed.turn.id,
      runState: {
        serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
        pendingApprovals: [{ id: ordinaryApprovalId }, { id: toolCallId }],
        interactionInterventionRequests: [
          { id: interventionId, operationId, toolCallId, input: request },
        ],
      },
      events: [
        {
          type: "session.requiresAction",
          payload: { approvals: [{ id: ordinaryApprovalId }] },
        },
        {
          type: "session.status.changed",
          payload: { status: "requires_action" },
        },
      ],
    });
    expect(initial.action).toBe("settled");

    const ordinary = await acceptSessionApprovalDecision(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      subjectId: scope.actorSubjectId,
      payload: { approvalId: ordinaryApprovalId, decision: "approve" },
    });
    expect(ordinary.action).toBe("accepted");
    if (ordinary.action !== "accepted") throw new Error("ordinary approval was not accepted");
    const resumedAttemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      workflowId: `session-${scope.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: resumedAttemptId,
      trigger: { kind: "approval", triggerEventId: ordinary.event.id },
    });
    if (resumed.action !== "claimed") {
      throw new Error(`Could not resume test turn: ${resumed.reason}`);
    }
    const refrozen = await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: resumed.turn.id,
      triggerEventId: resumed.turn.triggerEventId,
      attemptId: resumedAttemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: resumed.turn.id,
      runState: {
        serializedRunState: JSON.stringify({
          version: 1,
          interrupted: true,
          resumed: true,
        }),
        pendingApprovals: [{ id: toolCallId }],
        interactionInterventionRequests: [
          { id: interventionId, operationId, toolCallId, input: request },
        ],
      },
      events: [
        {
          type: "session.status.changed",
          payload: { status: "requires_action" },
        },
      ],
    });
    expect(refrozen.action).toBe("settled");

    await shared!.admin`
      update interaction_interventions
      set expires_at = now() - interval '1 second'
      where workspace_id = ${scope.workspaceId} and id = ${interventionId}`;
    // Passive reads must not settle the intervention without also resuming the
    // exact model approval.
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId,
      }),
    ).toMatchObject({ status: "open" });
    const wait = await peekSessionWork(client.db, scope.workspaceId, scope.sessionId);
    expect(wait).toMatchObject({
      kind: "approval-wait",
      interactionInterventionId: interventionId,
    });

    await expect(
      acceptSessionApprovalDecision(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        subjectId: scope.actorSubjectId,
        payload: { approvalId: toolCallId, decision: "approve" },
        clientEventId: crypto.randomUUID(),
        interactionIntervention: {
          interventionId,
          operationId: crypto.randomUUID(),
          expectedVersion: 1,
          outcome: "completed",
        },
      }),
    ).rejects.toBeInstanceOf(InteractionResourceStateError);
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId,
      }),
    ).toMatchObject({ status: "open", version: 1 });

    const expired = await expireSessionInteractionIntervention(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      interventionId,
    });
    expect(expired.action).toBe("expired");
    expect(expired.events).toEqual([
      expect.objectContaining({
        type: "user.approvalDecision",
        payload: { approvalId: toolCallId, decision: "reject" },
      }),
    ]);
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId,
      }),
    ).toMatchObject({ status: "expired", version: 2 });
    expect(
      await getInteractionInterventionResumeForEvent(
        client.db,
        scope.workspaceId,
        scope.sessionId,
        expired.events[0]!,
      ),
    ).toBeNull();
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: expired.events[0]!.id,
    });
    expect(
      await expireSessionInteractionIntervention(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        interventionId,
      }),
    ).toEqual({ action: "stale", events: [] });
  });

  async function freezeInteractionRequest(
    scope: Awaited<ReturnType<typeof fixture>>,
    claimed: Awaited<ReturnType<typeof claimTurn>>,
    toolCallId: string,
    input: Record<string, unknown>,
    currentTarget?:
      | {
          controllerGeneration: string;
          targetGeneration: string;
          documentGeneration: string | null;
        }
      | string,
  ) {
    const interventionId = crypto.randomUUID();
    const settled = await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: claimed.turn.id,
      runState: {
        serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
        pendingApprovals: [{ id: toolCallId }],
        interactionInterventionRequests: [
          {
            id: interventionId,
            operationId: crypto.randomUUID(),
            toolCallId,
            input: input as never,
            ...(currentTarget !== undefined ? { currentTarget } : {}),
          },
        ],
      },
      events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
    });
    return { settled, interventionId };
  }

  test("answers an interaction request it cannot record as the call's result", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const claimed = await claimTurn(scope);
    const toolCallId = "interaction-human-unknown-generations";
    // An agent that never saw the generations passed placeholders. The pause
    // used to fail the whole turn here; the person was never asked.
    const { settled, interventionId } = await freezeInteractionRequest(scope, claimed, toolCallId, {
      operation: "request",
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-unknown",
      expectedControllerGeneration: "unknown",
      expectedTargetGeneration: "unknown",
      expectedDocumentGeneration: "unknown",
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
    });
    expect(settled.action).toBe("settled");
    if (settled.action !== "settled") throw new Error("pause was not recorded");
    const refusal = settled.events.find((event) => event.type === "user.approvalDecision");
    expect(refusal?.payload).toEqual({
      approvalId: toolCallId,
      decision: "reject",
      refusal:
        "Nothing was requested: the expected generation values given do not match the tab or window as it is now. Call interaction_request_human again and leave out expectedControllerGeneration, expectedTargetGeneration and expectedDocumentGeneration; they are read from the tab or window when the turn pauses.",
    });
    // Nothing was recorded, so no person sees a request.
    await expect(
      getInteractionIntervention(client.db, { ...scope, interventionId }),
    ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);
    // The workflow resumes the turn with the refusal at once.
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-pending",
      triggerEventId: refusal!.id,
    });
    expect(
      await getInteractionInterventionResumeForEvent(
        client.db,
        scope.workspaceId,
        scope.sessionId,
        refusal!,
      ),
    ).toBeNull();
    const resumed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      workflowId: `session-${scope.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "approval", triggerEventId: refusal!.id },
    });
    expect(resumed.action).toBe("claimed");
  });

  test("records a request without generations from the target as it is now", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const claimed = await claimTurn(scope);
    const toolCallId = "interaction-human-current-target";
    const request = {
      operation: "request",
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-current",
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
    };
    const currentTarget = {
      controllerGeneration: browser.controllerGeneration,
      targetGeneration: "target-generation-current",
      documentGeneration: "document-generation-current",
    };
    const { settled, interventionId } = await freezeInteractionRequest(
      scope,
      claimed,
      toolCallId,
      request,
      currentTarget,
    );
    expect(settled.action).toBe("settled");
    if (settled.action !== "settled") throw new Error("pause was not recorded");
    expect(settled.events.map((event) => event.type)).not.toContain("user.approvalDecision");
    expect(await getInteractionIntervention(client.db, { ...scope, interventionId })).toMatchObject(
      {
        status: "open",
        targetId: "target-current",
        ...currentTarget,
        originatingToolOperationId: expect.any(String),
      },
    );
    expect(await peekSessionWork(client.db, scope.workspaceId, scope.sessionId)).toMatchObject({
      kind: "approval-wait",
      interactionInterventionId: interventionId,
    });
  });

  test("refuses requests whose target is gone or already has an open request", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const request = {
      operation: "request",
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-busy",
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
    };

    const gone = await freezeInteractionRequest(
      scope,
      await claimTurn(scope),
      "interaction-human-gone",
      request,
      "browser tab target-busy was not found",
    );
    if (gone.settled.action !== "settled") throw new Error("pause was not recorded");
    expect(
      gone.settled.events.find((event) => event.type === "user.approvalDecision")?.payload,
    ).toMatchObject({
      refusal:
        "Nothing was requested: browser tab target-busy was not found. Observe the tab or window again, then call interaction_request_human again if a person still needs to act there.",
    });

    // Another request already asks a person to act on this tab, for example
    // the one browser_auth opened. Its unique index used to fail the pause.
    const open = await createInteractionIntervention(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-busy",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-busy",
      expectedDocumentGeneration: null,
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
      expiresInSeconds: 900,
      originatingSessionId: scope.sessionId,
    });
    const busy = await freezeInteractionRequest(
      scope,
      await resumeRefusedTurn(scope, gone.settled),
      "interaction-human-busy",
      request,
      {
        controllerGeneration: browser.controllerGeneration,
        targetGeneration: "target-generation-busy",
        documentGeneration: null,
      },
    );
    if (busy.settled.action !== "settled") throw new Error("pause was not recorded");
    expect(
      busy.settled.events.find((event) => event.type === "user.approvalDecision")?.payload,
    ).toMatchObject({
      refusal: `Nothing was requested: another open request (intervention ${open.intervention.id}) already asks a person to act on this tab or window. If browser_auth returned that interventionId, wait for it with operation=wait; otherwise ask again only after that request is finished.`,
    });
    await expect(
      getInteractionIntervention(client.db, { ...scope, interventionId: busy.interventionId }),
    ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);
  });

  async function resumeRefusedTurn(
    scope: Awaited<ReturnType<typeof fixture>>,
    settled: Awaited<ReturnType<typeof applySessionTurnSettlement>>,
  ) {
    if (settled.action !== "settled") throw new Error("pause was not recorded");
    const refusal = settled.events.find((event) => event.type === "user.approvalDecision")!;
    const attemptId = crypto.randomUUID();
    const resumed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      workflowId: `session-${scope.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "approval", triggerEventId: refusal.id },
    });
    if (resumed.action !== "claimed") throw new Error(`Could not resume: ${resumed.reason}`);
    return { attemptId, turn: resumed.turn };
  }

  function refusalOf(settled: Awaited<ReturnType<typeof applySessionTurnSettlement>>) {
    if (settled.action !== "settled") throw new Error("pause was not recorded");
    const decision = settled.events.find((event) => event.type === "user.approvalDecision");
    return (decision?.payload as { refusal?: string } | undefined)?.refusal ?? null;
  }

  const LEAVE_OUT_GENERATIONS =
    "Call interaction_request_human again and leave out expectedControllerGeneration, expectedTargetGeneration and expectedDocumentGeneration; they are read from the tab or window when the turn pauses.";

  test("checks supplied generations against the target as read at the pause", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const current = {
      controllerGeneration: browser.controllerGeneration,
      targetGeneration: "target-generation-now",
      documentGeneration: "document-generation-now",
    };
    const request = (targetId: string, generations: Record<string, unknown>) => ({
      operation: "request",
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId,
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
      ...generations,
    });

    // A supplied target generation that the tab no longer has is refused, and
    // the agent is told to leave the fields out rather than observe again.
    let claimed = await claimTurn(scope);
    const stale = await freezeInteractionRequest(
      scope,
      claimed,
      "call-stale-target",
      request("tab-stale", { expectedTargetGeneration: "target-generation-before" }),
      current,
    );
    expect(refusalOf(stale.settled)).toBe(
      `Nothing was requested: the expected generation values given do not match the tab or window as it is now. ${LEAVE_OUT_GENERATIONS}`,
    );
    await expect(
      getInteractionIntervention(client.db, { ...scope, interventionId: stale.interventionId }),
    ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);

    // Supplied values that match the reading are recorded with it.
    claimed = await resumeRefusedTurn(scope, stale.settled);
    const matching = await freezeInteractionRequest(
      scope,
      claimed,
      "call-matching",
      request("tab-matching", { expectedDocumentGeneration: current.documentGeneration }),
      current,
    );
    expect(refusalOf(matching.settled)).toBeNull();
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId: matching.interventionId,
      }),
    ).toMatchObject({ status: "open", targetId: "tab-matching", ...current });
  });

  test("records fully supplied generations as given when the target cannot be read", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const unreadable = "the current state of browser tab tab-unread could not be read";
    const base = {
      operation: "request",
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "tab-unread",
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-given",
    };
    // Without a reading, a request missing a generation cannot be recorded.
    const partial = await freezeInteractionRequest(
      scope,
      await claimTurn(scope),
      "call-partial",
      base,
      unreadable,
    );
    expect(refusalOf(partial.settled)).toBe(
      `Nothing was requested: ${unreadable}. Observe the tab or window again, then call interaction_request_human again if a person still needs to act there.`,
    );
    // All three supplied: recorded as given (the controller is still checked).
    const given = await freezeInteractionRequest(
      scope,
      await resumeRefusedTurn(scope, partial.settled),
      "call-given",
      { ...base, expectedDocumentGeneration: null },
      unreadable,
    );
    expect(refusalOf(given.settled)).toBeNull();
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId: given.interventionId,
      }),
    ).toMatchObject({
      status: "open",
      controllerGeneration: browser.controllerGeneration,
      targetGeneration: "target-generation-given",
      documentGeneration: null,
    });
  });

  test("refuses waits it cannot attach in plain words", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const missing = crypto.randomUUID();
    const notFound = await freezeInteractionRequest(
      scope,
      await claimTurn(scope),
      "call-wait-missing",
      { operation: "wait", interventionId: missing },
    );
    expect(refusalOf(notFound.settled)).toBe(
      `Not waiting: intervention ${missing} was not found. Use operation=wait only with an interventionId browser_auth returned in this turn; otherwise ask with operation=request.`,
    );

    // Opened outside this turn (no originating turn): not this call's to wait for.
    const foreign = await createInteractionIntervention(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "tab-foreign",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-foreign",
      expectedDocumentGeneration: null,
      kind: "mfa",
      reason: "Approve the sign-in on your phone.",
      expiresInSeconds: 900,
      originatingSessionId: scope.sessionId,
    });
    const claimed = await resumeRefusedTurn(scope, notFound.settled);
    const other = await freezeInteractionRequest(scope, claimed, "call-wait-foreign", {
      operation: "wait",
      interventionId: foreign.intervention.id,
    });
    expect(refusalOf(other.settled)).toBe(
      `Not waiting: intervention ${foreign.intervention.id} was opened by another agent turn. Use operation=wait only with an interventionId browser_auth returned in this turn; otherwise ask with operation=request.`,
    );

    await resolveInteractionIntervention(client.db, {
      ...scope,
      interventionId: foreign.intervention.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      outcome: "completed",
    });
    const finished = await freezeInteractionRequest(
      scope,
      await resumeRefusedTurn(scope, other.settled),
      "call-wait-finished",
      { operation: "wait", interventionId: foreign.intervention.id },
    );
    expect(refusalOf(finished.settled)).toBe(
      `Not waiting: intervention ${foreign.intervention.id} is no longer open; it was finished, dismissed or expired. Observe the tab or window again, then call interaction_request_human with operation=request if a person still needs to act there.`,
    );
  });

  test("refuses a request that loses the open-request race instead of failing the turn", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const claimed = await claimTurn(scope);
    // Another writer holds an uncommitted open request on the same tab, so
    // the pause's check cannot see it and its insert waits on the unique
    // index; once that writer commits, the insert fails with 23505.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted!: () => void;
    const insertedRow = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const competing = shared!.admin.begin(async (tx) => {
      await tx`
        insert into interaction_interventions (
          id, account_id, workspace_id, resource_kind, resource_id, target_id,
          controller_generation, target_generation, document_generation, kind, reason,
          originating_session_id, operation_id, expires_at
        ) values (
          ${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, 'browser_session',
          ${browser.browserSessionId}, 'tab-race', ${browser.controllerGeneration},
          'target-generation-race', null, 'mfa', 'Approve the sign-in on your phone.',
          ${scope.sessionId}, ${crypto.randomUUID()}, now() + interval '15 minutes'
        )
      `;
      inserted();
      await released;
    });
    await insertedRow;
    const pausing = freezeInteractionRequest(
      scope,
      claimed,
      "call-race",
      {
        operation: "request",
        resourceKind: "browser_session",
        resourceId: browser.browserSessionId,
        targetId: "tab-race",
        kind: "mfa",
        reason: "Approve the sign-in on your phone.",
      },
      {
        controllerGeneration: browser.controllerGeneration,
        targetGeneration: "target-generation-race",
        documentGeneration: null,
      },
    );
    // Commit the competing request only once the pause's insert waits on it.
    for (let waited = 0; ; waited += 25) {
      const [waiting] = await shared!.admin<{ blocked: number }[]>`
        select count(*)::int as blocked from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query ilike '%insert into "interaction_interventions"%'
      `;
      if ((waiting?.blocked ?? 0) > 0) break;
      if (waited > 10_000) throw new Error("the pause never reached its insert");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await competing;
    const { settled, interventionId } = await pausing;
    expect(refusalOf(settled)).toBe(
      "Nothing was requested: another open request already asks a person to act on this tab or window. If browser_auth returned that interventionId, wait for it with operation=wait; otherwise ask again only after that request is finished.",
    );
    await expect(
      getInteractionIntervention(client.db, { ...scope, interventionId }),
    ).rejects.toBeInstanceOf(InteractionResourceNotFoundError);
  });

  test("cancels leftover intervention resources with their terminal agent turn", async () => {
    if (!available) return;
    const scope = await fixture();
    const browser = await activeBrowser(scope);
    const claimed = await claimTurn(scope);
    const created = await createInteractionIntervention(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      resourceKind: "browser_session",
      resourceId: browser.browserSessionId,
      targetId: "target-terminal",
      expectedControllerGeneration: browser.controllerGeneration,
      expectedTargetGeneration: "target-generation-terminal",
      expectedDocumentGeneration: "document-generation-terminal",
      kind: "confirmation",
      reason: "Confirm this action in the exact tab.",
      expiresInSeconds: 900,
      originatingSessionId: scope.sessionId,
      originatingTurnId: claimed.turn.id,
      originatingAttemptId: claimed.attemptId,
      originatingToolOperationId: crypto.randomUUID(),
    });
    const settled = await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: {} },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });

    expect(settled.action).toBe("settled");
    expect(
      await getInteractionIntervention(client.db, {
        ...scope,
        interventionId: created.intervention.id,
      }),
    ).toMatchObject({ status: "cancelled", version: 2 });
  });

  test("verifies only the observed exact target", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, { ...scope, ...siteAuth() });
    const browser = await activeBrowser(scope);
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-1",
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      methodId: "kernel-managed",
      authorityId: "kernel-managed",
    });
    const working = await reportAuthRun(client.db, {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: started.run.version,
      state: "working",
    });
    expect(working.run).toMatchObject({ state: "working", version: 2 });
    const verification = {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      targetId: "target-1",
      targetGeneration: "target-generation-1",
      documentGeneration: "document-generation-2",
      url: "https://example.com/app/home",
      expectedVersion: working.run.version,
    };
    await expect(
      verifyAuthRun(client.db, {
        ...verification,
        targetId: "target-2",
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Verification targets another browser tab");
    const verified = await verifyAuthRun(client.db, {
      ...verification,
      operationId: crypto.randomUUID(),
    });
    expect(verified.run).toMatchObject({
      state: "verified",
      verifiedUrl: "https://example.com/app/home",
      version: 3,
    });
    expect((await listSiteAuthConnections(client.db, scope)).connections[0]).toMatchObject({
      verificationState: "verified",
      lastVerifiedUrl: "https://example.com/app/home",
      lastCheckedAt: expect.any(String),
    });
  });

  test("projects only causally newest auth health evidence and schedules maintained repair", async () => {
    if (!available) return;
    const scope = await fixture();
    const request = siteAuth();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...request,
      healthPolicy: {
        mode: "maintained",
        intervalSeconds: 120,
        automaticRepair: true,
      },
    });
    expect(auth.connection).toMatchObject({
      verificationState: "unknown",
      lastCheckedAt: null,
      nextCheckAt: expect.any(String),
    });
    const browser = await activeBrowser(scope);
    const start = async (target: string, purpose: "authenticate" | "health_check" | "repair") =>
      await startAuthRun(client.db, {
        ...scope,
        ...browser,
        operationId: crypto.randomUUID(),
        siteAuthConnectionId: auth.connection.id,
        targetId: target,
        expectedTargetGeneration: `${target}-generation`,
        expectedDocumentGeneration: `${target}-document`,
        purpose,
      });

    const older = await start("older", "health_check");
    const newer = await start("newer", "repair");
    await verifyAuthRun(client.db, {
      ...scope,
      authRunId: newer.run.id,
      controllerGeneration: browser.controllerGeneration,
      targetId: "newer",
      targetGeneration: "newer-generation",
      documentGeneration: "newer-document",
      url: "https://example.com/app/verified",
      operationId: crypto.randomUUID(),
      expectedVersion: newer.run.version,
    });
    await reportAuthRun(client.db, {
      ...scope,
      authRunId: older.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: older.run.version,
      state: "failed",
      failureCode: "stale_check_failed",
    });
    let connection = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(connection).toMatchObject({
      verificationState: "verified",
      lastVerifiedUrl: "https://example.com/app/verified",
      repairCode: null,
    });

    const failedCheck = await start("failed-check", "health_check");
    const checkSettled = await reportAuthRun(client.db, {
      ...scope,
      authRunId: failedCheck.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: failedCheck.run.version,
      state: "failed",
      failureCode: "session_expired",
    });
    connection = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(connection).toMatchObject({
      verificationState: "needs_repair",
      repairCode: "session_expired",
    });
    expect(Date.parse(connection.nextCheckAt!)).toBe(Date.parse(checkSettled.run.settledAt!));

    const failedRepair = await start("failed-repair", "repair");
    const repairSettled = await reportAuthRun(client.db, {
      ...scope,
      authRunId: failedRepair.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: failedRepair.run.version,
      state: "failed",
      failureCode: "mfa_unavailable",
    });
    connection = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(connection).toMatchObject({
      verificationState: "failed",
      repairCode: "mfa_unavailable",
    });
    expect(Date.parse(connection.nextCheckAt!) - Date.parse(repairSettled.run.settledAt!)).toBe(
      120_000,
    );

    const updated = await updateSiteAuthConnection(client.db, {
      ...scope,
      siteAuthConnectionId: connection.id,
      operationId: crypto.randomUUID(),
      expectedVersion: connection.version,
      healthPolicy: { mode: "on_use", intervalSeconds: null, automaticRepair: true },
    });
    expect(updated.connection.nextCheckAt).toBeNull();
  });

  test("claims one hidden maintenance session and settles its exact health run", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
      healthPolicy: {
        mode: "maintained",
        intervalSeconds: 120,
        automaticRepair: true,
      },
    });
    const [claimed] = await claimSiteAuthMaintenance(client.db, {
      claimTimeoutMs: 0,
      limit: 1,
    });
    expect(claimed).toMatchObject({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      siteAuthConnectionId: auth.connection.id,
      action: "health_check",
    });
    const beforeStart = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(beforeStart.maintenance).toMatchObject({
      action: "health_check",
      sessionId: null,
      startedAt: null,
    });

    const [reclaimed] = await claimSiteAuthMaintenance(client.db, {
      claimTimeoutMs: 0,
      limit: 1,
    });
    expect(reclaimed).toMatchObject({
      operationId: claimed!.operationId,
      sessionId: claimed!.sessionId,
    });
    const maintenanceCreateInput = {
      requestedSessionId: reclaimed!.sessionId,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Maintain auth",
      resources: [],
      metadata: {},
      createdBy: {
        kind: "service",
        subjectId: "site-auth-maintenance",
        label: "Opengeni authentication maintenance",
      },
      createdByContext: {
        opengeniSiteAuthConnectionId: auth.connection.id,
        opengeniSiteAuthMaintenanceOperationId: reclaimed!.operationId,
      },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      subjectId: "site-auth-maintenance",
      createIdempotencyKey: `site-auth-maintenance:${reclaimed!.operationId}`,
      beforeCreateCommit: async (tx, sessionId) => {
        const confirmed = await confirmSiteAuthMaintenanceSessionInTransaction(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          siteAuthConnectionId: auth.connection.id,
          operationId: reclaimed!.operationId,
          sessionId,
        });
        if (!confirmed) throw new Error("maintenance claim changed");
      },
    } satisfies Parameters<typeof createSession>[1];
    const maintenanceSession = await createSession(client.db, maintenanceCreateInput);
    const replayedMaintenanceSession = await createSession(client.db, maintenanceCreateInput);
    expect(replayedMaintenanceSession.id).toBe(maintenanceSession.id);
    const activeMaintenance = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(activeMaintenance.maintenance).toMatchObject({
      action: "health_check",
      sessionId: reclaimed!.sessionId,
      startedAt: expect.any(String),
    });

    const browser = await activeBrowser(scope);
    await expect(
      startAuthRun(client.db, {
        ...scope,
        ...browser,
        originatingSessionId: reclaimed!.sessionId,
        operationId: crypto.randomUUID(),
        siteAuthConnectionId: auth.connection.id,
        targetId: "maintenance-wrong-purpose",
        expectedTargetGeneration: "maintenance-target-generation",
        expectedDocumentGeneration: "maintenance-document-generation",
        purpose: "repair",
      }),
    ).rejects.toBeInstanceOf(InteractionResourceStateError);
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      originatingSessionId: reclaimed!.sessionId,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "maintenance-health",
      expectedTargetGeneration: "maintenance-target-generation",
      expectedDocumentGeneration: "maintenance-document-generation",
      purpose: "health_check",
    });
    await expect(
      startAuthRun(client.db, {
        ...scope,
        ...browser,
        originatingSessionId: reclaimed!.sessionId,
        operationId: crypto.randomUUID(),
        siteAuthConnectionId: auth.connection.id,
        targetId: "maintenance-duplicate",
        expectedTargetGeneration: "maintenance-target-generation-2",
        expectedDocumentGeneration: "maintenance-document-generation-2",
        purpose: "health_check",
      }),
    ).rejects.toThrow("already has an auth run");
    const settled = await reportAuthRun(client.db, {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: started.run.version,
      state: "failed",
      failureCode: "session_expired",
    });
    const needsRepair = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(needsRepair).toMatchObject({
      maintenance: null,
      verificationState: "needs_repair",
      repairCode: "session_expired",
    });
    expect(Date.parse(needsRepair.nextCheckAt!)).toBe(Date.parse(settled.run.settledAt!));

    const [repair] = await claimSiteAuthMaintenance(client.db, {
      claimTimeoutMs: 0,
      limit: 1,
    });
    expect(repair).toMatchObject({
      siteAuthConnectionId: auth.connection.id,
      action: "repair",
    });
    expect(repair!.operationId).not.toBe(reclaimed!.operationId);
    expect(repair!.sessionId).not.toBe(reclaimed!.sessionId);

    await createSession(client.db, {
      requestedSessionId: repair!.sessionId,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Repair auth",
      resources: [],
      metadata: {},
      createdBy: { kind: "service", subjectId: "site-auth-maintenance" },
      createdByContext: {
        opengeniSiteAuthConnectionId: auth.connection.id,
        opengeniSiteAuthMaintenanceOperationId: repair!.operationId,
      },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      subjectId: "site-auth-maintenance",
      beforeCreateCommit: async (tx, sessionId) => {
        const confirmed = await confirmSiteAuthMaintenanceSessionInTransaction(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          siteAuthConnectionId: auth.connection.id,
          operationId: repair!.operationId,
          sessionId,
        });
        if (!confirmed) throw new Error("maintenance claim changed");
      },
    });
    const staleRepair = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      originatingSessionId: repair!.sessionId,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "maintenance-before-edit",
      expectedTargetGeneration: "maintenance-before-edit-target-generation",
      expectedDocumentGeneration: "maintenance-before-edit-document-generation",
      purpose: "repair",
    });
    const beforeEdit = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    const edited = await updateSiteAuthConnection(client.db, {
      ...scope,
      siteAuthConnectionId: auth.connection.id,
      operationId: crypto.randomUUID(),
      expectedVersion: beforeEdit.version,
      accountLabel: "Edited while maintenance was starting",
    });
    expect(edited.connection.maintenance).toBeNull();
    await reportAuthRun(client.db, {
      ...scope,
      authRunId: staleRepair.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: staleRepair.run.version,
      state: "failed",
      failureCode: "stale_repair_failed",
    });
    expect((await listSiteAuthConnections(client.db, scope)).connections[0]).toMatchObject({
      maintenance: null,
      verificationState: "needs_repair",
      repairCode: "session_expired",
    });
    await expect(
      startAuthRun(client.db, {
        ...scope,
        ...browser,
        originatingSessionId: repair!.sessionId,
        operationId: crypto.randomUUID(),
        siteAuthConnectionId: auth.connection.id,
        targetId: "stale-maintenance",
        expectedTargetGeneration: "stale-target-generation",
        expectedDocumentGeneration: "stale-document-generation",
        purpose: "repair",
      }),
    ).rejects.toBeInstanceOf(InteractionResourceStateError);
  });

  test("rolls back the maintenance session shell when its claim changes", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
      healthPolicy: { mode: "maintained", intervalSeconds: 120, automaticRepair: true },
    });
    const [claim] = await claimSiteAuthMaintenance(client.db, {
      claimTimeoutMs: 0,
      limit: 1,
    });
    const claimedConnection = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    await updateSiteAuthConnection(client.db, {
      ...scope,
      siteAuthConnectionId: auth.connection.id,
      operationId: crypto.randomUUID(),
      expectedVersion: claimedConnection.version,
      accountLabel: "Changed before dispatch",
    });

    await expect(
      createSession(client.db, {
        requestedSessionId: claim!.sessionId,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        initialMessage: "Stale maintenance",
        resources: [],
        metadata: {},
        createdBy: { kind: "service", subjectId: "site-auth-maintenance" },
        createdByContext: {
          opengeniSiteAuthConnectionId: auth.connection.id,
          opengeniSiteAuthMaintenanceOperationId: claim!.operationId,
        },
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        subjectId: "site-auth-maintenance",
        beforeCreateCommit: async (tx, sessionId) => {
          const confirmed = await confirmSiteAuthMaintenanceSessionInTransaction(tx, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            siteAuthConnectionId: auth.connection.id,
            operationId: claim!.operationId,
            sessionId,
          });
          if (!confirmed) throw new Error("maintenance claim changed");
        },
      }),
    ).rejects.toThrow("maintenance claim changed");
    expect(await getSession(client.db, scope.workspaceId, claim!.sessionId)).toBeNull();
    expect(
      (await listSiteAuthConnections(client.db, scope)).connections[0]!.maintenance,
    ).toBeNull();
  });

  test("cancels an orphaned maintenance auth run when its agent turn settles", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
      healthPolicy: { mode: "maintained", intervalSeconds: 3_600, automaticRepair: true },
    });
    const claims = await claimSiteAuthMaintenance(client.db, {
      claimTimeoutMs: 600_000,
      limit: 1_000,
    });
    const claim = claims.find((candidate) => candidate.siteAuthConnectionId === auth.connection.id);
    expect(claim).toBeDefined();
    await createSession(client.db, {
      requestedSessionId: claim!.sessionId,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Maintain auth",
      resources: [],
      metadata: {},
      createdBy: { kind: "service", subjectId: "site-auth-maintenance" },
      createdByContext: {
        opengeniSiteAuthConnectionId: auth.connection.id,
        opengeniSiteAuthMaintenanceOperationId: claim!.operationId,
      },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      subjectId: "site-auth-maintenance",
      beforeCreateCommit: async (tx, sessionId) => {
        const confirmed = await confirmSiteAuthMaintenanceSessionInTransaction(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          siteAuthConnectionId: auth.connection.id,
          operationId: claim!.operationId,
          sessionId,
        });
        if (!confirmed) throw new Error("maintenance claim changed");
      },
    });
    const initialized = await initializeSessionStartAtomically(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: claim!.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: { role: "site_auth_maintenance" },
    });
    expect(initialized.turn).not.toBeNull();
    const attemptId = crypto.randomUUID();
    const claimedTurn = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: claim!.sessionId,
      workflowId: `session-${claim!.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimedTurn.action !== "claimed") {
      throw new Error(`Could not claim maintenance turn: ${claimedTurn.reason}`);
    }
    const browser = await activeBrowser(scope);
    const run = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      originatingSessionId: claim!.sessionId,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "orphaned-maintenance",
      expectedTargetGeneration: "orphaned-target-generation",
      expectedDocumentGeneration: "orphaned-document-generation",
      purpose: "health_check",
    });
    const settled = await applySessionTurnSettlement(client.db, scope.workspaceId, {
      sessionId: claim!.sessionId,
      turnId: claimedTurn.turn.id,
      triggerEventId: claimedTurn.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: {} },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");
    expect((await getAuthRun(client.db, { ...scope, authRunId: run.run.id })).state).toBe(
      "cancelled",
    );
    const connection = (await listSiteAuthConnections(client.db, scope)).connections[0]!;
    expect(connection.maintenance).toBeNull();
    expect(Date.parse(connection.nextCheckAt!) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1_000);
    expect(Date.parse(connection.nextCheckAt!)).toBeGreaterThan(Date.now());
  });

  test("keeps maintenance live while the session has a queued continuation", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...siteAuth(),
      healthPolicy: { mode: "maintained", intervalSeconds: 3_600, automaticRepair: true },
    });
    const claim = (
      await claimSiteAuthMaintenance(client.db, {
        claimTimeoutMs: 600_000,
        limit: 1_000,
      })
    ).find((candidate) => candidate.siteAuthConnectionId === auth.connection.id);
    expect(claim).toBeDefined();
    await createSession(client.db, {
      requestedSessionId: claim!.sessionId,
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "Maintain auth",
      resources: [],
      metadata: {},
      createdBy: { kind: "service", subjectId: "site-auth-maintenance" },
      createdByContext: {
        opengeniSiteAuthConnectionId: auth.connection.id,
        opengeniSiteAuthMaintenanceOperationId: claim!.operationId,
      },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      subjectId: "site-auth-maintenance",
      beforeCreateCommit: async (tx, sessionId) => {
        const confirmed = await confirmSiteAuthMaintenanceSessionInTransaction(tx, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          siteAuthConnectionId: auth.connection.id,
          operationId: claim!.operationId,
          sessionId,
        });
        if (!confirmed) throw new Error("maintenance claim changed");
      },
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: claim!.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: { role: "site_auth_maintenance" },
    });
    const attemptId = crypto.randomUUID();
    const claimedTurn = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: claim!.sessionId,
      workflowId: `session-${claim!.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimedTurn.action !== "claimed") {
      throw new Error(`Could not claim maintenance turn: ${claimedTurn.reason}`);
    }
    const browser = await activeBrowser(scope);
    const run = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      originatingSessionId: claim!.sessionId,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "continued-maintenance",
      expectedTargetGeneration: "continued-target-generation",
      expectedDocumentGeneration: "continued-document-generation",
      purpose: "health_check",
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      scope.workspaceId,
      scope.actorSubjectId,
      (db) =>
        submitHumanPromptInTransaction(db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          sessionId: claim!.sessionId,
          subjectId: scope.actorSubjectId,
          actor: { type: "human", subjectId: scope.actorSubjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Continue the same maintenance check",
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
    );
    expect(
      (
        await applySessionTurnSettlement(client.db, scope.workspaceId, {
          sessionId: claim!.sessionId,
          turnId: claimedTurn.turn.id,
          triggerEventId: claimedTurn.turn.triggerEventId,
          attemptId,
          turnStatus: "completed",
          sessionStatus: "idle",
          activeTurnId: null,
          events: [
            { type: "turn.completed", payload: {} },
            { type: "session.status.changed", payload: { status: "idle" } },
          ],
        })
      ).action,
    ).toBe("settled");
    expect((await getAuthRun(client.db, { ...scope, authRunId: run.run.id })).state).toBe(
      "discovering",
    );
    expect(
      (await listSiteAuthConnections(client.db, scope)).connections[0]!.maintenance,
    ).toMatchObject({ action: "health_check", sessionId: claim!.sessionId });

    await reportAuthRun(client.db, {
      ...scope,
      authRunId: run.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: run.run.version,
      state: "cancelled",
    });
    expect(
      (await listSiteAuthConnections(client.db, scope)).connections[0]!.maintenance,
    ).toBeNull();
  });
});
