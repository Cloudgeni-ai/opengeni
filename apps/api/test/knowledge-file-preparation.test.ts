import { registerFileRoutes } from "../src/routes/files";
import { registerDocumentRoutes } from "../src/routes/documents";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  signDelegatedAccessToken,
  type KnowledgeFilePreparationResult,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  completeFileUpload,
  createDb,
  createFileUpload,
  createSession,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
  withSessionRlsActorContext,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";

const SECRET = "knowledge-file-preparation-test";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireSharedTestDatabase("knowledge-file-preparation");
  if (!database) throw new Error("Knowledge source verification requires PostgreSQL");
  shared = database;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(mode: "automatic" | "review_first" | "off" = "automatic") {
  const id = crypto.randomUUID();
  const subjectId = `user:${id}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Knowledge files",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const human: KnowledgeContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
  await saveAgentLearningSettings(client.db, human, {
    scope: "workspace",
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    settings: { knowledge: mode, instructions: "review_first", skills: "review_first" },
  });
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "What are Acme's renewal terms?",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim source task");
  const authorization = async (
    tools: FirstPartyMcpToolName[] = ["knowledge_retain_file"],
    fileRead = true,
  ) =>
    `Bearer ${await signDelegatedAccessToken(SECRET, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "worker:test",
      principalKind: "agent_attempt",
      permissions: fileRead ? ["files:read", "documents:search"] : ["documents:search"],
      firstPartyMcpTools: tools,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
  const fileId = crypto.randomUUID();
  const bytes = new TextEncoder().encode("original PDF bytes");
  const uploaded = await createFileUpload(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    fileId,
    filename: "Acme.pdf",
    safeFilename: "Acme.pdf",
    contentType: "application/pdf",
    sizeBytes: bytes.length,
    sha256: null,
    bucket: "test",
    objectKey: fileId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await completeFileUpload(client.db, grant.workspaceId, uploaded.uploadId);
  const calls: string[] = [];
  let parserFails = false;
  const app = new Hono();
  const deps = {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
    managedAuth: null,
    objectStorage: {
      getObjectBytes: async (key: string) => {
        calls.push(`read:${key}`);
        return { bytes };
      },
    },
    getDocumentServices: () => ({
      parser: {
        name: "fixture",
        parse: async (input: Uint8Array) => {
          expect(input).toEqual(bytes);
          calls.push("parse");
          if (parserFails) throw new Error("Test extraction unavailable");
          return { text: "  Acme renews in December.\n\u0000Exact extracted text.  " };
        },
      },
    }),
  } as unknown as ApiRouteDeps;
  registerFileRoutes(app, deps);
  registerKnowledgeRoutes(app, deps);
  registerDocumentRoutes(app, deps);
  // Expected parser errors stay HTTP failures; the worker records a retryable receipt.
  app.onError((error, c) =>
    "getResponse" in error
      ? (error as { getResponse: () => Response }).getResponse()
      : c.json({ error: "Source preparation failed" }, 500),
  );
  const url = `http://test/v1/workspaces/${grant.workspaceId}/knowledge/files/${fileId}/prepare`;
  return {
    app,
    grant,
    fileId,
    subjectId,
    url,
    calls,
    authorization,
    failParser: (value: boolean) => {
      parserFails = value;
    },
  };
}

describe("chat file to retained source through the public API", () => {
  test("uses the existing original, exact parser text and one pending source for repeated requests", async () => {
    const f = await fixture("review_first");
    const headers = { authorization: await f.authorization() };
    const response = await f.app.request(f.url, { method: "POST", headers });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as KnowledgeFilePreparationResult;
    expect(saved.status === "retained" && saved.receipt.outcome).toBe("pending");
    const retry = await f.app.request(f.url, { method: "POST", headers });
    const replayed = (await retry.json()) as KnowledgeFilePreparationResult;
    expect(replayed.status === "retained" && replayed.receipt.replayed).toBe(true);
    expect(f.calls.filter((call) => call === "parse")).toHaveLength(1);
  });
  test("Off, a missing file permission or a narrowed tool selection never touches the object store", async () => {
    const off = await fixture("off");
    const disabled = await off.app.request(off.url, {
      method: "POST",
      headers: { authorization: await off.authorization() },
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).status).toBe("disabled");
    expect(off.calls).toEqual([]);
    const f = await fixture();
    for (const authorization of [
      await f.authorization([]),
      await f.authorization(["knowledge_retain_file"], false),
    ]) {
      expect(
        (await f.app.request(f.url, { method: "POST", headers: { authorization } })).status,
      ).toBe(403);
    }
    expect(f.calls).toEqual([]);
  });
  test("retired Memory routes cannot write to a second store", async () => {
    const f = await fixture();
    const url = f.url.replace(/\/knowledge\/files\/[^/]+\/prepare$/, "/knowledge/memories");
    const response = await f.app.request(url, {
      method: "POST",
      headers: { authorization: await f.authorization(), "content-type": "application/json" },
      body: JSON.stringify({ text: "An old client tries to write", kind: "decision" }),
    });
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe("memory_replaced");
    expect(f.calls).toEqual([]);
  });

  test("a failed extraction can retry the same original and does not create a false ready source", async () => {
    const f = await fixture();
    f.failParser(true);
    const headers = { authorization: await f.authorization() };
    expect((await f.app.request(f.url, { method: "POST", headers })).status).toBe(500);
    f.failParser(false);
    const response = await f.app.request(f.url, { method: "POST", headers });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as KnowledgeFilePreparationResult;
    expect(saved.status === "retained" && saved.receipt.outcome).toBe("published");
    expect(f.calls.filter((call) => call === "parse")).toHaveLength(2);
  });
});

test("the public file catalogue excludes private originals before paging and validates cursors", async () => {
  const f = await fixture();
  const privateId = crypto.randomUUID();
  const privateUpload = await withSessionRlsActorContext(
    { subjectId: f.subjectId, privateFileOwnerSubjectId: f.subjectId },
    () =>
      createFileUpload(client.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        fileId: privateId,
        filename: "Private.pdf",
        safeFilename: "Private.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        sha256: null,
        bucket: "test",
        objectKey: privateId,
        expiresAt: new Date(Date.now() + 60000),
        privateOwnerSubjectId: f.subjectId,
      }),
  );
  await withSessionRlsActorContext(
    { subjectId: f.subjectId, privateFileOwnerSubjectId: f.subjectId },
    () => completeFileUpload(client.db, f.grant.workspaceId, privateUpload.uploadId),
  );
  // A service using the same human-shaped subject is not a personal-file owner.
  const authorization = `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: f.grant.accountId,
    workspaceId: f.grant.workspaceId,
    subjectId: f.subjectId,
    principalKind: "service",
    permissions: ["files:read"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const url = `http://test/v1/workspaces/${f.grant.workspaceId}/files`;
  const page = await f.app.request(`${url}?limit=1`, { headers: { authorization } });
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  expect(await page.json()).toMatchObject({ files: [{ id: f.fileId }], nextCursor: null });
  const personal = await f.app.request(`${url}?scope=personal`, { headers: { authorization } });
  expect(await personal.json()).toEqual({ files: [], nextCursor: null });
  const malformed = await f.app.request(`${url}?cursor=not-a-cursor`, {
    headers: { authorization },
  });
  expect(malformed.status).toBe(422);
  const denied = await f.app.request(url, {
    headers: { authorization: await f.authorization([], false) },
  });
  expect(denied.status).toBe(403);
});
