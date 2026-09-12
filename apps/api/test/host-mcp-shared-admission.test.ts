import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OpenGeniClient } from "@opengeni/sdk";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { type ApiRouteDeps } from "@opengeni/core";
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
import { registerSessionRoutes } from "../src/routes/sessions";
import { registerHostMcpBindingRoutes } from "../src/routes/host-mcp-bindings";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("host-shared-public");
  if (!acquired) throw new Error("Host public admission regressions require PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

test.each(["configured", "session-local"] as const)(
  "public asUser shared %s turns capture each owner and first text after an empty realtime create",
  async (configuration) => {
    const [account] =
      await shared.admin`insert into managed_accounts (name) values ('Shared host admission') returning id`;
    const accountId = account!.id as string;
    const workspace = await createWorkspace(db.db, { accountId, name: "Shared host admission" });
    const permissions = [
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "connections:read",
      "connections:write",
      "mcp_servers:attach",
      "scheduled_tasks:manage",
    ] as const;
    const token = crypto.randomUUID();
    await createOrganizationApiKey(db.db, {
      accountId,
      name: "Host admission fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: [...permissions],
    });
    const identities = await Promise.all(
      ["alice", "bob"].map(async (externalId) => {
        const identity = await ensureExternalIdentity(db.db, { accountId, externalId });
        await grantWorkspaceAccess(db.db, {
          accountId,
          workspaceId: workspace.id,
          subjectId: identity.subjectId,
          permissions: [...permissions],
        });
        return identity;
      }),
    );
    const connectionRef = {
      authoritySource: "host" as const,
      providerDomain: "tools.example",
      provider: "example",
      kind: "delegated" as const,
      subjectScope: "subject" as const,
      scopes: ["read"],
      hostBinding: { selection: "accepted_turn" as const },
    };
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      productAccessMode: "configured",
      hostMcpAuthoritySourceAdmissionEnabled: true,
      delegationSecret: "host-admission-test-secret",
      mcpServers: [{ id: "host-tools", url: "https://tools.example/mcp", connectionRef }],
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
    registerHostMcpBindingRoutes(app, deps);
    registerScheduledTaskRoutes(app, deps);
    const service = new OpenGeniClient({
      baseUrl: "http://fixture",
      apiKey: token,
      fetch: (input, init) => app.request(input, init),
    });
    const actors = [service.asUser("alice"), service.asUser("bob")];
    const grants = await Promise.all(
      actors.map(async (actor, i) => {
        const { hostBinding: _selector, ...ref } = connectionRef;
        const binding = await actor.createHostMcpBinding(workspace.id, {
          operationId: crypto.randomUUID(),
          definition: {
            serverId: "host-tools",
            destinationUrl: "https://tools.example/mcp",
            connectionRef: { ...ref, connectionId: `account-${i}` },
          },
        });
        const delegation = await actor.issueHostMcpDelegation(workspace.id, {
          operationId: crypto.randomUUID(),
          bindingId: binding.id,
          expectedBindingGeneration: binding.generation,
          grant: {
            scope: "user",
            mode: "always",
            context: "workspace_shared",
            workspaceSharedAcknowledged: true,
          },
        });
        return {
          binding,
          delegation,
          selection: [
            {
              serverId: "host-tools",
              delegationId: delegation.id,
              generation: delegation.generation,
            },
          ],
        };
      }),
    );
    const alice = actors[0]!,
      bob = actors[1]!;
    for (const i of [0, 1]) {
      const task = await actors[i]!.createScheduledTask(workspace.id, {
        name: "Selected host schedule",
        schedule: { type: "manual" },
        runMode: "new_session_per_run",
        agentConfig: { prompt: "Read my account", tools: [{ kind: "mcp", id: "host-tools" }] },
        selectedHostMcpDelegations: grants[i]!.selection,
      });
      const [snapshot] =
        await shared.admin`select owner_subject_id, binding_id from host_mcp_task_authorities
      where task_id = ${task.id} and task_authority_revision = ${task.authorityRevision}`;
      expect(snapshot).toMatchObject({
        owner_subject_id: identities[i]!.subjectId,
        binding_id: grants[i]!.binding.id,
      });
    }
    const server = settings.mcpServers[0]!;
    if (configuration === "session-local") settings.mcpServers = [];
    const session = await alice.createSession(workspace.id, {
      startMode: "realtime",
      visibility: "workspace",
      ...(configuration === "session-local" ? { mcpServers: [server] } : {}),
      tools: [{ kind: "mcp", id: "host-tools" }],
      idempotencyKey: crypto.randomUUID(),
    });
    const snapshots =
      () => shared.admin`select a.turn_id, a.owner_subject_id, a.binding_id, a.canonical_snapshot,
    jsonb_build_object('kind', t.initiator_kind, 'subjectId', t.initiator_subject_id) as initiator
    from host_mcp_turn_authorities a join session_turns t on t.id = a.turn_id
    where a.session_id = ${session.id} order by t.created_at, t.id`;
    expect(await snapshots()).toHaveLength(0);
    await expect(
      bob.createSession(workspace.id, {
        startMode: "realtime",
        selectedHostMcpDelegations: grants[1]!.selection,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bob.sendMessage(workspace.id, session.id, {
        text: "Stale selection",
        selectedHostMcpDelegations: [{ ...grants[1]!.selection[0]!, generation: 2 }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const privateGrant = await bob.issueHostMcpDelegation(workspace.id, {
      operationId: crypto.randomUUID(),
      bindingId: grants[1]!.binding.id,
      expectedBindingGeneration: 1,
      grant: { scope: "user", mode: "always", context: "user_private" },
    });
    await expect(
      bob.sendMessage(workspace.id, session.id, {
        text: "Wrong visibility",
        selectedHostMcpDelegations: [
          { serverId: "host-tools", delegationId: privateGrant.id, generation: 1 },
        ],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await snapshots()).toHaveLength(0);
    const first = {
      text: "First text from a non-creator",
      clientEventId: crypto.randomUUID(),
      selectedHostMcpDelegations: grants[1]!.selection,
    };
    const firstEvent = await bob.sendMessage(workspace.id, session.id, first);
    expect((await bob.sendMessage(workspace.id, session.id, first)).id).toBe(firstEvent.id);
    const second = {
      text: "Other participant",
      clientEventId: crypto.randomUUID(),
      selectedHostMcpDelegations: grants[0]!.selection,
    };
    await alice.sendMessage(workspace.id, session.id, second);
    const captured = await snapshots();
    expect(captured).toHaveLength(2);
    for (const i of [0, 1]) {
      const own = captured.find((row) => row.owner_subject_id === identities[i]!.subjectId)!;
      expect(own.binding_id).toBe(grants[i]!.binding.id);
      expect(own.initiator).toEqual({ kind: "subject", subjectId: identities[i]!.subjectId });
      expect(own.canonical_snapshot.definition.connectionRef.connectionId).toBe(`account-${i}`);
    }
    await expect(
      bob.sendMessage(workspace.id, session.id, {
        ...first,
        selectedHostMcpDelegations: grants[0]!.selection,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      bob.sendMessage(workspace.id, session.id, {
        text: "Cannot borrow",
        selectedHostMcpDelegations: grants[0]!.selection,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await snapshots()).toHaveLength(2);
    await bob.sendMessage(workspace.id, session.id, "No implicit selection");
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
    expect(claim.action).toBe("claimed");
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
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
      initialMessage: "Use the spawning turn's account",
      tools: [{ kind: "mcp", id: "host-tools" }],
      visibility: "workspace",
    });
    const [childAuthority] =
      await shared.admin`select owner_subject_id, binding_id, canonical_snapshot from host_mcp_turn_authorities where session_id = ${child.id}`;
    expect(childAuthority).toMatchObject({
      owner_subject_id: identities[1]!.subjectId,
      binding_id: grants[1]!.binding.id,
      canonical_snapshot: {
        source: { kind: "child_turn", sessionId: session.id, turnId: claim.turn.id },
      },
    });
    let physicalResolutions = 0;
    const resolver = connectionTokenResolverForTurn({
      db: db.db,
      settings,
      accountId,
      workspaceId: workspace.id,
      sessionId: session.id,
      rootSessionId: session.id,
      attemptId,
      turn: claim.turn,
      connectionCredentials: {
        mcpCredentials: async (request) => {
          physicalResolutions++;
          expect(request.initiator).toEqual({
            kind: "subject",
            subjectId: identities[1]!.subjectId,
          });
          expect(request.connectionRef.hostBinding).toEqual({
            bindingId: grants[1]!.binding.id,
            generation: 1,
          });
          return {
            status: "ok",
            accountId,
            workspaceId: workspace.id,
            sessionId: session.id,
            provider: "example",
            providerDomain: "tools.example",
            scopes: ["read"],
            connectionId: "account-1",
            headers: { authorization: "Bearer synthetic" },
          };
        },
      },
    });
    const resolved = await resolver({
      workspaceId: workspace.id,
      serverId: "host-tools",
      destinationUrl: "https://tools.example/mcp",
      connectionRef,
    });
    expect(resolved.status).toBe("ok");
    expect(physicalResolutions).toBe(1);
    await bob.revokeHostMcpDelegation(workspace.id, grants[1]!.delegation.id, {
      expectedGeneration: 1,
    });
    if (resolved.status === "ok") expect(await resolved.authorizeProviderRequest!()).toBe(false);
    expect((await bob.sendMessage(workspace.id, session.id, first)).id).toBe(firstEvent.id);
    expect(await snapshots()).toHaveLength(2);
  },
  90_000,
);
