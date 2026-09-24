import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  signDelegatedAccessToken,
  SessionMessageSearchResponse,
  type SessionAuthorizationPort,
} from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession } from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { MemoryEventBus, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import { Hono } from "hono";
import { acquireSearchTestDatabase } from "../../../packages/db/test/session-message-search-fixture";
import { toPostgresLosslessJson } from "../../../packages/db/src/lossless-json";
import { registerSessionRoutes } from "../src/routes/sessions";

const secret = `search-test-${crypto.randomUUID()}`;
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  shared = await acquireSearchTestDatabase("session-message-search-http");
  client = createDb(shared.appUrl, { max: 3 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function appWith(port?: SessionAuthorizationPort) {
  const app = new Hono();
  const noop = async () => undefined;
  registerSessionRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: secret,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    ...(port ? { sessionAuthorization: port } : {}),
  } as unknown as ApiRouteDeps);
  return app;
}
async function fixture() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Search HTTP",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Search HTTP",
    subjectId: `user:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    ...grant,
    initialMessage: "not a full-history index",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  for (const [index, text] of ["before", "literal %_\\🙂 twice TWICE", "after"].entries()) {
    await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values (${grant.accountId}, ${grant.workspaceId}, ${session.id}, ${index + 1}, 'user.message', ${shared.admin.json({ text, modelContext: "hidden model context" })})`;
  }
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    ...grant,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  return {
    grant,
    session,
    authorization,
    path: `/v1/workspaces/${grant.workspaceId}/session-message-search`,
  };
}

test("HTTP searches old visible content and existing bounded event reader loads surrounding context", async () => {
  const f = await fixture();
  const app = appWith();
  const response = await app.request(
    `${f.path}?${new URLSearchParams({ query: "%_\\🙂", sessionId: f.session.id })}`,
    { headers: { authorization: f.authorization } },
  );
  expect(response.status).toBe(200);
  const page = SessionMessageSearchResponse.parse(await response.json());
  expect(page.matches).toHaveLength(1);
  expect(page.matches[0]!.sequence).toBe(2);
  expect(JSON.stringify(page)).not.toContain("hidden model context");
  const context = await app.request(
    `/v1/workspaces/${f.grant.workspaceId}/sessions/${f.session.id}/events?after=0&before=4&includeTypes=user.message&payloadMode=summary&limit=3`,
    { headers: { authorization: f.authorization } },
  );
  expect(context.status).toBe(200);
  const events = (await context.json()) as Array<{ sequence: number; payload: { text?: string } }>;
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  // The existing reader is also an audit API and retains modelContext even on
  // small summary payloads. Preview only the explicitly visible text field.
  expect(events.map((event) => event.payload.text)).toEqual([
    "before",
    "literal %_\\🙂 twice TWICE",
    "after",
  ]);
}, 180_000);

test("HTTP occurrence pagination carries advancing cursors and exact terminal counts", async () => {
  const f = await fixture();
  const app = appWith();
  const query = { query: "twice", sessionId: f.session.id, limit: "1" };
  const first = await app.request(`${f.path}?${new URLSearchParams(query)}`, {
    headers: { authorization: f.authorization },
  });
  const page = SessionMessageSearchResponse.parse(await first.json());
  expect(page.matches).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  const second = await app.request(
    `${f.path}?${new URLSearchParams({ ...query, cursor: page.nextCursor! })}`,
    { headers: { authorization: f.authorization } },
  );
  const next = SessionMessageSearchResponse.parse(await second.json());
  expect(next.matches[0]!.messageMatchOffset).toBeGreaterThan(page.matches[0]!.messageMatchOffset);
  expect(next.matchedOccurrenceCount).toBe(2);
  expect(next.matchedMessageCount).toBe(1);
}, 180_000);

test("HTTP cancelled searches return an empty client-closed response, not a server error", async () => {
  const f = await fixture();
  for (const customReason of [false, true]) {
    const controller = new AbortController();
    controller.abort(customReason ? new Error("superseded search") : undefined);
    const response = await appWith().request(`${f.path}?query=twice`, {
      headers: { authorization: f.authorization },
      signal: controller.signal,
    });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
  }
  // The request may be cancelled while the live host scope is resolving,
  // before control enters the database search.
  const controller = new AbortController();
  const app = appWith({
    authorizeSession: async () => ({ allowed: true }),
    resolveListScope: async () => {
      controller.abort();
      return { kind: "all" };
    },
  });
  const response = await app.request(`${f.path}?query=twice`, {
    headers: { authorization: f.authorization },
    signal: controller.signal,
  });
  expect(response.status).toBe(499);
  expect(await response.text()).toBe("");
}, 180_000);

test("HTTP workspace grouping returns one representative and rejects an in-session filter", async () => {
  const f = await fixture();
  const app = appWith();
  const response = await app.request(`${f.path}?query=twice&groupBy=session`, {
    headers: { authorization: f.authorization },
  });
  expect(response.status).toBe(200);
  const page = SessionMessageSearchResponse.parse(await response.json());
  expect(page.matches).toHaveLength(1);
  expect(page.matches[0]!.sessionId).toBe(f.session.id);
  expect(page.matchedMessageCount).toBe(1);
  expect(page.matchedOccurrenceCount).toBe(1);
  expect(page.countIsExact).toBe(true);
  const invalid = await app.request(
    `${f.path}?query=twice&groupBy=session&sessionId=${f.session.id}`,
    { headers: { authorization: f.authorization } },
  );
  expect(invalid.status).toBe(400);
}, 180_000);

test("search filters intersect host list scope, denied scopes reveal no counts, unavailable host fails closed", async () => {
  const f = await fixture();
  const denied = appWith({
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => ({ kind: "scoped", rootSessionIds: [], sessionIds: [] }),
  });
  for (const query of [{ query: "twice" }, { query: "twice", sessionId: f.session.id }]) {
    const response = await denied.request(`${f.path}?${new URLSearchParams(query)}`, {
      headers: { authorization: f.authorization },
    });
    expect(response.status).toBe(200);
    const page = SessionMessageSearchResponse.parse(await response.json());
    expect(page.matches).toHaveLength(0);
    expect(page.scannedMessages).toBe(0);
    expect(page.matchedOccurrenceCount).toBe(0);
  }
  const unavailable = appWith({
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => {
      throw new Error("host unavailable");
    },
  });
  expect(
    (
      await unavailable.request(`${f.path}?query=twice`, {
        headers: { authorization: f.authorization },
      })
    ).status,
  ).toBe(503);
}, 180_000);

test("unauthenticated, cross-workspace, invalid and out-of-bound requests fail closed", async () => {
  const f = await fixture();
  const other = await fixture();
  const app = appWith();
  expect((await app.request(`${f.path}?query=twice`)).status).toBe(401);
  expect(
    (
      await app.request(`${f.path}?query=twice`, {
        headers: { authorization: other.authorization },
      })
    ).status,
  ).toBe(403);
  for (const query of [
    "query=",
    "query=x&limit=51",
    "query=x&limit=NaN",
    "query=x&sessionId=bad",
    "query=x&includeTools=true",
    "query=x&cursor=broken",
  ]) {
    expect(
      (await app.request(`${f.path}?${query}`, { headers: { authorization: f.authorization } }))
        .status,
    ).toBe(400);
  }
  // Revocation defeats an otherwise valid, unexpired delegated bearer.
  await shared.admin`delete from workspace_memberships where workspace_id = ${f.grant.workspaceId} and subject_id = ${f.grant.subjectId}`;
  expect(
    (await app.request(`${f.path}?query=twice`, { headers: { authorization: f.authorization } }))
      .status,
  ).toBe(403);
}, 180_000);

test("selected preview returns only exact visible text through the 12,000 UTF-16 boundary", async () => {
  const f = await fixture();
  const app = appWith();
  const base = `/v1/workspaces/${f.grant.workspaceId}/sessions/${f.session.id}/events`;
  const request = (eventId: string, sequence: number) =>
    app.request(`${base}/${eventId}/message-preview?sequence=${sequence}`, {
      headers: { authorization: f.authorization },
    });
  const texts = [
    "a".repeat(12_000),
    "a".repeat(12_001),
    "a".repeat(8_191) + "🙂" + "b".repeat(3_807),
    "🙂".repeat(6_001),
    "a\u0000\ud800" + "b".repeat(11_997),
  ];
  for (const [index, text] of texts.entries()) {
    const sequence = index + 4;
    const canonical = index === 4;
    const [row] = await shared.admin<{ id: string }[]>`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version)
      values (${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id}, ${sequence}, 'agent.message.completed',
        ${shared.admin.json(canonical ? toPostgresLosslessJson({ text, modelContext: "secret" }) : { text, modelContext: "secret" })},
        ${canonical ? 1 : null}) returning id`;
    const response = await request(row!.id, sequence);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(
      text.length <= 12_000 ? { status: "available", text } : { status: "unavailable" },
    );
    expect(JSON.stringify(body)).not.toContain("secret");
  }
}, 180_000);

test("selected preview rejects stale, duplicate, non-message, malformed and unauthorized references", async () => {
  const f = await fixture();
  const other = await fixture();
  const app = appWith();
  const [original] = await shared.admin<{ id: string }[]>`
    select id from session_events where workspace_id = ${f.grant.workspaceId}
      and session_id = ${f.session.id} and sequence = 2`;
  const base = `/v1/workspaces/${f.grant.workspaceId}/sessions/${f.session.id}/events`;
  const read = (id: string, sequence: string, authorization = f.authorization) =>
    app.request(`${base}/${id}/message-preview?sequence=${sequence}`, {
      headers: { authorization },
    });
  expect((await read(original!.id, "1")).status).toBe(404);
  expect((await read(crypto.randomUUID(), "2")).status).toBe(404);
  expect((await read(original!.id, "2", other.authorization)).status).toBe(403);
  expect((await app.request(`${base}/${original!.id}/message-preview?sequence=2`)).status).toBe(
    401,
  );
  for (const sequence of ["", "0", "-1", "2.5", "NaN", "2147483648"]) {
    expect((await read(original!.id, sequence)).status).toBe(400);
  }
  expect((await read("not-a-uuid", "2")).status).toBe(400);
  for (const [sequence, type, payload] of [
    [4, "agent.toolCall.output", { text: "tool" }],
    [5, "agent.model.usage", { sourceKey: "canonical-usage" }],
  ] as const) {
    const [row] = await shared.admin<{ id: string }[]>`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      values (${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id}, ${sequence}, ${type},
        ${shared.admin.json(payload)}) returning id`;
    expect((await read(row!.id, String(sequence))).status).toBe(404);
  }
  const [canonicalUsage] = await shared.admin<{ id: string }[]>`
    select id from session_events where workspace_id = ${f.grant.workspaceId}
      and session_id = ${f.session.id} and sequence = 5`;
  // The database permits duplicate classification only for model-usage events.
  const [duplicateUsage] = await shared.admin<{ id: string }[]>`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload,
      turn_association, duplicate_of_event_id, duplicate_reason)
    values (${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id}, 6, 'agent.model.usage',
      ${shared.admin.json({ sourceKey: "duplicate-usage" })}, 'duplicate', ${canonicalUsage!.id},
      'duplicate_provider_response_usage') returning id`;
  expect((await read(duplicateUsage!.id, "6")).status).toBe(404);
  const [structured] = await shared.admin<{ id: string }[]>`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${f.grant.accountId}, ${f.grant.workspaceId}, ${f.session.id}, 7, 'user.message',
      ${shared.admin.json({ text: { nested: "no scalar" } })}) returning id`;
  expect((await read(structured!.id, "7")).status).toBe(404);
  const denied = appWith({
    authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    resolveListScope: async () => ({ kind: "all" }),
  });
  expect(
    (
      await denied.request(`${base}/${original!.id}/message-preview?sequence=2`, {
        headers: { authorization: f.authorization },
      })
    ).status,
  ).toBe(403);
}, 180_000);
