import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { documentHttpException, registerDocumentRoutes } from "../src/routes/documents";

const SECRET = "durable-learning-memory-route-test-secret";

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let workspaceId: string;
let authorization: string;
let secondWorkspaceId: string;
let secondAuthorization: string;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("durable-learning-memory-routes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "durable-learning-memory-routes",
    accountExternalId: `account-${suffix}`,
    accountName: "Durable learning memory routes",
    workspaceExternalSource: "durable-learning-memory-routes",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Durable learning memory routes",
    subjectId: `human:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    permissions: ["documents:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
  const secondAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "durable-learning-memory-routes",
    accountExternalId: `second-account-${suffix}`,
    accountName: "Durable learning memory routes second tenant",
    workspaceExternalSource: "durable-learning-memory-routes",
    workspaceExternalId: `second-workspace-${suffix}`,
    workspaceName: "Durable learning memory routes second tenant",
    subjectId: `human:second:${suffix}`,
  });
  const secondGrant = secondAccess.workspaceGrants[0]!;
  secondWorkspaceId = secondGrant.workspaceId;
  secondAuthorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: secondGrant.accountId,
    workspaceId: secondWorkspaceId,
    subjectId: secondGrant.subjectId,
    permissions: ["documents:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;

  app = new Hono();
  registerDocumentRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    objectStorage: null,
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => ({ embedder: undefined }) as never,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

describe("durable-learning workspace Memory routes", () => {
  test("binds replay to a caller operation key rather than payload identity", async () => {
    const text = `REST operation identity ${crypto.randomUUID()}`;
    const payload = {
      text,
      kind: "decision" as const,
      metadata: { source: "rest-idempotency" },
    };
    const create = (
      body: { text: string; kind: "decision" | "semantic"; metadata: { source: string } },
      idempotencyKey?: string,
      target: { workspaceId: string; authorization: string } = {
        workspaceId,
        authorization,
      },
    ) =>
      app.request(`http://x/v1/workspaces/${target.workspaceId}/knowledge/memories`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: target.authorization,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
      });
    const update = (id: string, body: Record<string, unknown>) =>
      app.request(`http://x/v1/workspaces/${workspaceId}/knowledge/memories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { authorization, "content-type": "application/json" },
      });

    const firstResponse = await create(payload);
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as { id: string; kind: string; status: string };
    expect(first).toMatchObject({ kind: "decision", status: "active" });

    expect((await update(first.id, { text: `${text} edited` })).status).toBe(200);
    const afterEditResponse = await create(payload);
    expect(afterEditResponse.status).toBe(201);
    const afterEdit = (await afterEditResponse.json()) as {
      id: string;
      kind: string;
      status: string;
    };
    expect(afterEdit.id).not.toBe(first.id);
    expect(afterEdit).toMatchObject({ kind: "decision", status: "active" });

    expect((await update(afterEdit.id, { status: "archived" })).status).toBe(200);
    const afterArchiveResponse = await create(payload);
    expect(afterArchiveResponse.status).toBe(201);
    const afterArchive = (await afterArchiveResponse.json()) as {
      id: string;
      kind: string;
      status: string;
    };
    expect(afterArchive.id).not.toBe(afterEdit.id);
    expect(afterArchive).toMatchObject({ kind: "decision", status: "active" });

    const keyedPayload = {
      text: `Keyed REST operation ${crypto.randomUUID()}`,
      kind: "semantic" as const,
      metadata: { source: "rest-idempotency-key" },
    };
    const idempotencyKey = `memory-create-${crypto.randomUUID()}`;
    const keyedFirstResponse = await create(keyedPayload, idempotencyKey);
    expect(keyedFirstResponse.status).toBe(201);
    const keyedFirst = (await keyedFirstResponse.json()) as { id: string };
    const keyedReplayResponse = await create(keyedPayload, idempotencyKey);
    expect(keyedReplayResponse.status).toBe(201);
    expect((await keyedReplayResponse.json()) as { id: string }).toEqual(keyedFirst);

    expect(
      (await create({ ...keyedPayload, text: `${keyedPayload.text} changed` }, idempotencyKey))
        .status,
    ).toBe(409);
    expect((await create(keyedPayload, "x".repeat(201))).status).toBe(400);

    const secondTenantResponse = await create(keyedPayload, idempotencyKey, {
      workspaceId: secondWorkspaceId,
      authorization: secondAuthorization,
    });
    expect(secondTenantResponse.status).toBe(201);
    expect(((await secondTenantResponse.json()) as { id: string }).id).not.toBe(keyedFirst.id);
  });

  test("does not project raw database diagnostics through REST", () => {
    const projected = documentHttpException(
      new Error(
        'Failed query: insert into durable_learning_attempts (...) params: ["tenant-secret"]',
      ),
    );
    expect(projected.status).toBe(500);
    expect(projected.message).toBe("internal server error");
    expect(projected.message).not.toContain("insert into");
    expect(projected.message).not.toContain("tenant-secret");
  });
});
