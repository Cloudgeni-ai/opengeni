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
import {
  LOSSLESS_JSON_STRING_PREFIX,
  fromPostgresLosslessJson,
  toPostgresLosslessJson,
} from "../../../packages/db/src/lossless-json";
import { SESSION_MCP_PROGRESS_STORAGE_CHARS } from "../../../packages/db/src/session-mcp-progress";

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
  // session_wait requires both sessions:read and a trusted caller-session
  // context. Keep the bootstrap grant's authority; add this fixture's context.
  expect(grant.permissions).toContain("sessions:read");
  grant = {
    ...grant,
    metadata: { ...(grant.metadata ?? {}), sessionId },
  };
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
  )._registeredTools[name];
  if (!registered) throw new Error(`MCP fixture tool not registered: ${name}`);
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

  test("progress reads decode only a bounded scalar and retain canonical truncation facts", async () => {
    if (!shared || !client) return;
    for (const note of [
      "tests\u0000green",
      "before\ud800after\udc00",
      `${LOSSLESS_JSON_STRING_PREFIX}literal`,
      "a".repeat(900) + "🙂\u0000",
      "🙂".repeat(5000) + "\u0000",
      "a".repeat(599) + "🙂" + "b".repeat(5000) + "\u0000",
    ]) {
      await appendSessionEvents(client.db, grant.workspaceId, sessionId, [
        {
          type: "goal.progress",
          payload: { progressNote: note, privateExtra: "NO".repeat(50_000) },
        },
      ]);
      const summary = await getSessionMcpMonitoringSummary(client.db, grant.workspaceId, sessionId);
      const chars = Array.from(note);
      expect(summary.progress!.text).toBe(chars.slice(0, 600).join(""));
      const cutEncodedScalar =
        (toPostgresLosslessJson(note) as string).length > SESSION_MCP_PROGRESS_STORAGE_CHARS;
      expect(summary.progress!.originalChars).toBe(cutEncodedScalar ? null : chars.length);
      expect(summary.progress!.textTruncated === true).toBe(cutEncodedScalar);

      const compact = await call("session_get", { sessionId });
      expect(compact.progress.textTruncated === true).toBe(chars.length > 600);
      if (chars.length <= 600) expect(compact.progress.text).toBe(note);
      else expect(compact.progress.text).toStartWith(chars.slice(0, 100).join(""));
      expect(JSON.stringify(compact)).not.toContain("privateExtra");
      const progressRead = queries.find((query) => query.includes("progressNote"))!;
      expect(progressRead).toContain("left(");
      expect(progressRead).toContain("char_length(");
      expect(progressRead).toContain('"payload_codec_version"');
      expect(progressRead).not.toMatch(/"session_events"\."payload"\s*,/);
    }
  });

  test("marker-shaped legacy progress remains literal without a codec version", async () => {
    if (!shared || !client) return;
    const marker = toPostgresLosslessJson("literal legacy\u0000note") as string;
    const [event] = await appendSessionEvents(client.db, grant.workspaceId, sessionId, [
      { type: "goal.progress", payload: { progressNote: "legacy fixture" } },
    ]);
    // Simulate retained old-writer data in this isolated fixture, without
    // passing the marker through the new writer's escaping codec.
    await shared.admin`
      update session_events
      set payload = ${shared.admin.json({ progressNote: marker })}, payload_codec_version = null
      where id = ${event!.id}
    `;
    const compact = await call("session_get", { sessionId });
    expect(compact.progress.text).toBe(marker);
    expect(compact.progress).not.toHaveProperty("textTruncated");
  });

  test("malformed versioned suffixes beyond the prefix match canonical full-scalar decoding", async () => {
    if (!shared || !client) return;
    const prefix = LOSSLESS_JSON_STRING_PREFIX + "YQBhAGEA".repeat(600);
    expect(prefix.length).toBeGreaterThan(SESSION_MCP_PROGRESS_STORAGE_CHARS);
    for (const suffix of ["!", "\n", "=", "YQ==", "YWF=", "YQBh="]) {
      const stored = prefix + suffix;
      const canonical = fromPostgresLosslessJson(stored, 1);
      expect(canonical).toBe(stored);
      const [event] = await appendSessionEvents(client.db, grant.workspaceId, sessionId, [
        { type: "goal.progress", payload: { progressNote: "malformed scalar fixture" } },
      ]);
      // Preserve an explicit version while injecting malformed retained data.
      // The projection must match the codec, not assume new-writer validity.
      await shared.admin.begin(async (tx) => {
        await tx`select set_config('opengeni.lossless_content_writer', '1', true)`;
        await tx`
          update session_events
          set payload = ${tx.json({ progressNote: stored })}, payload_codec_version = 1
          where id = ${event!.id}
        `;
      });
      const summary = await getSessionMcpMonitoringSummary(client.db, grant.workspaceId, sessionId);
      expect(summary.progress!.text).toBe(canonical.slice(0, 600));
      expect(summary.progress!.originalChars).toBe(canonical.length);
      const compact = await call("session_get", { sessionId });
      expect(compact.progress.text).toStartWith(LOSSLESS_JSON_STRING_PREFIX);
      expect(compact.progress.textTruncated).toBeTrue();
      const progressRead = queries.find((query) => query.includes("progressNote"))!;
      expect(progressRead).toContain("similar to");
      expect(progressRead).not.toMatch(/"session_events"\."payload"\s*,/);
    }
  });

  test("a completion committed before session_get remains joinable from the consumed cursor", async () => {
    if (!shared || !client) return;
    const consumedCursor = (await call("session_get", { sessionId })).lastSequence;
    const [completed] = await appendSessionEvents(client.db, grant.workspaceId, sessionId, [
      { type: "turn.completed", payload: { output: "Retained child result" } },
    ]);
    const snapshot = await call("session_get", { sessionId });
    expect(snapshot.lastSequence).toBe(completed!.sequence);
    const joined = await call("session_wait", {
      targets: [{ sessionId, afterSequence: consumedCursor }],
      waitFor: "completion",
      includeOwnPendingUpdates: false,
      maxWaitSeconds: 1,
    });
    expect(joined.timedOut).toBeFalse();
    expect(joined.changed[0].events).toContainEqual(
      expect.objectContaining({
        sequence: completed!.sequence,
        text: "Retained child result",
      }),
    );
    const skipped = await call("session_wait", {
      targets: [{ sessionId, afterSequence: snapshot.lastSequence }],
      waitFor: "completion",
      includeOwnPendingUpdates: false,
      maxWaitSeconds: 1,
    });
    expect(skipped.timedOut).toBeTrue();
    expect(skipped.changed).toEqual([]);
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
