import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteWorkspace,
  enableCapabilityInstallation,
  listSessionEvents,
  persistAttemptToolCatalog,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

// An agent must never offer a Connect card for an integration this
// deployment cannot connect: the operator switched its setup off, or the
// provider needs an operator OAuth client that is missing. Production case:
// Google connector setup off, yet the agent posted Gmail and Google Calendar
// cards whose OAuth start then failed.

const suffix = crypto.randomUUID();
const entries = {
  gmail: {
    id: `registry:gmail-${suffix}`,
    name: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    domain: "gmailmcp.googleapis.com",
    serverId: `gmail-${suffix}`,
    metadata: {},
  },
  calendar: {
    id: `registry:google-calendar-${suffix}`,
    name: "Google Calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    domain: "calendarmcp.googleapis.com",
    serverId: `google-calendar-${suffix}`,
    metadata: {},
  },
  // Any provider that refuses OAuth self-registration (oauth-client-requirements.json).
  harvey: {
    id: `registry:harvey-${suffix}`,
    name: "Harvey",
    url: `https://api.harvey.ai/hosted_mcp/mcp-${suffix}`,
    domain: "api.harvey.ai",
    serverId: `harvey-${suffix}`,
    metadata: {
      oauthClientRequirement: { issuer: "https://api.harvey.ai", reason: "no_self_registration" },
    },
  },
} as const;
const GOOGLE_NOTE =
  "New connections are unavailable until Google data-access verification and provider setup are complete.";
const OPERATOR_CLIENT_NOTE =
  "New connections are unavailable until this deployment registers an OAuth client with the provider.";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let workspace: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("unconnectable-capability-setup");
  if (!shared) {
    console.warn("[unconnectable-capability-setup] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "unconnectable-capability-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Unconnectable capability test",
    workspaceExternalSource: "unconnectable-capability-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Unconnectable capability test",
    subjectId: `subject-${suffix}`,
  });
  workspace = access.workspaceGrants[0]!;
  // Reviewed registry rows, as the catalog import writes them.
  for (const entry of Object.values(entries)) {
    await shared.admin`insert into capability_catalog_items
      (id, kind, source, name, endpoint_url, mcp_url, provider_domain, auth_kind, metadata)
      values (${entry.id}, 'mcp', 'registry', ${entry.name}, ${entry.url}, ${entry.url},
        ${entry.domain}, 'oauth2',
        ${JSON.stringify({ ...entry.metadata, mcpServerId: entry.serverId, mcpProbe: { status: "real" } })}::jsonb)`;
  }
}, 180_000);

afterAll(async () => {
  if (client && workspace) await deleteWorkspace(client.db, workspace.workspaceId);
  if (shared) {
    for (const entry of Object.values(entries))
      await shared.admin`delete from capability_catalog_items where id = ${entry.id}`;
  }
  await client?.close();
  await shared?.release();
}, 60_000);

type Match = {
  capabilityId: string;
  setup: { status: string; action: string | null; detail: string; nextAction: unknown };
};

async function agentTools(
  settings: ReturnType<typeof testSettings>,
  availableServerIds: readonly string[] = [],
) {
  const attempt = await seedAttempt();
  if (availableServerIds.length > 0) {
    await persistAttemptToolCatalog(
      client.db,
      createAttemptToolEnvironment({
        scope: { ...attempt, accountId: workspace.accountId, workspaceId: workspace.workspaceId },
        generation: 1,
        definitions: availableServerIds.map((serverId) => ({
          identity: { serverId, toolName: "search_threads" },
          modelName: `${serverId}__search_threads`,
          description: "Search threads",
          inputSchema: { type: "object" },
          source: "mcp" as const,
          approval: "none" as const,
          execute: async () => ({ content: [] }),
        })),
      }).catalog,
    );
  }
  const server = buildOpenGeniMcpServer(
    { settings, db: client.db, bus: new MemoryEventBus() } as ApiRouteDeps,
    {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["workspace:read"],
      principalKind: "agent_attempt",
      metadata: {
        ...attempt,
        firstPartyMcpTools: ["capability_catalog_search", "capability_authorization_request"],
      },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "unconnectable-capability-test", version: "1" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    search: async (query: string, capabilityId: string): Promise<Match> => {
      const result = await mcp.callTool({
        name: "capability_catalog_search",
        arguments: { query, limit: 20 },
      });
      expect(result.isError).not.toBe(true);
      const match = (mcpJson(result) as { matches: Match[] }).matches.find(
        (candidate) => candidate.capabilityId === capabilityId,
      );
      expect(match).toBeDefined();
      return match!;
    },
    request: async (capabilityId: string) => {
      const result = await mcp.callTool({
        name: "capability_authorization_request",
        arguments: { capabilityId, rationale: "Read the person's newest email and meetings." },
      });
      expect(result.isError).not.toBe(true);
      return mcpJson(result);
    },
    cards: async () =>
      (await listSessionEvents(client.db, workspace.workspaceId, attempt.sessionId)).filter(
        (event) => event.type === "tool.auth_needed",
      ),
    close: async () => await Promise.all([mcp.close(), server.close()]),
  };
}

describe("agent setup for integrations this deployment cannot connect (real PostgreSQL)", () => {
  test("Google connector setup switched off: Gmail and Google Calendar get no Connect card", async () => {
    if (!shared) throw new Error("Real PostgreSQL fixture required");
    const tools = await agentTools(
      testSettings({ googleConnectorSetupEnabled: false, googleCalendarEnabled: true }),
    );
    try {
      for (const entry of [entries.gmail, entries.calendar]) {
        expect(await tools.search(entry.name, entry.id)).toMatchObject({
          setup: { status: "unavailable", action: null, detail: GOOGLE_NOTE, nextAction: null },
        });
        expect(await tools.request(entry.id)).toEqual({
          capabilityId: entry.id,
          status: "unavailable",
          message: GOOGLE_NOTE,
        });
      }
      expect(await tools.cards()).toHaveLength(0);
    } finally {
      await tools.close();
    }
  }, 60_000);

  test("with Google setup on, the same entries still offer their Connect card", async () => {
    if (!shared) throw new Error("Real PostgreSQL fixture required");
    const tools = await agentTools(
      testSettings({ googleConnectorSetupEnabled: true, googleCalendarEnabled: true }),
    );
    try {
      for (const entry of [entries.gmail, entries.calendar]) {
        expect(await tools.search(entry.name, entry.id)).toMatchObject({
          setup: {
            status: "authorization_required",
            action: "connect",
            nextAction: { toolName: "capability_authorization_request", capabilityId: entry.id },
          },
        });
        expect(await tools.request(entry.id)).toMatchObject({
          status: "authorization_requested",
          action: "connect",
        });
      }
      expect(await tools.cards()).toHaveLength(2);
    } finally {
      await tools.close();
    }
  }, 60_000);

  test("a provider without the operator OAuth client it needs gets no card until one is configured", async () => {
    if (!shared) throw new Error("Real PostgreSQL fixture required");
    const missing = await agentTools(testSettings());
    try {
      expect(await missing.search("Harvey", entries.harvey.id)).toMatchObject({
        setup: {
          status: "unavailable",
          action: null,
          detail: OPERATOR_CLIENT_NOTE,
          nextAction: null,
        },
      });
      expect(await missing.request(entries.harvey.id)).toEqual({
        capabilityId: entries.harvey.id,
        status: "unavailable",
        message: OPERATOR_CLIENT_NOTE,
      });
      expect(await missing.cards()).toHaveLength(0);
    } finally {
      await missing.close();
    }
    const configured = await agentTools(
      testSettings({
        integrationsOauthClientsJson: JSON.stringify({
          "https://api.harvey.ai": { clientId: "harvey-client" },
        }),
      }),
    );
    try {
      expect(await configured.search("Harvey", entries.harvey.id)).toMatchObject({
        setup: { status: "authorization_required", action: "connect" },
      });
    } finally {
      await configured.close();
    }
  }, 60_000);

  test("an installed Gmail keeps working while new Google connections are switched off", async () => {
    if (!shared) throw new Error("Real PostgreSQL fixture required");
    await enableCapabilityInstallation(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      capabilityId: entries.gmail.id,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok" } },
      config: {
        connectionRef: {
          providerDomain: entries.gmail.domain,
          kind: "oauth2",
          subjectScope: "subject",
          accountSelection: "all_eligible",
          resource: entries.gmail.url,
        },
      },
    });
    const tools = await agentTools(
      testSettings({ googleConnectorSetupEnabled: false, googleCalendarEnabled: true }),
      [entries.gmail.serverId],
    );
    try {
      expect(await tools.search("Gmail", entries.gmail.id)).toMatchObject({
        setup: { status: "ready", nextAction: null },
      });
      expect(await tools.request(entries.gmail.id)).toMatchObject({ status: "ready" });
      expect(await tools.cards()).toHaveLength(0);
    } finally {
      await tools.close();
      await shared.admin`DELETE FROM capability_installations
        WHERE workspace_id = ${workspace.workspaceId} AND capability_id = ${entries.gmail.id}`;
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
    initialMessage: "Check my email and calendar",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
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
      ${`unconnectable-wf-${crypto.randomUUID()}`}, 'running', 0, 'Check my email',
      'gpt-5.6-sol', 'medium', 'none', ${executionGeneration}, 'subject',
      ${workspace.subjectId}, '{"accepted":true}'::jsonb
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared!.admin.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    await tx`
      UPDATE sessions SET active_turn_id = ${turn!.id}, status = 'running'
      WHERE id = ${session.id}`;
    await tx`
      UPDATE session_turns SET active_attempt_id = ${attemptId}
      WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, ${turn!.id},
        ${executionGeneration}, 'running', 'unconnectable-wf', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}
