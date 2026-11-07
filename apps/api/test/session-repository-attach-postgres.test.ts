// An agent asks to attach a workspace GitHub App repository to its own chat
// with `github_repository_attach`. A person approves each call in the chat;
// the API attaches only a call a person approved for exactly that repository
// and branch, that this attempt is running, from the workspace App catalog.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant, FirstPartyMcpToolName, Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  beginConnectorActionExecution,
  bindAuthorizedGitHubInstallationRepositories,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deleteWorkspace,
  listSessionEvents,
  prepareConnectorActionApproval,
  requireSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let workspace: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

setDefaultTimeout(120_000);

const TOOLS: FirstPartyMcpToolName[] = ["github_repositories_list", "github_repository_attach"];

function githubRepository(
  id: number,
  name: string,
  extra: { archived?: boolean; sizeKb?: number; installationId?: number } = {},
) {
  return {
    id,
    installationId: 71,
    fullName: `example-owner/${name}`,
    name,
    private: true,
    htmlUrl: `https://github.com/example-owner/${name}`,
    cloneUrl: `https://github.com/example-owner/${name}.git`,
    defaultBranch: "main",
    accountLogin: "example-owner",
    accountType: "User",
    ...extra,
  };
}

function deps(): ApiRouteDeps {
  return {
    settings: testSettings(),
    db: client.db,
    bus: new MemoryEventBus(),
    githubAppApi: {
      getInstallation: async ({ installationId }: { installationId: number }) => ({
        installationId,
        accountId: 7100,
        accountLogin: "example-owner",
        accountType: "User",
        suspended: false,
      }),
      listRepositories: async () => [
        githubRepository(42, "project", { sizeKb: 120 }),
        githubRepository(43, "service"),
        githubRepository(46, "retired", { archived: true, sizeKb: 90 }),
        githubRepository(47, "blank", { sizeKb: 0 }),
        // Visible to the App through an installation this workspace never bound.
        githubRepository(99, "unbound", { installationId: 72 }),
      ],
    },
  } as unknown as ApiRouteDeps;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-repository-attach");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
    console.warn("[session-repository-attach] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "repository-attach-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Repository attach test",
    workspaceExternalSource: "repository-attach-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Repository attach test",
    subjectId: `user:${suffix}`,
  });
  workspace = access.workspaceGrants[0]!;
  const checkedAt = new Date();
  await bindAuthorizedGitHubInstallationRepositories(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    installationId: 71,
    githubAccountId: 7100,
    accountLogin: "example-owner",
    accountType: "User",
    linkedBySubjectId: workspace.subjectId,
    githubActorId: 7100,
    githubActorLogin: "example-owner",
    authorityKind: "personal_owner",
    authorityCheckedAt: checkedAt,
    authorityExpiresAt: new Date(checkedAt.getTime() + 600000),
    authorityNonce: crypto.randomUUID(),
    repositoryIds: [42, 43, 46, 47],
    eventRouteSecret: null,
  });
}, 180_000);

afterAll(async () => {
  if (client && workspace) await deleteWorkspace(client.db, workspace.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

/** A person's chat with one claimed turn, as the worker runs it. */
async function claimedTurn(resources: Parameters<typeof createSession>[1]["resources"] = []) {
  const db = client.db;
  const subjectId = workspace.subjectId;
  const session = await createSession(db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "repository attach fixture",
    resources,
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    firstPartyMcpTools: TOOLS,
  });
  await withWorkspaceSubjectSessionActivityRls(db, workspace.workspaceId, subjectId, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof scoped, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        sessionId: session.id,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: `send-${crypto.randomUUID()}`,
        delivery: "send",
        text: "check the service too",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspace.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`claim failed: ${claim.reason}`);
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    initiator: claim.turn.initiator,
  };
}

type Turn = Awaited<ReturnType<typeof claimedTurn>>;

function attachCall(approvalId: string, args: { repository: string; ref?: string }) {
  return {
    approvalId,
    connectionId: `session-mcp:opengeni:${"0".repeat(64)}`,
    serverId: "opengeni",
    toolName: "github_repository_attach",
    arguments: args,
    approvalMode: "session_mcp" as const,
    defaultDecision: "ask" as const,
    reviewContext: { kind: "generic" as const, title: `Attach ${args.repository} to this chat` },
  };
}

/** The worker's path for one call: the card, a decision, then execution. */
async function decideAndBegin(
  turn: Turn,
  approvalId: string,
  args: { repository: string; ref?: string },
  by: "human" | "api" | "agent_attempt" = "human",
) {
  const call = attachCall(approvalId, args);
  expect(await prepareConnectorActionApproval(client.db, turn, call)).toMatchObject({
    decision: "ask",
    approvalStatus: "pending",
  });
  const [event] = await shared!.admin<{ id: string }[]>`
    select id from session_events where session_id = ${turn.sessionId}
    order by sequence desc limit 1`;
  await shared!.admin`
    update connector_action_requests
    set status = 'approved', decision = 'approve', decision_by_subject_id = ${workspace.subjectId},
      decision_by_kind = ${by}, decision_by_signed_in_person = ${by === "human"},
      decision_event_id = ${event!.id}, decided_at = now(), updated_at = now()
    where workspace_id = ${turn.workspaceId} and turn_id = ${turn.turnId}
      and approval_id = ${approvalId}`;
  expect(await beginConnectorActionExecution(client.db, turn, call)).toMatchObject({
    allowed: true,
  });
}

async function withMcp<T>(
  turn: Turn | null,
  permissions: Permission[],
  run: (mcp: Client) => Promise<T>,
): Promise<T> {
  const grant: AccessGrant = {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions,
    ...(turn
      ? {
          principalKind: "agent_attempt" as const,
          metadata: {
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            attemptId: turn.attemptId,
            executionGeneration: turn.executionGeneration,
            firstPartyMcpTools: TOOLS,
          },
        }
      : {}),
  };
  const server = buildOpenGeniMcpServer(deps(), grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "repository-attach-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  try {
    return await run(mcp);
  } finally {
    await mcp.close();
    await server.close();
  }
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const item = (result.content as Array<{ type: string; text?: string }>).find(
    (entry) => entry.type === "text",
  );
  return item?.text ?? "";
}

async function sessionResources(turn: Turn) {
  return (await requireSession(client.db, turn.workspaceId, turn.sessionId)).resources;
}

describe("github_repository_attach (real PostgreSQL)", () => {
  test("is offered only to a chat's own signed attempt with github:use", async () => {
    if (!shared) return;
    const turn = await claimedTurn();
    const names = async (t: Turn | null, permissions: Permission[]) =>
      await withMcp(t, permissions, async (mcp) =>
        (await mcp.listTools()).tools.map((tool) => tool.name),
      );
    const offered = await names(turn, ["github:use", "sessions:read"]);
    expect(offered).toContain("github_repository_attach");
    expect(offered).toContain("github_repositories_list");
    expect(await names(turn, ["sessions:read"])).not.toContain("github_repository_attach");
    // A sessionless grant (an operator or API key) has no chat of its own.
    expect(await names(null, ["github:use", "sessions:read"])).not.toContain(
      "github_repository_attach",
    );
  });

  test("attaches nothing without a person's approval of exactly that call", async () => {
    if (!shared) return;
    const turn = await claimedTurn();
    await withMcp(turn, ["github:use"], async (mcp) => {
      const call = () =>
        mcp.callTool({
          name: "github_repository_attach",
          arguments: { repository: "example-owner/service" },
        });
      // Never asked.
      let result = await call();
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("needs a person's approval");
      // An agent (such as a parent answering for its worker) approved it.
      await decideAndBegin(
        turn,
        "by-agent",
        { repository: "example-owner/service" },
        "agent_attempt",
      );
      result = await call();
      expect(result.isError).toBe(true);
      // A person approved another repository, or another branch.
      await decideAndBegin(turn, "other-repo", { repository: "example-owner/project" });
      await decideAndBegin(turn, "other-ref", {
        repository: "example-owner/service",
        ref: "release",
      });
      result = await call();
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("needs a person's approval");
    });
    expect(await sessionResources(turn)).toEqual([]);
    // Another attempt never borrows this attempt's approval.
    await decideAndBegin(turn, "approved", { repository: "example-owner/service" });
    await withMcp({ ...turn, attemptId: crypto.randomUUID() }, ["github:use"], async (mcp) => {
      const result = await mcp.callTool({
        name: "github_repository_attach",
        arguments: { repository: "example-owner/service" },
      });
      expect(result.isError).toBe(true);
    });
    expect(await sessionResources(turn)).toEqual([]);
  });

  test("an approved call attaches the catalog repository on its default branch, once", async () => {
    if (!shared) return;
    const turn = await claimedTurn();
    await decideAndBegin(turn, "service", { repository: "Example-Owner/Service" });
    await withMcp(turn, ["github:use"], async (mcp) => {
      const result = await mcp.callTool({
        name: "github_repository_attach",
        arguments: { repository: "Example-Owner/Service" },
      });
      expect(result.isError, resultText(result)).not.toBe(true);
      expect(JSON.parse(resultText(result))).toEqual({
        status: "attached",
        repository: "example-owner/service",
        ref: "main",
        mountPath: "repos/github.com/example-owner/service",
        reattached: false,
        message:
          "Attached example-owner/service (branch main). It is cloned at repos/github.com/example-owner/service when the next turn starts.",
      });
      // The same approval again changes nothing.
      const again = await mcp.callTool({
        name: "github_repository_attach",
        arguments: { repository: "Example-Owner/Service" },
      });
      expect(JSON.parse(resultText(again))).toMatchObject({ status: "already_attached" });
    });
    expect(await sessionResources(turn)).toEqual([
      {
        kind: "repository",
        uri: "https://github.com/example-owner/service.git",
        ref: "main",
        mountPath: "repos/github.com/example-owner/service",
        provider: "github",
        githubInstallationId: 71,
        githubRepositoryId: 43,
        optional: true,
      },
    ]);
    const added = (await listSessionEvents(client.db, turn.workspaceId, turn.sessionId)).filter(
      (event) => event.type === "session.resources.added",
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.payload).toEqual({
      resources: [expect.objectContaining({ githubRepositoryId: 43 })],
    });
  });

  test("approval attaches a repository a person removed earlier, on the asked branch", async () => {
    if (!shared) return;
    const turn = await claimedTurn();
    await shared!.admin`
      update sessions set removed_repositories = ${shared!.admin.json([
        {
          id: crypto.randomUUID(),
          resource: {
            kind: "repository",
            uri: "https://github.com/example-owner/project.git",
            ref: "main",
            provider: "github",
            githubInstallationId: 71,
            githubRepositoryId: 42,
          },
          removedAt: new Date().toISOString(),
          sandboxCleanupPending: false,
        },
      ])}::jsonb
      where id = ${turn.sessionId}`;
    await decideAndBegin(turn, "project", {
      repository: "https://github.com/example-owner/project",
      ref: "feature",
    });
    await withMcp(turn, ["github:use"], async (mcp) => {
      const result = await mcp.callTool({
        name: "github_repository_attach",
        arguments: { repository: "https://github.com/example-owner/project", ref: "feature" },
      });
      expect(JSON.parse(resultText(result))).toMatchObject({
        status: "attached",
        ref: "feature",
        reattached: true,
      });
    });
    const session = await requireSession(client.db, turn.workspaceId, turn.sessionId);
    expect(session.resources).toEqual([
      expect.objectContaining({ githubRepositoryId: 42, ref: "feature", optional: true }),
    ]);
    expect(session.removedRepositories ?? []).toEqual([]);
  });

  test("refuses repositories the workspace App does not offer, archived and empty ones", async () => {
    if (!shared) return;
    const turn = await claimedTurn();
    const cases: Array<[string, string]> = [
      ["example-owner/unbound", "is not offered by the workspace GitHub App"],
      ["someone-else/elsewhere", "is not offered by the workspace GitHub App"],
      ["example-owner/retired", "is archived"],
      ["example-owner/blank", "is empty"],
    ];
    for (const [index, [repository]] of cases.entries()) {
      await decideAndBegin(turn, `refused-${index}`, { repository });
    }
    await withMcp(turn, ["github:use"], async (mcp) => {
      for (const [repository, message] of cases) {
        const result = await mcp.callTool({
          name: "github_repository_attach",
          arguments: { repository },
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain(message);
      }
    });
    expect(await sessionResources(turn)).toEqual([]);
  });
});
