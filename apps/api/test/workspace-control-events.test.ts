import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerWorkspaceRoutes } from "../src/routes/workspaces";

const SECRET = "workspace-control-events-test-secret";
let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let bus: MemoryEventBus;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-control-events");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `workspace-control-${crypto.randomUUID()}`,
    accountName: "Workspace control events",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-control-${crypto.randomUUID()}`,
    workspaceName: "Workspace control events",
    subjectId: "workspace-controller",
  });
  grant = access.workspaceGrants[0]!;
  bus = new MemoryEventBus();
  const noop = async () => undefined;
  const deps = {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
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
  app = new Hono();
  registerWorkspaceRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function authorization(): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions: ["workspace:read", "workspace:admin"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

describe("workspace control event API", () => {
  test("one committed control revision is durable, published once, and replayable", async () => {
    const auth = await authorization();
    const changed = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/inference-control`,
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          action: "pause",
          clientEventId: crypto.randomUUID(),
          expectedRevision: 0,
        }),
      },
    );
    expect(changed.status).toBe(200);
    expect(bus.publishedWorkspaceControl).toHaveLength(1);
    expect(bus.publishedWorkspaceControl[0]).toMatchObject({
      sequence: 1,
      revision: 1,
      scope: "workspace",
      action: "pause",
    });

    const replay = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/control-events?after=0&limit=10`,
      { headers: { authorization: auth } },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(bus.publishedWorkspaceControl);

    const streamed = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/control-events/stream?after=0`,
      { headers: { authorization: auth } },
    );
    expect(streamed.status).toBe(200);
    const reader = streamed.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: workspace.control.changed");
    expect(text).toContain('"revision":1');
    await reader.cancel();

    bus.publishWorkspaceControl = async () => {
      throw new Error("live fanout unavailable");
    };
    const resumed = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/inference-control`,
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          action: "resume",
          clientEventId: crypto.randomUUID(),
          expectedRevision: 1,
        }),
      },
    );
    expect(resumed.status).toBe(200);
    const afterFailure = await app.request(
      `http://x/v1/workspaces/${grant.workspaceId}/control-events?after=1&limit=10`,
      { headers: { authorization: auth } },
    );
    expect(await afterFailure.json()).toEqual([
      expect.objectContaining({ revision: 2, action: "resume" }),
    ]);
  });
});
