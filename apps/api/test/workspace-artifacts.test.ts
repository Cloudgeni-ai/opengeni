import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  normalizeWorkspaceArtifactSlug,
  signDelegatedAccessToken,
  type AttemptToolCatalog,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import { digestAttemptToolCatalog } from "@opengeni/codemode";
import type { ApiRouteDeps, ObjectStorageDependency } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  createWorkspaceArtifact,
  deleteWorkspace,
  persistAttemptToolCatalog,
  publishWorkspaceArtifactVersion,
  type DbClient,
} from "@opengeni/db";
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
let objectPutCount = 0;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-artifacts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:local",
    accountExternalId: "default",
    accountName: "Local",
    workspaceExternalSource: "opengeni:local",
    workspaceExternalId: "default",
    workspaceName: "Local",
    subjectId: "dev",
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
      objectPutCount += 1;
      objects.set(key, { bytes: body.slice(), contentType });
    },
    getObjectBytes: async (key: string) => objects.get(key) ?? null,
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as ObjectStorageDependency;
  app = new Hono();
  registerWorkspaceArtifactRoutes(app, {
    settings: testSettings({
      productAccessMode: "local",
      delegationSecret: SIGNING_SECRET,
      mcpServers: [{ id: "docs", url: "https://docs.example.test/mcp", cacheToolsList: true }],
    }),
    db: client.db,
    objectStorage,
    getDocumentServices: () => ({}) as never,
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

async function requestAsCanonicalLocalHuman(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  return await app.request(`http://x${path}`, { ...init, headers });
}

function rejectFirstCommittedTransaction(db: DbClient["db"]): DbClient["db"] {
  const transaction = db.transaction.bind(db);
  let reject = true;
  return new Proxy(db, {
    get(targetDb, property, receiver) {
      if (property === "transaction") {
        return async (...args: Parameters<typeof transaction>) => {
          const result = await transaction(...args);
          if (reject) {
            reject = false;
            throw new Error("simulated lost transaction commit response");
          }
          return result;
        };
      }
      const value = Reflect.get(targetDb, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(targetDb) : value;
    },
  });
}

describe("workspace artifact API and PostgreSQL authority", () => {
  test("reconciles ambiguously committed create and publish before deleting content", async () => {
    const suffix = crypto.randomUUID();
    const retainedObjects = new Set<string>();
    const discardedObjects: string[] = [];
    const createContentKey = `workspace-artifacts/${grant.workspaceId}/${suffix}/create.html`;
    const createSourceKey = `workspace-artifacts/${grant.workspaceId}/${suffix}/create-source.json`;
    const persistCreateContent = async () => {
      retainedObjects.add(createContentKey);
      retainedObjects.add(createSourceKey);
    };
    const discardCreateContent = async () => {
      discardedObjects.push(createContentKey, createSourceKey);
      retainedObjects.delete(createContentKey);
      retainedObjects.delete(createSourceKey);
    };

    const created = await createWorkspaceArtifact(rejectFirstCommittedTransaction(client.db), {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: crypto.randomUUID(),
      slug: `ambiguous-create-${suffix}`,
      title: "Ambiguously committed Site",
      description: null,
      contentKey: createContentKey,
      contentSha256: "1".repeat(64),
      sizeBytes: 128,
      sourceKey: createSourceKey,
      sourceSha256: "2".repeat(64),
      sourceSizeBytes: 64,
      requestedTools: [],
      operationKey: `ambiguous-create-${suffix}`,
      actorSubjectId: grant.subjectId,
      sourceSessionId: null,
      sourceTurnId: null,
      sourceAttemptId: null,
      sourceExecutionGeneration: null,
      sourceToolName: null,
      persistContent: persistCreateContent,
      discardContent: discardCreateContent,
    });

    expect(created.replayed).toBe(true);
    expect(created.version.revision).toBe(1);
    expect(created.artifact.currentVersion?.id).toBe(created.version.id);
    expect(retainedObjects).toEqual(new Set([createContentKey, createSourceKey]));
    expect(discardedObjects).toEqual([]);

    const publishContentKey = `workspace-artifacts/${grant.workspaceId}/${suffix}/publish.html`;
    const publishSourceKey = `workspace-artifacts/${grant.workspaceId}/${suffix}/publish-source.json`;
    const persistPublishContent = async () => {
      retainedObjects.add(publishContentKey);
      retainedObjects.add(publishSourceKey);
    };
    const discardPublishContent = async () => {
      discardedObjects.push(publishContentKey, publishSourceKey);
      retainedObjects.delete(publishContentKey);
      retainedObjects.delete(publishSourceKey);
    };

    const published = await publishWorkspaceArtifactVersion(
      rejectFirstCommittedTransaction(client.db),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        artifactId: created.artifact.id,
        expectedCurrentVersionId: created.version.id,
        contentKey: publishContentKey,
        contentSha256: "3".repeat(64),
        sizeBytes: 256,
        sourceKey: publishSourceKey,
        sourceSha256: "4".repeat(64),
        sourceSizeBytes: 96,
        requestedTools: [],
        operationKey: `ambiguous-publish-${suffix}`,
        actorSubjectId: grant.subjectId,
        sourceSessionId: null,
        sourceTurnId: null,
        sourceAttemptId: null,
        sourceExecutionGeneration: null,
        sourceToolName: null,
        persistContent: persistPublishContent,
        discardContent: discardPublishContent,
      },
    );

    expect(published.replayed).toBe(true);
    expect(published.version.revision).toBe(2);
    expect(published.artifact.currentVersion?.id).toBe(published.version.id);
    expect(retainedObjects).toEqual(
      new Set([createContentKey, createSourceKey, publishContentKey, publishSourceKey]),
    );
    expect(discardedObjects).toEqual([]);
  }, 60_000);

  test("publishes, versions concurrently, rolls back, replays, and isolates content", async () => {
    const base = `/v1/workspaces/${grant.workspaceId}/published-artifacts`;
    const publishPermissions: Permission[] = ["artifacts:publish", "documents:search"];
    expect((await request(grant, ["workspace:read"], base)).status).toBe(403);

    const createBody = {
      title: "Status board",
      description: "A generic live board",
      html: "<!doctype html><h1>Version one</h1>",
      source: {
        entrypoint: "src/index.tsx",
        files: [{ path: "src/index.tsx", content: "export const version = 1;" }],
      },
      requestedTools: [{ serverId: "docs", toolName: "search_documents" }],
      idempotencyKey: "create-status-board",
    };
    const putsBeforeDeniedPublisher = objectPutCount;
    const deniedPublisherResponse = await request(grant, publishPermissions, base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(deniedPublisherResponse.status).toBe(403);
    expect(objectPutCount).toBe(putsBeforeDeniedPublisher);
    const createdResponse = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(createdResponse.status).toBe(201);
    const created = WorkspaceArtifactMutationResponse.parse(await createdResponse.json());
    expect(created.replayed).toBe(false);
    expect(created.artifact).not.toHaveProperty("kind");
    expect(created.artifact.currentVersion?.revision).toBe(1);
    expect(created.version.requestedTools).toEqual(createBody.requestedTools);
    expect(created.version.sourceSha256).toHaveLength(64);
    const putsAfterCreate = objectPutCount;

    const replayResponse = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    const replay = WorkspaceArtifactMutationResponse.parse(await replayResponse.json());
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(created.artifact.id);
    expect(objectPutCount).toBe(putsAfterCreate);

    const changedCreateMetadata = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify({ ...createBody, title: "Changed status board" }),
    });
    expect(changedCreateMetadata.status).toBe(409);

    const createWithoutRequestedTools = { ...createBody, requestedTools: undefined };
    const createAuthorityConflict = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify(createWithoutRequestedTools),
    });
    expect(createAuthorityConflict.status).toBe(409);

    const authoritySeedResponse = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify({
        ...createBody,
        slug: "requested-tools-replay-authority",
        idempotencyKey: "requested-tools-replay-authority-create",
      }),
    });
    expect(authoritySeedResponse.status).toBe(201);
    const authoritySeed = WorkspaceArtifactMutationResponse.parse(
      await authoritySeedResponse.json(),
    );
    const authorityVersionPath = `${base}/${authoritySeed.artifact.id}/versions`;
    const authorityPublishBody = {
      html: "<!doctype html><h1>Explicit authority</h1>",
      expectedCurrentVersionId: authoritySeed.version.id,
      requestedTools: [{ serverId: "docs", toolName: "knowledge_search" }],
      idempotencyKey: "requested-tools-replay-authority-publish",
    };
    const authorityPublishResponse = await requestAsCanonicalLocalHuman(authorityVersionPath, {
      method: "POST",
      body: JSON.stringify(authorityPublishBody),
    });
    expect(authorityPublishResponse.status).toBe(200);
    const changedPublishMetadata = await requestAsCanonicalLocalHuman(authorityVersionPath, {
      method: "POST",
      body: JSON.stringify({ ...authorityPublishBody, title: "Changed publication title" }),
    });
    expect(changedPublishMetadata.status).toBe(409);
    const publishWithoutRequestedTools = {
      ...authorityPublishBody,
      requestedTools: undefined,
    };
    const publishAuthorityConflict = await requestAsCanonicalLocalHuman(authorityVersionPath, {
      method: "POST",
      body: JSON.stringify(publishWithoutRequestedTools),
    });
    expect(publishAuthorityConflict.status).toBe(409);

    const conflictSeed = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify({
        ...createBody,
        slug: "publication-cleanup",
        idempotencyKey: "publication-cleanup-seed",
      }),
    });
    expect(conflictSeed.status).toBe(201);
    const keysBeforeConflict = [...objects.keys()].sort();
    const conflict = await requestAsCanonicalLocalHuman(base, {
      method: "POST",
      body: JSON.stringify({
        ...createBody,
        slug: "publication-cleanup",
        html: "<!doctype html><h1>Should be discarded</h1>",
        idempotencyKey: "publication-cleanup-conflict",
      }),
    });
    expect(conflict.status).toBe(409);
    expect([...objects.keys()].sort()).toEqual(keysBeforeConflict);

    const concurrentCreate = await Promise.all([
      requestAsCanonicalLocalHuman(base, {
        method: "POST",
        body: JSON.stringify({
          ...createBody,
          idempotencyKey: "concurrent-create",
        }),
      }),
      requestAsCanonicalLocalHuman(base, {
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
    expect(listed.truncated).toBe(false);
    expect(listed.nextCursor).toBeNull();

    const firstPage = WorkspaceArtifactListResponse.parse(
      await (await request(grant, ["artifacts:read"], `${base}?limit=1`)).json(),
    );
    expect(firstPage.artifacts).toHaveLength(1);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = WorkspaceArtifactListResponse.parse(
      await (
        await request(
          grant,
          ["artifacts:read"],
          `${base}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        )
      ).json(),
    );
    expect(secondPage.artifacts).toHaveLength(1);
    expect(secondPage.artifacts[0]!.id).not.toBe(firstPage.artifacts[0]!.id);
    expect((await request(grant, ["artifacts:read"], `${base}?cursor=invalid`)).status).toBe(422);

    const contentPath = `${base}/${created.artifact.id}/content`;
    const firstContent = WorkspaceArtifactContentResponse.parse(
      await (await request(grant, ["artifacts:read"], contentPath)).json(),
    );
    expect(firstContent.html).toBe(createBody.html);
    expect(firstContent.source).toEqual(createBody.source);
    expect(firstContent.requestedTools).toEqual(createBody.requestedTools);

    const versionPath = `${base}/${created.artifact.id}/versions`;
    const publish = (html: string, key: string) =>
      requestAsCanonicalLocalHuman(versionPath, {
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
    expect(winner.version.requestedTools).toEqual(createBody.requestedTools);

    const putsBeforeStalePublish = objectPutCount;
    const stalePublish = await publish(
      "<!doctype html><h1>Must not be stored</h1>",
      "stale-publish",
    );
    expect(stalePublish.status).toBe(409);
    expect(objectPutCount).toBe(putsBeforeStalePublish);

    const reusedPublishKey = await requestAsCanonicalLocalHuman(versionPath, {
      method: "POST",
      body: JSON.stringify({
        html: createBody.html,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: "create-status-board",
      }),
    });
    expect(reusedPublishKey.status).toBe(409);

    const rollbackResponse = await requestAsCanonicalLocalHuman(
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

    const archivedResponse = await requestAsCanonicalLocalHuman(
      `${base}/${created.artifact.id}/status`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "archived",
          expectedCurrentVersionId: created.version.id,
          reason: "Temporarily unpublish the Site",
          idempotencyKey: "archive-site",
        }),
      },
    );
    expect(archivedResponse.status).toBe(200);
    const archived = WorkspaceArtifactMutationResponse.parse(await archivedResponse.json());
    expect(archived.artifact.status).toBe("archived");
    expect(archived.event.type).toBe("archived");
    expect(archived.replayed).toBe(false);
    const archiveReplay = WorkspaceArtifactMutationResponse.parse(
      await (
        await requestAsCanonicalLocalHuman(`${base}/${created.artifact.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "archived",
            expectedCurrentVersionId: created.version.id,
            reason: "Temporarily unpublish the Site",
            idempotencyKey: "archive-site",
          }),
        })
      ).json(),
    );
    expect(archiveReplay.replayed).toBe(true);
    const putsBeforeArchivedPublish = objectPutCount;
    const archivedPublish = await requestAsCanonicalLocalHuman(versionPath, {
      method: "POST",
      body: JSON.stringify({
        html: "<!doctype html><h1>Archived write</h1>",
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: "archived-publish",
      }),
    });
    expect(archivedPublish.status).toBe(422);
    expect(objectPutCount).toBe(putsBeforeArchivedPublish);
    const restoredResponse = await requestAsCanonicalLocalHuman(
      `${base}/${created.artifact.id}/status`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "active",
          expectedCurrentVersionId: created.version.id,
          reason: "Restore the Site",
          idempotencyKey: "restore-site",
        }),
      },
    );
    expect(restoredResponse.status).toBe(200);
    const restored = WorkspaceArtifactMutationResponse.parse(await restoredResponse.json());
    expect(restored.artifact.status).toBe("active");
    expect(restored.event.type).toBe("restored");

    const detail = WorkspaceArtifactDetailResponse.parse(
      await (await request(grant, ["artifacts:read"], `${base}/${created.artifact.id}`)).json(),
    );
    expect(detail.versions).toHaveLength(2);
    expect(detail.events).toHaveLength(5);
    expect(detail.versionsTruncated).toBe(false);
    expect(detail.eventsTruncated).toBe(false);

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

  test("carries exact attempt provenance through create, publish, rollback, and replay", async () => {
    const attempt = await seedAttempt(grant);
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
        subjectId: "worker:first-party-mcp",
        permissions: ["artifacts:read", "artifacts:publish"],
        principalKind: "agent_attempt",
        metadata: {
          sessionId: attempt.sessionId,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
          firstPartyMcpTools: [
            "artifacts_create",
            "artifacts_get_source",
            "artifacts_publish",
            "artifacts_rollback",
            "artifacts_archive",
            "artifacts_restore",
          ],
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "workspace-artifact-test", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    try {
      expect((await mcp.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "artifacts_archive",
        "artifacts_create",
        "artifacts_get_source",
        "artifacts_publish",
        "artifacts_restore",
        "artifacts_rollback",
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
      if (createdResult.isError) throw new Error(createdText.text);
      const created = WorkspaceArtifactMutationResponse.parse(JSON.parse(createdText.text));
      expect(created.version.sourceSessionId).toBe(attempt.sessionId);
      expect(created.version.sourceTurnId).toBe(attempt.turnId);
      expect(created.version.sourceAttemptId).toBe(attempt.attemptId);
      expect(created.version.sourceExecutionGeneration).toBe(attempt.executionGeneration);

      const putsAfterCreate = objectPutCount;
      const replayResult = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Agent-created map",
          html: "<!doctype html><main>Created through MCP</main>",
          idempotencyKey: "agent-create-map",
        },
      });
      const replayText = replayResult.content.find((item) => item.type === "text");
      if (!replayText || replayText.type !== "text") throw new Error("missing MCP replay result");
      const replayed = WorkspaceArtifactMutationResponse.parse(JSON.parse(replayText.text));
      expect(replayed.replayed).toBe(true);
      expect(replayed.artifact.id).toBe(created.artifact.id);
      expect(objectPutCount).toBe(putsAfterCreate);

      const sourceResult = await mcp.callTool({
        name: "artifacts_get_source",
        arguments: { artifactId: created.artifact.id },
      });
      const sourceText = sourceResult.content.find((item) => item.type === "text");
      if (!sourceText || sourceText.type !== "text") throw new Error("missing MCP source result");
      expect(JSON.parse(sourceText.text).html).toContain("Created through MCP");
      expect(JSON.parse(sourceText.text).source).toEqual({
        entrypoint: "index.html",
        files: [{ path: "index.html", content: "<!doctype html><main>Created through MCP</main>" }],
      });

      const publishedResult = await mcp.callTool({
        name: "artifacts_publish",
        arguments: {
          artifactId: created.artifact.id,
          expectedCurrentVersionId: created.version.id,
          html: "<!doctype html><main>Published through MCP</main>",
          idempotencyKey: "agent-publish-map",
        },
      });
      const publishedText = publishedResult.content.find((item) => item.type === "text");
      if (!publishedText || publishedText.type !== "text")
        throw new Error("missing MCP publish result");
      const published = WorkspaceArtifactMutationResponse.parse(JSON.parse(publishedText.text));
      expect(published.version.sourceAttemptId).toBe(attempt.attemptId);
      expect(published.version.sourceExecutionGeneration).toBe(attempt.executionGeneration);

      const rollbackResult = await mcp.callTool({
        name: "artifacts_rollback",
        arguments: {
          artifactId: created.artifact.id,
          versionId: created.version.id,
          expectedCurrentVersionId: published.version.id,
          reason: "Exact attempt rollback",
          idempotencyKey: "agent-rollback-map",
        },
      });
      const rollbackText = rollbackResult.content.find((item) => item.type === "text");
      if (!rollbackText || rollbackText.type !== "text")
        throw new Error("missing MCP rollback result");
      const rolledBack = WorkspaceArtifactMutationResponse.parse(JSON.parse(rollbackText.text));
      expect(rolledBack.event.sourceAttemptId).toBe(attempt.attemptId);
      expect(rolledBack.event.sourceExecutionGeneration).toBe(attempt.executionGeneration);

      const archiveResult = await mcp.callTool({
        name: "artifacts_archive",
        arguments: {
          artifactId: created.artifact.id,
          expectedCurrentVersionId: created.version.id,
          reason: "Exact attempt archive",
          idempotencyKey: "agent-archive-map",
        },
      });
      const archiveText = archiveResult.content.find((item) => item.type === "text");
      if (!archiveText || archiveText.type !== "text")
        throw new Error("missing MCP archive result");
      const archived = WorkspaceArtifactMutationResponse.parse(JSON.parse(archiveText.text));
      expect(archived.artifact.status).toBe("archived");
      expect(archived.event.sourceAttemptId).toBe(attempt.attemptId);

      const restoreResult = await mcp.callTool({
        name: "artifacts_restore",
        arguments: {
          artifactId: created.artifact.id,
          expectedCurrentVersionId: created.version.id,
          reason: "Exact attempt restore",
          idempotencyKey: "agent-restore-map",
        },
      });
      const restoreText = restoreResult.content.find((item) => item.type === "text");
      if (!restoreText || restoreText.type !== "text")
        throw new Error("missing MCP restore result");
      const restored = WorkspaceArtifactMutationResponse.parse(JSON.parse(restoreText.text));
      expect(restored.artifact.status).toBe("active");
      expect(restored.event.sourceExecutionGeneration).toBe(attempt.executionGeneration);

      const replacement = await supersedeAttempt(attempt);
      const putsBeforeStaleAttempt = objectPutCount;
      const staleResult = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Stale attempt",
          html: "<!doctype html><main>Must not be stored</main>",
          idempotencyKey: "stale-attempt-create",
        },
      });
      expect(staleResult.isError).toBe(true);
      expect(objectPutCount).toBe(putsBeforeStaleAttempt);

      const replacementServer = buildOpenGeniMcpServer(
        {
          settings: testSettings(),
          db: client.db,
          objectStorage,
          bus: new MemoryEventBus(),
        } as ApiRouteDeps,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: "worker:first-party-mcp",
          permissions: ["artifacts:read", "artifacts:publish"],
          principalKind: "agent_attempt",
          metadata: {
            sessionId: replacement.sessionId,
            turnId: replacement.turnId,
            attemptId: replacement.attemptId,
            executionGeneration: replacement.executionGeneration,
            firstPartyMcpTools: ["artifacts_create"],
          },
        },
      );
      const [replacementClientTransport, replacementServerTransport] =
        InMemoryTransport.createLinkedPair();
      const replacementMcp = new Client({ name: "workspace-artifact-replacement", version: "1" });
      await replacementServer.connect(replacementServerTransport);
      await replacementMcp.connect(replacementClientTransport);
      try {
        const replayAfterReplacement = await replacementMcp.callTool({
          name: "artifacts_create",
          arguments: {
            title: "Agent-created map",
            html: "<!doctype html><main>Created through MCP</main>",
            idempotencyKey: "agent-create-map",
          },
        });
        const replayAfterReplacementText = replayAfterReplacement.content.find(
          (item) => item.type === "text",
        );
        if (!replayAfterReplacementText || replayAfterReplacementText.type !== "text") {
          throw new Error("missing replacement replay result");
        }
        const replacementReplay = WorkspaceArtifactMutationResponse.parse(
          JSON.parse(replayAfterReplacementText.text),
        );
        expect(replacementReplay.replayed).toBe(true);
        expect(replacementReplay.artifact.id).toBe(created.artifact.id);
        expect(objectPutCount).toBe(putsBeforeStaleAttempt);
      } finally {
        await Promise.all([replacementMcp.close(), replacementServer.close()]);
      }
    } finally {
      await Promise.all([mcp.close(), server.close()]);
    }
  }, 60_000);

  test("prevents attempts from activating Site tools outside their immutable catalog", async () => {
    const attempt = await seedAttempt(grant, {
      permissions: ["artifacts:publish"],
      tools: ["artifacts_create", "artifacts_publish", "artifacts_rollback", "artifacts_restore"],
    });
    await persistArtifactAttemptCatalog(grant, attempt, [
      { serverId: "docs", toolName: "search" },
      { serverId: "inventory", toolName: "charge_card", approval: "human" },
      { serverId: "crm", toolName: "sync_contacts", approval: "policy" },
    ]);
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
        subjectId: "worker:first-party-mcp",
        permissions: ["artifacts:publish"],
        principalKind: "agent_attempt",
        metadata: {
          sessionId: attempt.sessionId,
          turnId: attempt.turnId,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
          firstPartyMcpTools: [
            "artifacts_create",
            "artifacts_publish",
            "artifacts_rollback",
            "artifacts_restore",
          ],
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "workspace-artifact-tool-authority-test", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const base = `/v1/workspaces/${grant.workspaceId}/published-artifacts`;
    const suffix = crypto.randomUUID();
    const seedStoredArtifact = async (
      title: string,
      requestedTools: Array<{ serverId: string; toolName: string }>,
      operationKey: string,
    ) => {
      const artifactId = crypto.randomUUID();
      return await createWorkspaceArtifact(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        artifactId,
        slug: `${normalizeWorkspaceArtifactSlug(title)}-${artifactId.slice(0, 8)}`,
        title,
        description: null,
        contentKey: `workspace-artifacts/${grant.workspaceId}/${artifactId}/index.html`,
        contentSha256: "d".repeat(64),
        sizeBytes: 64,
        sourceKey: null,
        sourceSha256: null,
        sourceSizeBytes: null,
        requestedTools,
        operationKey,
        actorSubjectId: grant.subjectId,
        sourceSessionId: null,
        sourceTurnId: null,
        sourceAttemptId: null,
        sourceExecutionGeneration: null,
        sourceToolName: null,
        persistContent: async () => undefined,
        discardContent: async () => undefined,
      });
    };
    try {
      const putsBeforeDeniedCreate = objectPutCount;
      const deniedCreate = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Unauthorized Site tool",
          html: "<!doctype html><main>Denied</main>",
          requestedTools: [{ serverId: "inventory", toolName: "delete_item" }],
          idempotencyKey: `denied-create-${suffix}`,
        },
      });
      expect(deniedCreate.isError).toBe(true);
      expect(objectPutCount).toBe(putsBeforeDeniedCreate);

      const deniedHumanApprovalCreate = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Human approval cannot be minted",
          html: "<!doctype html><main>Denied</main>",
          requestedTools: [{ serverId: "inventory", toolName: "charge_card" }],
          idempotencyKey: `denied-human-approval-create-${suffix}`,
        },
      });
      expect(deniedHumanApprovalCreate.isError).toBe(true);
      expect(deniedHumanApprovalCreate.content.find((item) => item.type === "text")).toMatchObject({
        text: expect.stringContaining(
          "cannot activate tools requiring policy or current-human approval",
        ),
      });
      expect(objectPutCount).toBe(putsBeforeDeniedCreate);

      const deniedPolicyApprovalCreate = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Attempt policy cannot be minted",
          html: "<!doctype html><main>Denied</main>",
          requestedTools: [{ serverId: "crm", toolName: "sync_contacts" }],
          idempotencyKey: `denied-policy-approval-create-${suffix}`,
        },
      });
      expect(deniedPolicyApprovalCreate.isError).toBe(true);
      expect(deniedPolicyApprovalCreate.content.find((item) => item.type === "text")).toMatchObject(
        {
          text: expect.stringContaining(
            "cannot activate tools requiring policy or current-human approval",
          ),
        },
      );
      expect(objectPutCount).toBe(putsBeforeDeniedCreate);

      const allowedCreate = await mcp.callTool({
        name: "artifacts_create",
        arguments: {
          title: "Authorized Site tool",
          html: "<!doctype html><main>Allowed</main>",
          requestedTools: [{ serverId: "docs", toolName: "search" }],
          idempotencyKey: `allowed-create-${suffix}`,
        },
      });
      const allowedCreateText = allowedCreate.content.find((item) => item.type === "text");
      if (!allowedCreateText || allowedCreateText.type !== "text") {
        throw new Error("missing allowed create result");
      }
      if (allowedCreate.isError) throw new Error(allowedCreateText.text);
      const allowed = WorkspaceArtifactMutationResponse.parse(JSON.parse(allowedCreateText.text));
      expect(allowed.version.requestedTools).toEqual([{ serverId: "docs", toolName: "search" }]);

      const putsBeforeDeniedPublish = objectPutCount;
      const deniedPublish = await mcp.callTool({
        name: "artifacts_publish",
        arguments: {
          artifactId: allowed.artifact.id,
          expectedCurrentVersionId: allowed.version.id,
          html: "<!doctype html><main>Denied publish</main>",
          requestedTools: [{ serverId: "inventory", toolName: "delete_item" }],
          idempotencyKey: `denied-publish-${suffix}`,
        },
      });
      expect(deniedPublish.isError).toBe(true);
      expect(objectPutCount).toBe(putsBeforeDeniedPublish);

      const rollbackSeed = await seedStoredArtifact(
        "Rollback authority seed",
        [{ serverId: "inventory", toolName: "delete_item" }],
        `rollback-seed-${suffix}`,
      );
      const putsBeforeInheritedPublish = objectPutCount;
      const deniedInheritedPublish = await mcp.callTool({
        name: "artifacts_publish",
        arguments: {
          artifactId: rollbackSeed.artifact.id,
          expectedCurrentVersionId: rollbackSeed.version.id,
          html: "<!doctype html><main>Inherited unsafe authority</main>",
          idempotencyKey: `denied-inherited-publish-${suffix}`,
        },
      });
      expect(deniedInheritedPublish.isError).toBe(true);
      expect(objectPutCount).toBe(putsBeforeInheritedPublish);
      const rollbackCurrentResponse = await requestAsCanonicalLocalHuman(
        `${base}/${rollbackSeed.artifact.id}/versions`,
        {
          method: "POST",
          body: JSON.stringify({
            html: "<!doctype html><main>Safe current version</main>",
            expectedCurrentVersionId: rollbackSeed.version.id,
            requestedTools: [{ serverId: "docs", toolName: "search_documents" }],
            idempotencyKey: `rollback-current-${suffix}`,
          }),
        },
      );
      expect(rollbackCurrentResponse.status).toBe(200);
      const rollbackCurrent = WorkspaceArtifactMutationResponse.parse(
        await rollbackCurrentResponse.json(),
      );
      const deniedRollback = await mcp.callTool({
        name: "artifacts_rollback",
        arguments: {
          artifactId: rollbackSeed.artifact.id,
          versionId: rollbackSeed.version.id,
          expectedCurrentVersionId: rollbackCurrent.version.id,
          reason: "Attempt to reactivate unauthorized tools",
          idempotencyKey: `denied-rollback-${suffix}`,
        },
      });
      expect(deniedRollback.isError).toBe(true);
      const rollbackDetail = WorkspaceArtifactDetailResponse.parse(
        await (
          await request(grant, ["artifacts:read"], `${base}/${rollbackSeed.artifact.id}`)
        ).json(),
      );
      expect(rollbackDetail.artifact.currentVersion?.id).toBe(rollbackCurrent.version.id);

      const restoreSeed = await seedStoredArtifact(
        "Restore authority seed",
        [{ serverId: "inventory", toolName: "delete_item" }],
        `restore-seed-${suffix}`,
      );
      const archiveResponse = await request(
        grant,
        ["artifacts:publish"],
        `${base}/${restoreSeed.artifact.id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "archived",
            expectedCurrentVersionId: restoreSeed.version.id,
            reason: "Prepare unauthorized restore",
            idempotencyKey: `restore-archive-${suffix}`,
          }),
        },
      );
      expect(archiveResponse.status).toBe(200);
      const deniedRestore = await mcp.callTool({
        name: "artifacts_restore",
        arguments: {
          artifactId: restoreSeed.artifact.id,
          expectedCurrentVersionId: restoreSeed.version.id,
          reason: "Attempt to restore unauthorized tools",
          idempotencyKey: `denied-restore-${suffix}`,
        },
      });
      expect(deniedRestore.isError).toBe(true);
      const restoreDetail = WorkspaceArtifactDetailResponse.parse(
        await (
          await request(grant, ["artifacts:read"], `${base}/${restoreSeed.artifact.id}`)
        ).json(),
      );
      expect(restoreDetail.artifact.status).toBe("archived");
    } finally {
      await Promise.all([mcp.close(), server.close()]);
    }
  }, 60_000);

  test("rejects signed attempt claims that lack durable tool or permission authority", async () => {
    const cases: Array<{
      name: string;
      permissions: Permission[] | null;
      tools: FirstPartyMcpToolName[];
      generationDelta?: number;
      wrongTurn?: boolean;
    }> = [
      { name: "empty permissions", permissions: [], tools: ["artifacts_create"] },
      {
        name: "narrow permissions",
        permissions: ["artifacts:read"],
        tools: ["artifacts_create"],
      },
      { name: "empty tools", permissions: ["artifacts:publish"], tools: [] },
      {
        name: "replacement generation",
        permissions: ["artifacts:publish"],
        tools: ["artifacts_create"],
        generationDelta: 1,
      },
      {
        name: "session turn association mismatch",
        permissions: ["artifacts:publish"],
        tools: ["artifacts_create"],
        wrongTurn: true,
      },
    ];
    for (const fixture of cases) {
      const attempt = await seedAttempt(grant, {
        permissions: fixture.permissions,
        tools: fixture.tools,
      });
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
          subjectId: "worker:first-party-mcp",
          permissions: ["artifacts:publish"],
          principalKind: "agent_attempt",
          metadata: {
            sessionId: attempt.sessionId,
            turnId: fixture.wrongTurn ? crypto.randomUUID() : attempt.turnId,
            attemptId: attempt.attemptId,
            executionGeneration: attempt.executionGeneration + (fixture.generationDelta ?? 0),
            firstPartyMcpTools: ["artifacts_create"],
          },
        },
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: `workspace-artifact-${fixture.name}`, version: "1" });
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      const putsBefore = objectPutCount;
      try {
        const result = await mcp.callTool({
          name: "artifacts_create",
          arguments: {
            title: fixture.name,
            html: "<!doctype html><main>Must not persist</main>",
            idempotencyKey: `denied-${fixture.name}`,
          },
        });
        expect(result.isError).toBe(true);
        expect(objectPutCount).toBe(putsBefore);
      } finally {
        await Promise.all([mcp.close(), server.close()]);
      }
    }
  }, 60_000);
});

type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

async function seedAttempt(
  targetGrant: Grant,
  options: {
    permissions?: Permission[] | null;
    tools?: FirstPartyMcpToolName[];
  } = {},
): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: targetGrant.accountId,
    workspaceId: targetGrant.workspaceId,
    initialMessage: "Artifact attempt test",
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    ...(options.permissions === undefined ? {} : { firstPartyMcpPermissions: options.permissions }),
    ...(options.tools === undefined ? {} : { firstPartyMcpTools: options.tools }),
  });
  const executionGeneration = 3;
  const [turn] = await shared.admin<{ id: string }[]>`
    INSERT INTO session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context
    ) VALUES (
      ${targetGrant.accountId}, ${targetGrant.workspaceId}, ${session.id}, gen_random_uuid(),
      ${`artifact-wf-${crypto.randomUUID()}`}, 'running', 0, 'Publish artifact',
      'gpt-5.6-sol', 'medium', 'none', ${executionGeneration}, 'subject',
      ${targetGrant.subjectId}, '{"accepted":true}'::jsonb
    ) RETURNING id`;
  const attemptId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`
      UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
    await tx`
      UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) VALUES (
        ${attemptId}, ${targetGrant.accountId}, ${targetGrant.workspaceId}, ${session.id},
        ${turn!.id}, ${executionGeneration}, 'running', 'artifact-wf', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}

async function persistArtifactAttemptCatalog(
  targetGrant: Grant,
  attempt: Attempt,
  identities: Array<{
    serverId: string;
    toolName: string;
    approval?: "none" | "human" | "policy";
  }>,
): Promise<void> {
  const unsigned: Omit<AttemptToolCatalog, "digest"> = {
    version: 1,
    accountId: targetGrant.accountId,
    workspaceId: targetGrant.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    generation: 1,
    createdAt: new Date().toISOString(),
    entries: identities.map(({ approval = "none", ...identity }) => ({
      identity,
      modelName: `${identity.serverId}__${identity.toolName}`,
      codemodePath: [identity.serverId, identity.toolName],
      inputSchema: { type: "object" },
      source: identity.serverId === "docs" ? "docs" : "mcp",
      approval,
    })),
  };
  await persistAttemptToolCatalog(client.db, {
    ...unsigned,
    digest: digestAttemptToolCatalog(unsigned),
  });
}

async function supersedeAttempt(attempt: Attempt): Promise<Attempt> {
  const replacementId = crypto.randomUUID();
  const replacementGeneration = attempt.executionGeneration + 1;
  await shared.admin.begin(async (tx) => {
    await tx`
      UPDATE session_turn_attempts
      SET state = 'closed', outcome = 'superseded', closed_at = now(), updated_at = now()
      WHERE id = ${attempt.attemptId}`;
    await tx`
      UPDATE session_turns
      SET execution_generation = ${replacementGeneration}, active_attempt_id = ${replacementId}
      WHERE id = ${attempt.turnId}`;
    await tx`
      INSERT INTO session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      )
      SELECT
        ${replacementId}, account_id, workspace_id, session_id, turn_id,
        ${replacementGeneration}, 'running', temporal_workflow_id,
        ${`replacement-run-${replacementId}`}, ${`replacement-activity-${replacementId}`},
        verified_control_revision, mcp_approval_policies
      FROM session_turn_attempts WHERE id = ${attempt.attemptId}`;
  });
  return {
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: replacementId,
    executionGeneration: replacementGeneration,
  };
}
