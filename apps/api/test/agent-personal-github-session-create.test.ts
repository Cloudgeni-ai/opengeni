import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { FirstPartyMcpToolName, Permission } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getPersonalGitHubRepositorySelectionState,
  getSession,
  initializeSessionStartAtomically,
  persistProviderOAuthConnection,
  replacePersonalGitHubRepositorySelections,
  type DbClient,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

/**
 * An agent turn that holds the person's Your GitHub delegation starts a
 * worker on a repository named only by uri, ref and connectionType, and the
 * status tool reports All my repositories (real PostgreSQL, fake GitHub).
 */

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const AGENT_PERMISSIONS: Permission[] = [
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "workspace:read",
  "github:use",
  "scheduled_tasks:manage",
];
const TOOLS: FirstPartyMcpToolName[] = [
  "session_create",
  "github_connect_link",
  "scheduled_tasks_create",
  "scheduled_tasks_update",
];
const listed = {
  repositoryId: "9007199254740993",
  fullName: "Cloudgeni-ai/opengeni",
  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
};

let shared: SharedTestDatabase | null = null;
let dbClient: DbClient | null = null;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-agent-personal-github-session-create");
  if (!shared && requireRealDatabase) {
    throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
  }
  if (shared) dbClient = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await dbClient?.close();
  await shared?.release();
}, 60_000);

function githubRepository(fullName: string, id: string, push: boolean) {
  return {
    id,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    private: true,
    visibility: "private",
    archived: false,
    disabled: false,
    default_branch: "main",
    permissions: { pull: true, triage: false, push, maintain: false, admin: false },
  };
}

async function personWithYourGitHub(allRepositories: "read" | "write" | null) {
  if (!shared || !dbClient) throw new Error("PostgreSQL test database unavailable");
  const db = dbClient.db;
  const userId = `agent-personal-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Your GitHub owner",
  });
  const originGrant = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  );
  if (!originGrant) throw new Error("personal workspace grant was not projected");
  const [target] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${originGrant.accountId}, 'Agent workers as the person') returning id
  `;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${target!.id}, ${originGrant.accountId})
  `;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, permissions)
    values (
      ${originGrant.accountId}, ${target!.id}, ${subjectId},
      ${JSON.stringify([
        "workspace:read",
        "sessions:create",
        "github:use",
        "scheduled_tasks:manage",
        "connections:read",
        "connections:write",
      ])}::jsonb
    )
  `;
  const settings: Settings = testSettings({
    productAccessMode: "managed",
    sandboxBackend: "none",
    githubPersonalOauthEnabled: true,
    githubPersonalAllRepositoriesEnabled: true,
    githubPersonalOauthClientId: "Ov23agent-client",
    githubPersonalOauthClientSecret: "agent-client-secret",
    integrationsEnabled: true,
    integrationsStateSecret: "agent-personal-github-state-secret",
    environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
  });
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("test encryption key was not configured");
  const credentialBindingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const connection = await persistProviderOAuthConnection(db, {
    accountId: originGrant.accountId,
    workspaceId: target!.id,
    subjectId,
    visibleToSubjectId: subjectId,
    providerDomain: "github.com",
    kind: "oauth2",
    status: "active",
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({ access_token: "person-token", token_type: "Bearer", scope: "repo" }),
    ),
    grantedScopes: ["repo"],
    expiresAt: null,
    metadata: {
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "9876543210987654321",
      githubUserId: "9876543210987654321",
      githubLogin: "octocat",
      oauthEnvironment: settings.environment,
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
  const empty = await getPersonalGitHubRepositorySelectionState(db, {
    accountId: originGrant.accountId,
    originWorkspaceId: target!.id,
    subjectId,
    connectionId: connection.id,
  });
  if (!empty) throw new Error("repository selection head was not created");
  const selected = await replacePersonalGitHubRepositorySelections(db, {
    accountId: originGrant.accountId,
    originWorkspaceId: target!.id,
    subjectId,
    connectionId: connection.id,
    expectedConnectionAuthorityGeneration: empty.connectionAuthorityGeneration,
    expectedSelectionGeneration: 0,
    idempotencyKey: crypto.randomUUID(),
    ...(allRepositories ? { allRepositoriesAccess: allRepositories } : {}),
    repositories: [
      {
        ...listed,
        defaultBranch: "main",
        visibility: "private",
        private: true,
        archived: false,
        disabled: false,
        permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
        selectedAccess: "write",
        lastVerifiedAt: now,
      },
    ],
  });
  // The person's own message: Your GitHub as accepted for this chat.
  const parentRepositories = allRepositories
    ? []
    : [
        {
          ...listed,
          ref: "main",
          access: "write" as const,
          selectionGeneration: selected.selectionGeneration,
        },
      ];
  const delegation = {
    serverId: "github:personal",
    connectionId: connection.id,
    originWorkspaceId: target!.id,
    ownerSubjectId: subjectId,
    providerDomain: "github.com",
    kind: "oauth2" as const,
    connectionType: "github_personal" as const,
    personalGitHubRepositorySelection: {
      credentialBindingId,
      connectionAuthorityGeneration: empty.connectionAuthorityGeneration,
      selectionGeneration: selected.selectionGeneration,
      ...(allRepositories ? { allRepositoriesAccess: allRepositories } : {}),
      repositories: parentRepositories,
    },
  };
  const root = await createSession(db, {
    accountId: originGrant.accountId,
    workspaceId: target!.id,
    initialMessage: "start workers as me",
    resources: allRepositories
      ? []
      : [
          {
            kind: "repository",
            uri: listed.canonicalUrl,
            ref: "main",
            provider: "github",
            connectionType: "github_personal",
            credentialBindingId,
            repositoryId: listed.repositoryId,
            access: "write",
          },
        ],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: settings.openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    subjectId,
    firstPartyMcpTools: TOOLS,
    personalConnectionDelegations: [delegation],
  });
  await initializeSessionStartAtomically(db, {
    accountId: originGrant.accountId,
    workspaceId: target!.id,
    sessionId: root.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, target!.id, {
    sessionId: root.id,
    workflowId: `session-${root.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const githubCalls: string[] = [];
  const githubPersonalFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    githubCalls.push(`${url.pathname} ${new Headers(init?.headers).get("authorization")}`);
    const known = {
      "/repos/acme/elsewhere": githubRepository("acme/elsewhere", "77", true),
      "/repos/acme/read-only": githubRepository("acme/read-only", "78", false),
      "/repos/octocat_acme/tools": githubRepository("octocat_acme/tools", "79", true),
    }[url.pathname];
    // GitHub no longer accepts the person's token for this one.
    if (url.pathname === "/repos/acme/token-revoked") return new Response("{}", { status: 401 });
    return known ? Response.json(known) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const noop = async () => undefined;
  const deps = {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    githubPersonalFetch,
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
  const server = buildOpenGeniMcpServer(deps, {
    accountId: originGrant.accountId,
    workspaceId: target!.id,
    subjectId: "worker:first-party-mcp",
    permissions: AGENT_PERMISSIONS,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: root.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: TOOLS,
    },
  });
  async function call(name: string, args: Record<string, unknown>) {
    const tool = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            description: string;
            handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
          }
        >;
      }
    )._registeredTools[name];
    if (!tool) throw new Error(`MCP tool not registered: ${name}`);
    let result: {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    try {
      result = (await tool.handler(args, {})) as typeof result;
    } catch (error) {
      // The MCP transport reports a thrown refusal as a tool error.
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    }
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
  }
  async function child(resources: Record<string, unknown>[]) {
    const result = await call("session_create", { initialMessage: "worker", resources });
    if (result.isError) return { error: result.text } as const;
    const receipt = JSON.parse(result.text) as { resource: { id: string } };
    const session = await getSession(db, target!.id, receipt.resource.id);
    if (!session) throw new Error("child session was not created");
    const [row] = await shared!.admin<Array<{ delegations: unknown }>>`
      select initial_personal_connection_delegations as delegations
      from sessions where id = ${session.id}
    `;
    return { session, delegations: row!.delegations as Array<Record<string, any>> } as const;
  }
  const selection = {
    accountId: originGrant.accountId,
    originWorkspaceId: target!.id,
    subjectId,
    connectionId: connection.id,
  };
  return { call, child, credentialBindingId, connection, githubCalls, root, db, selection };
}

describe("agent-created workers act as the person (real PostgreSQL)", () => {
  test("a repository in the chat's chosen list resolves from uri and ref; others are refused", async () => {
    if (!shared) return;
    const person = await personWithYourGitHub(null);
    const created = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/cloudgeni-ai/opengeni.git",
        ref: "feature/worker",
        connectionType: "github_personal",
      },
    ]);
    if ("error" in created) throw new Error(created.error);
    expect(created.session.parentSessionId).toBe(person.root.id);
    expect(created.session.resources).toEqual([
      expect.objectContaining({
        kind: "repository",
        uri: listed.canonicalUrl,
        ref: "feature/worker",
        provider: "github",
        connectionType: "github_personal",
        credentialBindingId: person.credentialBindingId,
        repositoryId: listed.repositoryId,
        access: "write",
      }),
    ]);
    // The worker's first turn carries the same person's connection for that repository.
    expect(created.delegations).toEqual([
      expect.objectContaining({
        connectionId: person.connection.id,
        connectionType: "github_personal",
        personalGitHubRepositorySelection: expect.objectContaining({
          credentialBindingId: person.credentialBindingId,
          repositories: [
            expect.objectContaining({
              repositoryId: listed.repositoryId,
              ref: "feature/worker",
              access: "write",
            }),
          ],
        }),
      }),
    ]);
    // The chosen list never asks GitHub.
    expect(person.githubCalls).toEqual([]);

    const outside = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/acme/elsewhere",
        ref: "main",
        connectionType: "github_personal",
      },
    ]);
    expect("error" in outside && outside.error).toContain(
      "acme/elsewhere is not part of this turn's Your GitHub access",
    );

    const status = await person.call("github_connect_link", {});
    expect(JSON.parse(status.text).personal).toMatchObject({
      connected: true,
      repositoryCount: 1,
      allRepositories: { enabled: false, access: null },
    });

    // A schedule the agent creates resolves the same way.
    const schedule = await person.call("scheduled_tasks_create", {
      name: "Nightly as the person",
      schedule: { type: "manual" },
      runMode: "new_session_per_run",
      agentConfig: {
        prompt: "nightly work",
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/Cloudgeni-ai/opengeni",
            ref: "main",
            connectionType: "github_personal",
            access: "read",
          },
        ],
        tools: [],
        metadata: {},
      },
    });
    expect(schedule.isError).toBe(false);
    const taskId = (JSON.parse(schedule.text) as { resource: { id: string } }).resource.id;
    const [task] = await shared.admin<Array<{ agentConfig: { resources: unknown[] } }>>`
      select agent_config as "agentConfig" from scheduled_tasks where id = ${taskId}
    `;
    expect(task?.agentConfig.resources).toEqual([
      expect.objectContaining({
        uri: listed.canonicalUrl,
        provider: "github",
        connectionType: "github_personal",
        credentialBindingId: person.credentialBindingId,
        repositoryId: listed.repositoryId,
        access: "read",
      }),
    ]);

    // Editing the schedule resolves the same way, and refuses the same way.
    const updated = await person.call("scheduled_tasks_update", {
      id: taskId,
      agentConfig: {
        prompt: "nightly work",
        resources: [
          {
            kind: "repository",
            uri: "git@github.com:Cloudgeni-ai/opengeni.git",
            ref: "release",
            connectionType: "github_personal",
          },
        ],
        tools: [],
        metadata: {},
      },
    });
    expect(updated.isError).toBe(false);
    const [edited] = await shared.admin<Array<{ agentConfig: { resources: unknown[] } }>>`
      select agent_config as "agentConfig" from scheduled_tasks where id = ${taskId}
    `;
    expect(edited?.agentConfig.resources).toEqual([
      expect.objectContaining({
        uri: listed.canonicalUrl,
        ref: "release",
        credentialBindingId: person.credentialBindingId,
        repositoryId: listed.repositoryId,
        access: "write",
      }),
    ]);
    const refusedEdit = await person.call("scheduled_tasks_update", {
      id: taskId,
      agentConfig: {
        prompt: "nightly work",
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/acme/elsewhere",
            ref: "main",
            connectionType: "github_personal",
          },
        ],
        tools: [],
        metadata: {},
      },
    });
    expect(refusedEdit.isError).toBe(true);
    expect(refusedEdit.text).toContain(
      "acme/elsewhere is not part of this turn's Your GitHub access",
    );
  });

  test("All my repositories resolves any repository the person can reach, as the person", async () => {
    if (!shared) return;
    const person = await personWithYourGitHub("write");
    const created = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/acme/elsewhere",
        ref: "main",
        connectionType: "github_personal",
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/read-only",
        ref: "main",
        connectionType: "github_personal",
      },
    ]);
    if ("error" in created) throw new Error(created.error);
    expect(created.session.resources).toEqual([
      expect.objectContaining({ repositoryId: "77", access: "write" }),
      expect.objectContaining({ repositoryId: "78", access: "read" }),
    ]);
    expect(created.delegations[0]?.personalGitHubRepositorySelection).toMatchObject({
      allRepositoriesAccess: "write",
      repositories: [
        expect.objectContaining({ repositoryId: "77", access: "write" }),
        expect.objectContaining({ repositoryId: "78", access: "read" }),
      ],
    });
    // GitHub was asked as the person.
    expect(person.githubCalls).toEqual([
      "/repos/acme/elsewhere Bearer person-token",
      "/repos/acme/read-only Bearer person-token",
    ]);
    const writeOnReadOnly = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/acme/read-only",
        ref: "main",
        connectionType: "github_personal",
        access: "write",
      },
    ]);
    expect("error" in writeOnReadOnly && writeOnReadOnly.error).toContain(
      "can only be read as the person",
    );
    const missing = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/acme/missing",
        ref: "main",
        connectionType: "github_personal",
      },
    ]);
    expect("error" in missing && missing.error).toContain("GitHub has no repository acme/missing");
    // GitHub refusing the person's token asks them to reconnect, not to retry.
    const revoked = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/acme/token-revoked",
        ref: "main",
        connectionType: "github_personal",
      },
    ]);
    expect("error" in revoked && revoked.error).toContain("reconnect Your GitHub");

    const status = await person.call("github_connect_link", {});
    expect(JSON.parse(status.text).personal).toMatchObject({
      connected: true,
      repositoryCount: 1,
      allRepositories: { enabled: true, access: "write" },
    });
  });

  test("an enterprise managed user's own repositories (owner with an underscore) work", async () => {
    if (!shared) return;
    const person = await personWithYourGitHub("write");
    const created = await person.child([
      {
        kind: "repository",
        uri: "https://github.com/octocat_acme/tools.git",
        ref: "main",
        connectionType: "github_personal",
      },
    ]);
    if ("error" in created) throw new Error(created.error);
    expect(created.session.resources).toEqual([
      expect.objectContaining({
        uri: "https://github.com/octocat_acme/tools",
        repositoryId: "79",
        access: "write",
      }),
    ]);
    // The chosen list stores it too (the database checks the owner shape).
    const current = await getPersonalGitHubRepositorySelectionState(person.db, person.selection);
    if (!current) throw new Error("repository selection head is missing");
    const replaced = await replacePersonalGitHubRepositorySelections(person.db, {
      ...person.selection,
      expectedConnectionAuthorityGeneration: current.connectionAuthorityGeneration,
      expectedSelectionGeneration: current.selectionGeneration,
      idempotencyKey: crypto.randomUUID(),
      repositories: [
        {
          repositoryId: "79",
          fullName: "octocat_acme/tools",
          canonicalUrl: "https://github.com/octocat_acme/tools",
          defaultBranch: "main",
          visibility: "private",
          private: true,
          archived: false,
          disabled: false,
          permissions: { pull: true, triage: false, push: true, maintain: false, admin: false },
          selectedAccess: "write",
          lastVerifiedAt: new Date().toISOString(),
        },
      ],
    });
    expect(replaced.repositories.map((repository) => repository.fullName)).toEqual([
      "octocat_acme/tools",
    ]);
  });
});
