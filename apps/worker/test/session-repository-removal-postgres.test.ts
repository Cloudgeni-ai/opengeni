import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { AccessGrant, ResourceRef, SessionTurn } from "@opengeni/contracts";
import { pendingSessionRepositoryCleanup, removeSessionResources } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSandboxGroupRepositoryResources,
  settleSessionRepositoryCleanup,
  type DbClient,
} from "@opengeni/db";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  assertTokenRepositoriesAttached,
  attachedRepositoryResources,
  GitHubTokenMintRepositoryRemovedError,
} from "../src/activities/agent-turn/session-repository-authority";
import { buildGitHubRestMcpForTurn } from "../src/github-rest-mcp";
import {
  prepareTurnToolPolicy,
  type PrepareTurnToolPolicyDeps,
} from "../src/activities/agent-turn/tool-environment";
import { sandboxRepositoryRemovalHooks } from "@opengeni/runtime";
import {
  createStandaloneConnectionCredentialsPort,
  gitTokensMintedByOpengeni,
} from "../src/standalone-git-credentials";

// A repository removed from a chat stops reaching GitHub App token mints and
// the GitHub tools on the next call, for the chat and its child chats, even
// though their turns hold an older resource snapshot.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-session-repository-removal");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const groceryBot: ResourceRef = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/grocery-bot.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 72,
};
const docs: ResourceRef = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/docs.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 73,
};

async function chatWithChild(db: DbClient["db"]) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "session-repository-removal-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Repository removal",
    workspaceExternalSource: "session-repository-removal-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Repository removal",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const create = async (parent: { id: string; sandboxGroupId: string } | null) => {
    const session = await createSession(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      parentSessionId: parent?.id ?? null,
      // Children share their parent's box by default.
      sandboxGroupId: parent?.sandboxGroupId ?? null,
      initialMessage: "work on the repositories",
      resources: [groceryBot, docs],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      createdByContext: {},
    });
    await initializeSessionStartAtomically(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    return session;
  };
  const parent = await create(null);
  const child = await create(parent);
  const person: AccessGrant = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["sessions:read", "sessions:control"],
    principalKind: "human_session",
  };
  const removeGroceryBot = async (from: { id: string } = parent) =>
    await removeSessionResources({ db, bus: new MemoryEventBus() }, person, from.id, {
      resources: [{ kind: "repository", uri: groceryBot.uri }],
    });
  return { grant, parent, child, removeGroceryBot };
}

const uris = (resources: ResourceRef[]) =>
  resources.map((resource) => (resource.kind === "repository" ? resource.uri : resource.kind));

describe("removed repositories and credential minting (real PostgreSQL)", () => {
  test("lazy and renewed mints narrow, and the mint guard refuses a removed repository", async () => {
    if (!client) return;
    const { grant, parent, child, removeGroceryBot } = await chatWithChild(client.db);
    for (const session of [parent, child]) {
      const ref = { db: client.db, workspaceId: grant.workspaceId, sessionId: session.id };
      expect(uris(await attachedRepositoryResources(ref, [groceryBot, docs]))).toEqual([
        groceryBot.uri,
        docs.uri,
      ]);
      await assertTokenRepositoriesAttached(ref, [groceryBot]);
    }

    await removeGroceryBot();

    for (const session of [parent, child]) {
      const ref = { db: client.db, workspaceId: grant.workspaceId, sessionId: session.id };
      // The turn's own snapshot still lists both repositories.
      expect(uris(await attachedRepositoryResources(ref, [groceryBot, docs]))).toEqual([docs.uri]);
      await assertTokenRepositoriesAttached(ref, [docs]);
      await expect(assertTokenRepositoriesAttached(ref, [docs, groceryBot])).rejects.toBeInstanceOf(
        GitHubTokenMintRepositoryRemovedError,
      );
    }
  });

  test("the GitHub tools refuse a removed repository on the next call", async () => {
    if (!client) return;
    const { grant, parent, child, removeGroceryBot } = await chatWithChild(client.db);
    const repositoryGet = async (sessionId: string) => {
      const built = await buildGitHubRestMcpForTurn({
        db: client!.db,
        settings: testSettings({ githubRestMcpEnabled: true }),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        attemptId: crypto.randomUUID(),
        turn: { personalConnectionDelegations: [] } as unknown as SessionTurn,
        // A turn accepted before the removal keeps this snapshot.
        resources: [groceryBot, docs],
        tools: [],
        resolveCredential: async () => ({
          status: "auth_needed",
          reason: "missing_connection",
          providerDomain: "github.com",
        }),
      });
      const server = built.localMcpServers[0]!.server as {
        callToolResult(name: string, args: Record<string, unknown>): Promise<any>;
      };
      return await server.callToolResult("repository_get", {
        repository: "Cloudgeni-ai/grocery-bot",
      });
    };

    for (const session of [parent, child]) {
      const before = await repositoryGet(session.id);
      // No App installation exists in this test, so the call fails later,
      // but not because of session membership.
      expect(before.content[0].text).not.toContain("removed from this chat");
    }
    await removeGroceryBot();
    for (const session of [parent, child]) {
      const after = await repositoryGet(session.id);
      expect(after.isError).toBe(true);
      expect(after.content[0].text).toBe("Cloudgeni-ai/grocery-bot was removed from this chat");
    }
  });

  test("a child's cleanup keeps what its parent still uses in the shared box", async () => {
    if (!client) return;
    const { grant, parent, child, removeGroceryBot } = await chatWithChild(client.db);
    expect(child.sandboxGroupId).toBe(parent.sandboxGroupId);
    await removeGroceryBot(child);
    const removed = pendingSessionRepositoryCleanup(
      (await getSession(client.db, grant.workspaceId, child.id))!,
    ).map((entry) => entry.resource);
    expect(uris(removed)).toEqual([groceryBot.uri]);
    const retained = await listSandboxGroupRepositoryResources(
      client.db,
      grant.workspaceId,
      child.sandboxGroupId,
      child.id,
    );
    expect(uris(retained)).toEqual([groceryBot.uri, docs.uri]);
    // Nothing is deleted from the box the parent still uses; the child's
    // pending cleanup is simply cleared.
    let cleaned = 0;
    const hooks = sandboxRepositoryRemovalHooks(
      [docs],
      { removed, retained, onCleaned: async () => void (cleaned += 1) },
      "docker",
    );
    expect(hooks.map((hook) => hook.id)).toEqual(["repository-removal"]);
    let commands = 0;
    const box = { exec: async () => void (commands += 1) };
    await hooks[0]!.run(box as never, {} as never);
    expect(commands).toBe(0);
    expect(cleaned).toBe(1);
  });

  test("a turn accepted before the removal leaves the repository out, also after cleanup", async () => {
    if (!client) return;
    const db = client.db;
    const { grant, parent, removeGroceryBot } = await chatWithChild(db);
    await removeGroceryBot();
    const settings = testSettings();
    const prepare = async () => {
      const session = (await getSession(db, grant.workspaceId, parent.id))!;
      return await prepareTurnToolPolicy({
        input: {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: parent.id,
          attemptId: crypto.randomUUID(),
        } as PrepareTurnToolPolicyDeps["input"],
        db,
        cancellationSignal: undefined,
        // Accepted with both repositories attached.
        turn: {
          resources: [groceryBot, docs],
          tools: [],
        } as unknown as PrepareTurnToolPolicyDeps["turn"],
        session,
        fileAuthoritySubjectId: null,
        capabilitySettings: settings,
        runSettings: settings,
        rigVersion: null,
      });
    };
    const first = await prepare();
    expect(uris(first.turnResources)).toEqual([docs.uri]);
    expect(uris(first.runtimeResources)).toEqual([docs.uri]);
    expect(uris(first.repositoryRemoval?.removed ?? [])).toEqual([groceryBot.uri]);
    // The sandbox cleanup ran: later turns skip it, and the repository still
    // stays out of the turn.
    await first.repositoryRemoval!.onCleaned!();
    const later = await prepare();
    expect(later.repositoryRemoval).toBeNull();
    expect(uris(later.turnResources)).toEqual([docs.uri]);
    // Settling is idempotent.
    await settleSessionRepositoryCleanup(db, grant.workspaceId, parent.id, [crypto.randomUUID()]);
  });
});

describe("revoking a removed repository's token", () => {
  test("only Opengeni's own GitHub App tokens are revocable", () => {
    expect(
      gitTokensMintedByOpengeni(createStandaloneConnectionCredentialsPort(testSettings())),
    ).toBe(true);
    expect(gitTokensMintedByOpengeni(undefined)).toBe(true);
    // A host credential callback supplies its own tokens.
    expect(
      gitTokensMintedByOpengeni({
        gitCredentials: async (request) => ({ token: "host", workspaceId: request.workspaceId }),
      }),
    ).toBe(false);
  });
});
