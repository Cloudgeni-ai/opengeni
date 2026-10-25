import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createFeedback,
  listOwnFeedback,
  withWorkspaceSubjectRls,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  type DbClient,
} from "@opengeni/db";
import { feedbackSubmissions } from "../../../packages/db/src/schema";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerFeedbackRoutes } from "../src/routes/feedback";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let workspaceId: string;
let accountId: string;
let sessionId: string;
const subjectId = "user:feedback-author";
const secret = "feedback-route-test-delegation-secret";
const permissions = ["workspace:read", "sessions:read", "sessions:create"] as const;
const storedObjects = new Map<string, { bytes: Uint8Array; contentType: string }>();
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("feedback-routes");
  if (!shared) throw new Error("Real PostgreSQL is required for feedback isolation verification");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Feedback test",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Feedback test",
    subjectId,
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Feedback target",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  app = new Hono();
  registerFeedbackRoutes(app, {
    db: client.db,
    settings: testSettings({ delegationSecret: secret }),
    objectStorage: {
      async putObjectIfAbsent(args: { key: string; contentType: string; body: Uint8Array }) {
        if (storedObjects.has(args.key)) return false;
        storedObjects.set(args.key, { bytes: args.body, contentType: args.contentType });
        return true;
      },
      async getObjectBytes(key: string) {
        return storedObjects.get(key) ?? null;
      },
    },
  } as unknown as ApiRouteDeps);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
async function request(
  payload?: unknown,
  options: {
    query?: string;
    actor?: string;
    kind?: "human_session" | "agent_attempt";
    readOnly?: boolean;
    path?: string;
  } = {},
) {
  const bearer = await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId: options.actor ?? subjectId,
    principalKind: options.kind ?? "human_session",
    permissions: options.readOnly ? ["workspace:read", "sessions:read"] : [...permissions],
    ...(options.kind === "agent_attempt"
      ? {
          sessionId,
          turnId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
        }
      : {}),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return app.request(
    `http://x/v1/workspaces/${workspaceId}/feedback${options.path ?? ""}${options.query ?? ""}`,
    {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
  );
}
test("general feedback stores exact comments and replays without duplicates", async () => {
  const payload = { idempotencyKey: crypto.randomUUID(), comment: "  exact\nfeedback\u0000🙂  " };
  const first = await request(payload);
  expect(first.status).toBe(201);
  const created = await first.json();
  expect(created.feedback.comment).toBe(payload.comment);
  const retry = await request(payload);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ ...created, replayed: true });
  expect((await request({ ...payload, comment: "changed" })).status).toBe(409);
  const result = await (await request()).json();
  expect(result.feedback).toHaveLength(1);
});
test("concurrent retries insert once and changing a rating preserves history", async () => {
  const payload = { idempotencyKey: crypto.randomUUID(), sessionId, sentiment: "negative" };
  const results = await Promise.all([request(payload), request(payload)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(
    (
      await request({
        ...payload,
        idempotencyKey: crypto.randomUUID(),
        sentiment: "positive",
        comment: "Fixed",
      })
    ).status,
  ).toBe(201);
  const list = await (await request(undefined, { query: `?sessionId=${sessionId}` })).json();
  expect(list.feedback.map((f: { sentiment: string }) => f.sentiment)).toEqual([
    "positive",
    "negative",
  ]);
  expect(
    (await (await request()).json()).feedback.every(
      (f: { sessionId: string | null }) => f.sessionId === null,
    ),
  ).toBe(true);
});
test("rejects foreign targets, unknown turns, spoofed identity, agents and empty input", async () => {
  expect(
    (
      await request({
        idempotencyKey: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        sentiment: "positive",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request({
        idempotencyKey: crypto.randomUUID(),
        sessionId,
        turnId: crypto.randomUUID(),
        sentiment: "positive",
      })
    ).status,
  ).toBe(404);
  expect(
    (await request({ idempotencyKey: crypto.randomUUID(), comment: "hello", subjectId: "other" }))
      .status,
  ).toBe(400);
  expect(
    (
      await request(
        { idempotencyKey: crypto.randomUUID(), comment: "hello" },
        { kind: "agent_attempt" },
      )
    ).status,
  ).toBe(403);
  expect((await request({ idempotencyKey: crypto.randomUUID() })).status).toBe(400);
  expect(
    (await app.request(`http://x/v1/workspaces/${workspaceId}/feedback`, { method: "POST" }))
      .status,
  ).toBe(403);
});
test("runtime RLS isolates authors and does not permit overwriting feedback", async () => {
  expect(await listOwnFeedback(client.db, { workspaceId, subjectId: "other-author" })).toEqual([]);
  await expect(
    withWorkspaceSubjectRls(client.db, workspaceId, subjectId, (tx) =>
      tx.update(feedbackSubmissions).set({ comment: "overwrite" }),
    ),
  ).rejects.toThrow();
  await expect(
    createFeedback(client.db, {
      workspaceId,
      accountId: crypto.randomUUID(),
      subjectId,
      principalKind: "human_session",
      request: { idempotencyKey: crypto.randomUUID(), comment: "wrong tenant" },
    }),
  ).rejects.toThrow();
});

test("turn feedback is tied to the exact session", async () => {
  const turn = await enqueueSessionTurn(client.db, {
    accountId,
    workspaceId,
    sessionId,
    triggerEventId: crypto.randomUUID(),
    temporalWorkflowId: "feedback-test",
    source: "user",
    prompt: "A task",
    resources: [],
    tools: [],
    model: "test-model",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId },
  });
  expect(
    (
      await request({
        idempotencyKey: crypto.randomUUID(),
        sessionId,
        turnId: turn.id,
        sentiment: "positive",
      })
    ).status,
  ).toBe(201);
  const other = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Other",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  expect(
    (
      await request({
        idempotencyKey: crypto.randomUUID(),
        sessionId: other.id,
        turnId: turn.id,
        sentiment: "negative",
      })
    ).status,
  ).toBe(404);
});
test("session-only reads exclude turn ratings before applying the limit", async () => {
  const response = await request(undefined, {
    query: `?sessionId=${sessionId}&includeTurns=false&limit=1`,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.feedback).toHaveLength(1);
  expect(result.feedback[0].turnId).toBeNull();
  expect(result.feedback[0].comment).toBe("Fixed");
});

test("embedding host can deny session feedback and reads without exposing records", async () => {
  const original = app;
  const denied = new Hono();
  registerFeedbackRoutes(denied, {
    db: client.db,
    settings: testSettings({ delegationSecret: secret }),
    sessionAuthorization: {
      authorizeSession: async () => ({ allowed: false, reason: "forbidden" }),
    },
  } as unknown as ApiRouteDeps);
  app = denied;
  try {
    expect(
      (await request({ idempotencyKey: crypto.randomUUID(), sessionId, sentiment: "negative" }))
        .status,
    ).toBe(404);
    expect((await request(undefined, { query: `?sessionId=${sessionId}` })).status).toBe(404);
    expect(
      (
        await request({
          idempotencyKey: crypto.randomUUID(),
          comment: "General feedback is independent",
        })
      ).status,
    ).toBe(201);
  } finally {
    app = original;
  }
});

test("private-session feedback requires the session owner even with workspace permissions", async () => {
  const userId = `feedback-private-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared!
    .admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'test') on conflict (account_id) do nothing`;
  const policy = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
    enabled: true,
    expectedVersion: policy.version,
    operationId: crypto.randomUUID(),
  });
  const target = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Private task",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: owner },
    createdByContext: {},
  });
  await createFeedback(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "user:other-workspace-reader",
    principalKind: "human_session",
    request: { idempotencyKey: crypto.randomUUID(), sessionId: target.id, sentiment: "negative" },
  });
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: target.id,
    actorSubjectId: owner,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  expect(
    await listOwnFeedback(client.db, {
      workspaceId: grant.workspaceId,
      subjectId: "user:other-workspace-reader",
      sessionId: target.id,
    }),
  ).toEqual([]);
  for (const actor of [owner, "user:other-workspace-reader"]) {
    const bearer = await signDelegatedAccessToken(secret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: actor,
      principalKind: "human_session",
      permissions: [...permissions],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const response = await app.request(`http://x/v1/workspaces/${grant.workspaceId}/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        sessionId: target.id,
        sentiment: "positive",
      }),
    });
    expect(response.status).toBe(actor === owner ? 201 : 404);
  }
});

test("read-only credentials can read own feedback but cannot submit it", async () => {
  for (const target of [{}, { sessionId, sentiment: "positive" }]) {
    const response = await request(
      { idempotencyKey: crypto.randomUUID(), comment: "read-only feedback", ...target },
      { readOnly: true },
    );
    expect(response.status).toBe(403);
  }
  expect((await request(undefined, { readOnly: true })).status).toBe(200);
});

test("feedback keeps its screenshots and app context, and replays only the same images", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const payload = {
    idempotencyKey: crypto.randomUUID(),
    comment: "The send button did nothing",
    context: {
      source: "mobile",
      trigger: "shake",
      platform: "ios",
      appVersion: "1.4.0",
      buildNumber: "202610251500",
      screen: `/session/${sessionId}`,
      recentErrors: [{ at: new Date().toISOString(), message: "Couldn't send" }],
    },
    screenshots: [{ contentType: "image/jpeg", base64: Buffer.from(jpeg).toString("base64") }],
  };
  const first = await request(payload);
  expect(first.status).toBe(201);
  const { feedback } = await first.json();
  expect(feedback.context).toEqual(payload.context);
  expect(feedback.screenshots).toEqual([
    expect.objectContaining({ index: 0, contentType: "image/jpeg", sizeBytes: jpeg.byteLength }),
  ]);
  expect(JSON.stringify(feedback)).not.toContain("objectKey");
  expect(storedObjects.size).toBe(1);
  expect((await request(payload)).status).toBe(200);
  expect(storedObjects.size).toBe(1);
  const other = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]);
  expect(
    (
      await request({
        ...payload,
        screenshots: [{ contentType: "image/jpeg", base64: Buffer.from(other).toString("base64") }],
      })
    ).status,
  ).toBe(409);
  const image = await request(undefined, { path: `/${feedback.id}/screenshots/0` });
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(jpeg);
  expect(
    (await request(undefined, { path: `/${feedback.id}/screenshots/0`, actor: "user:someone-else" }))
      .status,
  ).toBe(404);
  expect((await request(undefined, { path: `/${feedback.id}/screenshots/1` })).status).toBe(404);
});
test("screenshots must be real images of the declared type", async () => {
  const response = await request({
    idempotencyKey: crypto.randomUUID(),
    comment: "Not an image",
    screenshots: [{ contentType: "image/png", base64: Buffer.from("hello").toString("base64") }],
  });
  expect(response.status).toBe(400);
});
