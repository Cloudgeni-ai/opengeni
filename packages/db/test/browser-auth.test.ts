import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  createDb,
  createInteractionIntervention,
  createNetworkRoute,
  createSession,
  createSiteAuthConnection,
  dispatchBrowserSessionOperation,
  getAuthRun,
  getInteractionIntervention,
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  listInteractionInterventions,
  listNetworkRoutes,
  listSiteAuthConnections,
  prepareBrowserSessionCreate,
  reportAuthRun,
  resolveInteractionIntervention,
  startAuthRun,
  updateNetworkRoute,
  updateSiteAuthConnection,
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
});
