import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createFileUpload, createSession } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { assertFileResourcesRemainAuthorized } from "../src/activities/agent-turn/file-resources";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("file-resource-host-access");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("a host revocation blocks an already selected File before worker materialization", async () => {
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "File host access",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "File host access",
    subjectId,
  });
  const membership = access.workspaceGrants[0]!;
  const accountId = membership.accountId;
  const workspaceId = membership.workspaceId!;
  const source = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Example",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const fileId = crypto.randomUUID();
  await createFileUpload(client.db, {
    accountId,
    workspaceId,
    fileId,
    sourceSessionId: source.id,
    filename: "example.txt",
    safeFilename: "example.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    bucket: "fixture",
    objectKey: `workspaces/${workspaceId}/files/${fileId}/original/example.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready' where id = ${fileId}`;
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["files:read"],
  };
  let allowed = true;
  const port = {
    authorizeSession: async () =>
      allowed ? ({ allowed: true } as const) : ({ allowed: false, reason: "revoked" } as const),
    resolveListScope: async () => ({ kind: "all" as const }),
  };
  const check = () =>
    assertFileResourcesRemainAuthorized(
      client.db,
      accountId,
      workspaceId,
      subjectId,
      [{ kind: "file" as const, fileId }],
      { grant, port },
    );
  await expect(check()).resolves.toBeUndefined();
  allowed = false;
  await expect(check()).rejects.toThrow("no longer authorized");
}, 180_000);
