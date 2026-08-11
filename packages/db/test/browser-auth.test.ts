import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
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
  completeProtectedAuthFill,
  dispatchBrowserSessionOperation,
  dispatchProtectedAuthFill,
  dispatchExternalAuth,
  expireSessionInteractionIntervention,
  findBrowserSessionControlRecordByOperation,
  getAuthRun,
  getExternalAuthInteractiveContext,
  getInteractionIntervention,
  getInteractionInterventionResumeForEvent,
  getProtectedAuthFillPreparation,
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
  prepareProtectedAuthFill,
  prepareExternalAuth,
  prepareBrowserSessionCreate,
  reportAuthRun,
  resolveInteractionIntervention,
  startAuthRun,
  submitHumanPromptInTransaction,
  updateNetworkRoute,
  updateSiteAuthConnection,
  verifyAuthRun,
  withWorkspaceSubjectRls,
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
  await withWorkspaceSubjectRls(client.db, scope.workspaceId, scope.actorSubjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof db, {
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
    ),
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

function humanSiteAuth(operationId = crypto.randomUUID()) {
  return {
    operationId,
    name: `Example ${operationId.slice(0, 8)}`,
    accountLabel: "test@example.com",
    origins: ["https://example.com"],
    loginUrl: "https://example.com/login",
    verificationUrlPrefixes: ["https://example.com/app"],
    authorities: [
      {
        id: "human",
        kind: "human" as const,
        label: "Ask the user",
        fields: [
          { id: "email", purpose: "identifier" as const },
          { id: "password", purpose: "password" as const },
        ],
      },
    ],
    methods: [
      {
        id: "password",
        kind: "password" as const,
        label: "Email and password",
        authorityIds: ["human"],
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

function externalSiteAuth(operationId = crypto.randomUUID()) {
  return {
    ...humanSiteAuth(operationId),
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
    await shared!.admin`
      insert into connections (
        id, account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, status, created_by_subject_id, updated_by_subject_id
      ) values (
        ${connectionId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.actorSubjectId},
        'example.com', 'api_key', 'encrypted-never-read-here', 'active',
        ${scope.actorSubjectId}, ${scope.actorSubjectId}
      )`;
    const operationId = crypto.randomUUID();
    const base = humanSiteAuth(operationId);
    const credentialAuthority = {
      id: "connection",
      kind: "connection_fields" as const,
      label: "Saved connection",
      credential: {
        connectionId,
        connectionSubjectId: scope.actorSubjectId,
        providerDomain: "example.com",
      },
      fields: [
        { id: "email", purpose: "identifier" as const, credentialKey: "email" },
        {
          id: "password",
          purpose: "password" as const,
          credentialKey: "password",
        },
      ],
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
        ...humanSiteAuth(),
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
        ...humanSiteAuth(),
        preferredNetworkRouteId: route.route.id,
      }),
    ).rejects.toThrow("external browser provider placement");
    const configured = await createSiteAuthConnection(client.db, {
      ...scope,
      ...humanSiteAuth(),
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
      ...humanSiteAuth(),
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
      methodId: "password",
      authorityId: "human",
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
        methodId: "password",
        authorityId: "human",
      }),
    ).toMatchObject({ replayed: true });

    const waiting = await reportAuthRun(client.db, {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      state: "awaiting_secret",
      pendingFields: [
        { id: "email", label: "Email", purpose: "identifier" },
        { id: "password", label: "Password", purpose: "password" },
      ],
    });
    expect(waiting.run).toMatchObject({ state: "awaiting_secret", version: 2 });

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

  test("atomically turns a human protected fill into one replay-safe intervention", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...humanSiteAuth(),
    });
    const browser = await activeBrowser(scope);
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-human",
      expectedTargetGeneration: "target-generation-human",
      expectedDocumentGeneration: "document-generation-human",
      methodId: "password",
      authorityId: "human",
    });
    const operationId = crypto.randomUUID();
    const request = {
      operationId,
      expectedVersion: started.run.version,
      expectedTargetGeneration: "target-generation-human",
      expectedDocumentGeneration: "document-generation-human",
      expectedFrameId: "frame-human",
      authorityId: "human",
      fields: [
        {
          fieldId: "email",
          locator: { kind: "css" as const, selector: "#email" },
        },
        {
          fieldId: "password",
          locator: { kind: "css" as const, selector: "#password" },
        },
      ],
      submit: { type: "none" as const },
    };
    await prepareProtectedAuthFill(client.db, {
      ...scope,
      authRunId: started.run.id,
      credentialVersion: null,
      ...request,
    });
    const waiting = await completeProtectedAuthFill(client.db, {
      ...scope,
      authRunId: started.run.id,
      operationId,
      status: "needs_human",
      intervention: {
        originatingSessionId: scope.sessionId,
        kind: "manual_login",
        reason: "Sign in in this browser tab.",
        expiresInSeconds: 900,
      },
    });
    expect(waiting).toMatchObject({
      status: "needs_human",
      replayed: false,
      run: { state: "awaiting_secret", version: 2 },
    });
    expect(waiting.run.interventionId).toBeString();
    expect((await listInteractionInterventions(client.db, scope)).interventions).toEqual([
      expect.objectContaining({
        id: waiting.run.interventionId,
        operationId,
        status: "open",
        authRunId: started.run.id,
      }),
    ]);
    expect(
      await prepareProtectedAuthFill(client.db, {
        ...scope,
        authRunId: started.run.id,
        credentialVersion: null,
        ...request,
      }),
    ).toMatchObject({
      replayed: true,
      response: {
        replayed: true,
        run: { interventionId: waiting.run.interventionId },
      },
    });
    await resolveInteractionIntervention(client.db, {
      ...scope,
      interventionId: waiting.run.interventionId!,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      outcome: "completed",
    });
    expect(await getAuthRun(client.db, { ...scope, authRunId: started.run.id })).toMatchObject({
      state: "working",
      interventionId: null,
      version: 3,
    });
  });

  test("advances external auth durably and rebinds the run after provider profile load", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...externalSiteAuth(),
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

  test("fences protected credential fill and verifies only the observed exact target", async () => {
    if (!available) return;
    const scope = await fixture();
    const credentialId = crypto.randomUUID();
    await shared!.admin`
      insert into connections (
        id, account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted, status, version, created_by_subject_id, updated_by_subject_id
      ) values (
        ${credentialId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.actorSubjectId},
        'example.com', 'api_key', 'encrypted-outside-auth-run', 'active', 7,
        ${scope.actorSubjectId}, ${scope.actorSubjectId}
      )`;
    const base = humanSiteAuth();
    const auth = await createSiteAuthConnection(client.db, {
      ...scope,
      ...base,
      authorities: [
        {
          id: "saved",
          kind: "connection_fields",
          label: "Saved login",
          credential: {
            connectionId: credentialId,
            connectionSubjectId: scope.actorSubjectId,
            providerDomain: "example.com",
          },
          fields: [
            { id: "email", purpose: "identifier", credentialKey: "email" },
            { id: "password", purpose: "password", credentialKey: "password" },
          ],
        },
      ],
      methods: [{ ...base.methods[0]!, authorityIds: ["saved"] }],
    });
    const browser = await activeBrowser(scope);
    const started = await startAuthRun(client.db, {
      ...scope,
      ...browser,
      operationId: crypto.randomUUID(),
      siteAuthConnectionId: auth.connection.id,
      targetId: "target-1",
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      methodId: "password",
      authorityId: "saved",
    });
    const operationId = crypto.randomUUID();
    const request = {
      operationId,
      expectedVersion: started.run.version,
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      expectedFrameId: "frame-1",
      authorityId: "saved",
      fields: [
        {
          fieldId: "email",
          locator: { kind: "css" as const, selector: "#email" },
        },
        {
          fieldId: "password",
          locator: { kind: "css" as const, selector: "#password" },
        },
      ],
      submit: {
        type: "click" as const,
        locator: { kind: "css" as const, selector: "#login" },
      },
    };
    expect(
      await getProtectedAuthFillPreparation(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...request,
      }),
    ).toBeNull();
    const prepared = await prepareProtectedAuthFill(client.db, {
      ...scope,
      authRunId: started.run.id,
      credentialVersion: 7,
      ...request,
    });
    expect(prepared).toMatchObject({
      operationState: "prepared",
      credentialVersion: 7,
      response: null,
    });
    expect(
      await getProtectedAuthFillPreparation(client.db, {
        ...scope,
        authRunId: started.run.id,
        ...request,
      }),
    ).toMatchObject({ operationState: "prepared", credentialVersion: 7 });
    expect(
      await dispatchProtectedAuthFill(client.db, {
        ...scope,
        authRunId: started.run.id,
        operationId,
      }),
    ).toBe("dispatched");
    const completed = await completeProtectedAuthFill(client.db, {
      ...scope,
      authRunId: started.run.id,
      operationId,
      status: "submitted",
      targetGeneration: "target-generation-1",
      documentGeneration: "document-generation-2",
    });
    expect(completed).toMatchObject({
      status: "submitted",
      replayed: false,
      run: {
        state: "working",
        version: 2,
        documentGeneration: "document-generation-2",
      },
    });
    expect(
      await prepareProtectedAuthFill(client.db, {
        ...scope,
        authRunId: started.run.id,
        credentialVersion: 99,
        ...request,
      }),
    ).toMatchObject({
      operationState: "completed",
      credentialVersion: 7,
      replayed: true,
      response: { replayed: true },
    });
    const [operation] = await shared!.admin<
      Array<{ metadata: unknown; result: unknown }>
    >`select metadata, result from interaction_resource_operations where operation_id = ${operationId}`;
    expect(JSON.stringify(operation)).not.toContain("encrypted-outside-auth-run");

    const verified = await verifyAuthRun(client.db, {
      ...scope,
      authRunId: started.run.id,
      controllerGeneration: browser.controllerGeneration,
      targetId: "target-1",
      targetGeneration: "target-generation-1",
      documentGeneration: "document-generation-2",
      url: "https://example.com/app/home",
      operationId: crypto.randomUUID(),
      expectedVersion: completed.run.version,
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
    const request = humanSiteAuth();
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
      ...humanSiteAuth(),
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
        label: "OpenGeni authentication maintenance",
      },
      createdByContext: {
        opengeniSiteAuthConnectionId: auth.connection.id,
        opengeniSiteAuthMaintenanceOperationId: reclaimed!.operationId,
      },
      model: "scripted-model",
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
      ...humanSiteAuth(),
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
      ...humanSiteAuth(),
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
      ...humanSiteAuth(),
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
    await withWorkspaceSubjectRls(client.db, scope.workspaceId, scope.actorSubjectId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as typeof db, {
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
      ),
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
