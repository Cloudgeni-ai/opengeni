import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteWorkspace,
  listGitHubInstallationsForWorkspace,
  listSessionEvents,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let workspace: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("capability-discovery-mcp");
  if (!shared) {
    console.warn("[capability-discovery-mcp] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "capability-discovery-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Capability discovery test",
    workspaceExternalSource: "capability-discovery-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Capability discovery test",
    subjectId: `subject-${suffix}`,
  });
  workspace = access.workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && workspace) await deleteWorkspace(client.db, workspace.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

describe("agent capability discovery MCP (real PostgreSQL)", () => {
  test("finds GitHub, requests human authorization, and persists no grant", async () => {
    if (!shared) return;
    const attempt = await seedAttempt();
    const bus = new MemoryEventBus();
    const agentGrant: AccessGrant = {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["workspace:read"],
      principalKind: "agent_attempt",
      metadata: {
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
        firstPartyMcpTools: ["capability_catalog_search", "capability_authorization_request"],
      },
    };
    const server = buildOpenGeniMcpServer(
      {
        settings: testSettings({
          githubAppId: "12345",
          githubClientId: "github-client",
          githubClientSecret: "github-secret",
          githubAppSlug: "opengeni-test",
          githubAppPrivateKey: "test-private-key",
        }),
        db: client.db,
        bus,
        githubStateSecret: "capability-discovery-state-secret",
      } as ApiRouteDeps,
      agentGrant,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "capability-discovery-test", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      const search = await mcp.callTool({
        name: "capability_catalog_search",
        arguments: { query: "GitHub repositories" },
      });
      expect(search.isError).not.toBe(true);
      const searchBody = mcpJson(search) as {
        matches: Array<{
          capabilityId: string;
          providerDomain: string | null;
          setup: { status: string; action: string | null };
        }>;
      };
      expect(searchBody.matches[0]).toMatchObject({
        capabilityId: "api:github-app",
        providerDomain: "github.com",
        setup: { status: "authorization_required", action: "connect" },
      });

      const request = await mcp.callTool({
        name: "capability_authorization_request",
        arguments: {
          capabilityId: "api:github-app",
          rationale: "Repository access is needed to inspect and update the requested code.",
        },
      });
      expect(request.isError).not.toBe(true);
      expect(mcpJson(request)).toMatchObject({
        capabilityId: "api:github-app",
        status: "authorization_requested",
        action: "connect",
      });

      const events = await listSessionEvents(client.db, workspace.workspaceId, attempt.sessionId);
      const authEvent = events.find((event) => event.type === "tool.auth_needed");
      expect(authEvent).toMatchObject({
        turnId: attempt.turnId,
        turnAttemptId: attempt.attemptId,
        payload: {
          serverId: "opengeni",
          toolName: "capability_authorization_request",
          providerDomain: "github.com",
          capability: {
            id: "api:github-app",
            action: "connect",
          },
        },
      });
      expect(bus.published.flat().some((event) => event.id === authEvent?.id)).toBe(true);
      expect(await listGitHubInstallationsForWorkspace(client.db, workspace.workspaceId)).toEqual(
        [],
      );
      const [installationCount] = await shared.admin<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM capability_installations
        WHERE workspace_id = ${workspace.workspaceId}`;
      expect(installationCount?.count).toBe(0);
    } finally {
      await Promise.all([mcp.close(), server.close()]);
    }
  }, 60_000);
});

function mcpJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const item = result.content.find((entry) => entry.type === "text");
  if (!item || item.type !== "text") throw new Error("MCP result did not contain JSON text");
  return JSON.parse(item.text) as unknown;
}

async function seedAttempt(): Promise<{
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
}> {
  const session = await createSession(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "Use GitHub for this task",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    sandboxBackend: "none",
    firstPartyMcpPermissions: ["workspace:read"],
    firstPartyMcpTools: ["capability_catalog_search", "capability_authorization_request"],
  });
  const executionGeneration = 1;
  const [turn] = await shared!.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) VALUES (
      ${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, gen_random_uuid(),
      ${`capability-wf-${crypto.randomUUID()}`}, 'running', 0, 'Use GitHub',
      'gpt-5.6-sol', 'medium', 'none', ${executionGeneration}, 'subject',
      ${workspace.subjectId}, '{"accepted":true}'::jsonb
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared!.admin`
    INSERT INTO session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
      verified_control_revision, mcp_approval_policies
    ) VALUES (
      ${attemptId}, ${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, ${turn!.id},
      ${executionGeneration}, 'running', 'capability-wf', ${`run-${attemptId}`},
      ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared!.admin`
    UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
  await shared!.admin`
    UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}
