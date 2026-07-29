import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  signDelegatedAccessToken,
  WORKSPACE_STATE_MAX_BASES,
  WorkspaceStateResponse,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  deleteWorkspace,
  updateWorkspace,
  type DbClient,
} from "@opengeni/db";
import { addDocumentToBase, createDocumentBase, listDocumentBases } from "@opengeni/documents";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";

import { registerWorkspaceStateRoutes } from "../src/routes/workspace-state";

const DELEGATION_SIGNING_FIXTURE = ["workspace", "state", "test", "signing", "fixture"].join("-");

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let grant: Grant;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-state");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `workspace-state-account-${crypto.randomUUID()}`,
    accountName: "Workspace State account",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-state-workspace-${crypto.randomUUID()}`,
    workspaceName: "Workspace State workspace",
    subjectId: "user:workspace-state-reader",
  });
  grant = access.workspaceGrants[0]!;
  await updateWorkspace(client.db, grant.workspaceId, {
    agentInstructions: "PRIVATE LEGACY WORKSPACE INSTRUCTIONS",
  });
  app = new Hono();
  registerWorkspaceStateRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SIGNING_FIXTURE,
    }),
    db: client.db,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && grant) await deleteWorkspace(client.db, grant.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(permissions: Permission[]): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SIGNING_FIXTURE, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const headers = new Headers();
  headers.set("authorization", ["Bearer", bearer].join(" "));
  return await app.request(`http://x/v1/workspaces/${grant.workspaceId}/workspace-state`, {
    headers,
  });
}

async function readyFile(name: string): Promise<string> {
  const fileId = crypto.randomUUID();
  const upload = await createFileUpload(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    fileId,
    filename: `${name}.txt`,
    safeFilename: `${name}.txt`,
    contentType: "text/plain",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    bucket: "workspace-state-test",
    objectKey: `workspace-state/${fileId}.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await completeFileUpload(client.db, grant.workspaceId, upload.uploadId);
  return fileId;
}

describe("workspace state API authorization", () => {
  test("requires workspace read and withholds all knowledge facts without document search", async () => {
    const denied = await request(["documents:search"]);
    expect(denied.status).toBe(403);

    const metadataOnly = await request(["workspace:read"]);
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.headers.get("cache-control")).toBe("private, no-store");
    const body = WorkspaceStateResponse.parse(await metadataOnly.json());
    expect(body.knowledge).toEqual({
      availability: "unavailable",
      reason: "missing_permission",
      requiredPermission: "documents:search",
    });
    expect(body.policy.legacyRuntime).toEqual({
      source: "workspace_override",
      workspaceOverrideConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE LEGACY WORKSPACE INSTRUCTIONS");
  });

  test("returns an empty visible inventory only with document search permission", async () => {
    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge.availability).toBe("available");
    if (body.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(body.knowledge).toMatchObject({
      baseCount: 0,
      inspectedVisibleDocumentCount: 0,
      gaps: [
        { code: "no_document_bases", relatedCount: 0 },
        { code: "no_memory_records", relatedCount: 0 },
      ],
    });
  });

  test("bounds base rows while aggregating all and only subject-visible documents", async () => {
    for (let index = 0; index < WORKSPACE_STATE_MAX_BASES + 1; index += 1) {
      await createDocumentBase(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        name: `Inventory base ${String(index).padStart(2, "0")}`,
      });
    }
    const targetBase = (await listDocumentBases(client.db, grant.workspaceId))[0]!;
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("workspace-visible"),
      title: "workspace visible",
      sourceKind: "repository",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("owner-private"),
      title: "owner private",
      sourceKind: "email",
      visibility: "private",
      createdBy: grant.subjectId,
    });
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("other-private"),
      title: "other private",
      sourceKind: "chat",
      visibility: "private",
      createdBy: "user:another-subject",
    });

    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge.availability).toBe("available");
    if (body.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(body.knowledge).toMatchObject({
      coverage: "partial",
      baseCount: WORKSPACE_STATE_MAX_BASES + 1,
      basesTruncated: true,
      inspectedVisibleDocumentCount: 2,
      documentStatusCounts: { queued: 2, indexing: 0, ready: 0, failed: 0 },
      sourceKindCounts: { repository: 1, email: 1, chat: 0 },
    });
    expect(body.knowledge.bases).toHaveLength(WORKSPACE_STATE_MAX_BASES);
    expect(body.knowledge.bases.find((base) => base.id === targetBase.id)).toMatchObject({
      visibleDocumentCount: 2,
      statusCounts: { queued: 2, indexing: 0, ready: 0, failed: 0 },
    });
    expect(body.knowledge.gaps).toContainEqual({
      code: "processing_documents",
      severity: "info",
      relatedCount: 2,
    });
    expect(body.knowledge.gaps).toContainEqual({
      code: "partial_inventory",
      severity: "info",
      relatedCount: null,
    });
  });
});
