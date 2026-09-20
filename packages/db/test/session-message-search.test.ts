import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SharedTestDatabase } from "@opengeni/testing";
import { acquireSearchTestDatabase } from "./session-message-search-fixture";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  grantWorkspaceAccess,
  searchSessionMessagesForSubject,
  setSessionArchive,
  SessionListAccessError,
  ensureManagedAccessForUser,
  transitionSessionVisibility,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
} from "../src";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/schema";
import { toPostgresLosslessJson, LOSSLESS_JSON_STRING_PREFIX } from "../src/lossless-json";
import type {
  SessionMessageSearchRequest,
  SessionMessageSearchResponse,
} from "@opengeni/contracts";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let workspaceId: string;
let accountId: string;
const subjectId = `user:search-${crypto.randomUUID()}`;
beforeAll(async () => {
  shared = await acquireSearchTestDatabase("session-message-search");
  client = createDb(shared.appUrl, { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Search",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Search",
    subjectId,
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
const makeSession = () =>
  createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "initial title only",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
async function insert(
  sessionId: string,
  sequence: number,
  type: string,
  payload: unknown,
  extra: { turnId?: string; codec?: number | null; duplicate?: string; association?: string } = {},
) {
  const [event] =
    await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version, turn_id, duplicate_of_event_id, turn_association, duplicate_reason)
    values (${accountId}, ${workspaceId}, ${sessionId}, ${sequence}, ${type}, ${shared.admin.json(payload as never)}, ${extra.codec ?? null}, ${extra.turnId ?? null}, ${extra.duplicate ?? null}, ${extra.association ?? (extra.duplicate ? "duplicate" : null)}, ${extra.duplicate ? "duplicate_provider_response_usage" : null}) returning id`;
  return event!.id as string;
}
async function collect(
  request: SessionMessageSearchRequest,
  authority: Parameters<typeof searchSessionMessagesForSubject>[3] = { subjectId },
) {
  const matches: SessionMessageSearchResponse["matches"] = [];
  let page: SessionMessageSearchResponse;
  let cursor: string | undefined;
  let pages = 0;
  do {
    page = await searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { ...request, ...(cursor ? { cursor } : {}) },
      authority,
    );
    matches.push(...page.matches);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
    expect(page.hasMore).toBe(page.nextCursor !== null);
    cursor = page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(1000);
  } while (cursor);
  expect(page.countIsExact).toBe(true);
  expect(page.matchedOccurrenceCount).toBe(matches.length);
  expect(page.matchedMessageCount).toBe(new Set(matches.map((m) => m.eventId)).size);
  return { matches, pages, page };
}

test("old messages paginate without a recent-history cap, tools/reasoning/context/deltas excluded", async () => {
  const session = await makeSession();
  const first = await insert(session.id, 1, "user.message", {
    text: "old needle",
    modelContext: "hidden-context",
  });
  for (let n = 2; n <= 70; n++) await insert(session.id, n, "user.message", { text: "unmatched" });
  await insert(session.id, 71, "agent.message.completed", { text: "new NEEDLE" });
  await insert(session.id, 72, "agent.message.delta", { delta: "needle" });
  await insert(session.id, 73, "agent.reasoning.delta", { text: "needle" });
  await insert(session.id, 74, "agent.toolCall.output", { text: "needle" });
  const result = await collect({ query: "needle", sessionId: session.id, limit: 1 });
  expect(result.matches.map((m) => m.sequence)).toEqual([1, 71]);
  expect(result.matches[0]!.eventId).toBe(first);
  expect(result.pages).toBeGreaterThan(2);
  expect((await collect({ query: "hidden-context", sessionId: session.id })).matches).toHaveLength(
    0,
  );
}, 180_000);

test("literal wildcards and Unicode offsets survive SQL, codec text and multi-page scalar scans", async () => {
  const session = await makeSession();
  const needle = "%_\\🙂İ";
  const text = "a\u0000\ud800" + "x".repeat(1_100_000) + needle;
  await insert(session.id, 1, "agent.message.completed", toPostgresLosslessJson({ text }), {
    codec: 1,
  });
  const result = await collect({ query: needle, sessionId: session.id });
  expect(result.pages).toBeGreaterThan(1);
  expect(result.matches).toHaveLength(1);
  const match = result.matches[0]!;
  expect(match.messageMatchOffset).toBe(text.indexOf(needle));
  expect(match.snippet.text.slice(match.snippet.matchStart, match.snippet.matchEnd)).toBe(needle);
  expect((await collect({ query: "wildcard", sessionId: session.id })).matches).toHaveLength(0);
  // An unversioned codec-looking legacy value is literal, never decoded.
  await insert(session.id, 2, "user.message", { text: LOSSLESS_JSON_STRING_PREFIX + "YQA=" });
  expect(
    (await collect({ query: LOSSLESS_JSON_STRING_PREFIX, sessionId: session.id })).matches.map(
      (m) => m.sequence,
    ),
  ).toEqual([2]);
}, 180_000);

test("matches crossing plain Unicode and encoded scalar boundaries are not lost", async () => {
  const session = await makeSession();
  const needle = "a🙂BCDEF";
  for (const [index, prefix] of [
    "🙂".repeat(8190),
    "\u0000" + "x".repeat(8189),
    "🙂".repeat(32766),
    "\u0000" + "x".repeat(32765),
    "\u0000" + "x".repeat(32766),
  ].entries()) {
    const text = prefix + needle;
    await insert(session.id, index + 1, "user.message", toPostgresLosslessJson({ text }), {
      codec: 1,
    });
  }
  const result = await collect({ query: needle.toLowerCase(), sessionId: session.id });
  expect(result.matches.map((m) => m.messageMatchOffset)).toEqual([
    16380, 8190, 65532, 32766, 32767,
  ]);
}, 180_000);

test("long reads retain the 32-window budget and stop on between-read cancellation", async () => {
  const session = await makeSession();
  await insert(session.id, 1, "user.message", { text: "x".repeat(400_000) });
  let scalarReads = 0;
  let cancelOnRead = false;
  const controller = new AbortController();
  const wire = postgres(shared.appUrl, {
    max: 1,
    debug: (_connection, query) => {
      if (query.includes("with source as")) {
        scalarReads++;
        if (cancelOnRead) controller.abort();
      }
    },
  });
  const observed = drizzle(wire, { schema });
  try {
    const page = await searchSessionMessagesForSubject(
      observed,
      workspaceId,
      { query: "not-present", sessionId: session.id },
      { subjectId },
    );
    expect(page.matches).toHaveLength(0);
    expect(page.hasMore).toBe(true);
    expect(scalarReads).toBeGreaterThan(0);
    expect(scalarReads).toBeLessThanOrEqual(8);
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(cursor.position.offset).toBeGreaterThan(0);
    expect(cursor.position.offset).toBeLessThanOrEqual(32 * 8192);
    scalarReads = 0;
    cancelOnRead = true;
    await expect(
      searchSessionMessagesForSubject(
        observed,
        workspaceId,
        { query: "not-present", sessionId: session.id },
        { subjectId },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(scalarReads).toBe(1);
  } finally {
    await wire.end();
  }
}, 180_000);

test("list scope, member removal, workspace and personally archived boundaries apply before counts", async () => {
  const allowed = await makeSession();
  const denied = await makeSession();
  await insert(allowed.id, 1, "user.message", { text: "isolated-token" });
  await insert(denied.id, 1, "user.message", { text: "isolated-token" });
  const authority = {
    subjectId,
    authorizationScope: { kind: "scoped" as const, sessionIds: [allowed.id], rootSessionIds: [] },
  };
  const scoped = await collect({ query: "isolated-token" }, authority);
  expect(scoped.matches.map((m) => m.sessionId)).toEqual([allowed.id]);
  expect(scoped.page.matchedMessageCount).toBe(1);
  expect(
    (await collect({ query: "isolated-token", sessionId: denied.id }, authority)).matches,
  ).toHaveLength(0);
  expect(
    (await collect({ query: "isolated-token", sessionId: crypto.randomUUID() })).matches,
  ).toHaveLength(0);
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { query: "isolated-token" },
      { subjectId: "user:removed" },
    ),
  ).rejects.toBeInstanceOf(SessionListAccessError);
  await setSessionArchive(client.db, {
    workspaceId,
    sessionId: allowed.id,
    subjectId,
    archived: true,
  });
  expect((await collect({ query: "isolated-token", sessionId: allowed.id })).matches).toHaveLength(
    0,
  );
  expect(
    (await collect({ query: "isolated-token", sessionId: allowed.id, archiveStatus: "archived" }))
      .matches,
  ).toHaveLength(1);
}, 180_000);

test("cursors bind subject, query and filters and cannot broaden authorization", async () => {
  const session = await makeSession();
  await insert(session.id, 1, "user.message", { text: "cursor token" });
  await insert(session.id, 2, "user.message", { text: "cursor token" });
  const page = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "cursor", sessionId: session.id, limit: 1 },
    { subjectId },
  );
  expect(page.nextCursor).not.toBeNull();
  for (const change of [
    { query: "different" },
    { archiveStatus: "all" as const },
    { sessionId: crypto.randomUUID() },
  ]) {
    await expect(
      searchSessionMessagesForSubject(
        client.db,
        workspaceId,
        { query: "cursor", sessionId: session.id, cursor: page.nextCursor!, ...change },
        { subjectId },
      ),
    ).rejects.toThrow("cursor");
  }
  const other = `user:other-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(client.db, {
    accountId,
    workspaceId,
    subjectId: other,
    permissions: ["sessions:read"],
  });
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { query: "cursor", sessionId: session.id, cursor: page.nextCursor! },
      { subjectId: other },
    ),
  ).rejects.toThrow("cursor");
}, 180_000);

test("every non-overlapping occurrence survives pagination within one message", async () => {
  const session = await makeSession();
  const text = "🙂 aa aaa AA aa aa";
  await insert(session.id, 1, "user.message", { text });
  await insert(session.id, 2, "agent.message.completed", { text: "aa aa" });
  const result = await collect({ query: "aa", sessionId: session.id, limit: 1 });
  expect(result.matches.map((m) => [m.sequence, m.messageMatchOffset])).toEqual([
    [1, 3],
    [1, 6],
    [1, 10],
    [1, 13],
    [1, 16],
    [2, 0],
    [2, 3],
  ]);
  expect(result.page.matchedMessageCount).toBe(2);
  expect(result.page.matchedOccurrenceCount).toBe(7);
  expect(result.page.scannedMessages).toBe(2);
}, 180_000);

test("all occurrences cross scalar windows without repeat or loss", async () => {
  const session = await makeSession();
  const text = "\u0000🙂" + ("x".repeat(249) + "abAB").repeat(160);
  await insert(session.id, 1, "agent.message.completed", toPostgresLosslessJson({ text }), {
    codec: 1,
  });
  const result = await collect({ query: "ab", sessionId: session.id, limit: 7 });
  expect(result.matches.map((m) => m.messageMatchOffset)).toEqual(
    [...text.matchAll(/ab/giu)].map((m) => m.index),
  );
  expect(result.page.matchedMessageCount).toBe(1);
  expect(result.page.matchedOccurrenceCount).toBe(320);
}, 180_000);

test("canonical completion copies, explicit duplicates, stale events and unclaimed prompts are excluded", async () => {
  const session = await makeSession();
  const triggerId = await insert(session.id, 1, "user.message", { text: "unclaimed keyword" });
  const [turn] = await shared.admin`insert into session_turns (
    account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
    status, source, position, prompt, model, reasoning_effort, sandbox_backend
  ) values (${accountId}, ${workspaceId}, ${session.id}, ${triggerId}, 'search-fixture',
    'cancelled', 'user', 1, 'unclaimed keyword', 'test', 'medium', 'none') returning id`;
  const turnId = turn!.id as string;
  const canonical = await insert(
    session.id,
    2,
    "agent.message.completed",
    { text: "keyword", messageId: "provider-1" },
    { turnId },
  );
  await insert(
    session.id,
    3,
    "agent.message.completed",
    { text: "keyword full-tail", messageId: "provider-1" },
    { turnId, codec: 1 },
  );
  await insert(session.id, 4, "agent.message.completed", { text: "keyword full-tail" }, { turnId });
  await insert(
    session.id,
    5,
    "agent.message.completed",
    { text: "keyword", messageId: "provider-2" },
    { turnId },
  );
  await insert(session.id, 6, "agent.model.usage", { text: "keyword" }, { duplicate: canonical });
  await insert(
    session.id,
    7,
    "agent.message.completed",
    { text: "keyword" },
    { association: "late_rejected" },
  );
  await insert(session.id, 8, "turn.completed", { output: "keyword" }, { turnId });
  const result = await collect({ query: "keyword", sessionId: session.id });
  expect(result.matches.map((m) => m.sequence)).toEqual([3, 5]);
  expect(
    (await collect({ query: "full-tail", sessionId: session.id })).matches.map((m) => m.sequence),
  ).toEqual([3]);
}, 180_000);

test("ordinary no-hit history uses batched scalar SQL rather than per-message reads", async () => {
  const session = await makeSession();
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    select ${accountId}, ${workspaceId}, ${session.id}, n, 'user.message', jsonb_build_object('text', 'ordinary historical message ' || n)
    from generate_series(1, 1024) n`;
  let statements = 0;
  let messageQueries = 0;
  const wire = postgres(shared.appUrl, {
    max: 1,
    debug: (_connection, query) => {
      statements++;
      if (query.includes('from "session_events"')) messageQueries++;
    },
  });
  const observed = drizzle(wire, { schema });
  const started = performance.now();
  let cursor: string | undefined;
  let page: SessionMessageSearchResponse;
  try {
    do {
      page = await searchSessionMessagesForSubject(
        observed,
        workspaceId,
        {
          query: "not-present",
          sessionId: session.id,
          ...(cursor ? { cursor } : {}),
        },
        { subjectId },
      );
      expect(page.matches).toHaveLength(0);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(page.scannedMessages).toBe(1024);
    expect(messageQueries).toBeLessThanOrEqual(33);
    expect(statements).toBeLessThan(600);
    console.info(
      `[session-search performance] 1024 no-hit messages: ${messageQueries} batched message queries, ${statements} total statements, ${Math.round(performance.now() - started)}ms`,
    );
  } finally {
    await wire.end();
  }
}, 180_000);

test("efficiency benchmark covers ordinary, long and multi-session complete traversals", async () => {
  // Keep performance volumes out of the authority regression workspace: list
  // scope tests deliberately exercise different recursive authorization plans.
  const benchmarkSubjectId = `user:search-benchmark-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Search benchmark",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Search benchmark",
    subjectId: benchmarkSubjectId,
  });
  const { workspaceId: benchmarkWorkspaceId, accountId: benchmarkAccountId } =
    access.workspaceGrants[0]!;
  const makeBenchmarkSession = (requestedSessionId: string) =>
    createSession(client.db, {
      requestedSessionId,
      accountId: benchmarkAccountId,
      workspaceId: benchmarkWorkspaceId,
      initialMessage: "benchmark",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
  const scenarios: { name: string; ids: string[]; count: number }[] = [];
  let fixtureId = 1;
  for (const [name, sessionCount, messageCount, text] of [
    ["ordinary", 1, 1024, "ordinary historical text"],
    ["long-plain", 1, 1, "🙂ordinary text ".repeat(40_000)],
    ["long-lossless", 1, 1, "\u0000🙂ordinary text ".repeat(40_000)],
    ["multi-session", 8, 64, "ordinary historical text"],
  ] as const) {
    const ids: string[] = [];
    for (let i = 0; i < sessionCount; i++) {
      const session = await makeBenchmarkSession(
        `10000000-0000-4000-8000-${String(fixtureId++).padStart(12, "0")}`,
      );
      ids.push(session.id);
      const payload = toPostgresLosslessJson({ text });
      await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version)
        select ${benchmarkAccountId}, ${benchmarkWorkspaceId}, ${session.id}, n, 'user.message', ${shared.admin.json(payload as never)}, 1
        from generate_series(1, ${messageCount}) n`;
    }
    scenarios.push({ name, ids, count: sessionCount * messageCount });
  }
  let statements = 0;
  let messageQueries = 0;
  const wire = postgres(shared.appUrl, {
    max: 1,
    debug: (_connection, query) => {
      statements++;
      if (query.includes('from "session_events"')) messageQueries++;
    },
  });
  const observed = drizzle(wire, { schema });
  try {
    for (const scenario of scenarios) {
      const samples = [];
      for (let run = 0; run < 3; run++) {
        statements = messageQueries = 0;
        const started = performance.now();
        let cursor: string | undefined;
        let pages = 0;
        let page: SessionMessageSearchResponse;
        do {
          page = await searchSessionMessagesForSubject(
            observed,
            benchmarkWorkspaceId,
            { query: "never-present-token", ...(cursor ? { cursor } : {}) },
            {
              subjectId: benchmarkSubjectId,
              authorizationScope: { kind: "scoped", sessionIds: scenario.ids, rootSessionIds: [] },
            },
          );
          expect(page.matches).toHaveLength(0);
          expect(page.hasMore).toBe(page.nextCursor !== null);
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
          cursor = page.nextCursor ?? undefined;
          expect(++pages).toBeLessThan(1000);
        } while (cursor);
        expect(page.scannedMessages).toBe(scenario.count);
        expect(page.countIsExact).toBe(true);
        if (scenario.name.startsWith("long-")) {
          // Slow CI may exhaust the time budget before the window budget. Each
          // extra page needs ordinary authority/identity setup, not more scalar
          // reads. Guard round trips without imposing a wall-clock threshold.
          expect(messageQueries - pages).toBeLessThanOrEqual(21);
          expect(statements).toBeLessThanOrEqual(pages * 15 + 22);
        }
        samples.push({
          pages,
          messageQueries,
          statements,
          ms: Math.round(performance.now() - started),
        });
      }
      console.info(`[session-search efficiency] ${scenario.name}: ${JSON.stringify(samples)}`);
    }
  } finally {
    await wire.end();
  }
}, 180_000);

test("private sessions stay owner-only under the real production RLS role", async () => {
  const ownerUserId = `search-owner-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Search owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'search-test') on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const other = `user:search-other-${crypto.randomUUID()}`;
  const personalId = crypto.randomUUID();
  await shared.admin`insert into workspaces (id, account_id, name) values (${personalId}, ${grant.accountId}, 'Other personal')`;
  await shared.admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${grant.accountId}, ${other}, 'active', ${personalId})`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${grant.accountId}, ${grant.workspaceId}, ${other}, 'member', '["sessions:read"]'::jsonb)`;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "private",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: owner },
    createdByContext: {},
  });
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${grant.accountId}, ${grant.workspaceId}, ${session.id}, 1, 'user.message',
      jsonb_build_object('text', repeat('x', 40000) || 'private-search-token'))`;
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    actorSubjectId: owner,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  const ownerPage = await searchSessionMessagesForSubject(
    client.db,
    grant.workspaceId,
    { query: "private-search-token" },
    { subjectId: owner, personalWorkspaceOwnerException: true },
  );
  expect(ownerPage.matches.map((m) => m.sessionId)).toEqual([session.id]);
  expect(ownerPage.matches[0]!.messageMatchOffset).toBe(40000);
  for (const request of [
    { query: "private-search-token" },
    { query: "private-search-token", sessionId: session.id },
  ]) {
    const denied = await searchSessionMessagesForSubject(client.db, grant.workspaceId, request, {
      subjectId: other,
    });
    expect(denied.matches).toHaveLength(0);
    expect(denied.matchedMessageCount).toBe(0);
    expect(denied.scannedMessages).toBe(0);
  }
  // A foreign workspace cannot disclose even an exact known session UUID.
  expect(
    (await collect({ query: "private-search-token", sessionId: session.id })).matches,
  ).toHaveLength(0);
}, 180_000);

test("aborted requests stop before scanning", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { query: "x" },
      { subjectId },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
}, 180_000);

test("agent list reach intersects host scope before messages and counts", async () => {
  const own = await makeSession();
  const peer = await makeSession();
  await insert(own.id, 1, "user.message", { text: "agent-reach-token" });
  await insert(peer.id, 1, "user.message", { text: "agent-reach-token" });
  const viewer = {
    callerRootSessionId: own.id,
    agentAccess: "session" as const,
    scopeSubjectId: null,
  };
  const withinTree = await collect(
    { query: "agent-reach-token" },
    {
      subjectId,
      authorizationScope: { kind: "all", agentAccessViewer: viewer },
    },
  );
  expect(withinTree.matches.map((m) => m.sessionId)).toEqual([own.id]);
  const intersected = await collect(
    { query: "agent-reach-token" },
    {
      subjectId,
      authorizationScope: {
        kind: "scoped",
        sessionIds: [peer.id],
        rootSessionIds: [],
        agentAccessViewer: viewer,
      },
    },
  );
  expect(intersected.matches).toHaveLength(0);
  expect(intersected.page.scannedMessages).toBe(0);
}, 180_000);

test("workspace grouping skips prolific sessions in both buffered results and continuation", async () => {
  const sessions = await Promise.all([makeSession(), makeSession()]);
  const [first, second] = sessions.sort((a, b) => (a.id < b.id ? -1 : 1));
  const authority = {
    subjectId,
    authorizationScope: {
      kind: "scoped" as const,
      sessionIds: sessions.map((s) => s.id),
      rootSessionIds: [],
    },
  };
  await insert(first!.id, 1, "user.message", { text: "group-token ".repeat(1000) });
  await insert(second!.id, 1, "agent.message.completed", { text: "group-token group-token" });
  // Both identities fit one batch: only the first occurrence of each is returned.
  const together = await collect({ query: "group-token", groupBy: "session" }, authority);
  expect(together.matches.map((m) => [m.sessionId, m.sequence, m.messageMatchOffset])).toEqual([
    [first!.id, 1, 0],
    [second!.id, 1, 0],
  ]);
  expect(together.page.matchedMessageCount).toBe(2);
  expect(together.page.matchedOccurrenceCount).toBe(2);
  expect(together.page.scannedMessages).toBe(2);
  // Fill the first session beyond the candidate batch. Continuation must use
  // session-id > boundary, not scan its 80 remaining messages or 999 occurrences.
  for (let sequence = 2; sequence <= 81; sequence++)
    await insert(first!.id, sequence, "user.message", { text: "group-token" });
  const request = { query: "group-token", groupBy: "session" as const, limit: 1 };
  const page = await searchSessionMessagesForSubject(client.db, workspaceId, request, authority);
  expect(page.matches.map((m) => m.sessionId)).toEqual([first!.id]);
  expect(page.hasMore).toBe(true);
  const next = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { ...request, cursor: page.nextCursor! },
    authority,
  );
  expect(next.matches.map((m) => m.sessionId)).toEqual([second!.id]);
  expect(next.matchedOccurrenceCount).toBe(2);
  expect(next.matchedMessageCount).toBe(2);
  expect(next.scannedMessages).toBe(2);
  expect(next.countIsExact).toBe(true);
  // A larger/default result limit must also preserve the continuation when
  // grouping drains all 33 buffered identities of the first session. There
  // may still be another session beyond this full batch; no buffered identity
  // is not evidence that the entire search is exhausted.
  for (const limit of [undefined, 50]) {
    const groupedRequest = {
      query: "group-token",
      groupBy: "session" as const,
      ...(limit === undefined ? {} : { limit }),
    };
    const drained = await searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      groupedRequest,
      authority,
    );
    expect(drained.matches.map((m) => m.sessionId)).toEqual([first!.id]);
    expect(drained.hasMore).toBe(true);
    expect(drained.countIsExact).toBe(false);
    expect(drained.nextCursor).not.toBeNull();
    const resumed = await searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { ...groupedRequest, cursor: drained.nextCursor! },
      authority,
    );
    expect(resumed.matches.map((m) => m.sessionId)).toEqual([second!.id]);
    expect(resumed.scannedMessages).toBe(2);
    expect(resumed.matchedOccurrenceCount).toBe(2);
    expect(resumed.countIsExact).toBe(true);
    expect(resumed.hasMore).toBe(false);
  }
  // Grouping participates in cursor identity in both directions.
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { query: "group-token", cursor: page.nextCursor! },
      authority,
    ),
  ).rejects.toThrow("cursor");
  const ordinary = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "group-token", limit: 1 },
    authority,
  );
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { ...request, cursor: ordinary.nextCursor! },
      authority,
    ),
  ).rejects.toThrow("cursor");
  const unchangedFind = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "group-token", sessionId: first!.id, limit: 50 },
    { subjectId },
  );
  expect(unchangedFind.matches).toHaveLength(50);
  expect(unchangedFind.matches[49]!.messageMatchOffset).toBe(49 * "group-token ".length);
}, 180_000);

test("grouped exact multiples of the identity batch terminate on one empty continuation", async () => {
  for (const messageCount of [33, 66]) {
    const session = await makeSession();
    for (let sequence = 1; sequence <= messageCount; sequence++)
      await insert(session.id, sequence, "user.message", { text: "exact-batch-token" });
    const authority = {
      subjectId,
      authorizationScope: {
        kind: "scoped" as const,
        sessionIds: [session.id],
        rootSessionIds: [],
      },
    };
    const request = { query: "exact-batch-token", groupBy: "session" as const, limit: 50 };
    const first = await searchSessionMessagesForSubject(client.db, workspaceId, request, authority);
    expect(first.matches.map((match) => match.sessionId)).toEqual([session.id]);
    expect(first.hasMore).toBe(true);
    expect(first.countIsExact).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    const terminal = await searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { ...request, cursor: first.nextCursor! },
      authority,
    );
    expect(terminal.matches).toHaveLength(0);
    expect(terminal.hasMore).toBe(false);
    expect(terminal.nextCursor).toBeNull();
    expect(terminal.countIsExact).toBe(true);
    expect(terminal.scannedMessages).toBe(1);
    expect(terminal.matchedMessageCount).toBe(1);
    expect(terminal.matchedOccurrenceCount).toBe(1);
  }
}, 180_000);

test("grouped workspace counts still exclude sessions outside authorization scope", async () => {
  const permitted = await makeSession();
  const hidden = await makeSession();
  await insert(permitted.id, 1, "user.message", { text: "group-isolation" });
  await insert(hidden.id, 1, "user.message", { text: "group-isolation ".repeat(1000) });
  const page = await collect(
    { query: "group-isolation", groupBy: "session" },
    {
      subjectId,
      authorizationScope: { kind: "scoped", rootSessionIds: [], sessionIds: [permitted.id] },
    },
  );
  expect(page.matches.map((m) => m.sessionId)).toEqual([permitted.id]);
  expect(page.page.matchedMessageCount).toBe(1);
  expect(page.page.scannedMessages).toBe(1);
}, 180_000);

test("a later text-less completion copy never hides earlier retained text", async () => {
  const session = await makeSession();
  const triggerId = await insert(session.id, 1, "user.message", { text: "start" });
  const [turn] = await shared.admin`insert into session_turns (
    account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
    status, source, position, prompt, model, reasoning_effort, sandbox_backend
  ) values (${accountId}, ${workspaceId}, ${session.id}, ${triggerId}, 'search-fixture',
    'cancelled', 'user', 1, 'start', 'test', 'medium', 'none') returning id`;
  const turnId = turn!.id as string;
  // A failed/empty retry completion can share the provider message id without
  // retaining any text. It must not suppress the earlier complete copy.
  await insert(
    session.id,
    2,
    "agent.message.completed",
    { text: "kept needle", messageId: "retry-shared-id" },
    { turnId },
  );
  await insert(
    session.id,
    3,
    "agent.message.completed",
    { messageId: "retry-shared-id" },
    { turnId },
  );
  await insert(
    session.id,
    4,
    "agent.message.completed",
    { text: null, messageId: "retry-shared-id" },
    { turnId },
  );
  await insert(
    session.id,
    5,
    "agent.message.completed",
    { text: 42, messageId: "retry-shared-id" },
    { turnId },
  );
  const result = await collect({ query: "kept needle", sessionId: session.id });
  expect(result.matches.map((m) => m.sequence)).toEqual([2]);
}, 180_000);

test("cursor binding canonicalizes authorization scope id order", async () => {
  const first = await makeSession();
  const second = await makeSession();
  await insert(first.id, 1, "user.message", { text: "order-canonical-token" });
  await insert(second.id, 1, "user.message", { text: "order-canonical-token" });
  const ids = [first.id, second.id].sort();
  const ascending = { kind: "scoped" as const, sessionIds: ids, rootSessionIds: ids };
  const descending = {
    kind: "scoped" as const,
    sessionIds: [...ids].reverse().concat(ids[0]!),
    rootSessionIds: [...ids].reverse().concat(ids[0]!),
  };
  const page = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "order-canonical-token", limit: 1 },
    { subjectId, authorizationScope: ascending },
  );
  expect(page.matches).toHaveLength(1);
  expect(page.nextCursor).not.toBeNull();
  // Same semantic scope, different id order across pages: still one traversal.
  const next = await searchSessionMessagesForSubject(
    client.db,
    workspaceId,
    { query: "order-canonical-token", limit: 1, cursor: page.nextCursor! },
    { subjectId, authorizationScope: descending },
  );
  expect(next.matches).toHaveLength(1);
  expect(next.countIsExact).toBe(true);
  expect(next.matchedOccurrenceCount).toBe(2);
  // A genuinely narrower scope is still a changed scope.
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      workspaceId,
      { query: "order-canonical-token", limit: 1, cursor: page.nextCursor! },
      {
        subjectId,
        authorizationScope: { kind: "scoped", sessionIds: [first.id], rootSessionIds: [] },
      },
    ),
  ).rejects.toThrow("cursor");
}, 180_000);

test("Slack-private sessions stay owner-only in message search", async () => {
  const slackOwner = `user:slack-owner-${crypto.randomUUID()}`;
  const slackPeer = `user:slack-peer-${crypto.randomUUID()}`;
  for (const member of [slackOwner, slackPeer])
    await grantWorkspaceAccess(client.db, {
      accountId,
      workspaceId,
      subjectId: member,
      permissions: ["sessions:read"],
    });
  const session = await makeSession();
  await insert(session.id, 1, "user.message", { text: "slack-private-search-token" });
  const [connection] = await shared.admin`insert into connections (
    account_id, workspace_id, origin_workspace_id, provider_domain, kind,
    credential_encrypted, status
  ) values (${accountId}, ${workspaceId}, ${workspaceId}, 'slack.test', 'oauth2',
    'ciphertext-never-read-by-search-test', 'active') returning id`;
  await shared.admin`insert into slack_interactions (
    account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
    slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
    visibility, session_reservation_id, session_id
  ) values (
    ${accountId}, ${workspaceId}, ${connection!.id}, 'TSEARCH', 'CSEARCH',
    '1700000000.0099', ${`route-${crypto.randomUUID()}`}, ${`Ev-${crypto.randomUUID()}`},
    ${slackOwner}, 'private', ${session.id}, ${session.id}
  )`;
  const ownerResult = await collect(
    { query: "slack-private-search-token", sessionId: session.id },
    { subjectId: slackOwner },
  );
  expect(ownerResult.matches.map((m) => m.sessionId)).toEqual([session.id]);
  const peerResult = await collect(
    { query: "slack-private-search-token" },
    { subjectId: slackPeer },
  );
  expect(peerResult.matches).toHaveLength(0);
  expect(peerResult.page.matchedMessageCount).toBe(0);
  expect(peerResult.page.matchedOccurrenceCount).toBe(0);
  // Other shared messages in this workspace can still be scanned. Narrowing
  // to the known private session proves it contributes no scans or counts.
  const narrowed = await collect(
    { query: "slack-private-search-token", sessionId: session.id },
    { subjectId: slackPeer },
  );
  expect(narrowed.matches).toHaveLength(0);
  expect(narrowed.page.scannedMessages).toBe(0);
  expect(narrowed.page.matchedMessageCount).toBe(0);
  expect(narrowed.page.matchedOccurrenceCount).toBe(0);
}, 180_000);

test("cross-account workspaces are fenced before any message is scanned", async () => {
  const foreignSubject = `user:foreign-${crypto.randomUUID()}`;
  const foreign = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Foreign",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Foreign",
    subjectId: foreignSubject,
  });
  const foreignGrant = foreign.workspaceGrants[0]!;
  const foreignSession = await createSession(client.db, {
    accountId: foreignGrant.accountId,
    workspaceId: foreignGrant.workspaceId,
    initialMessage: "foreign",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${foreignGrant.accountId}, ${foreignGrant.workspaceId}, ${foreignSession.id}, 1, 'user.message', '{"text":"cross-tenant-search-token"}'::jsonb)`;
  // The same token exists in our workspace: a correct search returns only ours.
  const ownSession = await makeSession();
  await insert(ownSession.id, 1, "user.message", { text: "cross-tenant-search-token" });
  const ours = await collect({ query: "cross-tenant-search-token" });
  expect(ours.matches.map((m) => m.sessionId)).toEqual([ownSession.id]);
  // Our member has no authority in the foreign workspace at all.
  await expect(
    searchSessionMessagesForSubject(
      client.db,
      foreignGrant.workspaceId,
      { query: "cross-tenant-search-token" },
      { subjectId },
    ),
  ).rejects.toBeInstanceOf(SessionListAccessError);
  // The foreign subject sees only its own workspace's copy.
  const theirs = await searchSessionMessagesForSubject(
    client.db,
    foreignGrant.workspaceId,
    { query: "cross-tenant-search-token" },
    { subjectId: foreignSubject },
  );
  expect(theirs.matches.map((m) => m.sessionId)).toEqual([foreignSession.id]);
}, 180_000);
