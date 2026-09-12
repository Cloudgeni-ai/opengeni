// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createNativeRemoteMcpCredentialsPort } from "@opengeni/core/remote-mcp-credentials";
import {
  acquireOwnerMigratedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  createDb,
  createOrganizationApiKey,
  mutateHostMcpResolver,
  createWorkspace,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  createHostMcpBinding,
  issueHostMcpDelegation,
  createScheduledTask,
  captureHostMcpTaskAuthorities,
  claimSessionWorkForAttempt,
  authorizeDirectHostMcpUse,
  resolveAcceptedHostMcpBinding,
  buildHostConnectionTokenResolver,
  revokeHostMcpDelegation,
  createSession,
  initializeSessionStartAtomically,
  inheritHostMcpTaskAuthoritiesFromAttempt,
  getHostMcpTaskAuthorities,
  type DbClient,
} from "@opengeni/db";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase | null;
let client: DbClient;
beforeAll(async () => {
  const owned = await acquireOwnerMigratedTestDatabase("scheduled-host-mcp");
  if (!owned) throw new Error("This host authority test requires PostgreSQL");
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  shared = { ...owned, appUrl: appUrl.toString() };
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function verifyScheduledHostSelection(selectionMode: "fixed" | "accepted_turn") {
  for (const runMode of ["new_session_per_run", "reusable_session", "existing_session"] as const) {
    const [account] = await shared!
      .admin`insert into managed_accounts (name) values ('scheduled host fixture') returning id`;
    const workspace = await createWorkspace(client.db, {
      accountId: account!.id,
      name: "Host schedule",
      externalSource: "instance:scheduled",
      externalId: "customer",
    });
    const identity = await ensureExternalIdentity(client.db, {
      accountId: account!.id,
      externalId: "product-owner",
    });
    await grantWorkspaceAccess(client.db, {
      accountId: account!.id,
      workspaceId: workspace.id,
      subjectId: identity.subjectId,
      permissions: [
        "sessions:read",
        "sessions:create",
        "sessions:control",
        "connections:read",
        "connections:write",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ],
    });
    const owner = {
      accountId: account!.id,
      workspaceId: workspace.id,
      subjectId: identity.subjectId,
      authorizationRevision: identity.authorizationRevision,
    };
    const binding = await createHostMcpBinding(client.db, owner, {
      operationId: crypto.randomUUID(),
      definition: {
        serverId: "product",
        destinationUrl: "https://host.fixture.invalid/mcp",
        connectionRef: {
          authoritySource: "host",
          connectionId: "product-account",
          providerDomain: "host.fixture.invalid",
          subjectScope: "subject",
        },
      },
    });
    const delegation = await issueHostMcpDelegation(client.db, owner, {
      operationId: crypto.randomUUID(),
      bindingId: binding.id,
      expectedBindingGeneration: 1,
      grant: {
        scope: "user",
        mode: "always",
        context: "workspace_shared",
        workspaceSharedAcknowledged: true,
      },
    });
    const tools = [{ kind: "mcp" as const, id: "product" }];
    const connectionRef = {
      ...binding.definition.connectionRef,
      hostBinding: { bindingId: binding.id, generation: 1 },
    };
    const configuredRef =
      selectionMode === "fixed"
        ? connectionRef
        : {
            authoritySource: "host" as const,
            providerDomain: "host.fixture.invalid",
            subjectScope: "subject" as const,
            hostBinding: { selection: "accepted_turn" as const },
          };
    const mcpServer = {
      id: "product",
      url: binding.definition.destinationUrl,
      transport: "streamable_http" as const,
      connectionRef: configuredRef,
    };
    const target =
      runMode === "existing_session"
        ? await createSession(client.db, {
            ...owner,
            createdBy: { kind: "subject", subjectId: owner.subjectId },
            initialMessage: "",
            resources: [],
            tools,
            metadata: {},
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            mcpServers: [mcpServer],
          })
        : null;
    const task = await createScheduledTask(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      name: "Read product data later",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode,
      overlapPolicy: "allow_concurrent",
      ...(target ? { targetSessionId: target.id } : {}),
      agentConfig: { prompt: "Read product data", resources: [], tools, metadata: {} },
      metadata: {},
      captureHostAuthority: (tx, accepted) =>
        captureHostMcpTaskAuthorities(tx, owner, accepted, [
          {
            delegationId: delegation.id,
            generation: 1,
            bindingId: binding.id,
            bindingGeneration: 1,
            definition: binding.definition,
          },
        ]),
    });
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
      hostMcpAuthoritySourceAdmissionEnabled: true,
      environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      mcpServers: [mcpServer],
    });
    const activities = createScheduledTaskActivities(
      async () =>
        ({ settings, db: client.db, bus: new MemoryEventBus() }) as unknown as ActivityServices,
    );
    const dispatchInput = {
      workspaceId: workspace.id,
      taskId: task.id,
      triggerType: "scheduled" as const,
      producerKey: crypto.randomUUID(),
    };
    const dispatched = await activities.dispatchScheduledTaskRun(dispatchInput);
    expect(dispatched.action, JSON.stringify({ runMode, dispatched })).toBe(
      target ? "signal" : "start",
    );
    if (dispatched.action !== "signal" && dispatched.action !== "start")
      throw new Error(JSON.stringify(dispatched));
    const replay = await activities.dispatchScheduledTaskRun(dispatchInput);
    expect(replay.sessionId).toBe(dispatched.sessionId);
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspace.id, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claim.action).toBe("claimed");
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
    const request = {
      accountId: owner.accountId,
      workspaceId: workspace.id,
      sessionId: dispatched.sessionId,
      rootSessionId: dispatched.sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      initiator: claim.turn.initiator,
      initiatorContext: claim.turn.initiatorContext,
      surface: "model" as const,
      serverId: "product",
      destinationUrl: binding.definition.destinationUrl,
      credentialTarget: "mcp" as const,
      forceRefresh: false,
      connectionRef,
    };
    const snapshots: unknown[] = [];
    expect(
      await authorizeDirectHostMcpUse(client.db, request, (snapshot) => snapshots.push(snapshot)),
    ).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      bindingId: binding.id,
      delegationId: delegation.id,
      targetSessionId: request.sessionId,
    });
    let renewals = 0;
    let resolverActor: { accountId: string; subjectId: string } | undefined;
    const resolverConfig = {
      externalSource: "instance:scheduled",
      encryptionKey: Buffer.alloc(32, 9),
      legacyConfigured: false,
    };
    if (selectionMode === "accepted_turn") {
      const token = crypto.randomUUID();
      const key = await createOrganizationApiKey(client.db, {
        accountId: owner.accountId,
        name: "Scheduled resolver",
        prefix: "test",
        keyHash: createHash("sha256").update(token).digest("hex"),
        permissions: ["account:admin"],
      });
      resolverActor = { accountId: owner.accountId, subjectId: `api_key:${key.id}` };
      await mutateHostMcpResolver(client.db, resolverActor, {
        ...resolverConfig,
        kind: "put",
        request: {
          operationId: crypto.randomUUID(),
          expectedGeneration: 0,
          url: "https://resolver.example/credentials",
          bearerToken: "scheduled-secret",
        },
      });
    }
    const hostCredential = async () => {
      renewals++;
      return {
        status: "ok" as const,
        accountId: owner.accountId,
        workspaceId: workspace.id,
        sessionId: dispatched.sessionId,
        providerDomain: "host.fixture.invalid",
        connectionId: "product-account",
        headers: { Authorization: `Bearer synthetic-${renewals}` },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    };
    const port = createNativeRemoteMcpCredentialsPort(settings, client.db, async (url, init) => {
      expect(String(url)).toBe("https://resolver.example/credentials");
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.request.initiator).toEqual(claim.turn.initiator);
      expect(envelope.request.connectionRef.hostBinding).toEqual(connectionRef.hostBinding);
      return Response.json({
        version: 1,
        requestId: envelope.requestId,
        destinationUrl: envelope.request.destinationUrl,
        resolution: await hostCredential(),
      });
    });
    const resolve = buildHostConnectionTokenResolver(
      resolverActor ? port.mcpCredentials! : hostCredential,
      {
        ...request,
        authorizeDurableBinding: (candidate) => authorizeDirectHostMcpUse(client.db, candidate),
        resolveAcceptedBinding: (candidate) => resolveAcceptedHostMcpBinding(client.db, candidate),
      },
    );
    const credential = await resolve({ ...request, connectionRef: configuredRef });
    expect(credential.status).toBe("ok");
    if (credential.status !== "ok") throw new Error("No scheduled host credential");
    expect(await credential.authorizeProviderRequest?.()).toBe(true);
    if (resolverActor) {
      await mutateHostMcpResolver(client.db, resolverActor, {
        ...resolverConfig,
        kind: "revoke",
        request: { operationId: crypto.randomUUID(), expectedGeneration: 1 },
      });
      expect(await credential.authorizeProviderRequest?.()).toBe(false);
      expect((await resolve({ ...request, connectionRef: configuredRef })).status).toBe(
        "auth_needed",
      );
      await mutateHostMcpResolver(client.db, resolverActor, {
        ...resolverConfig,
        kind: "put",
        request: {
          operationId: crypto.randomUUID(),
          expectedGeneration: 2,
          url: "https://resolver.example/credentials",
          bearerToken: "rotated-scheduled-secret",
        },
      });
      expect((await resolve({ ...request, connectionRef: configuredRef })).status).toBe("ok");
    }
    const sourceActor = {
      type: "agent_attempt" as const,
      sessionId: dispatched.sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };
    const derivative = await createScheduledTask(client.db, {
      accountId: owner.accountId,
      workspaceId: workspace.id,
      createdByActor: sourceActor,
      name: "Agent-created product reminder",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Check again", resources: [], tools, metadata: {} },
      metadata: {},
      captureHostAuthority: (tx, accepted) =>
        inheritHostMcpTaskAuthoritiesFromAttempt(tx, accepted, sourceActor, [
          { ...binding.definition, connectionRef: configuredRef },
        ]),
    });
    expect(
      await getHostMcpTaskAuthorities(client.db, {
        accountId: owner.accountId,
        workspaceId: workspace.id,
        taskId: derivative.id,
        taskAuthorityRevision: derivative.authorityRevision,
      }),
    ).toHaveLength(1);
    const child = await createSession(client.db, {
      accountId: owner.accountId,
      workspaceId: workspace.id,
      parentSessionId: dispatched.sessionId,
      initialMessage: "Read the same explicitly delegated account",
      resources: [],
      tools,
      metadata: {},
      model: claim.turn.model,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      mcpServers: [mcpServer],
      createdByActor: {
        type: "agent_attempt",
        sessionId: dispatched.sessionId,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: owner.accountId,
      workspaceId: workspace.id,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(client.db, workspace.id, {
      sessionId: child.id,
      workflowId: `session-${child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(childClaim.action).toBe("claimed");
    if (childClaim.action !== "claimed") throw new Error(JSON.stringify(childClaim));
    const childRequest = {
      ...request,
      sessionId: child.id,
      turnId: childClaim.turn.id,
      attemptId: childAttemptId,
      executionGeneration: childClaim.turn.executionGeneration,
      initiator: childClaim.turn.initiator,
      initiatorContext: childClaim.turn.initiatorContext,
    };
    expect(await authorizeDirectHostMcpUse(client.db, childRequest)).toBe(true);
    if (selectionMode === "accepted_turn")
      expect(
        await resolveAcceptedHostMcpBinding(client.db, {
          ...childRequest,
          connectionRef: configuredRef,
        }),
      ).toEqual(connectionRef);
    await revokeHostMcpDelegation(client.db, owner, delegation.id, 1);
    expect(
      await authorizeDirectHostMcpUse(client.db, childRequest, (snapshot) =>
        snapshots.push(snapshot),
      ),
    ).toBe(false);
    expect(snapshots).toHaveLength(1);
    expect(await credential.authorizeProviderRequest?.()).toBe(false);
    expect((await resolve({ ...request, connectionRef: configuredRef })).status).not.toBe("ok");
    expect(renewals).toBe(resolverActor ? 2 : 1);
  }
}

test.each(["fixed", "accepted_turn"] as const)(
  "scheduled %s host grants survive browser-independent dispatch in every run mode and revoke at physical use",
  verifyScheduledHostSelection,
  60_000,
);
