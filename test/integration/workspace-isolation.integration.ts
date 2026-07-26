import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant, type Permission } from "@opengeni/contracts";
import {
  allWorkspacePermissions,
  bootstrapWorkspace,
  createDb,
  createFileUpload,
  createSessionGoal,
  grantWorkspaceAccess,
} from "@opengeni/db";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import {
  MemoryEventBus,
  startTestServices,
  testSettings,
  type TestServices,
} from "@opengeni/testing";

const delegationSecret = "workspace-isolation-delegation-secret";

describe("workspace isolation matrix", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("never authorizes workspace A credentials through workspace B URLs", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        delegationSecret,
        environmentsEncryptionKey: Buffer.alloc(32, 6).toString("base64"),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const a = await workspaceGrant(dbClient.db, "A");
    const b = await workspaceGrant(dbClient.db, "B");
    const authA = await authHeader(a);
    const authB = await authHeader(b);

    const createdSession = await app.request(workspacePath(a.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "workspace A session" }),
      headers: { ...authA, "content-type": "application/json" },
    });
    expect(createdSession.status).toBe(202);
    const session = (await createdSession.json()) as { id: string };

    const listA = await app.request(workspacePath(a.workspaceId, "/sessions"), { headers: authA });
    expect(listA.status).toBe(200);
    expect(
      ((await listA.json()) as Array<{ id: string }>).some((item) => item.id === session.id),
    ).toBe(true);

    const secondSubject = `test:isolation:A:member:${crypto.randomUUID()}`;
    await grantWorkspaceAccess(dbClient.db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      subjectId: secondSubject,
      subjectLabel: "Isolation A member",
      permissions: ["sessions:read"],
    });
    const authASecond = await authHeader({ ...a, subjectId: secondSubject }, ["sessions:read"]);
    const pinnedByA = await app.request(
      workspacePath(a.workspaceId, `/sessions/${session.id}/pin`),
      {
        method: "PUT",
        body: JSON.stringify({ pinned: true, expectedVersion: 0 }),
        headers: { ...authA, "content-type": "application/json" },
      },
    );
    expect(pinnedByA.status).toBe(200);
    expect(await pinnedByA.json()).toMatchObject({ pinned: true, pinVersion: 1 });
    const listASecond = await app.request(workspacePath(a.workspaceId, "/sessions?view=page"), {
      headers: authASecond,
    });
    expect(listASecond.status).toBe(200);
    expect(await listASecond.json()).toMatchObject({
      pinned: [],
      sessions: [{ id: session.id, pinned: false, pinVersion: 0 }],
    });
    await expectStatus(app, authA, workspacePath(b.workspaceId, "/sessions"), 403);
    const listB = await app.request(workspacePath(b.workspaceId, "/sessions"), { headers: authB });
    expect(listB.status).toBe(200);
    expect(
      ((await listB.json()) as Array<{ id: string }>).some((item) => item.id === session.id),
    ).toBe(false);

    await expectStatus(app, authA, workspacePath(b.workspaceId, `/sessions/${session.id}`), 403);
    await expectStatus(app, authB, workspacePath(b.workspaceId, `/sessions/${session.id}`), 404);
    await expectStatus(app, authA, legacyRoute("sessions", session.id), 404);

    await createSessionGoal(dbClient.db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      sessionId: session.id,
      text: "workspace A objective",
      createdBy: "api",
    });
    await expectStatus(
      app,
      authA,
      workspacePath(a.workspaceId, `/sessions/${session.id}/goal`),
      200,
    );
    await expectStatus(
      app,
      authA,
      workspacePath(b.workspaceId, `/sessions/${session.id}/goal`),
      403,
    );
    await expectStatus(
      app,
      authB,
      workspacePath(b.workspaceId, `/sessions/${session.id}/goal`),
      404,
    );

    const fileId = crypto.randomUUID();
    await createFileUpload(dbClient.db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      fileId,
      filename: "workspace-a.txt",
      safeFilename: "workspace-a.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      bucket: "opengeni-files",
      objectKey: `workspaces/${a.workspaceId}/files/${fileId}/original/workspace-a.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expectStatus(app, authA, workspacePath(b.workspaceId, `/files/${fileId}`), 403);
    await expectStatus(app, authB, workspacePath(b.workspaceId, `/files/${fileId}`), 404);
    await expectStatus(app, authA, legacyRoute("files", fileId), 404);

    const baseResponse = await app.request(workspacePath(a.workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({ name: "Workspace A docs" }),
      headers: { ...authA, "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string };
    await expectStatus(app, authA, workspacePath(b.workspaceId, `/document-bases/${base.id}`), 403);
    await expectStatus(app, authB, workspacePath(b.workspaceId, `/document-bases/${base.id}`), 404);
    await expectStatus(app, authA, legacyRoute("document-bases", base.id), 404);

    const taskResponse = await app.request(workspacePath(a.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "Workspace A schedule",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "run", resources: [], tools: [] },
      }),
      headers: { ...authA, "content-type": "application/json" },
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as { id: string };
    await expectStatus(
      app,
      authA,
      workspacePath(b.workspaceId, `/scheduled-tasks/${task.id}`),
      403,
    );
    await expectStatus(
      app,
      authB,
      workspacePath(b.workspaceId, `/scheduled-tasks/${task.id}`),
      404,
    );
    await expectStatus(app, authA, legacyRoute("scheduled-tasks", task.id), 404);

    await expectStatus(app, authA, workspacePath(b.workspaceId, "/packs"), 403);
    await expectStatus(app, authA, workspacePath(b.workspaceId, "/capabilities"), 403);
    const connectionResponse = await app.request(
      workspacePath(a.workspaceId, "/social/connections"),
      {
        method: "POST",
        body: JSON.stringify({ provider: "linkedin", accountHandle: "isolation-a" }),
        headers: { ...authA, "content-type": "application/json" },
      },
    );
    expect(connectionResponse.status).toBe(201);
    const connection = (await connectionResponse.json()) as { id: string };
    await expectStatus(app, authA, workspacePath(b.workspaceId, "/social/connections"), 403);
    const otherWorkspaceConnections = await app.request(
      workspacePath(b.workspaceId, "/social/connections"),
      { headers: authB },
    );
    expect(otherWorkspaceConnections.status).toBe(200);
    expect(
      ((await otherWorkspaceConnections.json()) as Array<{ id: string }>).some(
        (item) => item.id === connection.id,
      ),
    ).toBe(false);

    await expectStatus(app, authA, workspacePath(b.workspaceId, "/mcp"), 403, "POST");
    await expectStatus(app, authA, workspacePath(b.workspaceId, "/github/app"), 403);
    await expectStatus(app, authB, workspacePath(b.workspaceId, "/github/app"), 200);

    const environmentResponse = await app.request(workspacePath(a.workspaceId, "/environments"), {
      method: "POST",
      body: JSON.stringify({
        name: "Workspace A environment",
        variables: [{ name: "ISOLATION_TOKEN", value: "isolation-secret-a" }],
      }),
      headers: { ...authA, "content-type": "application/json" },
    });
    expect(environmentResponse.status).toBe(201);
    const environment = (await environmentResponse.json()) as { id: string };
    await expectStatus(
      app,
      authA,
      workspacePath(b.workspaceId, `/environments/${environment.id}`),
      403,
    );
    await expectStatus(
      app,
      authB,
      workspacePath(b.workspaceId, `/environments/${environment.id}`),
      404,
    );
    const environmentsVisibleToB = await app.request(
      workspacePath(b.workspaceId, "/environments"),
      { headers: authB },
    );
    expect(environmentsVisibleToB.status).toBe(200);
    expect(
      ((await environmentsVisibleToB.json()) as Array<{ id: string }>).some(
        (item) => item.id === environment.id,
      ),
    ).toBe(false);
    // Cross-workspace attachment is indistinguishable from a missing variable set.
    // Request still uses the deprecated `environmentId` alias field on purpose (alias coverage);
    // the canonical error message names the variable set.
    const crossAttachment = await app.request(workspacePath(b.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "cross-workspace attach",
        environmentId: environment.id,
      }),
      headers: { ...authB, "content-type": "application/json" },
    });
    expect(crossAttachment.status).toBe(422);
    expect(await crossAttachment.text()).toContain("unknown variableSetId");

    const apiKeyResponse = await app.request(workspacePath(a.workspaceId, "/api-keys"), {
      method: "POST",
      body: JSON.stringify({ name: "Workspace A reader", permissions: ["sessions:read"] }),
      headers: { ...authA, "content-type": "application/json" },
    });
    expect(apiKeyResponse.status).toBe(201);
    const apiKey = (await apiKeyResponse.json()) as { token: string };
    await expectStatus(
      app,
      { authorization: `Bearer ${apiKey.token}` },
      workspacePath(a.workspaceId, `/sessions/${session.id}`),
      200,
    );
    await expectStatus(
      app,
      { authorization: `Bearer ${apiKey.token}` },
      workspacePath(b.workspaceId, `/sessions/${session.id}`),
      403,
    );
  });
});

async function workspaceGrant(
  db: ReturnType<typeof createDb>["db"],
  label: string,
): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:isolation",
    accountExternalId: `account:${label}:${id}`,
    accountName: `Isolation ${label}`,
    workspaceExternalSource: "test:isolation",
    workspaceExternalId: `workspace:${label}:${id}`,
    workspaceName: `Isolation ${label}`,
    subjectId: `test:isolation:${label}:${id}`,
    subjectLabel: `Isolation ${label}`,
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("Isolation setup did not create a workspace grant");
  }
  return grant;
}

async function authHeader(
  grant: AccessGrant,
  permissions: Permission[] = allWorkspacePermissions,
): Promise<{ authorization: string }> {
  const token = await signDelegatedAccessToken(delegationSecret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  return { authorization: `Bearer ${token}` };
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}

function legacyRoute(...segments: string[]): string {
  return ["", "v1", ...segments].join("/");
}

async function expectStatus(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  path: string,
  expected: number,
  method = "GET",
): Promise<void> {
  const response = await app.request(path, { method, headers });
  expect(response.status).toBe(expected);
}

class FakeWorkflowClient implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}
