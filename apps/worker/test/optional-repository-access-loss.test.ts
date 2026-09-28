// A Slack-started session carries the caller's recently used GitHub
// repositories as automatically attached (`optional: true`) resources. When one
// of them loses access after the session started (a workspace admin removes it
// from the GitHub App allowlist), later turns must continue without it instead
// of failing the whole turn, while an explicitly attached repository keeps the
// strict per-turn authorization. This drives a real `runAgentTurn` against
// Postgres: the allowlist change is the ordinary rebind a workspace admin makes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GitCredentialsRequest, ResourceRef } from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";

const INSTALLATION_ID = 9_001;
const KEPT_REPOSITORY_ID = 101;
const REMOVED_REPOSITORY_ID = 202;

function githubRepository(input: {
  name: string;
  repositoryId: number;
  optional?: boolean;
}): ResourceRef {
  return {
    kind: "repository",
    uri: `https://github.com/example-org/${input.name}.git`,
    ref: "main",
    mountPath: `repos/github.com/example-org/${input.name}`,
    provider: "github",
    githubInstallationId: INSTALLATION_ID,
    githubRepositoryId: input.repositoryId,
    ...(input.optional ? { optional: true } : {}),
  } as ResourceRef;
}

describe("optional repository access lost after the session started", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("optional-repository-access-loss");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function allowlist(
    scope: { accountId: string; workspaceId: string; subjectId: string },
    repositoryIds: number[],
  ) {
    const checkedAt = new Date();
    const bound = await bindAuthorizedGitHubInstallationRepositories(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      installationId: INSTALLATION_ID,
      githubAccountId: 9_100,
      accountLogin: "example-org",
      accountType: "Organization",
      linkedBySubjectId: scope.subjectId,
      githubActorId: 9_200,
      githubActorLogin: "example-admin",
      authorityKind: "organization_owner",
      authorityCheckedAt: checkedAt,
      authorityExpiresAt: new Date(checkedAt.getTime() + 600_000),
      authorityNonce: crypto.randomUUID(),
      repositoryIds,
    });
    if (!bound) throw new Error("allowlist binding was not recorded");
  }

  async function runTurnAfterAllowlistChange(resources: ResourceRef[]) {
    const suffix = crypto.randomUUID();
    const human = `subject-${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Optional repository access",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Optional repository access",
      subjectId: human,
    });
    const grant = access.workspaceGrants[0]!;
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: human,
    };
    // The session starts while both repositories are allowlisted.
    await allowlist(scope, [KEPT_REPOSITORY_ID, REMOVED_REPOSITORY_ID]);
    const session = await createSession(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      initialMessage: "What changed in the repositories this week?",
      resources,
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: human },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    // A workspace admin then removes one repository from the allowlist.
    await allowlist(scope, [KEPT_REPOSITORY_ID]);

    const settings = testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    });
    const model = new ScriptedModel([
      { output: [assistantMessage("Nothing risky changed.", "msg_answer")] as never },
    ]);
    const productionRuntime = createProductionAgentRuntime({ model });
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Test chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        client: {} as never,
        model,
        configured: {
          id: "scripted-model",
          label: "Scripted model",
          providerId: "test-chat",
          providerLabel: "Test chat",
          api: "chat",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactTokenLimit: 225_000,
          reasoningEffort: false,
          hostedWebSearch: false,
        },
      }),
    };
    const mintRequests: GitCredentialsRequest[] = [];
    const activities = createActivityTestHarness({
      settings,
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
      connectionCredentials: {
        gitCredentials: async (request) => {
          mintRequests.push(request);
          return {
            token: "host-minted-token",
            workspaceId: request.workspaceId,
            credentialBindingId: request.credentialBindingId,
            provider: request.provider,
            ...(request.providerHost ? { providerHost: request.providerHost } : {}),
          };
        },
      },
    });
    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    const events = await listSessionEvents(client.db, scope.workspaceId, session.id, {
      after: 0,
      limit: 500,
    });
    return { result, events, mintRequests };
  }

  test("a removed automatically attached repository is dropped with a warning and the turn completes", async () => {
    const { result, events, mintRequests } = await runTurnAfterAllowlistChange([
      githubRepository({ name: "kept", repositoryId: KEPT_REPOSITORY_ID, optional: true }),
      githubRepository({ name: "removed", repositoryId: REMOVED_REPOSITORY_ID, optional: true }),
    ]);
    const failure = events.find((event) => event.type === "turn.failed");
    expect(failure?.payload ?? null).toBeNull();
    expect(result).toMatchObject({ status: "idle" });
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    // The turn still mints a token, scoped to the repository still allowlisted.
    expect(mintRequests.map((request) => request.repositoryIds)).toEqual([[KEPT_REPOSITORY_ID]]);
    expect(JSON.stringify(mintRequests)).not.toContain("example-org/removed");
    const warning = events.find(
      (event) =>
        event.type === "sandbox.operation.completed" &&
        (event.payload as { name?: unknown }).name === "optional-repository-access",
    );
    expect(warning?.payload).toEqual({
      name: "optional-repository-access",
      repositoryCount: 2,
      skippedOptionalRepositories: ["repos/github.com/example-org/removed"],
    });
  }, 120_000);

  test("a removed explicitly attached repository still fails the turn", async () => {
    const { events } = await runTurnAfterAllowlistChange([
      githubRepository({ name: "kept", repositoryId: KEPT_REPOSITORY_ID, optional: true }),
      githubRepository({ name: "removed", repositoryId: REMOVED_REPOSITORY_ID }),
    ]);
    const failure = events.find((event) => event.type === "turn.failed");
    expect(JSON.stringify(failure?.payload ?? null)).toContain(
      "no longer authorizes one or more GitHub repositories",
    );
    expect(
      events.some(
        (event) =>
          event.type === "sandbox.operation.completed" &&
          (event.payload as { name?: unknown }).name === "optional-repository-access",
      ),
    ).toBe(false);
  }, 120_000);
});
