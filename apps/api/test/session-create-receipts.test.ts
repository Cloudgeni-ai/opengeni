import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, McpMutationReceiptType } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

class FakeWorkflowClient {
  wakeups: unknown[] = [];

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
  }
}

async function freshGrant(): Promise<AccessGrant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "session-create-receipts",
    accountExternalId: `account-${suffix}`,
    accountName: "Session create receipt account",
    workspaceExternalSource: "session-create-receipts",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session create receipt workspace",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

function buildServer(grant: AccessGrant, workflow: FakeWorkflowClient): unknown {
  const noop = async () => undefined;
  return buildOpenGeniMcpServer(
    {
      settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: workflow.wakeSessionWorkflow.bind(workflow),
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
        signalSessionControl: noop,
        syncScheduledTask: noop,
        deleteScheduledTaskSchedule: noop,
        triggerScheduledTask: noop,
      } as unknown as SessionWorkflowClient,
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}) as never,
    } as unknown as ApiRouteDeps,
    grant,
  );
}

async function callMcpTool<T>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}

async function durableCounts(workspaceId: string, sessionId: string) {
  const [row] = await shared!.admin<
    Array<{
      workspaceSessions: number;
      events: number;
      turns: number;
      wakeRows: number;
      wakeRevision: number;
      usageEvents: number;
      updatedAt: Date;
    }>
  >`
    select
      (select count(*)::int from sessions where workspace_id = ${workspaceId}) as "workspaceSessions",
      (select count(*)::int from session_events where workspace_id = ${workspaceId} and session_id = ${sessionId}) as events,
      (select count(*)::int from session_turns where workspace_id = ${workspaceId} and session_id = ${sessionId}) as turns,
      (select count(*)::int from session_workflow_wake_outbox where workspace_id = ${workspaceId} and session_id = ${sessionId}) as "wakeRows",
      coalesce((select wake_revision::int from session_workflow_wake_outbox where workspace_id = ${workspaceId} and session_id = ${sessionId}), 0) as "wakeRevision",
      (select count(*)::int from usage_events where workspace_id = ${workspaceId} and source_resource_id = ${sessionId}) as "usageEvents",
      (select updated_at from sessions where workspace_id = ${workspaceId} and id = ${sessionId}) as "updatedAt"
  `;
  if (!row) throw new Error("durable count query returned no row");
  return row;
}

async function withUsageInsertRevoked<T>(fn: () => Promise<T>): Promise<T> {
  await shared!.admin`revoke insert on table usage_events from opengeni_app`;
  try {
    return await fn();
  } finally {
    await shared!.admin`grant insert on table usage_events to opengeni_app`;
  }
}

async function markInitialTurnRunning(workspaceId: string, sessionId: string): Promise<void> {
  await shared!.admin`
    update session_turns
    set status = 'running'
    where workspace_id = ${workspaceId} and session_id = ${sessionId}
  `;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-create-receipts");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable");
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[session-create-receipts] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("session_create receipts under FORCE RLS (real PostgreSQL)", () => {
  test("runs through a non-superuser, non-BYPASSRLS app role on forced tables", async () => {
    if (!available) return;
    const [role] = await shared!.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles
      where rolname = 'opengeni_app'
    `;
    const forced = await shared!.admin<Array<{ relname: string; forced: boolean }>>`
      select relname, relforcerowsecurity as forced
      from pg_class
      where relname in ('sessions', 'session_events', 'session_turns', 'usage_events')
      order by relname
    `;
    expect(role).toEqual({ superuser: false, bypassRls: false });
    expect(forced).toHaveLength(4);
    expect(forced.every((table) => table.forced)).toBeTrue();
  });

  test("reports keyed state and wake repairs before a pure replay", async () => {
    if (!available) return;
    const grant = await freshGrant();
    const idempotencyKey = `repair-${crypto.randomUUID()}`;
    const initialMessage = `repair fixture ${crypto.randomUUID()}`;
    const seeded = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage,
      resources: [],
      tools: [],
      metadata: { model: "scripted-model", reasoningEffort: "high" },
      model: "scripted-model",
      sandboxBackend: "none",
      createIdempotencyKey: idempotencyKey,
    });
    expect(await durableCounts(grant.workspaceId, seeded.id)).toMatchObject({
      workspaceSessions: 1,
      events: 0,
      turns: 0,
      wakeRows: 0,
      wakeRevision: 0,
    });

    const workflow = new FakeWorkflowClient();
    const server = buildServer(grant, workflow);
    const args = {
      initialMessage,
      model: "scripted-model",
      sandboxBackend: "none",
      idempotencyKey,
    };
    const repaired = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
    expect(repaired).toMatchObject({
      operation: "session_create",
      outcome: "repaired",
      changed: true,
      resource: { type: "session", id: seeded.id, state: "queued" },
      idempotency: { status: "applied" },
      facts: { sessionCreateOutcome: "repaired" },
    });
    const afterRepair = await durableCounts(grant.workspaceId, seeded.id);
    expect(afterRepair).toMatchObject({
      workspaceSessions: 1,
      events: 4,
      turns: 1,
      wakeRows: 1,
      wakeRevision: 1,
      usageEvents: 1,
    });
    expect(workflow.wakeups).toHaveLength(1);

    const wakeRepair = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
    expect(wakeRepair).toMatchObject({
      outcome: "repaired",
      changed: true,
      resource: { id: seeded.id },
      idempotency: { status: "applied" },
      facts: { sessionCreateOutcome: "repaired" },
    });
    expect(workflow.wakeups).toHaveLength(2);
    expect(await durableCounts(grant.workspaceId, seeded.id)).toMatchObject({ wakeRevision: 2 });

    // Once the initial queued turn has advanced, the same key neither repairs
    // start state nor issues another wake and is therefore a true replay.
    await markInitialTurnRunning(grant.workspaceId, seeded.id);
    const replayed = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
    expect(replayed).toMatchObject({
      outcome: "replayed",
      changed: false,
      resource: { id: seeded.id },
      idempotency: { status: "replayed" },
      facts: { sessionCreateOutcome: "replayed" },
    });
    const afterReplay = await durableCounts(grant.workspaceId, seeded.id);
    expect(afterReplay).toMatchObject({
      workspaceSessions: 1,
      events: 4,
      turns: 1,
      wakeRows: 1,
      wakeRevision: 2,
      usageEvents: 1,
    });
    expect(afterReplay.updatedAt.getTime()).toBe(afterRepair.updatedAt.getTime());
    expect(workflow.wakeups).toHaveLength(2);
  });

  test("returns a committed non-retryable receipt when keyless usage recording fails", async () => {
    if (!available) return;
    const grant = await freshGrant();
    const workflow = new FakeWorkflowClient();
    const server = buildServer(grant, workflow);

    await withUsageInsertRevoked(async () => {
      const receipt = await callMcpTool<McpMutationReceiptType>(server, "session_create", {
        initialMessage: `keyless usage failure ${crypto.randomUUID()}`,
        model: "scripted-model",
        sandboxBackend: "none",
      });
      expect(receipt).toMatchObject({
        operation: "session_create",
        committed: true,
        outcome: "partial_failure",
        changed: true,
        resource: { type: "session", state: "queued" },
        idempotency: { status: "not_requested" },
        partialFailure: { stage: "usage_recording", retryable: false },
        facts: { sessionCreateOutcome: "created" },
        nextAction: { tool: "session_get", arguments: { sessionId: receipt.resource.id } },
      });
      expect(receipt.warnings).toEqual([
        "The session committed, but usage recording failed. Do not retry this keyless request; inspect the returned session.",
      ]);
      expect(await durableCounts(grant.workspaceId, receipt.resource.id)).toMatchObject({
        workspaceSessions: 1,
        events: 4,
        turns: 1,
        wakeRows: 1,
        wakeRevision: 1,
        usageEvents: 0,
      });
      expect(workflow.wakeups).toHaveLength(1);
      // Deliberately no keyless retry: the returned receipt says it would be unsafe.
    });
  });

  test("keeps a failed keyed usage retry safe and truthful", async () => {
    if (!available) return;
    const grant = await freshGrant();
    const workflow = new FakeWorkflowClient();
    const server = buildServer(grant, workflow);
    const idempotencyKey = `usage-failure-${crypto.randomUUID()}`;
    const args = {
      initialMessage: `keyed usage failure ${crypto.randomUUID()}`,
      model: "scripted-model",
      sandboxBackend: "none",
      idempotencyKey,
    };

    await withUsageInsertRevoked(async () => {
      const first = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
      const wakeRepair = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
      expect(first).toMatchObject({
        committed: true,
        outcome: "partial_failure",
        changed: true,
        idempotency: { status: "applied" },
        partialFailure: { stage: "usage_recording", retryable: true },
        facts: { sessionCreateOutcome: "created" },
      });
      expect(wakeRepair).toMatchObject({
        committed: true,
        outcome: "partial_failure",
        changed: true,
        resource: { id: first.resource.id },
        idempotency: { status: "applied" },
        partialFailure: { stage: "usage_recording", retryable: true },
        facts: { sessionCreateOutcome: "repaired" },
      });
      await markInitialTurnRunning(grant.workspaceId, first.resource.id);
      const replay = await callMcpTool<McpMutationReceiptType>(server, "session_create", args);
      expect(replay).toMatchObject({
        committed: true,
        outcome: "partial_failure",
        changed: false,
        resource: { id: first.resource.id },
        idempotency: { status: "replayed" },
        partialFailure: { stage: "usage_recording", retryable: true },
        facts: { sessionCreateOutcome: "replayed" },
      });
      expect(first.warnings).toEqual([
        "The session committed, but usage recording failed. Retry only with the same idempotency key.",
      ]);
      expect(wakeRepair.warnings).toEqual(first.warnings);
      expect(replay.warnings).toEqual(first.warnings);
      expect(workflow.wakeups).toHaveLength(2);
      expect(await durableCounts(grant.workspaceId, first.resource.id)).toMatchObject({
        workspaceSessions: 1,
        events: 4,
        turns: 1,
        wakeRows: 1,
        wakeRevision: 2,
        usageEvents: 0,
      });
    });
  });
});
