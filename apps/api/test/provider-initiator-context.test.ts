import { afterAll, beforeAll, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  signDelegatedAccessToken,
  type CredentialProviderRequest,
  type Session,
  type SessionTurn,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  encryptEnvironmentValue,
  getSession,
  initializeSessionStartAtomically,
  listSessionTurns,
  upsertOrganizationCredentialProvider,
  upsertWorkspaceCredentialProvider,
  type DbClient,
} from "@opengeni/db";
import { verifyCredentialProviderRequest } from "@opengeni/sdk";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { bindRunCredentialResolver } from "../../worker/src/activities/run-credentials";
import { registerSessionRoutes } from "../src/routes/sessions";

let shared: SharedTestDatabase;
let db: DbClient;
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: "test-only-delegation-secret",
  environmentsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
  sandboxBackend: "none",
  integrationsAllowPrivateNetworkTargets: true,
});

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("provider-initiator-context");
  if (!acquired) throw new Error("Provider initiator tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

async function fixture(lane: "workspace" | "organization") {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db.db, {
    accountExternalSource: "provider-initiator",
    accountExternalId: suffix,
    accountName: "Provider initiator",
    workspaceExternalSource: "provider-initiator",
    workspaceExternalId: suffix,
    workspaceName: "Provider initiator",
    subjectId: `user:owner-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const secret = "test-only-provider-secret";
  const received: Array<{ body: string; headers: Headers; request: CredentialProviderRequest }> =
    [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const verified = await verifyCredentialProviderRequest({
        body,
        headers: request.headers,
        secret,
      });
      received.push({ body, headers: request.headers, request: verified });
      return Response.json({ status: "ok", environment: { AUTHORIZED_TURN: verified.turnId } });
    },
  });
  const provider = {
    ...scope,
    url: `http://127.0.0.1:${receiver.port}/credentials`,
    secretEncrypted: encryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, secret),
    enabled: true,
    timeoutMs: 2000,
    createdBySubjectId: null,
  };
  if (lane === "workspace") await upsertWorkspaceCredentialProvider(db.db, provider);
  else {
    const { workspaceId: _workspaceId, ...organizationProvider } = provider;
    await upsertOrganizationCredentialProvider(db.db, {
      ...organizationProvider,
      workspaceFilter: null,
    });
  }
  const noop = async () => undefined;
  const app = new Hono();
  registerSessionRoutes(app, {
    db: db.db,
    settings,
    bus: new MemoryEventBus(),
    objectStorage: null,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalSessionControl: noop,
    },
    githubStateSecret: "test",
  } as unknown as ApiRouteDeps);
  const service = {
    kind: "service" as const,
    subjectId: "product:scheduled-drift",
    label: "Scheduled drift",
  };
  const context = { occurrenceId: suffix, trigger: "cron", bounded: { region: "eu", sequence: 7 } };
  async function headers(kind: "human" | "service") {
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      ...scope,
      subjectId: kind === "human" ? grant.subjectId : `host:automation-${suffix}`,
      permissions: ["sessions:create", "sessions:read", "sessions:control"],
      principalKind: kind === "human" ? "human_session" : "service",
      ...(kind === "service"
        ? { serviceInitiator: service, serviceInitiatorContext: context }
        : {}),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }
  async function root(kind: "human" | "service") {
    const response = await app.request(
      `http://fixture/v1/workspaces/${scope.workspaceId}/sessions`,
      {
        method: "POST",
        headers: await headers(kind),
        body: JSON.stringify({
          initialMessage: "Inspect drift",
          resources: [],
          tools: [],
          sandboxBackend: "none",
        }),
      },
    );
    expect(response.status).toBe(202);
    const created = (await response.json()) as { id: string };
    const session = await getSession(db.db, scope.workspaceId, created.id);
    const [turn] = await listSessionTurns(db.db, scope.workspaceId, created.id);
    if (!session || !turn) throw new Error("API did not freeze the accepted turn");
    return { session: session as unknown as Session, turn };
  }
  async function bind(session: Session, turn: SessionTurn, attemptId = crypto.randomUUID()) {
    const resolver = await bindRunCredentialResolver({
      db: db.db,
      settings,
      ...scope,
      session,
      turn,
      attemptId,
      effectiveTools: [],
      effectiveSandboxBackend: "none",
      variableSet: null,
    });
    if (!resolver) throw new Error("Provider was not bound");
    return resolver;
  }
  async function claim(sessionId: string) {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db.db, scope.workspaceId, {
      sessionId,
      attemptId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Turn not claimed: ${claimed.action}`);
    return { turn: claimed.turn, attemptId };
  }
  async function settle(sessionId: string, claimed: Awaited<ReturnType<typeof claim>>) {
    await applySessionTurnSettlement(db.db, scope.workspaceId, {
      sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [],
    });
  }
  return {
    ...scope,
    grant,
    lane,
    app,
    headers,
    service,
    context,
    receiver,
    secret,
    received,
    root,
    bind,
    claim,
    settle,
  };
}

test.each(["workspace", "organization"] as const)(
  "%s provider verifies exact human and signed service turn bytes",
  async (lane) => {
    const f = await fixture(lane);
    try {
      for (const kind of ["human", "service"] as const) {
        const { session } = await f.root(kind);
        const { turn, attemptId } = await f.claim(session.id);
        const resolver = await f.bind(session, turn, attemptId);
        await resolver.resolve({ purpose: "provision", forceRefresh: false });
        const received = f.received.at(-1)!;
        expect(received.request).toMatchObject({
          lane,
          sessionId: session.id,
          turnId: turn.id,
          initiatorContext: { kind, initiator: turn.initiator, context: turn.initiatorContext },
          initiatingHumanSubjectId: kind === "human" ? f.grant.subjectId : null,
          initiatingHuman:
            kind === "human" ? { subjectId: f.grant.subjectId, externalIdentity: null } : null,
        });
        if (kind === "service")
          expect(received.request.initiatorContext).toEqual({
            kind,
            initiator: f.service,
            context: { ...f.context, label: f.service.label },
          });
        const tampered = JSON.stringify({
          ...received.request,
          initiatorContext: { kind: "human", context: {} },
        });
        await expect(
          verifyCredentialProviderRequest({
            body: tampered,
            headers: received.headers,
            secret: f.secret,
          }),
        ).rejects.toThrow();
        await resolver.resolve({ purpose: "renewal", forceRefresh: true });
        expect(f.received.at(-1)!.request.initiatorContext).toEqual(
          received.request.initiatorContext,
        );
      }
    } finally {
      f.receiver.stop(true);
    }
  },
  60_000,
);

test("a child of a signed service retains service identity and exact calling-attempt lineage", async () => {
  const f = await fixture("workspace");
  try {
    const { session } = await f.root("service");
    const parent = await f.claim(session.id);
    const child = await createSession(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      parentSessionId: session.id,
      initialMessage: "Inspect a drift shard",
      resources: [],
      metadata: {},
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      latencyMode: session.latencyMode,
      sandboxBackend: "none",
      createdByActor: {
        type: "agent_attempt",
        sessionId: session.id,
        turnId: parent.turn.id,
        attemptId: parent.attemptId,
        executionGeneration: parent.turn.executionGeneration,
      },
    });
    const started = await initializeSessionStartAtomically(db.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: child.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("Child initial turn missing");
    const resolver = await f.bind(child as unknown as Session, started.turn);
    await resolver.resolve({ purpose: "provision", forceRefresh: false });
    expect(f.received.at(-1)!.request).toMatchObject({
      sessionId: child.id,
      parentSessionId: session.id,
      rootSessionId: session.id,
      initiatingHuman: null,
      initiatorContext: {
        kind: "agent",
        initiator: f.service,
        context: {
          ...f.context,
          label: f.service.label,
          via: [
            {
              kind: "agent",
              sessionId: session.id,
              turnId: parent.turn.id,
              attemptId: parent.attemptId,
              executionGeneration: parent.turn.executionGeneration,
            },
          ],
        },
      },
    });
  } finally {
    f.receiver.stop(true);
  }
}, 60_000);

test.each([false, true])(
  "a service continuation freezes causal provenance and coalesced update ids (coalesced=%s)",
  async (coalesced) => {
    const f = await fixture("organization");
    try {
      const { session } = await f.root("service");
      const parent = await f.claim(session.id);
      await f.settle(session.id, parent);
      const goal = await createSessionGoal(db.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        text: "Complete drift inspection",
        createdBy: "api",
      });
      const update = await addSessionSystemUpdate(db.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        kind: "goal_continuation",
        classification: "info",
        sourceId: goal.id,
        dedupeKey: crypto.randomUUID(),
        summary: "Continue drift inspection",
        payload: {
          type: "goal_continuation",
          goalId: goal.id,
          goalVersion: goal.version,
          autoContinuation: 1,
          prompt: "Continue drift inspection",
        },
        lineage: { causalTurnId: parent.turn.id, goalId: goal.id },
      });
      if (!update.added) throw new Error(`Goal update refused: ${update.reason}`);
      const updateIds = [update.update.id];
      if (coalesced) {
        const notice = await addSessionSystemUpdate(db.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          kind: "child_progress",
          classification: "info",
          sourceId: crypto.randomUUID(),
          dedupeKey: crypto.randomUUID(),
          summary: "Drift shard progress",
          payload: {
            type: "child_progress",
            childSessionId: crypto.randomUUID(),
            goalId: goal.id,
            objectiveRevision: 1,
            operationId: crypto.randomUUID(),
            progressNote: "Inspecting",
          },
          lineage: { parentSessionId: session.id, parentTurnId: parent.turn.id },
        });
        if (!notice.added) throw new Error(`Child update refused: ${notice.reason}`);
        updateIds.push(notice.update.id);
      }
      const continuation = await f.claim(session.id);
      const resolver = await f.bind(session, continuation.turn, continuation.attemptId);
      await resolver.resolve({ purpose: "provision", forceRefresh: false });
      const received = f.received.at(-1)!.request;
      expect(received.initiatorContext).toEqual({
        kind: "service",
        initiator: continuation.turn.initiator,
        context: continuation.turn.initiatorContext,
      });
      expect(received.initiatorContext!.context).toMatchObject({
        updateIds,
        via: [
          {
            kind: "service",
            sessionId: session.id,
            turnId: parent.turn.id,
            initiator: f.service,
            context: { ...f.context, label: f.service.label },
          },
        ],
      });
      expect(received.initiatingHuman).toBeNull();
      expect(continuation.turn.initiator.subjectId).toBe(
        coalesced ? "internal-update" : "goal-continuation",
      );

      // A later human request and mutable projections cannot re-own this resolver.
      const followUp = await f.app.request(
        `http://fixture/v1/workspaces/${f.workspaceId}/sessions/${session.id}/events`,
        {
          method: "POST",
          headers: await f.headers("human"),
          body: JSON.stringify({
            type: "user.message",
            clientEventId: crypto.randomUUID(),
            payload: { text: "Human follow-up", resources: [] },
          }),
        },
      );
      expect(followUp.status).toBe(202);
      continuation.turn.initiatorContext.via = [];
      continuation.turn.initiator.subjectId = "mutated-projection";
      await resolver.resolve({ purpose: "renewal", forceRefresh: true });
      expect(f.received.at(-1)!.request.initiatorContext).toEqual(received.initiatorContext);
      expect(f.received.at(-1)!.request.turnId).toBe(continuation.turn.id);
    } finally {
      f.receiver.stop(true);
    }
  },
  60_000,
);
