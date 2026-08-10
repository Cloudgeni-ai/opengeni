import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  acceptSessionApprovalDecision,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createInteractionIntervention,
  createNetworkRoute,
  createSession,
  createSiteAuthConnection,
  completeProtectedAuthFill,
  dispatchBrowserSessionOperation,
  dispatchProtectedAuthFill,
  expireSessionInteractionIntervention,
  getAuthRun,
  getInteractionIntervention,
  getInteractionInterventionResumeForEvent,
  getProtectedAuthFillPreparation,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
  listInteractionInterventions,
  listNetworkRoutes,
  listSiteAuthConnections,
  peekSessionWork,
  prepareProtectedAuthFill,
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
    placement: { kind: "sandbox_group" as const, sandboxGroupId: scope.sandboxGroupId },
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
    healthPolicy: { mode: "on_use" as const, intervalSeconds: null, automaticRepair: false },
  };
}

describe("browser auth and network resources", () => {
  test("keeps route mutations idempotent, version-fenced, and independently discoverable", async () => {
    if (!available) return;
    const scope = await fixture();
    const request = directRoute();
    const created = await createNetworkRoute(client.db, { ...scope, ...request });
    expect(created).toMatchObject({ replayed: false, operationId: request.operationId });
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
    expect(updated.route).toMatchObject({ name: "Direct preferred", version: 2 });
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
        { id: "password", purpose: "password" as const, credentialKey: "password" },
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

  test("runs exact-target auth and resumes it through one durable intervention", async () => {
    if (!available) return;
    const scope = await fixture();
    const auth = await createSiteAuthConnection(client.db, { ...scope, ...humanSiteAuth() });
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
    expect(intervention.intervention).toMatchObject({ status: "open", version: 1 });
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
    expect(resolved.intervention).toMatchObject({ status: "completed", version: 2 });
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
    const auth = await createSiteAuthConnection(client.db, { ...scope, ...humanSiteAuth() });
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
        { fieldId: "email", locator: { kind: "css" as const, selector: "#email" } },
        { fieldId: "password", locator: { kind: "css" as const, selector: "#password" } },
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
      response: { replayed: true, run: { interventionId: waiting.run.interventionId } },
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
        { type: "session.status.changed", payload: { status: "requires_action" } },
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
        serializedRunState: JSON.stringify({ version: 1, interrupted: true, resumed: true }),
        pendingApprovals: [{ id: toolCallId }],
        interactionInterventionRequests: [
          { id: interventionId, operationId, toolCallId, input: request },
        ],
      },
      events: [{ type: "session.status.changed", payload: { status: "requires_action" } }],
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
        { fieldId: "email", locator: { kind: "css" as const, selector: "#email" } },
        { fieldId: "password", locator: { kind: "css" as const, selector: "#password" } },
      ],
      submit: { type: "click" as const, locator: { kind: "css" as const, selector: "#login" } },
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
      run: { state: "working", version: 2, documentGeneration: "document-generation-2" },
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
    });
  });
});
