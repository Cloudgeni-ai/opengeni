import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AccessGrant } from "@opengeni/contracts";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  createSessionGoal,
  getSessionMcpMonitoringSummary,
  listSessionDiscoverySummaries,
  setSessionGoalStatusWithEvent,
  updateSessionTitle,
  type DbClient,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let observedSql: postgres.Sql | null = null;
let grant: AccessGrant;
let sessionId: string;
let mcp: ReturnType<typeof buildOpenGeniMcpServer>;
const queries: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-mcp-compact");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("PostgreSQL test database unavailable (Docker required)");
    return;
  }
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Compact MCP",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Compact MCP",
    subjectId: `user:${suffix}`,
  });
  grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "NEVER SHOW THIS PROMPT",
    metadata: { privateConfig: "NO" },
    resources: [],
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  await updateSessionTitle(client.db, {
    workspaceId: grant.workspaceId,
    sessionId,
    title: "Compact work",
    source: "user",
  });
  await createSessionGoal(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    text: "Ship compact monitoring",
    createdBy: "api",
  });
  await appendSessionEvents(client.db, grant.workspaceId, sessionId, [
    { type: "goal.progress", payload: { progressNote: "Tests are green", privateExtra: "NO" } },
  ]);
  await setSessionGoalStatusWithEvent(client.db, grant.workspaceId, sessionId, {
    status: "completed",
    evidence: "🙂".repeat(5_000),
    event: { type: "goal.completed", evidence: "🙂".repeat(5_000) },
  });
  observedSql = postgres(shared.appUrl, { max: 2, prepare: false });
  const observedDb = drizzle(observedSql, {
    schema,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  const noop = async () => undefined;
  mcp = buildOpenGeniMcpServer(
    {
      settings: testSettings({ databaseUrl: shared.appUrl }),
      db: observedDb,
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}),
    } as unknown as ApiRouteDeps,
    grant,
  );
}, 180_000);

afterAll(async () => {
  await observedSql?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function call(name: string, args: Record<string, unknown> = {}) {
  queries.length = 0;
  const registered = (
    mcp as unknown as {
      _registeredTools: Record<
        string,
        { handler(args: unknown, extra: unknown): Promise<{ content: Array<{ text: string }> }> }
      >;
    }
  )._registeredTools[name]!;
  return JSON.parse((await registered.handler(args, {})).content[0]!.text);
}

describe("compact session MCP database boundary", () => {
  test("plain browse skips claim SQL; full, explicit evidence, query and subject opt in", async () => {
    if (!shared) return;
    const compact = await call("sessions_list");
    expect(compact.sessions[0].goal.status).toBe("completed");
    expect(compact.sessions[0]).not.toHaveProperty("relatedWork");
    expect(queries.some((sql) => sql.includes("session_work_claims"))).toBeFalse();
    const full = await call("sessions_list", { detail: "full" });
    expect(full.sessions[0].relatedWork).toMatchObject({
      advisoryOnly: true,
      noAdditionalAccess: true,
    });
    expect(full).toHaveProperty("bytes");
    expect(full.sessions[0]).toHaveProperty("children");
    expect(queries.some((sql) => sql.includes("session_work_claims"))).toBeTrue();
    await call("sessions_list", { detail: "full", includeRelatedWork: false });
    expect(queries.some((sql) => sql.includes("session_work_claims"))).toBeFalse();
    for (const args of [
      { includeRelatedWork: true },
      { query: "Compact", includeRelatedWork: false },
      {
        subject: { namespace: "git", type: "repository", canonicalKey: "sample/repo" },
        includeRelatedWork: false,
      },
    ]) {
      const result = await call("sessions_list", args);
      expect(queries.some((sql) => sql.includes("session_work_claims"))).toBeTrue();
      for (const row of result.sessions)
        expect(row.relatedWork).toMatchObject({ advisoryOnly: true, noAdditionalAccess: true });
    }
    // The shared DB default used by REST/UI is intentionally unchanged.
    const legacy = await listSessionDiscoverySummaries(client!.db, grant.workspaceId, {
      limit: 20,
      subjectId: grant.subjectId,
    });
    expect(legacy.sessions[0]!.workDiscovery).toMatchObject({
      advisoryOnly: true,
      noAdditionalAccess: true,
    });
  });

  test("default detail retains completion/progress using bounded selected columns and skips policy assembly", async () => {
    if (!shared) return;
    const compact = await call("session_get", { sessionId });
    expect(compact.goal).toMatchObject({
      status: "completed",
      summary: "Ship compact monitoring",
      evidenceTruncated: true,
    });
    expect(compact.progress.text).toBe("Tests are green");
    expect(compact).not.toHaveProperty("effectiveToolPolicy");
    expect(compact).not.toHaveProperty("initialMessage");
    expect(JSON.stringify(compact)).not.toContain("privateExtra");
    const goalRead = queries.find((query) => query.includes('from "session_goals"'))!;
    expect(goalRead).toContain("left(");
    expect(goalRead).toContain("char_length(");
    expect(goalRead).not.toContain('"metadata"');
    const full = await call("session_get", { sessionId, detail: "full" });
    expect(full).toHaveProperty("effectiveToolPolicy");
    expect(full.initialMessage).toBe("NEVER SHOW THIS PROMPT");
    expect(full).toHaveProperty("projection");
  });

  test("monitoring lookup never crosses a workspace or target id", async () => {
    if (!shared || !client) return;
    expect(
      await getSessionMcpMonitoringSummary(client.db, grant.workspaceId, crypto.randomUUID()),
    ).toEqual({ goal: null, progress: null, wait: null });
    const suffix = crypto.randomUUID();
    const other = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "Other",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "Other",
      subjectId: `user:${suffix}`,
    });
    expect(
      await getSessionMcpMonitoringSummary(
        client.db,
        other.workspaceGrants[0]!.workspaceId,
        sessionId,
      ),
    ).toEqual({ goal: null, progress: null, wait: null });
  });
});
