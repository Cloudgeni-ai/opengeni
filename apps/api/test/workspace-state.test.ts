import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  signDelegatedAccessToken,
  WorkspaceStateExportResponse,
  WorkspaceStateResponse,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  saveKnowledgeEntry,
  type KnowledgeContext,
  deleteWorkspace,
  updateWorkspace,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import { registerWorkspaceStateRoutes } from "../src/routes/workspace-state";

const DELEGATION_SIGNING_FIXTURE = ["workspace", "state", "test", "signing", "fixture"].join("-");

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let grant: Grant;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_STATE_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_STATE_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const explicitAppPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword: explicitAppPassword });
    const admin = postgres(explicitAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    const acquired = await acquireSharedTestDatabase("workspace-state");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
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

async function request(
  permissions: Permission[],
  attemptId?: string,
  mode: "state" | "export" = "state",
): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SIGNING_FIXTURE, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "service",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const headers = new Headers();
  headers.set("authorization", ["Bearer", bearer].join(" "));
  const query = attemptId ? `?attemptId=${encodeURIComponent(attemptId)}` : "";
  const suffix = mode === "export" ? "/export" : "";
  return await app.request(
    `http://x/v1/workspaces/${grant.workspaceId}/workspace-state${suffix}${query}`,
    { headers },
  );
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
    expect(body.preferences).toMatchObject({
      authority: "preference_registry_preferences",
      activeDescriptorCount: 0,
      scopeCounts: { organization: 0, workspace: 0, user: 0 },
      truncated: false,
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE LEGACY WORKSPACE INSTRUCTIONS");
  });

  test("filters knowledge before producing the canonical sanitized export", async () => {
    const response = await request(["workspace:read"], undefined, "export");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("sanitized.json");
    const serialized = await response.text();
    const exported = WorkspaceStateExportResponse.parse(JSON.parse(serialized));
    expect(exported.state.knowledge).toEqual({
      availability: "unavailable",
      reason: "missing_permission",
      requiredPermission: "documents:search",
    });
    expect(exported.omissions).toContain("secret_values_and_credentials");
    expect(exported.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).not.toContain("PRIVATE LEGACY WORKSPACE INSTRUCTIONS");
  });

  test("returns an empty visible inventory only with document search permission", async () => {
    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge.availability).toBe("available");
    if (body.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(body.knowledge).toMatchObject({
      authority: "knowledge_entries",
      coverage: "complete",
      entries: [],
      sampleLimit: 50,
    });
  });

  test("does not disclose whether an unavailable attempt exists", async () => {
    const response = await request(["workspace:read"], crypto.randomUUID());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.truth.attemptGovernance).toEqual({
      status: "unavailable",
      reason: "attempt_not_found_or_not_authorized",
      driftStatus: "unavailable",
    });
    expect(JSON.stringify(body.truth.attemptGovernance)).not.toContain("sessionId");
    expect(JSON.stringify(body.truth.attemptGovernance)).not.toContain("turnId");
  });

  test("publishes canonical metadata, excluding personal records and exact content", async () => {
    const human: KnowledgeContext = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: grant.subjectId,
        writeScopes: ["workspace", "personal"],
        review: true,
        settingsScopes: ["workspace", "personal"],
      },
    };
    const save = async (scope: "workspace" | "personal", title: string) =>
      saveKnowledgeEntry(client.db, human, {
        operationId: crypto.randomUUID(),
        entryId: crypto.randomUUID(),
        expectedVersion: 0,
        scope,
        entry: {
          kind: "fact",
          title,
          content: "Exact content must not be included in an inventory",
        },
      });
    const visible = await save("workspace", "ACME renewal");
    await save("personal", "Owner-only customer detail");
    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge).toMatchObject({
      availability: "available",
      authority: "knowledge_entries",
      coverage: "complete",
      entries: [{ id: visible.entryId, title: "ACME renewal", kind: "fact", scope: "workspace" }],
    });
    expect(JSON.stringify(body)).not.toContain("Owner-only customer detail");
    expect(JSON.stringify(body)).not.toContain("Exact content");
    const exported = WorkspaceStateExportResponse.parse(
      await (await request(["workspace:read", "documents:search"], undefined, "export")).json(),
    );
    expect(exported.state.knowledge).toEqual(body.knowledge);
  });
});
