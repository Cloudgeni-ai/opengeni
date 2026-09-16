import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, testSettings } from "@opengeni/testing";
import postgres from "postgres";
import type { ConnectionMetadata, McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
} from "@opengeni/contracts/google-drive";
import type { ResolveConnectionCredentialInput } from "@opengeni/db";
import {
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  ensureManagedAccessForUser,
  getPersonalGitHubRepositorySelectionState,
  getSessionTurnPersonalConnectionDelegations,
  persistProviderOAuthConnection,
  replacePersonalGitHubRepositorySelections,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  freezePersonalConnectionDelegations,
  googleDrivePublicationDelegationFromVisibleConnections,
  personalAtlassianDelegationsFromVisibleConnections,
  personalConnectionDelegationSourceForGrant,
  personalConnectionDelegationsFromParent,
  personalConnectionDelegationsFromVisibleConnections,
  selectedPersonalConnectionServers,
  withFrozenPersonalConnectionDelegations,
} from "../src/domain/personal-connection-delegations";
import { validatedScheduledTaskUpdate } from "../src/domain/scheduled-tasks";

const personalServer = {
  id: "linear",
  url: "https://mcp.linear.app/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "linear.app",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

function googleDriveConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const now = "2026-08-14T00:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "user:owner",
    authorityId: crypto.randomUUID(),
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    kind: "oauth2",
    status: "active",
    grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
      credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
      googlePermissionId: "permission-1",
      googleEmail: "owner@example.com",
      googleDisplayName: "Owner",
      verifiedAt: now,
      accessMode: "file_only",
      lifecycle: { state: "active", recoverable: true, observedAt: now },
      outputDestination: {
        folderId: "folder-1",
        folderName: "Published",
        driveId: null,
        location: "my_drive",
        selectedAt: now,
      },
    },
    createdBySubjectId: "user:owner",
    updatedBySubjectId: "user:owner",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("personal MCP connection delegation", () => {
  test("never freezes, inherits, or rewrites subject-scoped host authority", async () => {
    const hostServer = {
      id: "host-tools",
      url: "https://host-tools.example/mcp",
      cacheToolsList: false,
      connectionRef: {
        authoritySource: "host" as const,
        connectionId: "11111111-1111-4111-8111-111111111111",
        providerDomain: "host-tools.example",
        kind: "delegated" as const,
        subjectScope: "subject" as const,
      },
    };
    expect(
      selectedPersonalConnectionServers({ mcpServers: [hostServer, personalServer] }, [
        { kind: "mcp", id: hostServer.id },
        { kind: "mcp", id: personalServer.id },
      ]).map((server) => server.id),
    ).toEqual([personalServer.id]);
    expect(
      personalConnectionDelegationsFromVisibleConnections({
        servers: [hostServer],
        subjectId: "user:owner",
        connections: [
          googleDriveConnection({
            id: hostServer.connectionRef.connectionId,
            providerDomain: hostServer.connectionRef.providerDomain,
            kind: "delegated",
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      personalConnectionDelegationsFromParent({
        servers: [hostServer],
        parentDelegations: [
          {
            serverId: hostServer.id,
            connectionId: hostServer.connectionRef.connectionId,
            ownerSubjectId: "user:owner",
            providerDomain: hostServer.connectionRef.providerDomain,
            kind: "delegated",
          },
        ],
      }),
    ).toEqual([]);

    const received: ResolveConnectionCredentialInput[] = [];
    let membershipChecks = 0;
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [hostServer] },
      personalConnectionDelegations: [],
      ownerHasWorkspaceMembership: async () => {
        membershipChecks += 1;
        return true;
      },
      resolveCredential: async (request) => {
        received.push(request);
        return {
          status: "auth_needed",
          reason: "unsupported_auth",
          providerDomain: request.connectionRef.providerDomain,
          connectionId: request.connectionRef.connectionId,
        };
      },
    });
    const request: ResolveConnectionCredentialInput = {
      workspaceId: "workspace-1",
      subjectId: "user:owner",
      serverId: hostServer.id,
      destinationUrl: hostServer.url,
      connectionRef: hostServer.connectionRef,
    };
    await expect(resolver(request)).resolves.toEqual({
      status: "auth_needed",
      reason: "unsupported_auth",
      providerDomain: hostServer.connectionRef.providerDomain,
      connectionId: hostServer.connectionRef.connectionId,
    });
    expect(received).toEqual([request]);
    expect(membershipChecks).toBe(0);
  });

  test("admits an exact same-organization portable selection and membershipless personal owner", async () => {
    const blank = await acquireBlankTestDatabase("core-portable-connection-authority");
    if (!blank) return;
    await migrate(blank.databaseUrl);
    const sql = postgres(blank.databaseUrl, { max: 2, onnotice: () => undefined });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('portable connection authority') returning id
      `;
      const [origin] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'owner personal')
        returning id
      `;
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'shared target')
        returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${origin!.id}, ${account!.id}), (${target!.id}, ${account!.id})
      `;
      const subjectId = `user:${crypto.randomUUID()}`;
      await sql`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (${account!.id}, ${subjectId}, 'active', ${origin!.id})
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${target!.id}, ${subjectId})
      `;
      const connection = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; authorityId: string }>>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${origin!.id}, ${subjectId}, 'linear.app', 'oauth2', 'ciphertext'
          ) returning id, authority_id as "authorityId"
        `;
        return row!;
      });
      const selection = { serverId: "linear", connectionId: connection.id };
      const frozen = await freezePersonalConnectionDelegations({
        db: client.db,
        workspaceId: target!.id,
        settings: { mcpServers: [personalServer] },
        tools: [{ kind: "mcp", id: "linear" }],
        source: { kind: "subject", subjectId, accountId: account!.id },
        authoritySelections: [selection],
      });
      expect(frozen).toEqual([
        {
          serverId: "linear",
          connectionId: connection.id,
          originWorkspaceId: origin!.id,
          ownerSubjectId: subjectId,
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ]);

      const personalFrozen = await freezePersonalConnectionDelegations({
        db: client.db,
        workspaceId: origin!.id,
        settings: { mcpServers: [personalServer] },
        tools: [{ kind: "mcp", id: "linear" }],
        source: { kind: "subject", subjectId, accountId: account!.id },
        authoritySelections: [selection],
      });
      expect(personalFrozen[0]?.originWorkspaceId).toBe(origin!.id);
      const defaultInput = {
        db: client.db,
        workspaceId: origin!.id,
        settings: { mcpServers: [personalServer] },
        tools: [{ kind: "mcp" as const, id: "linear" }],
        source: { kind: "subject" as const, subjectId, accountId: account!.id },
        visibility: "workspace_shared" as const,
      };
      // The server restores only a pre-existing native grant, with the same
      // capture as an explicit selection. An explicit empty list suppresses it.
      expect(await freezePersonalConnectionDelegations(defaultInput)).toEqual([]);
      await sql`
        insert into session_tenancy_activations (
          account_id, activation_version, inventory_digest, parity_digest, activated_by
        ) values (${account!.id}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'connection-default-test')
      `;
      expect(await freezePersonalConnectionDelegations(defaultInput)).toEqual(personalFrozen);
      expect(
        await freezePersonalConnectionDelegations({
          ...defaultInput,
          authoritySelections: [],
        }),
      ).toEqual([]);
      expect(
        await freezePersonalConnectionDelegations({
          ...defaultInput,
          visibility: "user_private",
        }),
      ).toEqual([]);
      const scopedSession = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: origin!.id,
        initialMessage: "conversation grant capture",
        resources: [],
        tools: [{ kind: "mcp", id: "linear" }],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId,
      });
      const [scopedAuthority] = await sql<
        Array<{ visibility: "user_private" | "workspace_shared"; epoch: number }>
      >`select visibility, authority_epoch::int as epoch from sessions where id = ${scopedSession.id}`;
      const scopedGrant = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; generation: number }>>`
          select grant_id as id, grant_generation::int as generation
          from issue_self_connection_use_grant(
            ${account!.id}::uuid, ${connection.authorityId}::uuid, ${origin!.id}::uuid,
            'session', ${scopedAuthority!.visibility}, ${scopedSession.id}::uuid,
            ${scopedAuthority!.visibility === "workspace_shared"}
          )
        `;
        return row!;
      });
      const scopedSelection = {
        ...selection,
        userDelegation: {
          ...selection.userDelegation,
          workspaceId: origin!.id,
          sessionId: scopedSession.id,
          mode: "session" as const,
          context: scopedAuthority!.visibility,
          authorityEpoch: scopedAuthority!.epoch,
          grantId: scopedGrant.id,
          grantGeneration: scopedGrant.generation,
        },
      };
      const scopedInput = {
        ...defaultInput,
        targetSessionId: scopedSession.id,
        visibility: scopedAuthority!.visibility,
      };
      const automaticallyFrozen = await freezePersonalConnectionDelegations(scopedInput);
      expect(automaticallyFrozen).toEqual(
        await freezePersonalConnectionDelegations({
          ...scopedInput,
          authoritySelections: [scopedSelection],
        }),
      );
      expect(automaticallyFrozen[0]?.userDelegation?.grantId).toBe(scopedGrant.id);
      expect(
        await freezePersonalConnectionDelegations({ ...scopedInput, authoritySelections: [] }),
      ).toEqual([]);
      const acceptedScoped = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        origin!.id,
        subjectId,
        (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: origin!.id,
            sessionId: scopedSession.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "use the existing conversation grant",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: automaticallyFrozen,
          }),
      );
      expect(
        await getSessionTurnPersonalConnectionDelegations(
          client.db,
          origin!.id,
          scopedSession.id,
          acceptedScoped.turnId,
        ),
      ).toEqual(automaticallyFrozen);
      expect(
        await sql`
          select 1 from workspace_memberships
          where workspace_id = ${origin!.id} and subject_id = ${subjectId}
        `,
      ).toHaveLength(0);

      await expect(
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [personalServer] },
          tools: [{ kind: "mcp", id: "linear" }],
          source: {
            kind: "subject",
            subjectId: `user:${crypto.randomUUID()}`,
            accountId: account!.id,
          },
          authoritySelections: [selection],
        }),
      ).rejects.toBeTruthy();

      const ambientAdminSubjectId = `user:${crypto.randomUUID()}`;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values
          (${account!.id}, ${origin!.id}, ${ambientAdminSubjectId}, 'admin'),
          (${account!.id}, ${target!.id}, ${ambientAdminSubjectId}, 'admin')
      `;
      await expect(
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [personalServer] },
          tools: [{ kind: "mcp", id: "linear" }],
          source: {
            kind: "subject",
            subjectId: ambientAdminSubjectId,
            accountId: account!.id,
          },
          authoritySelections: [selection],
        }),
      ).rejects.toBeTruthy();

      const replaySession = await createSession(client.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "sender transport replay",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId,
      });
      const freezeAccounts = () =>
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [personalServer] },
          tools: [{ kind: "mcp", id: "linear" }],
          source: { kind: "subject", subjectId, accountId: account!.id },
          authoritySelections: [selection],
        });
      const frozenAccounts = await freezeAccounts();
      const operationKey = crypto.randomUUID();
      const submitMessage = (key = operationKey) =>
        withWorkspaceSubjectSessionActivityRls(client.db, target!.id, subjectId, (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: account!.id,
            workspaceId: target!.id,
            sessionId: replaySession.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: key,
            delivery: "send",
            text: "one replayable accepted use",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: frozenAccounts,
          }),
        );
      const accepted = await submitMessage();
      expect(await freezeAccounts()).toEqual(frozenAccounts);
      const replayed = await submitMessage();
      expect(replayed).toMatchObject({ turnId: accepted.turnId, replay: true });
      expect((await submitMessage(crypto.randomUUID())).turnId).not.toBe(accepted.turnId);

      await sql`
        update connections set status = 'revoked' where id = ${connection.id}
      `;
      await expect(
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [personalServer] },
          tools: [{ kind: "mcp", id: "linear" }],
          source: { kind: "subject", subjectId, accountId: account!.id },
          authoritySelections: [selection],
        }),
      ).rejects.toBeTruthy();
    } finally {
      await client.close();
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 120_000);

  test("freezes exact personal GitHub repository authority for a portable accepted turn", async () => {
    const blank = await acquireBlankTestDatabase("core-personal-github-repository-authority");
    if (!blank) return;
    await migrate(blank.databaseUrl);
    const sql = postgres(blank.databaseUrl, { max: 2, onnotice: () => undefined });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      const userId = `personal-github-${crypto.randomUUID()}`;
      const subjectId = `user:${userId}`;
      const access = await ensureManagedAccessForUser(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Personal GitHub owner",
      });
      const originGrant = access.workspaceGrants.find(
        (grant) => grant.workspaceId === access.defaultWorkspaceId,
      );
      if (!originGrant) throw new Error("managed personal workspace grant was not projected");
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${originGrant.accountId}, 'Personal GitHub target') returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${target!.id}, ${originGrant.accountId})
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${originGrant.accountId}, ${target!.id}, ${subjectId})
      `;

      const credentialBindingId = crypto.randomUUID();
      const now = new Date().toISOString();
      const connection = await persistProviderOAuthConnection(client.db, {
        accountId: originGrant.accountId,
        workspaceId: originGrant.workspaceId,
        subjectId,
        visibleToSubjectId: subjectId,
        providerDomain: "github.com",
        kind: "oauth2",
        status: "active",
        credentialEncrypted: "test-ciphertext-never-resolved",
        grantedScopes: ["repo"],
        expiresAt: null,
        metadata: {
          credentialRole: "opengeni_github_personal",
          providerFamily: "github",
          providerPrincipalId: "9876543210987654321",
          githubUserId: "9876543210987654321",
          githubLogin: "octocat",
          oauthEnvironment: "test",
          oauthClientMarker: "a".repeat(32),
          credentialBindingId,
          connectedAt: now,
          lastVerifiedAt: now,
        },
        createdBySubjectId: subjectId,
        updatedBySubjectId: subjectId,
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "9876543210987654321",
        requireLiveUserAuthority: true,
        requiredLiveUserPermission: "connections:write",
        exclusiveProviderPrincipalPerOwner: true,
      });
      if (!connection?.authorityId) throw new Error("personal GitHub connection was not created");
      const initialSelection = await getPersonalGitHubRepositorySelectionState(client.db, {
        accountId: originGrant.accountId,
        originWorkspaceId: originGrant.workspaceId,
        subjectId,
        connectionId: connection.id,
      });
      if (!initialSelection) throw new Error("personal GitHub selection head was not created");
      const repository = {
        repositoryId: "9007199254740993123",
        fullName: "octocat/private-repository",
        canonicalUrl: "https://github.com/octocat/private-repository",
        defaultBranch: "main",
        visibility: "private" as const,
        private: true,
        archived: false,
        disabled: false,
        permissions: {
          pull: true,
          push: true,
          admin: false,
          maintain: false,
          triage: false,
        },
        selectedAccess: "write" as const,
        lastVerifiedAt: now,
      };
      const selected = await replacePersonalGitHubRepositorySelections(client.db, {
        accountId: originGrant.accountId,
        originWorkspaceId: originGrant.workspaceId,
        subjectId,
        connectionId: connection.id,
        expectedConnectionAuthorityGeneration: initialSelection.connectionAuthorityGeneration,
        expectedSelectionGeneration: 0,
        idempotencyKey: crypto.randomUUID(),
        repositories: [repository],
      });
      const resource = {
        kind: "repository" as const,
        uri: repository.canonicalUrl,
        ref: repository.defaultBranch,
        provider: "github" as const,
        connectionType: "github_personal" as const,
        credentialBindingId,
        repositoryId: repository.repositoryId,
        access: "write" as const,
      };
      const authoritySelection = { serverId: "github:personal", connectionId: connection.id };
      const freeze = () =>
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [], githubPersonalOauthEnabled: true },
          tools: [],
          resources: [resource],
          source: { kind: "subject" as const, subjectId, accountId: originGrant.accountId },
          authoritySelections: [authoritySelection],
        });
      const frozen = await freeze();
      expect(frozen).toEqual([
        {
          serverId: "github:personal",
          connectionId: connection.id,
          originWorkspaceId: originGrant.workspaceId,
          ownerSubjectId: subjectId,
          providerDomain: "github.com",
          kind: "oauth2",
          connectionType: "github_personal",
          personalGitHubRepositorySelection: {
            credentialBindingId,
            connectionAuthorityGeneration: initialSelection.connectionAuthorityGeneration,
            selectionGeneration: selected.selectionGeneration,
            repositories: [
              {
                repositoryId: repository.repositoryId,
                fullName: repository.fullName,
                canonicalUrl: repository.canonicalUrl,
                ref: repository.defaultBranch,
                access: "write",
                selectionGeneration: selected.selectionGeneration,
              },
            ],
          },
        },
      ]);

      const session = await createSession(client.db, {
        accountId: originGrant.accountId,
        workspaceId: target!.id,
        initialMessage: "personal GitHub authority persistence",
        resources: [resource],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId,
      });
      const accepted = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        target!.id,
        subjectId,
        (db) =>
          submitHumanPromptInTransaction(db, {
            accountId: originGrant.accountId,
            workspaceId: target!.id,
            sessionId: session.id,
            subjectId,
            actor: { type: "human", subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "use the selected repository",
            resources: [],
            model: "test-model",
            reasoningEffort: "low",
            reasoningEffortFallback: "medium",
            source: "user",
            personalConnectionDelegations: frozen,
          }),
      );
      expect(
        await getSessionTurnPersonalConnectionDelegations(
          client.db,
          target!.id,
          session.id,
          accepted.turnId,
        ),
      ).toEqual(frozen);

      const task = await createScheduledTask(client.db, {
        id: crypto.randomUUID(),
        accountId: originGrant.accountId,
        workspaceId: target!.id,
        name: "personal GitHub authority persistence",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `personal-github-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "use the selected repository",
          resources: [resource],
          tools: [],
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId },
        metadata: {},
      });
      const [persistedTask] = await sql<Array<{ delegations: unknown }>>`
        select personal_connection_delegations as delegations
        from scheduled_tasks where id = ${task.id}
      `;
      expect(persistedTask?.delegations).toEqual([]);
      expect(task.ownerSubjectId).toBe(subjectId);

      const [revisionAuthority] = await sql<
        Array<{
          organizationMembershipId: string;
          membershipAuthorizationRevision: number;
        }>
      >`
        select organization_membership_id as "organizationMembershipId",
          membership_authorization_revision::int as "membershipAuthorizationRevision"
        from scheduled_task_revision_authorities
        where task_id = ${task.id} and task_authority_revision = ${task.authorityRevision}
      `;
      if (!revisionAuthority) throw new Error("scheduled task revision authority was not frozen");
      const [depthPolicy] = await sql<
        Array<{ maxNestedAgentDepth: number; policySource: "deployment" | "default" }>
      >`
        select max_nested_agent_depth::int as "maxNestedAgentDepth",
          policy_source as "policySource"
        from nested_agent_depth_configuration where singleton
      `;
      if (!depthPolicy) throw new Error("nested-agent depth policy is unavailable");
      const scheduledRun = await createScheduledTaskRun(client.db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
        taskExecutionDigest: task.executionDigest,
        triggerType: "manual",
        producerKey: `personal-github-sender-${crypto.randomUUID()}`,
        acceptedExecutionSnapshot: {
          version: 1,
          task,
          resolvedModel: "test-model",
          resolvedReasoningEffort: "medium",
          resolvedLatencyMode: "standard",
          resolvedSandboxBackend: "none",
          resolvedSandboxOs: "linux",
          resolvedTools: [],
          resolvedFirstPartyMcpTools: [],
          resolvedFirstPartyMcpPermissions: [],
          resolvedVariableSet: null,
          resolvedRig: null,
          resolvedSlackBotConnection: null,
          targetSessionExecution: null,
          generatedSessionBinding: {
            createIdempotencyKey: `personal-github-sender:${task.id}`,
            effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
            nestedAgentDepthPolicySource: depthPolicy.policySource,
            codexCompactionMode: "portable",
          },
          personalConnectionDelegations: frozen,
          personalResourceAuthoritySubjectId: null,
          causalHumanSubjectId: subjectId,
          causalHumanAuthority: {
            subjectId,
            organizationMembershipId: revisionAuthority.organizationMembershipId,
            membershipAuthorizationRevision: revisionAuthority.membershipAuthorizationRevision,
          },
          xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
          xaiAuthoritySubjectId: null,
          connectionAuthoritySubjectId: subjectId,
          triggerInitiator: { kind: "service", subjectId: "scheduler" },
          agentRunUsageIdempotencyKey: null,
          incidentPreflightRequired: false,
          alertOccurrenceLabels: null,
        },
      });
      expect(scheduledRun.status).toBe("queued");
      const [scheduledOccurrence] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from scheduled_task_runs where task_id = ${task.id}
      `;
      expect(scheduledOccurrence?.count).toBe(1);

      await expect(
        validatedScheduledTaskUpdate({
          settings: testSettings({ githubPersonalOauthEnabled: true }),
          db: client.db,
          objectStorage: null,
          grant: {
            ...originGrant,
            workspaceId: target!.id,
            principalKind: "human_session",
          },
          existing: task,
          payload: {
            agentConfig: {
              ...task.agentConfig,
              resources: [{ ...resource, access: "read" }],
            },
          },
          toolsProvided: true,
        }),
      ).resolves.toMatchObject({
        agentConfig: { resources: [{ ...resource, access: "read" }] },
      });
      await expect(
        validatedScheduledTaskUpdate({
          settings: testSettings({ githubPersonalOauthEnabled: true }),
          db: client.db,
          objectStorage: null,
          grant: {
            ...originGrant,
            workspaceId: target!.id,
            principalKind: "human_session",
          },
          existing: task,
          payload: {
            agentConfig: {
              ...task.agentConfig,
              prompt: "materially changed instructions for the same repository",
            },
          },
          toolsProvided: true,
        }),
      ).resolves.toMatchObject({
        agentConfig: { prompt: "materially changed instructions for the same repository" },
      });
      await expect(
        validatedScheduledTaskUpdate({
          settings: testSettings({ githubPersonalOauthEnabled: true }),
          db: client.db,
          objectStorage: null,
          grant: {
            ...originGrant,
            workspaceId: target!.id,
            principalKind: "human_session",
          },
          existing: task,
          payload: { connectionAccounts: [] },
        }),
      ).resolves.toMatchObject({
        agentConfig: { connectionAccounts: [] },
      });

      await replacePersonalGitHubRepositorySelections(client.db, {
        accountId: originGrant.accountId,
        originWorkspaceId: originGrant.workspaceId,
        subjectId,
        connectionId: connection.id,
        expectedConnectionAuthorityGeneration: initialSelection.connectionAuthorityGeneration,
        expectedSelectionGeneration: selected.selectionGeneration,
        idempotencyKey: crypto.randomUUID(),
        repositories: [],
      });
      await expect(freeze()).rejects.toThrow(
        "personal GitHub repository resource is outside the selected authority",
      );

      await sql`
        delete from workspace_memberships
        where workspace_id = ${target!.id} and subject_id = ${subjectId}
      `;
      await expect(
        freezePersonalConnectionDelegations({
          db: client.db,
          workspaceId: target!.id,
          settings: { mcpServers: [], githubPersonalOauthEnabled: true },
          tools: [],
          resources: [resource],
          source: { kind: "subject", subjectId, accountId: originGrant.accountId },
          authoritySelections: [],
        }),
      ).rejects.toThrow("personal GitHub repository authority requires live causal user authority");
    } finally {
      await client.close();
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 120_000);

  test("uses human/API subjects but copies authority for agent attempts", () => {
    const humanAccountId = crypto.randomUUID();
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: humanAccountId,
        workspaceId: crypto.randomUUID(),
        subjectId: "user:owner",
        principalKind: "human_session",
        permissions: [],
      }),
      // The grant's organization travels with the subject: the owner-only
      // personal-workspace pointer lives on an organization membership, so a
      // subject alone cannot answer "does this human still belong here".
    ).toEqual({ kind: "subject", subjectId: "user:owner", accountId: humanAccountId });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session", turnId: "parent-turn" },
      }),
    ).toEqual({ kind: "turn", sessionId: "parent-session", turnId: "parent-turn" });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session" },
      }),
    ).toEqual({ kind: "none" });
  });

  test("narrows inherited personal GitHub authority to the child resources", () => {
    const credentialBindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parent: McpPersonalConnectionDelegation = {
      serverId: "github:personal",
      connectionId: crypto.randomUUID(),
      originWorkspaceId: crypto.randomUUID(),
      ownerSubjectId: "user:owner",
      providerDomain: "github.com",
      kind: "oauth2",
      connectionType: "github_personal",
      userDelegation: {
        organizationId: crypto.randomUUID(),
        authorityId: crypto.randomUUID(),
        authorityGeneration: 1,
        workspaceId: crypto.randomUUID(),
        sessionId: null,
        action: "connection.use",
        mode: "always",
        context: "workspace_shared",
        authorityEpoch: null,
        grantId: crypto.randomUUID(),
        grantGeneration: 1,
      },
      personalGitHubRepositorySelection: {
        credentialBindingId,
        connectionAuthorityGeneration: 1,
        selectionGeneration: 2,
        repositories: [
          {
            repositoryId: "9007199254740993123",
            fullName: "octocat/private-repository",
            canonicalUrl: "https://github.com/octocat/private-repository",
            ref: "main",
            access: "write",
            selectionGeneration: 2,
          },
        ],
      },
    };
    const inherited = personalConnectionDelegationsFromParent({
      servers: [],
      parentDelegations: [parent],
      personalGitHubResources: [
        {
          kind: "repository",
          uri: "https://github.com/octocat/private-repository",
          ref: "main",
          provider: "github",
          connectionType: "github_personal",
          credentialBindingId,
          repositoryId: "9007199254740993123",
          access: "read",
        },
      ],
    });
    expect(inherited).toEqual([
      {
        ...parent,
        personalGitHubRepositorySelection: {
          ...parent.personalGitHubRepositorySelection!,
          repositories: [
            { ...parent.personalGitHubRepositorySelection!.repositories[0]!, access: "read" },
          ],
        },
      },
    ]);
  });

  test("fails closed instead of dropping personal GitHub authority without a causal human", async () => {
    await expect(
      freezePersonalConnectionDelegations({
        db: null as never,
        workspaceId: crypto.randomUUID(),
        settings: { mcpServers: [], githubPersonalOauthEnabled: true },
        tools: [],
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/octocat/private-repository",
            ref: "main",
            provider: "github",
            connectionType: "github_personal",
            credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            repositoryId: "9007199254740993123",
            access: "read",
          },
        ],
        source: { kind: "none" },
      }),
    ).rejects.toThrow(
      "personal GitHub repository authority requires an authenticated causal human",
    );
  });

  test("keeps personal GitHub repository admission default-off", async () => {
    await expect(
      freezePersonalConnectionDelegations({
        db: null as never,
        workspaceId: crypto.randomUUID(),
        settings: { mcpServers: [] },
        tools: [],
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/octocat/private-repository",
            ref: "main",
            provider: "github",
            connectionType: "github_personal",
            credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            repositoryId: "9007199254740993123",
            access: "read",
          },
        ],
        source: {
          kind: "subject",
          subjectId: "user:owner",
          accountId: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow("personal GitHub repository authority is not enabled");
  });

  test("freezes only an active exact subject connection", () => {
    const active: ConnectionMetadata = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      authorityId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:owner",
      providerDomain: "linear.app",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:owner",
      updatedBySubjectId: "user:owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = personalConnectionDelegationsFromVisibleConnections({
      servers: [personalServer],
      subjectId: "user:owner",
      connections: [
        { ...active, id: crypto.randomUUID(), status: "revoked" },
        { ...active, id: crypto.randomUUID(), subjectId: "someone-else" },
        active,
      ],
    });
    expect(result).toEqual([
      {
        serverId: "linear",
        connectionId: active.id,
        originWorkspaceId: active.workspaceId,
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ]);
  });

  test("children copy only selected server-bound grants", () => {
    const parent: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
      {
        serverId: "other",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "other.example",
        kind: "oauth2",
      },
    ];
    expect(
      personalConnectionDelegationsFromParent({
        servers: [personalServer],
        parentDelegations: parent,
      }),
    ).toEqual([parent[0]]);
  });

  test("children retain frozen first-party social authority alongside selected MCP grants", () => {
    const social: McpPersonalConnectionDelegation = {
      serverId: "social:x",
      connectionId: crypto.randomUUID(),
      ownerSubjectId: "user:owner",
      providerDomain: "x.com",
      kind: "oauth2",
      connectionType: "social",
    };
    expect(
      personalConnectionDelegationsFromParent({
        servers: [personalServer],
        parentDelegations: [social],
      }),
    ).toEqual([social]);
  });

  test("captures canonical Atlassian accounts and excludes legacy account rows", () => {
    const authorityId = crypto.randomUUID();
    const atlassian = googleDriveConnection({
      id: crypto.randomUUID(),
      providerDomain: "api.atlassian.com",
      grantedScopes: [],
      metadata: {},
      authorityId,
    });
    expect(
      personalAtlassianDelegationsFromVisibleConnections({
        subjectId: "user:owner",
        connections: [atlassian],
      }),
    ).toEqual([
      expect.objectContaining({
        connectionId: atlassian.id,
        originWorkspaceId: atlassian.workspaceId,
        ownerSubjectId: "user:owner",
        connectionType: "atlassian",
      }),
    ]);
    expect(
      personalAtlassianDelegationsFromVisibleConnections({
        subjectId: "user:owner",
        connections: [{ ...atlassian, authorityId: null }],
      }),
    ).toEqual([]);
  });

  test("freezes, inherits, and composes one exact Google Drive publication connection", async () => {
    const drive = googleDriveConnection();
    const delegation = googleDrivePublicationDelegationFromVisibleConnections({
      subjectId: "user:owner",
      connections: [drive],
    });
    expect(delegation).toEqual({
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      connectionId: drive.id,
      originWorkspaceId: drive.workspaceId,
      ownerSubjectId: "user:owner",
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2",
      // The exact destination frozen at acceptance: a later
      // connection-settings change can never redirect an already-accepted
      // turn's publication.
      outputDestination: {
        folderId: "folder-1",
        folderName: "Published",
        driveId: null,
        location: "my_drive",
        selectedAt: "2026-08-14T00:00:00.000Z",
      },
    });
    const inherited = personalConnectionDelegationsFromParent({
      servers: [],
      parentDelegations: [delegation!],
    });
    expect(inherited).toEqual([delegation]);
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: inherited,
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { authorization: "Bearer exact-frozen-drive" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });
    await resolver({
      workspaceId: drive.workspaceId,
      subjectId: "worker:first-party-mcp",
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: "google_drive_publish_file",
      destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      subjectId: "user:owner",
      connectionRef: { connectionId: drive.id },
    });
  });

  test("fails closed when Google Drive publication authority is missing or ambiguous", () => {
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [
          googleDriveConnection({ grantedScopes: [] }),
          googleDriveConnection({ subjectId: "user:other" }),
        ],
      }),
    ).toBeNull();
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [googleDriveConnection(), googleDriveConnection()],
      }),
    ).toBeNull();
    const selected = googleDriveConnection();
    const other = googleDriveConnection();
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [selected],
      }),
    ).toMatchObject({ connectionId: selected.id, originWorkspaceId: selected.workspaceId });
    expect(
      googleDrivePublicationDelegationFromVisibleConnections({
        subjectId: "user:owner",
        connections: [other, selected],
        authoritySelection: {
          serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
          connectionId: selected.id,
        },
      }),
    ).toMatchObject({ connectionId: selected.id });
  });

  test("pins every caller surface to the same exact owner, UUID, provider, and kind", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [personalServer] },
      personalConnectionDelegations: [
        {
          serverId: "linear",
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { "x-test-credential": "frozen" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });
    const request = {
      workspaceId: "workspace-1",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: personalServer.connectionRef,
    };

    await resolver({ ...request, subjectId: "user:owner", toolName: "model_issue_create" });
    await resolver({
      ...request,
      subjectId: "worker:first-party-mcp",
      toolName: "codemode_issue_create",
    });

    expect(received).toHaveLength(2);
    for (const input of received) {
      expect(input.subjectId).toBe("user:owner");
      expect(input.connectionRef).toMatchObject({
        providerDomain: "linear.app",
        connectionId: frozenConnectionId,
        kind: "oauth2",
        subjectScope: "subject",
      });
    }
  });

  test("never falls forward when the exact frozen connection is unavailable", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const replacementConnectionId = "22222222-2222-4222-8222-222222222222";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [personalServer] },
      personalConnectionDelegations: [
        {
          serverId: "linear",
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async () => true,
      resolveCredential: async (input) => {
        received.push(input);
        if (input.connectionRef.connectionId === frozenConnectionId) {
          return {
            status: "auth_needed",
            reason: "missing_connection",
            providerDomain: "linear.app",
            connectionId: frozenConnectionId,
          };
        }
        return {
          status: "ok",
          headers: { "x-test-credential": "replacement" },
          connectionId: replacementConnectionId,
        };
      },
    });

    const result = await resolver({
      workspaceId: "workspace-1",
      subjectId: "user:owner",
      serverId: "linear",
      destinationUrl: "https://mcp.linear.app/mcp",
      connectionRef: personalServer.connectionRef,
    });

    expect(result).toEqual({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
      providerDomain: "linear.app",
    });
    expect(received.map((input) => input.connectionRef.connectionId)).toEqual([frozenConnectionId]);
    expect(
      received.some((input) => input.connectionRef.connectionId === replacementConnectionId),
    ).toBe(false);
  });

  test("resolves the private Google Drive publication server only through its frozen UUID", async () => {
    const frozenConnectionId = "11111111-1111-4111-8111-111111111111";
    const received: ResolveConnectionCredentialInput[] = [];
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: [
        {
          serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
          connectionId: frozenConnectionId,
          ownerSubjectId: "user:owner",
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
        },
      ],
      ownerHasWorkspaceMembership: async (subjectId) => subjectId === "user:owner",
      resolveCredential: async (input) => {
        received.push(input);
        return {
          status: "ok",
          headers: { "x-test-credential": "frozen" },
          connectionId: input.connectionRef.connectionId!,
        };
      },
    });

    await resolver({
      workspaceId: "workspace-1",
      subjectId: "worker:first-party-mcp",
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: "google_drive_publish_file",
      destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: [GOOGLE_DRIVE_FILE_SCOPE],
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      subjectId: "user:owner",
      connectionRef: { connectionId: frozenConnectionId },
    });
  });

  test("rejects ambiguous frozen Google Drive publication delegations", async () => {
    const delegation = {
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      connectionId: "11111111-1111-4111-8111-111111111111",
      ownerSubjectId: "user:owner",
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2" as const,
    };
    const resolver = withFrozenPersonalConnectionDelegations({
      settings: { mcpServers: [] },
      personalConnectionDelegations: [
        delegation,
        { ...delegation, connectionId: "22222222-2222-4222-8222-222222222222" },
      ],
      ownerHasWorkspaceMembership: async () => true,
      resolveCredential: async () => {
        throw new Error("must not resolve an ambiguous delegation");
      },
    });
    await expect(
      resolver({
        workspaceId: "workspace-1",
        subjectId: "worker:first-party-mcp",
        serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
        toolName: "google_drive_publish_file",
        destinationUrl: "https://www.googleapis.com/upload/drive/v3/files",
        connectionRef: {
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
          subjectScope: "subject",
          scopes: [GOOGLE_DRIVE_FILE_SCOPE],
        },
      }),
    ).resolves.toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
  });
});
