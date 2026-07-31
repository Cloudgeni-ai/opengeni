import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency } from "@opengeni/core";
import { bootstrapWorkspace, createDb, deleteWorkspace, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";

import { registerWorkspaceArtifactRoutes } from "../src/routes/workspace-artifacts";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const SIGNING_SECRET = "workspace-artifacts-test-signing-secret";
type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let grant: Grant;
let otherGrant: Grant;
let objectStorage: ObjectStorageDependency;
const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-artifacts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "artifact-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Artifact test",
    workspaceExternalSource: "artifact-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Artifact test",
    subjectId: `subject-${suffix}`,
  });
  grant = access.workspaceGrants[0]!;
  const other = await bootstrapWorkspace(client.db, {
    accountExternalSource: "artifact-test",
    accountExternalId: `other-account-${suffix}`,
    accountName: "Other artifact test",
    workspaceExternalSource: "artifact-test",
    workspaceExternalId: `other-workspace-${suffix}`,
    workspaceName: "Other artifact test",
    subjectId: `other-subject-${suffix}`,
  });
  otherGrant = other.workspaceGrants[0]!;
  objectStorage = {
    putObject: async ({
      key,
      body,
      contentType,
    }: {
      key: string;
      body: Uint8Array;
      contentType: string;
    }) => {
      objects.set(key, { bytes: body.slice(), contentType });
    },
    getObjectBytes: async (key: string) => objects.get(key) ?? null,
  } as unknown as ObjectStorageDependency;
  app = new Hono();
  registerWorkspaceArtifactRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SIGNING_SECRET,
    }),
    db: client.db,
    objectStorage,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && grant) await deleteWorkspace(client.db, grant.workspaceId);
  if (client && otherGrant) await deleteWorkspace(client.db, otherGrant.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(
  targetGrant: Grant,
  permissions: Permission[],
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const bearer = await signDelegatedAccessToken(SIGNING_SECRET, {
    accountId: targetGrant.accountId,
    workspaceId: targetGrant.workspaceId,
    subjectId: targetGrant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return await app.request(`http://x${path}`, { ...init, headers });
}

describe("workspace artifact API and PostgreSQL authority", () => {
  test("publishes, versions concurrently, rolls back, replays, and isolates content", async () => {
    const base = `/v1/workspaces/${grant.workspaceId}/published-artifacts`;
    expect((await request(grant, ["workspace:read"], base)).status).toBe(403);

    const createBody = {
      title: "Status board",
      description: "A generic live board",
      html: "<!doctype html><h1>Version one</h1>",
      idempotencyKey: "create-status-board",
    };
    const createdResponse = await request(grant, ["artifacts:publish"], base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(createdResponse.status).toBe(201);
    const created = WorkspaceArtifactMutationResponse.parse(await createdResponse.json());
    expect(created.replayed).toBe(false);
    expect(created.artifact).not.toHaveProperty("kind");
    expect(created.artifact.currentVersion?.revision).toBe(1);

    const replayResponse = await request(grant, ["artifacts:publish"], base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    const replay = WorkspaceArtifactMutationResponse.parse(await replayResponse.json());
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(created.artifact.id);

    const concurrentCreate = await Promise.all([
      request(grant, ["artifacts:publish"], base, {
        method: "POST",
        body: JSON.stringify({
          ...createBody,
          idempotencyKey: "concurrent-create",
        }),
      }),
      request(grant, ["artifacts:publish"], base, {
        method: "POST",
        body: JSON.stringify({
          ...createBody,
          idempotencyKey: "concurrent-create",
        }),
      }),
    ]);
    expect(concurrentCreate.map((response) => response.status)).toEqual([201, 201]);
    const concurrentCreates = await Promise.all(
      concurrentCreate.map(async (response) =>
        WorkspaceArtifactMutationResponse.parse(await response.json()),
      ),
    );
    expect(new Set(concurrentCreates.map((result) => result.artifact.id)).size).toBe(1);
    expect(concurrentCreates.filter((result) => result.replayed)).toHaveLength(1);

    const listed = WorkspaceArtifactListResponse.parse(
      await (await request(grant, ["artifacts:read"], base)).json(),
    );
    expect(listed.artifacts.map((artifact) => artifact.id)).toContain(created.artifact.id);

    const contentPath = `${base}/${created.artifact.id}/content`;
    const firstContent = WorkspaceArtifactContentResponse.parse(
      await (await request(grant, ["artifacts:read"], contentPath)).json(),
    );
    expect(firstContent.html).toBe(createBody.html);

    const versionPath = `${base}/${created.artifact.id}/versions`;
    const publish = (html: string, key: string) =>
      request(grant, ["artifacts:publish"], versionPath, {
        method: "POST",
        body: JSON.stringify({
          html,
          expectedCurrentVersionId: created.version.id,
          idempotencyKey: key,
        }),
      });
    const concurrent = await Promise.all([
      publish("<!doctype html><h1>Version two A</h1>", "publish-a"),
      publish("<!doctype html><h1>Version two B</h1>", "publish-b"),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerResponse = concurrent.find((response) => response.status === 200)!;
    const winner = WorkspaceArtifactMutationResponse.parse(await winnerResponse.json());
    expect(winner.version.revision).toBe(2);

    const reusedPublishKey = await request(grant, ["artifacts:publish"], versionPath, {
      method: "POST",
      body: JSON.stringify({
        html: createBody.html,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: "create-status-board",
      }),
    });
    expect(reusedPublishKey.status).toBe(409);

    const rollbackResponse = await request(
      grant,
      ["artifacts:publish"],
      `${base}/${created.artifact.id}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({
          versionId: created.version.id,
          expectedCurrentVersionId: winner.version.id,
          reason: "Verify immutable restoration",
          idempotencyKey: "rollback-one",
        }),
      },
    );
    expect(rollbackResponse.status).toBe(200);
    const rolledBack = WorkspaceArtifactMutationResponse.parse(await rollbackResponse.json());
    expect(rolledBack.artifact.currentVersion?.id).toBe(created.version.id);

    const detail = WorkspaceArtifactDetailResponse.parse(
      await (await request(grant, ["artifacts:read"], `${base}/${created.artifact.id}`)).json(),
    );
    expect(detail.versions).toHaveLength(2);
    expect(detail.events).toHaveLength(3);

    const isolated = await request(
      otherGrant,
      ["artifacts:read"],
      `/v1/workspaces/${otherGrant.workspaceId}/published-artifacts/${created.artifact.id}`,
    );
    expect(isolated.status).toBe(404);

    let immutableError: unknown;
    try {
      await shared.admin`UPDATE workspace_artifact_versions SET revision = 99 WHERE id = ${created.version.id}`;
    } catch (error) {
      immutableError = error;
    }
    expect(immutableError).toBeInstanceOf(Error);
    expect(String(immutableError)).toContain("workspace artifact history is immutable");
  }, 60_000);

  test("exposes exact agent create and source tools through the first-party MCP surface", async () => {
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const server = buildOpenGeniMcpServer(
      {
        settings: testSettings(),
        db: client.db,
        objectStorage,
        bus: new MemoryEventBus(),
      } as ApiRouteDeps,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        permissions: ["artifacts:read", "artifacts:publish"],
        principalKind: "agent_attempt",
        metadata: {
          sessionId,
          turnId,
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
          firstPartyMcpTools: ["artifacts_create", "artifacts_get_source"],
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "workspace-artifact-test", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      expect((await mcp.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "artifacts_create",
        "artifacts_get_source",
      ]);
      const createdResult = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Agent-created map",
          html: "<!doctype html><main>Created through MCP</main>",
          idempotencyKey: "agent-create-map",
        },
      });
      const createdText = createdResult.content.find((item) => item.type === "text");
      if (!createdText || createdText.type !== "text") throw new Error("missing MCP text result");
      const created = WorkspaceArtifactMutationResponse.parse(JSON.parse(createdText.text));
      expect(created.version.sourceSessionId).toBe(sessionId);
      expect(created.version.sourceTurnId).toBe(turnId);

      const sourceResult = await mcp.callTool({
        name: "artifacts_get_source",
        arguments: { artifactId: created.artifact.id },
      });
      const sourceText = sourceResult.content.find((item) => item.type === "text");
      if (!sourceText || sourceText.type !== "text") throw new Error("missing MCP source result");
      expect(JSON.parse(sourceText.text).html).toContain("Created through MCP");
    } finally {
      await Promise.all([mcp.close(), server.close()]);
    }
  }, 60_000);
});
