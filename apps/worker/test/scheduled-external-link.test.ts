// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
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
  createWorkspace,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  revokeExternalIdentityLink,
  createScheduledTask,
  captureExternalLinkTaskAuthority,
  getExternalLinkTaskSnapshot,
  getExternalLinkTurnSnapshot,
  getExternalLinkTurnAuthorization,
  getSessionTurnForAttempt,
  claimSessionWorkForAttempt,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
  resolveHostMcpBindingOwner,
  createHostMcpBinding,
  issueHostMcpDelegation,
  captureHostMcpTaskAuthorities,
  authorizeDirectHostMcpUse,
  getHostMcpBinding,
} from "@opengeni/db";
import { ExternalLinkWorkSnapshot } from "@opengeni/contracts/external-identities";
import { prepareExternalLinkTaskAdmission } from "../../../packages/core/src/application/external-link-work-admission";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const database = await acquireOwnerMigratedTestDatabase("scheduled-external-link");
  if (!database) throw new Error("Linked execution requires real PostgreSQL");
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, {
    appPassword: database.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(database.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = database.appPassword;
  shared = { ...database, appUrl: appUrl.toString() };
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("linked schedules and children retain exact revocable native authority in all execution modes without an API key", async () => {
  for (const runMode of ["new_session_per_run", "reusable_session", "existing_session"] as const) {
    const [account] =
      await shared.admin`insert into managed_accounts(name) values ('Native linked schedule fixture') returning id`;
    const workspace = await createWorkspace(client.db, {
      accountId: account!.id,
      name: "Linked execution",
    });
    const identity = await ensureExternalIdentity(client.db, {
      accountId: account!.id,
      externalId: "product-user",
    });
    const nativeSubjectId = `user:${crypto.randomUUID()}`;
    const personal = await createWorkspace(client.db, {
      accountId: account!.id,
      name: "Native owner",
    });
    await shared.admin`insert into organization_memberships(account_id, subject_id, role, status, personal_workspace_id, authorization_revision)
      values (${account!.id}, ${nativeSubjectId}, 'member', 'active', ${personal.id}, 7)`;
    await grantWorkspaceAccess(client.db, {
      accountId: account!.id,
      workspaceId: workspace.id,
      subjectId: nativeSubjectId,
      permissions: ["workspace:admin"],
    });
    const pending = await beginExternalIdentityLink(client.db, identity, {
      permissions: ["workspace:admin"],
    });
    const link = await confirmExternalIdentityLink(client.db, {
      accountId: account!.id,
      linkId: pending.link.id,
      nativeSubjectId,
      request: {
        challenge: pending.challenge,
        expectedRevision: 1,
        permissions: ["workspace:admin"],
      },
    });
    // Original key ID is deliberately audit-only: no such API key is inserted.
    const snapshot = ExternalLinkWorkSnapshot.parse({
      identity: { externalId: identity.externalId, source: identity.source },
      actor: {
        accountId: account!.id,
        authenticatingApiKeyId: crypto.randomUUID(),
        externalIdentityId: identity.id,
        externalSubjectId: identity.subjectId,
        externalAuthorizationRevision: identity.authorizationRevision,
        effectiveSubjectId: nativeSubjectId,
        actingMode: "linked_native",
        linkId: link.id,
        linkRevision: link.revision,
      },
      permissions: [
        "sessions:read",
        "sessions:create",
        "sessions:control",
        "connections:read",
        "scheduled_tasks:manage",
      ],
    });
    const scope = { accountId: account!.id, workspaceId: workspace.id };
    const owner = await resolveHostMcpBindingOwner(client.db, {
      ...scope,
      subjectId: nativeSubjectId,
    });
    expect(owner.authorizationRevision).toBe(7);
    const binding = await createHostMcpBinding(client.db, owner, {
      operationId: crypto.randomUUID(),
      definition: {
        serverId: "product",
        destinationUrl: "https://host.fixture.invalid/mcp",
        connectionRef: {
          authoritySource: "host",
          connectionId: "native-product-account",
          providerDomain: "host.fixture.invalid",
        },
      },
    });
    expect(binding.ownerSubjectId).toBe(nativeSubjectId);
    expect(
      await getHostMcpBinding(
        client.db,
        {
          ...scope,
          subjectId: identity.subjectId,
          authorizationRevision: identity.authorizationRevision,
        },
        binding.id,
      ),
    ).toBeNull();
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
    const mcpServer = {
      id: "product",
      url: binding.definition.destinationUrl,
      transport: "streamable_http" as const,
      connectionRef,
    };
    const target =
      runMode === "existing_session"
        ? await createSession(client.db, {
            ...scope,
            createdBy: { kind: "subject", subjectId: nativeSubjectId },
            initialMessage: "",
            resources: [],
            tools,
            mcpServers: [mcpServer],
            metadata: {},
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
          })
        : null;
    const task = await createScheduledTask(client.db, {
      ...scope,
      createdBy: { kind: "subject", subjectId: nativeSubjectId },
      name: "Linked task",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode,
      overlapPolicy: "allow_concurrent",
      ...(target ? { targetSessionId: target.id } : {}),
      agentConfig: { prompt: "Run with the confirmed link", resources: [], tools, metadata: {} },
      metadata: {},
      captureLinkAuthority: (tx, accepted) =>
        captureExternalLinkTaskAuthority(tx, accepted, snapshot),
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
    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({
            databaseUrl: shared.appUrl,
            sandboxBackend: "none",
            hostMcpAuthoritySourceAdmissionEnabled: true,
            mcpServers: [mcpServer],
          }),
          db: client.db,
          bus: new MemoryEventBus(),
        }) as unknown as ActivityServices,
    );
    const dispatchInput = {
      workspaceId: workspace.id,
      taskId: task.id,
      triggerType: "scheduled" as const,
      producerKey: crypto.randomUUID(),
    };
    const dispatched = await activities.dispatchScheduledTaskRun(dispatchInput);
    if (dispatched.action !== "start" && dispatched.action !== "signal")
      throw new Error(JSON.stringify(dispatched));
    expect((await activities.dispatchScheduledTaskRun(dispatchInput)).sessionId).toBe(
      dispatched.sessionId,
    );
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspace.id, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
    expect(await getExternalLinkTurnSnapshot(client.db, scope, claim.turn.id)).toEqual(snapshot);
    expect(await getExternalLinkTurnAuthorization(client.db, scope, claim.turn.id)).toMatchObject({
      authorized: true,
    });
    const hostRequest = {
      ...scope,
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
    expect(await authorizeDirectHostMcpUse(client.db, hostRequest)).toBe(true);
    const actor = {
      type: "agent_attempt" as const,
      sessionId: dispatched.sessionId,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };
    const derivative = await createScheduledTask(client.db, {
      ...scope,
      createdByActor: actor,
      name: "Linked derivative",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Keep the same link restriction",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
      captureLinkAuthority: prepareExternalLinkTaskAdmission(undefined, actor)!,
    });
    expect(
      await getExternalLinkTaskSnapshot(client.db, {
        ...scope,
        taskId: derivative.id,
        taskRevision: derivative.authorityRevision,
      }),
    ).toEqual(snapshot);
    const child = await createSession(client.db, {
      ...scope,
      parentSessionId: dispatched.sessionId,
      createdByActor: actor,
      initialMessage: "Child",
      resources: [],
      tools: [],
      metadata: {},
      model: claim.turn.model,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      ...scope,
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
    if (childClaim.action !== "claimed") throw new Error(JSON.stringify(childClaim));
    expect(await getExternalLinkTurnSnapshot(client.db, scope, childClaim.turn.id)).toEqual(
      snapshot,
    );
    await revokeExternalIdentityLink(client.db, {
      accountId: scope.accountId,
      linkId: link.id,
      subjectId: identity.subjectId,
      expectedRevision: link.revision,
    });
    expect(await authorizeDirectHostMcpUse(client.db, hostRequest)).toBe(false);
    expect(await getExternalLinkTurnAuthorization(client.db, scope, claim.turn.id)).toMatchObject({
      authorized: false,
    });
    expect(
      await getExternalLinkTurnAuthorization(client.db, scope, childClaim.turn.id),
    ).toMatchObject({ authorized: false });
    expect(
      await getSessionTurnForAttempt(client.db, workspace.id, child.id, childAttemptId),
    ).toBeNull();
    expect(
      await getSessionTurnForAttempt(client.db, workspace.id, dispatched.sessionId, attemptId),
    ).toBeNull();
    expect(await getExternalLinkTurnSnapshot(client.db, scope, childClaim.turn.id)).toEqual(
      snapshot,
    );
  }
}, 60_000);
