import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  signDelegatedAccessToken,
  type FirstPartyMcpToolName,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteWorkspace,
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
      objectPutCount += 1;
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
    const putsAfterCreate = objectPutCount;

    const replayResponse = await request(grant, ["artifacts:publish"], base, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    const replay = WorkspaceArtifactMutationResponse.parse(await replayResponse.json());
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(created.artifact.id);
    expect(objectPutCount).toBe(putsAfterCreate);

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

    const putsBeforeStalePublish = objectPutCount;
    const stalePublish = await publish(
      "<!doctype html><h1>Must not be stored</h1>",
      "stale-publish",
    );
    expect(stalePublish.status).toBe(409);
    expect(objectPutCount).toBe(putsBeforeStalePublish);

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
        "artifacts_create",
        "artifacts_get_source",
        "artifacts_publish",
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

      await supersedeAttempt(attempt);
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
  await shared.admin`
    INSERT INTO session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
      verified_control_revision, mcp_approval_policies
    ) VALUES (
      ${attemptId}, ${targetGrant.accountId}, ${targetGrant.workspaceId}, ${session.id}, ${turn!.id},
      ${executionGeneration}, 'running', 'artifact-wf', ${`run-${attemptId}`},
      ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared.admin`
    UPDATE session_turns SET active_attempt_id = ${attemptId} WHERE id = ${turn!.id}`;
  await shared.admin`
    UPDATE sessions SET active_turn_id = ${turn!.id} WHERE id = ${session.id}`;
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}

async function supersedeAttempt(attempt: Attempt): Promise<void> {
  const replacementId = crypto.randomUUID();
  const replacementGeneration = attempt.executionGeneration + 1;
  await shared.admin.begin(async (tx) => {
    await tx`
      UPDATE session_turn_attempts
      SET state = 'closed', outcome = 'superseded', closed_at = now(), updated_at = now()
      WHERE id = ${attempt.attemptId}`;
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
    await tx`
      UPDATE session_turns
      SET execution_generation = ${replacementGeneration}, active_attempt_id = ${replacementId}
      WHERE id = ${attempt.turnId}`;
  });
}
