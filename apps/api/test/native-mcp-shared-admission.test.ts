import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  OpenGeniClient,
  type SendMessageInput,
  type SubmitComposerDraftRequest,
} from "@opengeni/sdk";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createWorkspace,
  createOrganizationApiKey,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  claimSessionWorkForAttempt,
  type DbClient,
} from "@opengeni/db";
import { connectionTokenResolverForTurn } from "../../worker/src/activities/mcp-credentials";
import { createScheduledTaskActivities } from "../../worker/src/activities/scheduled-tasks";
import type { ActivityServices } from "../../worker/src/activities/types";
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("native-shared-public");
  if (!acquired) throw new Error("Native public admission regressions require PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test.each(["configured", "session-local", "durable"] as const)(
  "native OAuth shared %s turns use each asUser participant, including first text and children",
  async (configuration) => {
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('Native OAuth admission') returning id`;
    const accountId = account!.id as string;
    await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
      values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'native-test')`;
    const workspace = await createWorkspace(db.db, {
      accountId,
      name: "Shared OAuth",
      externalSource: "instance:shared",
      externalId: "customer",
    });
    const permissions = organizationApiKeyPermissionsForAccess("full");
    const token = crypto.randomUUID();
    await createOrganizationApiKey(db.db, {
      accountId,
      name: "Native fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions,
    });
    const identities = await Promise.all(
      ["alice", "bob"].map(async (externalId) => {
        const identity = await ensureExternalIdentity(db.db, { accountId, externalId });
        await grantWorkspaceAccess(db.db, {
          accountId,
          workspaceId: workspace.id,
          subjectId: identity.subjectId,
          permissions,
        });
        return identity;
      }),
    );
    const connectionRef = {
      providerDomain: "tools.example",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    };
    const server = { id: "example-tools", url: "https://tools.example/mcp", connectionRef };
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      productAccessMode: "configured",
      delegationSecret: "native-admission-test-secret",
      environmentsEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
      mcpServers: [server],
    });
    const noop = async () => undefined;
    const deps = {
      db: db.db,
      settings,
      bus: new MemoryEventBus(),
      objectStorage: null,
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalSessionControl: noop,
        syncScheduledTask: noop,
      },
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}),
    } as unknown as ApiRouteDeps;
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
      throw error;
    });
    registerSessionRoutes(app, deps);
    registerConnectionRoutes(app, deps);
    registerScheduledTaskRoutes(app, deps);
    const service = new OpenGeniClient({
      baseUrl: "http://fixture",
      apiKey: token,
      fetch: (input, init) => app.request(input, init),
    });
    const actors = [service.asUser("alice"), service.asUser("bob")];
    const selections = await Promise.all(
      actors.map(async (actor, i) => {
        const input = {
          providerDomain: "tools.example",
          kind: "oauth2" as const,
          ownership: "personal" as const,
          credential: { access_token: `synthetic-${i}`, token_type: "Bearer" },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          operationId: crypto.randomUUID(),
        };
        const connection = await actor.createConnection(workspace.id, input);
        expect(connection.subjectId).toBe(identities[i]!.subjectId);
        expect((await actor.createConnection(workspace.id, input)).id).toBe(connection.id);
        return {
          connection,
          selection: [{ serverId: server.id, connectionId: connection.id }],
        };
      }),
    );
    const scheduledUses: { actorIndex: number; authorize: () => Promise<boolean> }[] = [];
    const activities = createScheduledTaskActivities(
      async () => ({ settings, db: db.db, bus: deps.bus }) as unknown as ActivityServices,
    );
    for (const i of [0, 1]) {
      for (const runMode of [
        "new_session_per_run",
        "reusable_session",
        "existing_session",
      ] as const) {
        if (runMode === "existing_session" && configuration === "session-local")
          settings.mcpServers = [];
        const target =
          runMode === "existing_session"
            ? await actors[i]!.createSession(workspace.id, {
                startMode: "realtime",
                visibility: "workspace",
                tools: [{ kind: "mcp", id: server.id }],
                idempotencyKey: crypto.randomUUID(),
                ...(configuration === "session-local" ? { mcpServers: [server] } : {}),
              })
            : undefined;
        const task = await actors[i]!.createScheduledTask(workspace.id, {
          name: "Native OAuth schedule",
          schedule: { type: "manual" },
          runMode,
          ...(target ? { targetSessionId: target.id } : {}),
          agentConfig: {
            prompt: "Read my account",
            tools: target ? [] : [{ kind: "mcp", id: server.id }],
          },
          connectionAccounts: selections[i]!.selection,
        });
        if (target) {
          const updated = await actors[i]!.updateScheduledTask(workspace.id, task.id, {
            agentConfig: { prompt: "Read my account after updating the schedule", tools: [] },
            connectionAccounts: selections[i]!.selection,
          });
          expect(updated.id).toBe(task.id);
          expect(updated.agentConfig.tools).toEqual([]);
        }
        const [stored] =
          await shared.admin`select owner_subject_id from scheduled_tasks where id = ${task.id}`;
        expect(stored!.owner_subject_id).toBe(identities[i]!.subjectId);
        const dispatch = {
          workspaceId: workspace.id,
          taskId: task.id,
          triggerType: "scheduled" as const,
          producerKey: crypto.randomUUID(),
        };
        const occurrence = await activities.dispatchScheduledTaskRun(dispatch);
        expect(occurrence.action).toBe(target ? "signal" : "start");
        if (occurrence.action !== "start" && occurrence.action !== "signal")
          throw new Error(`Schedule failed: ${JSON.stringify(occurrence)}`);
        expect((await activities.dispatchScheduledTaskRun(dispatch)).sessionId).toBe(
          occurrence.sessionId,
        );
        const scheduledAttemptId = crypto.randomUUID();
        const scheduledClaim = await claimSessionWorkForAttempt(db.db, workspace.id, {
          sessionId: occurrence.sessionId,
          workflowId: occurrence.workflowId,
          workflowRunId: crypto.randomUUID(),
          attemptId: scheduledAttemptId,
          dispatchId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        if (scheduledClaim.action !== "claimed")
          throw new Error("Cannot claim scheduled occurrence");
        expect(scheduledClaim.turn.initiatingHumanSubjectId).toBe(identities[i]!.subjectId);
        expect(scheduledClaim.turn.personalConnectionDelegations).toMatchObject([
          { connectionId: selections[i]!.connection.id, ownerSubjectId: identities[i]!.subjectId },
        ]);
        expect(scheduledClaim.turn.mcpAccountBindings).toHaveLength(1);
        const scheduledBinding = scheduledClaim.turn.mcpAccountBindings![0]!;
        expect(scheduledBinding).toMatchObject({
          canonicalServerId: server.id,
          connectionId: selections[i]!.connection.id,
          ownerSubjectId: identities[i]!.subjectId,
        });
        const scheduledResolver = connectionTokenResolverForTurn({
          db: db.db,
          settings,
          accountId,
          workspaceId: workspace.id,
          sessionId: occurrence.sessionId,
          attemptId: scheduledAttemptId,
          turn: scheduledClaim.turn,
        });
        const credential = await scheduledResolver({
          workspaceId: workspace.id,
          subjectId: identities[i]!.subjectId,
          serverId: scheduledBinding.serverId,
          destinationUrl: server.url,
          connectionRef: scheduledBinding.connectionRef,
        });
        expect(credential.status).toBe("ok");
        if (credential.status !== "ok")
          throw new Error(`Scheduled access denied: ${credential.reason}`);
        expect(credential.headers.Authorization ?? credential.headers.authorization).toBe(
          `Bearer synthetic-${i}`,
        );
        expect(await credential.authorizeProviderRequest?.()).toBe(true);
        if (!credential.authorizeProviderRequest)
          throw new Error("Scheduled access lacks live authority check");
        scheduledUses.push({ actorIndex: i, authorize: credential.authorizeProviderRequest });
        settings.mcpServers = [server];
      }
    }
    if (configuration === "session-local") settings.mcpServers = [];
    const session = await actors[0]!.createSession(workspace.id, {
      startMode: "realtime",
      visibility: "workspace",
      tools: [{ kind: "mcp", id: server.id }],
      idempotencyKey: crypto.randomUUID(),
      ...(configuration === "session-local" ? { mcpServers: [server] } : {}),
    });
    const drafts = new Map<string, SubmitComposerDraftRequest>();
    const send = async (actor: OpenGeniClient, message: SendMessageInput) => {
      if (configuration !== "durable") return actor.sendMessage(workspace.id, session.id, message);
      const clientEventId = message.clientEventId ?? crypto.randomUUID();
      let draft = drafts.get(clientEventId);
      if (!draft) {
        const current = await actor.getComposerDraft(workspace.id, session.id);
        const saved = await actor.saveComposerDraft(workspace.id, session.id, {
          ...current,
          text: message.text,
          expectedRevision: current.revision,
        });
        draft = {
          ...saved,
          annotations: [],
          connectionAccounts: message.connectionAccounts ?? [],
          expectedDraftRevision: saved.revision,
          clientEventId,
          delivery: "send",
        };
        drafts.set(clientEventId, draft);
      }
      return (await actor.submitComposerDraft(workspace.id, session.id, { ...draft, ...message }))
        .accepted;
    };
    const snapshots = () =>
      shared.admin`select id, initiator_subject_id, personal_connection_delegations from session_turns where session_id = ${session.id} order by created_at, id`;
    expect(await snapshots()).toHaveLength(0);
    const bob = actors[1]!;
    const first = {
      text: "First text from non-creator",
      clientEventId: crypto.randomUUID(),
      connectionAccounts: selections[1]!.selection,
    };
    const event = await send(bob, first);
    expect((await send(bob, first)).id).toBe(event.id);
    await send(actors[0]!, {
      text: "Other participant",
      clientEventId: crypto.randomUUID(),
      connectionAccounts: selections[0]!.selection,
    });
    const captured = await snapshots();
    expect(captured).toHaveLength(2);
    for (const i of [0, 1]) {
      const own = captured.find((row) => row.initiator_subject_id === identities[i]!.subjectId);
      expect(own?.personal_connection_delegations).toMatchObject([
        { connectionId: selections[i]!.connection.id, ownerSubjectId: identities[i]!.subjectId },
      ]);
    }
    await expect(
      send(bob, { text: "Cannot borrow", connectionAccounts: selections[0]!.selection }),
    ).rejects.toMatchObject({ status: 422, retryable: false, outcomeUnknown: false });
    expect(await snapshots()).toHaveLength(2);
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db.db, workspace.id, {
      sessionId: session.id,
      workflowId: session.temporalWorkflowId!,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`Cannot claim: ${claim.action}`);
    expect(claim.turn.initiatingHumanSubjectId).toBe(identities[1]!.subjectId);
    expect(claim.turn.mcpAccountBindings).toHaveLength(1);
    const binding = claim.turn.mcpAccountBindings![0]!;
    expect(binding).toMatchObject({
      canonicalServerId: server.id,
      connectionId: selections[1]!.connection.id,
      ownerSubjectId: identities[1]!.subjectId,
    });
    const resolver = connectionTokenResolverForTurn({
      db: db.db,
      settings,
      accountId,
      workspaceId: workspace.id,
      sessionId: session.id,
      attemptId,
      turn: claim.turn,
    });
    const request = {
      workspaceId: workspace.id,
      subjectId: identities[1]!.subjectId,
      serverId: binding.serverId,
      destinationUrl: server.url,
      connectionRef: binding.connectionRef,
    };
    const resolved = await resolver(request);
    expect((await resolver({ ...request, serverId: server.id })).status).toBe("auth_needed");
    expect(
      (
        await resolver({
          ...request,
          connectionRef: { ...binding.connectionRef, connectionId: selections[0]!.connection.id },
        })
      ).status,
    ).toBe("auth_needed");
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") throw new Error(`Native resolution denied: ${resolved.reason}`);
    expect(resolved.headers.Authorization ?? resolved.headers.authorization).toBe(
      "Bearer synthetic-1",
    );
    expect(await resolved.authorizeProviderRequest?.()).toBe(true);
    const agent = new OpenGeniClient({
      baseUrl: "http://fixture",
      fetch: (input, init) => app.request(input, init),
      apiKey: await signDelegatedAccessToken(settings.delegationSecret!, {
        accountId,
        workspaceId: workspace.id,
        subjectId: "worker:fixture",
        principalKind: "agent_attempt",
        permissions: ["sessions:create", "sessions:read"],
        firstPartyMcpTools: ["session_create"],
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
    const child = await agent.createSession(workspace.id, {
      initialMessage: "Use spawning user's connection",
      tools: [{ kind: "mcp", id: server.id }],
      visibility: "workspace",
    });
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(db.db, workspace.id, {
      sessionId: child.id,
      workflowId: child.temporalWorkflowId!,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (childClaim.action !== "claimed") throw new Error("Cannot claim child");
    expect(childClaim.turn.initiatingHumanSubjectId).toBe(identities[1]!.subjectId);
    expect(childClaim.turn.mcpAccountBindings).toEqual(claim.turn.mcpAccountBindings);
    expect(childClaim.turn.personalConnectionDelegations).toMatchObject([
      { connectionId: selections[1]!.connection.id, ownerSubjectId: identities[1]!.subjectId },
    ]);
    const childResolver = connectionTokenResolverForTurn({
      db: db.db,
      settings,
      accountId,
      workspaceId: workspace.id,
      sessionId: child.id,
      attemptId: childAttemptId,
      turn: childClaim.turn,
    });
    expect((await childResolver(request)).status).toBe("ok");
    await bob.deleteConnection(workspace.id, selections[1]!.connection.id);
    for (const use of scheduledUses) expect(await use.authorize()).toBe(use.actorIndex === 0);
    expect(await resolved.authorizeProviderRequest?.()).toBe(false);
    expect((await childResolver(request)).status).toBe("auth_needed");
    await expect(
      send(bob, { text: "Revoked selection", connectionAccounts: selections[1]!.selection }),
    ).rejects.toMatchObject({ status: 422, retryable: false, outcomeUnknown: false });
  },
  90_000,
);
