import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  referenceKey,
  type FirstPartyMcpToolName,
  type Permission,
  type ResolvedSecretValue,
  type SecretResolver,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createSecretArgumentResolver } from "@opengeni/runtime/workspace-tool-gateway";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { withMcpClient } from "./helpers/first-party-tool-client";

// Incident 2 (26 October 2026): an agent wrote an unescaped vault reference
// into session_create's initialMessage, the gateway resolved it, and the real
// value was stored in the child's first message. Hand-off tools now receive
// reference text: this drives the real first-party handlers through the
// gateway with a resolver that WOULD return a value, then searches every
// table for that value.

const DELEGATION_SECRET = "secret-handoff-test-secret";
const ENVIRONMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 47).toString("base64");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const VALUE = `og-canary-handoff-${crypto.randomUUID()}`;
const brace = "{";
// Built so this file never holds the marker literally.
const REFERENCE = `${brace}${brace}secret:cloudgeni-cloud-auth/FAKE_HANDOFF_TOKEN/value}}`;
const ESCAPED = `\\${REFERENCE}`;
const TOOLS = [
  "session_create",
  "session_send_message",
  "session_steer",
  "goal_set",
  "goal_update",
  "scheduled_tasks_create",
  "scheduled_tasks_update",
  "task_note_save",
  "knowledge_save",
  "notify_user",
] as const satisfies readonly FirstPartyMcpToolName[];
const PERMISSIONS: Permission[] = [
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "goals:manage",
  "workspace:read",
  "scheduled_tasks:manage",
  "scheduled_tasks:read",
  "documents:search",
  "secrets:use",
];

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-secret-handoff");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function settings() {
  return testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: ENVIRONMENTS_ENCRYPTION_KEY,
    sandboxBackend: "none",
    allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
  });
}

function routeDeps(bus: MemoryEventBus): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings: settings(),
    db: client.db,
    bus,
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
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

/** A resolver that would hand out VALUE for any reference, recording each use. */
function valueResolver() {
  const uses: string[][] = [];
  const resolver: SecretResolver = {
    principal: {
      kind: "attempt",
      accountId: "a",
      workspaceId: "w",
      sessionId: "s",
      turnId: "t",
      attemptId: "x",
      executionGeneration: 1,
    },
    enabled: true,
    async resolve(references) {
      uses.push(references.map((reference) => reference.raw));
      const out = new Map<string, ResolvedSecretValue>();
      for (const reference of references) {
        out.set(referenceKey(reference), {
          key: referenceKey(reference),
          reference,
          source: "opengeni",
          vaultId: "v",
          vaultName: "cloudgeni-cloud-auth",
          itemId: "i",
          itemName: "FAKE_HANDOFF_TOKEN",
          fieldId: null,
          fieldName: "value",
          version: 1,
          material: { type: "text", value: VALUE },
        });
      }
      return out;
    },
  };
  return { resolver, uses };
}

async function liveAgent(bus: MemoryEventBus) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "secret-handoff-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Secret hand-off",
    workspaceExternalSource: "secret-handoff-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Secret hand-off",
    subjectId: `user:${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const root = await createSession(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    initialMessage: "root",
    resources: [],
    tools: [],
    metadata: {},
    model: settings().openaiModel,
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...TOOLS],
    createdBy: { kind: "subject", subjectId: owner.subjectId, label: "Test owner" },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    sessionId: root.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, owner.workspaceId, {
    sessionId: root.id,
    workflowId: `session-${root.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("test attempt was not claimed");
  const grant = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    permissions: PERMISSIONS,
    principalKind: "agent_attempt" as const,
    metadata: {
      sessionId: root.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      firstPartyMcpTools: [...TOOLS],
    },
  };
  return { owner, root, server: buildOpenGeniMcpServer(routeDeps(bus), grant) };
}

/** The real handlers behind the gateway, with the runtime's secret hook installed. */
function gatewayOver(
  mcp: Client,
  resolver: SecretResolver,
  workspace: { accountId: string; workspaceId: string },
) {
  const resolveArguments = createSecretArgumentResolver({ resolver });
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    generation: 1,
    ...(resolveArguments ? { resolveArguments } : {}),
    definitions: TOOLS.map((toolName) => ({
      identity: { serverId: "opengeni", toolName },
      modelName: toolName,
      codemodePath: ["opengeni", toolName],
      inputSchema: { type: "object" },
      source: "opengeni" as const,
      approval: "none" as const,
      execute: async (args: Record<string, unknown>) =>
        (await mcp.callTool({ name: toolName, arguments: args })) as never,
    })),
  });
  return async (toolName: (typeof TOOLS)[number], args: Record<string, unknown>) => {
    const prepared = await gateway.prepareCall({
      operationId: crypto.randomUUID(),
      catalogDigest: catalog.digest,
      identity: { serverId: "opengeni", toolName },
      arguments: args,
      caller: { kind: "model", subjectId: "worker:first-party-mcp" },
    });
    const result = (await prepared.execute()) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = result.content?.[0]?.text ?? "";
    expect(result.isError, `${toolName}: ${text}`).toBeFalsy();
    return JSON.parse(text) as Record<string, unknown>;
  };
}

/** Every row of every table whose text form contains `needle`, as schema.table counts. */
async function rowsContaining(needle: string): Promise<Record<string, number>> {
  const tables = await shared!.admin<{ schema: string; name: string }[]>`
    select table_schema as schema, table_name as name
    from information_schema.tables
    where table_type = 'BASE TABLE'
      and table_schema not in ('pg_catalog', 'information_schema')`;
  const found: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await shared!.admin.unsafe<{ count: number }[]>(
      `select count(*)::int as count from "${table.schema.replaceAll('"', '""')}"."${table.name.replaceAll('"', '""')}" as t where strpos(t::text, $1) > 0`,
      [needle],
    );
    if ((row?.count ?? 0) > 0) found[`${table.schema}.${table.name}`] = row!.count;
  }
  return found;
}

describe("hand-off tools keep secret references (incident 2)", () => {
  test("session, goal, schedule, note, Knowledge and notification tools store reference text, never the value", async () => {
    if (!available) return;
    const bus = new MemoryEventBus();
    const { owner, root, server } = await liveAgent(bus);
    const { resolver, uses } = valueResolver();
    await withMcpClient(server, async (mcp) => {
      const call = gatewayOver(mcp, resolver, owner);
      // Incident 2 exactly: an unescaped reference in a child's initial message.
      const child = await call("session_create", {
        initialMessage: `Push the branch with GH_TOKEN=${REFERENCE} git push`,
      });
      const childId = String((child as { id?: unknown }).id ?? "");
      expect(childId).toMatch(/^[0-9a-f-]{36}$/u);
      await call("session_send_message", {
        sessionId: childId,
        text: `Then open the PR with ${REFERENCE}`,
        idempotencyKey: crypto.randomUUID(),
      });
      await call("session_steer", {
        sessionId: childId,
        instruction: `Stop and use ${ESCAPED} instead`,
        idempotencyKey: crypto.randomUUID(),
      });
      await call("goal_set", {
        text: `Land the PR using ${REFERENCE}`,
        successCriteria: `Pushed with ${REFERENCE}`,
      });
      await call("goal_update", {
        expectedObjectiveRevision: 1,
        idempotencyKey: crypto.randomUUID(),
        changeKind: "refinement",
        rationale: `Clarified that ${REFERENCE} is the push credential`,
        text: `Land the PR and push with ${REFERENCE}`,
      });
      const schedule = await call("scheduled_tasks_create", {
        name: "Nightly push",
        schedule: { type: "manual" },
        prompt: `Push nightly with ${REFERENCE}`,
      });
      const scheduleId = String(
        (schedule as { resource?: { id?: unknown } }).resource?.id ??
          (schedule as { id?: unknown }).id ??
          "",
      );
      expect(scheduleId).toMatch(/^[0-9a-f-]{36}$/u);
      await call("scheduled_tasks_update", {
        id: scheduleId,
        prompt: `Push nightly, then report, with ${REFERENCE}`,
      });
      await call("task_note_save", {
        operationId: crypto.randomUUID(),
        kind: "handoff",
        text: `The push token is ${REFERENCE}`,
        expiresInDays: 1,
      });
      await call("knowledge_save", {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: {
          kind: "note",
          title: "Push credential",
          content: `Pushes use ${REFERENCE}`,
          groupIds: [],
          evidence: [],
          relationships: [],
        },
      });
      await call("notify_user", {
        title: "Push ready",
        message: `Pushed with ${REFERENCE}`,
      });
    });

    expect(await rowsContaining(VALUE)).toEqual({});
    expect(JSON.stringify(bus.published)).not.toContain(VALUE);
    expect(uses).toEqual([]);
    // The text arrived intact: the escape is removed, the reference kept.
    const stored = await rowsContaining(REFERENCE);
    expect(Object.keys(stored).length).toBeGreaterThan(0);
    expect(Object.keys(await rowsContaining(`Stop and use ${REFERENCE} instead`))).not.toEqual([]);
    const childEvents = await shared!.admin<{ payload: string }[]>`
      select e.payload::text as payload from session_events e
      join sessions s on s.id = e.session_id
      where s.parent_session_id = ${root.id}`;
    expect(childEvents.some((row) => row.payload.includes(REFERENCE))).toBe(true);
    expect(childEvents.some((row) => row.payload.includes(VALUE))).toBe(false);
  });
});
