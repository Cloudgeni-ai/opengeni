import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  signDelegatedAccessToken,
  WorkspaceStateResponse,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  updateWorkspace,
  type DbClient,
} from "@opengeni/db";
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
});
