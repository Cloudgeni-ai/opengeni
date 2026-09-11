import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { signDelegatedAccessToken, type Session } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEventsAndUpdateSession,
  bootstrapWorkspace,
  createDb,
  createSession,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerSessionRoutes } from "../src/routes/sessions";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("failure-detail-coherence");
  if (!acquired) throw new Error("PostgreSQL unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** Pause after the real initial session SELECT resolves, without replacing its rows. */
function afterSessionSelect(db: Database, afterRead: () => Promise<void>): Database {
  const wrapQuery = (query: any): any =>
    new Proxy(query, {
      get(target, property) {
        if (property === "then")
          return (resolve: any, reject: any) =>
            target
              .then(async (rows: unknown) => {
                await afterRead();
                return rows;
              })
              .then(resolve, reject);
        const value = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]) => wrapQuery(value.apply(target, args))
          : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "transaction")
        return (callback: (tx: Database) => unknown, ...args: unknown[]) =>
          (target.transaction as any)(
            (tx: Database) => callback(afterSessionSelect(tx, afterRead)),
            ...args,
          );
      if (property === "select")
        return (fields: any) => {
          const query = target.select(fields);
          return fields?.session === schema.sessions ? wrapQuery(query) : query;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("HTTP detail preserves a coherent failure cursor while a concurrent revival commits", async () => {
  const subjectId = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: subjectId,
    accountName: "Failure API",
    workspaceExternalSource: "test",
    workspaceExternalId: subjectId,
    workspaceName: "Failure API",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "test",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [failure] = await appendSessionEventsAndUpdateSession(
    client.db,
    workspaceId,
    session.id,
    [{ type: "turn.failed", payload: { error: "upstream failed", providerRecoveryCount: 2 } }],
    { status: "failed" },
  );
  let revivalSequence = 0;
  let intercepted = false;
  const observedDb = afterSessionSelect(client.db, async () => {
    if (intercepted) return;
    intercepted = true;
    const [revival] = await appendSessionEventsAndUpdateSession(
      client.db,
      workspaceId,
      session.id,
      [{ type: "session.status.changed", payload: { status: "running" } }],
      { status: "running" },
    );
    revivalSequence = revival!.sequence;
  });
  const secret = "failure-detail-coherence-test";
  const app = new Hono();
  registerSessionRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    db: observedDb,
    bus: new MemoryEventBus(),
    workflowClient: {},
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps);
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId,
    subjectId,
    permissions: ["sessions:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const read = () =>
    app.request(`http://api.test/v1/workspaces/${workspaceId}/sessions/${session.id}`, {
      headers: { authorization },
    });
  const response = await read();
  expect(response.status).toBe(200);
  const oldDetail = (await response.json()) as Session;
  expect(intercepted).toBe(true);
  expect(oldDetail.status).toBe("failed");
  expect(oldDetail.lastSequence).toBe(failure!.sequence);
  expect(oldDetail.lastSequence).toBeLessThan(revivalSequence);
  expect(oldDetail.failureDiagnostics?.eventId).toBe(failure!.id);
  const current = (await (await read()).json()) as Session;
  expect(current.status).toBe("running");
  expect(current.lastSequence).toBe(revivalSequence);
  expect(current.failureDiagnostics).toBeNull();
}, 30_000);
