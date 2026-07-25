import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import {
  RETAINED_OUTPUT_MAX_PAGE_BYTES,
  type ConnectionMetadata,
  type SessionTurn,
} from "../src/types";
import { makeEvent, SESSION_ID, WORKSPACE_ID } from "./helpers";

const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const UPLOAD_ID = "66666666-6666-4666-8666-666666666666";
const BASE_ID = "77777777-7777-4777-8777-777777777777";
const DOCUMENT_ID = "88888888-8888-4888-8888-888888888888";
const TURN_A = "99999999-9999-4999-8999-999999999991";
const TURN_B = "99999999-9999-4999-8999-999999999992";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

function recordingFetch(responder: (request: RecordedRequest) => Response): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body:
        init?.body !== undefined && init?.body !== null
          ? typeof init.body === "string"
            ? init.body
            : await new Response(init.body as BodyInit).text()
          : null,
    };
    requests.push(recorded);
    return responder(recorded);
  }) as typeof fetch;
  return { fetch: impl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(responder: (request: RecordedRequest) => Response): {
  client: OpenGeniClient;
  requests: RecordedRequest[];
} {
  const { fetch, requests } = recordingFetch(responder);
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test_key",
    fetch,
  });
  return { client, requests };
}

function fakeTurn(overrides: Partial<SessionTurn>): SessionTurn {
  return {
    id: TURN_A,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    triggerEventId: "00000000-0000-4000-8000-000000000001",
    temporalWorkflowId: "wf",
    status: "queued",
    source: "user",
    position: 1,
    prompt: "queued work",
    resources: [],
    tools: [],
    model: "model-x",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    sandboxOs: null,
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "subject", subjectId: "user:test" },
    initiatorContext: {},
    cancelledBy: null,
    cancelReason: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("OpenGeniClient turn queue", () => {
  test("steerMessage performs one atomic server request", async () => {
    const accepted = makeEvent(7, "user.message", { text: "do this now" });
    const steerTurn = fakeTurn({ id: TURN_B, position: 1, triggerEventId: accepted.id });
    const { client, requests } = makeClient(() => jsonResponse({ accepted, turn: steerTurn }, 202));
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "do this now");
    expect(result.accepted.id).toBe(accepted.id);
    expect(result.turn.id).toBe(TURN_B);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/steer`,
    );
    expect(JSON.parse(requests[0]!.body!)).toEqual({ text: "do this now" });
  });

  test("steerMessage forwards idempotency, control, and draft fences", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    const steerTurn = fakeTurn({ id: TURN_B, position: 1, triggerEventId: accepted.id });
    const { client, requests } = makeClient(() => jsonResponse({ accepted, turn: steerTurn }, 202));
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, {
      text: "now",
      clientEventId: "steer-once",
      controlEtag: "sc1:observed",
      expectedDraftRevision: 4,
    });
    expect(result.turn.id).toBe(TURN_B);
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      text: "now",
      clientEventId: "steer-once",
      controlEtag: "sc1:observed",
      expectedDraftRevision: 4,
    });
  });

  test("steerMessage surfaces an atomic control conflict without fallback calls", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ message: "session control changed" }, 409),
    );
    let thrown: unknown;
    try {
      await client.steerMessage(WORKSPACE_ID, SESSION_ID, {
        text: "now",
        controlEtag: "sc1:stale",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenGeniApiError);
    expect((thrown as OpenGeniApiError).status).toBe(409);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.endsWith("/steer")).toBe(true);
  });
});

describe("OpenGeniClient goals", () => {
  test("getGoal GETs the session goal", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: "goal-1", status: "active" }));
    const goal = await client.getGoal(WORKSPACE_ID, SESSION_ID);
    expect(goal.status).toBe("active");
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`,
    );
  });

  test("pauseGoal and resumeGoal PATCH the documented status transitions", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: "goal-1", status: "paused" }));
    await client.pauseGoal(WORKSPACE_ID, SESSION_ID, { rationale: "manual review" });
    await client.resumeGoal(WORKSPACE_ID, SESSION_ID);
    expect(requests[0]!.method).toBe("PATCH");
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      status: "paused",
      rationale: "manual review",
    });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ status: "active" });
  });

  test("deleteGoal DELETEs the session goal route", async () => {
    const { client, requests } = makeClient(() => new Response(null, { status: 204 }));
    await client.deleteGoal(WORKSPACE_ID, SESSION_ID);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`,
    );
  });
});

describe("OpenGeniClient access + workspaces", () => {
  test("getAccessContext and workspace CRUD hit the expected endpoints", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/v1/access/me")) {
        return jsonResponse({
          mode: "local",
          subjectId: "s",
          accountGrants: [],
          workspaceGrants: [],
          defaultAccountId: null,
          defaultWorkspaceId: null,
        });
      }
      return jsonResponse({ id: WORKSPACE_ID, name: "Ops" });
    });
    await client.getAccessContext();
    await client.listWorkspaces();
    await client.createWorkspace({ name: "Ops" });
    await client.getWorkspace(WORKSPACE_ID);
    await client.updateWorkspace(WORKSPACE_ID, { name: "Ops 2", slug: null });
    await client.setWorkspaceDefaultRig(WORKSPACE_ID, {
      rigId: "22222222-2222-4222-8222-222222222222",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "GET /v1/access/me",
        "GET /v1/workspaces",
        "POST /v1/workspaces",
        `GET /v1/workspaces/${WORKSPACE_ID}`,
        `PATCH /v1/workspaces/${WORKSPACE_ID}`,
        `PUT /v1/workspaces/${WORKSPACE_ID}/default-rig`,
      ],
    );
    expect(JSON.parse(requests[4]!.body!)).toEqual({ name: "Ops 2", slug: null });
    expect(JSON.parse(requests[5]!.body!)).toEqual({
      rigId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("getClientConfig fetches the public bootstrap endpoint and returns the provider-grouped models", async () => {
    const config = {
      deploymentRevision: "rev-1",
      apiContractRevision: "2026-07-turn-instructions-v1",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol", "accounts/fireworks/models/glm-5p2"],
      models: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          provider: "openai",
          providerLabel: "OpenAI",
          api: "responses",
          contextWindowTokens: 400000,
        },
        {
          id: "accounts/fireworks/models/glm-5p2",
          label: "GLM 5.2",
          provider: "fireworks",
          providerLabel: "Fireworks AI",
          api: "chat",
          contextWindowTokens: 1048576,
        },
      ],
      defaultReasoningEffort: "medium",
      allowedReasoningEfforts: ["low", "medium", "high"],
      mcpServers: [{ id: "documents", name: "Documents" }],
      fileUploads: { enabled: true, maxSizeBytes: 26214400 },
      productAccessMode: "managed",
      auth: { mode: "managedSession", session: "cookie" },
    };
    const { client, requests } = makeClient(() => jsonResponse(config));
    const result = await client.getClientConfig();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/config/client");
    expect(result.defaultModel).toBe("gpt-5.6-sol");
    expect(result.models.map((model) => `${model.provider}:${model.id}:${model.api}`)).toEqual([
      "openai:gpt-5.6-sol:responses",
      "fireworks:accounts/fireworks/models/glm-5p2:chat",
    ]);
  });
});

describe("OpenGeniClient scheduled tasks", () => {
  test("create, update, pause, resume, trigger, delete, and runs", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: TASK_ID }));
    await client.createScheduledTask(WORKSPACE_ID, {
      name: "drift",
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "check drift" },
    });
    await client.updateScheduledTask(WORKSPACE_ID, TASK_ID, { name: "drift v2" });
    await client.pauseScheduledTask(WORKSPACE_ID, TASK_ID);
    await client.resumeScheduledTask(WORKSPACE_ID, TASK_ID);
    await client.triggerScheduledTask(WORKSPACE_ID, TASK_ID);
    await client.deleteScheduledTask(WORKSPACE_ID, TASK_ID);
    await client.listScheduledTaskRuns(WORKSPACE_ID, TASK_ID, { limit: 5 });
    expect(
      requests.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
    ).toEqual([
      `POST /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks`,
      `PATCH /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}`,
      `POST /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}/pause`,
      `POST /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}/resume`,
      `POST /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}/trigger`,
      `DELETE /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}`,
      `GET /v1/workspaces/${WORKSPACE_ID}/scheduled-tasks/${TASK_ID}/runs?limit=5`,
    ]);
  });
});

describe("OpenGeniClient variable sets", () => {
  test("variable set CRUD + write-only variable PUT/DELETE", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ id: ENVIRONMENT_ID, variables: [] }),
    );
    await client.listVariableSets(WORKSPACE_ID);
    await client.createVariableSet(WORKSPACE_ID, {
      name: "staging",
      variables: [{ name: "EXAMPLE_TOKEN", value: "v" }],
    });
    await client.getVariableSet(WORKSPACE_ID, ENVIRONMENT_ID);
    await client.updateVariableSet(WORKSPACE_ID, ENVIRONMENT_ID, { description: "staging vars" });
    await client.setVariableSetVariable(WORKSPACE_ID, ENVIRONMENT_ID, "EXAMPLE_TOKEN", "v2");
    await client.deleteVariableSetVariable(WORKSPACE_ID, ENVIRONMENT_ID, "EXAMPLE_TOKEN");
    await client.deleteVariableSet(WORKSPACE_ID, ENVIRONMENT_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/variable-sets`,
        `POST /v1/workspaces/${WORKSPACE_ID}/variable-sets`,
        `GET /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}`,
        `PATCH /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}`,
        `PUT /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}/variables/EXAMPLE_TOKEN`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}/variables/EXAMPLE_TOKEN`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}`,
      ],
    );
    // The variable PUT sends only the value; nothing else carries the secret.
    expect(JSON.parse(requests[4]!.body!)).toEqual({ value: "v2" });
  });

  test("deprecated environment method names delegate to the canonical variable-set paths", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ id: ENVIRONMENT_ID, variables: [] }),
    );
    await client.listEnvironments(WORKSPACE_ID);
    await client.setEnvironmentVariable(WORKSPACE_ID, ENVIRONMENT_ID, "EXAMPLE_TOKEN", "v2");
    await client.deleteEnvironment(WORKSPACE_ID, ENVIRONMENT_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/variable-sets`,
        `PUT /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}/variables/EXAMPLE_TOKEN`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/variable-sets/${ENVIRONMENT_ID}`,
      ],
    );
  });
});

describe("OpenGeniClient files", () => {
  test("uploadFile runs begin -> signed PUT -> complete and returns the ready file", async () => {
    const begin = {
      fileId: FILE_ID,
      uploadId: UPLOAD_ID,
      putUrl: "https://storage.example.test/put/abc",
      // Realistic backend shape: every real backend (Azure/S3/GCS) puts a
      // lowercase `content-type` into requiredHeaders (see packages/storage/src
      // index.ts:74/152/208). The SDK must rely on this and not also set its own
      // `Content-Type` key, or WHATWG Headers comma-joins the two into
      // "text/plain, text/plain" and the server's COMPLETE check 422s.
      requiredHeaders: { "content-type": "text/plain", "x-ms-blob-type": "BlockBlob" },
      expiresAt: "2026-06-12T01:00:00.000Z",
      maxSizeBytes: 1024 * 1024,
    };
    const file = { id: FILE_ID, status: "ready", filename: "notes.txt" };
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/files/uploads")) {
        return jsonResponse(begin, 201);
      }
      if (request.url.startsWith("https://storage.example.test/")) {
        return new Response(null, { status: 200 });
      }
      if (request.url.endsWith(`/files/uploads/${UPLOAD_ID}/complete`)) {
        return jsonResponse({ file });
      }
      throw new Error(`unexpected request: ${request.url}`);
    });
    const uploaded = await client.uploadFile(WORKSPACE_ID, {
      filename: "notes.txt",
      contentType: "text/plain",
      data: "hello world",
    });
    expect(uploaded).toEqual(file as never);
    expect(requests).toHaveLength(3);
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 11,
    });
    const put = requests[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(begin.putUrl);
    expect(put.headers["x-ms-blob-type"]).toBe("BlockBlob");
    // Regression guard: the PUT must send exactly ONE content-type value. If the
    // SDK redundantly sets a `Content-Type` key alongside the backend's lowercase
    // `content-type`, WHATWG Headers comma-joins them to "text/plain, text/plain",
    // the object store persists that verbatim, and COMPLETE rejects it with a 422
    // ("uploaded object content type does not match file metadata").
    expect(put.headers["content-type"]).toBe("text/plain");
    // API credentials must never be sent to object storage.
    expect(put.headers.authorization).toBeUndefined();
    expect(put.body).toBe("hello world");
    expect(requests[2]!.url).toContain(`/files/uploads/${UPLOAD_ID}/complete`);
  });

  test("uploadFile surfaces a failed signed PUT as OpenGeniApiError without completing", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/files/uploads")) {
        return jsonResponse(
          {
            fileId: FILE_ID,
            uploadId: UPLOAD_ID,
            putUrl: "https://storage.example.test/put/x",
            requiredHeaders: {},
            expiresAt: "",
            maxSizeBytes: 1,
          },
          201,
        );
      }
      return new Response("denied", { status: 403 });
    });
    const error = await client
      .uploadFile(WORKSPACE_ID, { filename: "a", contentType: "text/plain", data: "x" })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(403);
    expect(requests.some((request) => request.url.includes("/complete"))).toBe(false);
  });

  test("getFile and createFileDownloadUrl hit the expected endpoints", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ url: "https://storage.example.test/get/x", expiresAt: "" }),
    );
    await client.getFile(WORKSPACE_ID, FILE_ID);
    await client.createFileDownloadUrl(WORKSPACE_ID, FILE_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`,
        `POST /v1/workspaces/${WORKSPACE_ID}/files/${FILE_ID}/download-url`,
      ],
    );
  });

  test("reads retained metadata and one authenticated bounded API range", async () => {
    const metadata = {
      available: true as const,
      artifactId: FILE_ID,
      kind: "tool_result" as const,
      contentType: "application/json",
      originalBytes: 5_000_000,
      sha256: "a".repeat(64),
      retainedAt: "2026-07-21T00:00:00.000Z",
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${WORKSPACE_ID}/artifacts/${FILE_ID}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
      },
    };
    const expected = new Uint8Array([4, 5, 6, 7]);
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith(`/artifacts/${FILE_ID}`)) return jsonResponse(metadata);
      if (request.url.endsWith(`/artifacts/${FILE_ID}/content`)) {
        return new Response(expected, {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": String(expected.byteLength),
            "Content-Range": "bytes 4-7/5000000",
            "Content-Type": "application/json",
          },
        });
      }
      throw new Error(`unexpected request: ${request.url}`);
    });

    expect(await client.getRetainedArtifact(WORKSPACE_ID, FILE_ID)).toEqual(metadata);
    const content = await client.getRetainedArtifactContent(WORKSPACE_ID, FILE_ID, {
      range: "bytes=4-7",
    });
    expect(content).toEqual({
      bytes: expected,
      status: 206,
      contentType: "application/json",
      contentLength: 4,
      contentRange: "bytes 4-7/5000000",
      acceptRanges: "bytes",
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/workspaces/${WORKSPACE_ID}/artifacts/${FILE_ID}`,
      `/v1/workspaces/${WORKSPACE_ID}/artifacts/${FILE_ID}/content`,
    ]);
    expect(requests[1]!.headers.range).toBe("bytes=4-7");
    expect(requests[1]!.headers.authorization).toBe("Bearer og_test_key");
    expect(requests.some((request) => request.url.includes("download-url"))).toBeFalse();
  });

  test("fails closed when retained content exceeds the SDK byte ceiling", async () => {
    let cancelReason: unknown;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(RETAINED_OUTPUT_MAX_PAGE_BYTES + 1));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const { client } = makeClient(
      () =>
        new Response(oversized, {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes 0-${RETAINED_OUTPUT_MAX_PAGE_BYTES}/${RETAINED_OUTPUT_MAX_PAGE_BYTES + 1}`,
          },
        }),
    );
    const error = await client.getRetainedArtifactContent(WORKSPACE_ID, FILE_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(502);
    expect((error as OpenGeniApiError).body).toContain("exceeds the SDK byte limit");
    expect(cancelReason).toBe("retained artifact response exceeded the SDK byte limit");
  });

  test("cancels retained content rejected from response headers before reading bytes", async () => {
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const { client } = makeClient(
      () =>
        new Response(body, {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": String(RETAINED_OUTPUT_MAX_PAGE_BYTES + 1),
          },
        }),
    );

    await expect(client.getRetainedArtifactContent(WORKSPACE_ID, FILE_ID)).rejects.toThrow(
      "exceeds the SDK byte limit",
    );
    expect(cancelReason).toBe("invalid retained artifact content-length");
  });
});

describe("OpenGeniClient documents", () => {
  test("bases, documents, reindex, and search", async () => {
    const { client, requests } = makeClient((request) =>
      request.url.endsWith("/search")
        ? jsonResponse({ results: [] })
        : jsonResponse({ id: BASE_ID }),
    );
    await client.createDocumentBase(WORKSPACE_ID, { name: "runbooks" });
    await client.listDocumentBases(WORKSPACE_ID);
    await client.getDocumentBase(WORKSPACE_ID, BASE_ID);
    await client.addDocument(WORKSPACE_ID, BASE_ID, { fileId: FILE_ID });
    await client.listDocuments(WORKSPACE_ID, BASE_ID);
    await client.reindexDocument(WORKSPACE_ID, BASE_ID, DOCUMENT_ID);
    const search = await client.searchDocuments(WORKSPACE_ID, BASE_ID, {
      query: "rollback steps",
      limit: 3,
    });
    const knowledgeSearch = await client.searchKnowledge(WORKSPACE_ID, {
      query: "decision",
      mode: "keyword",
      limit: 2,
    });
    await client.listKnowledgeMemories(WORKSPACE_ID, {
      status: "approved",
      query: "azure",
      limit: 5,
    });
    await client.getKnowledgeMemory(WORKSPACE_ID, DOCUMENT_ID);
    await client.createKnowledgeMemory(WORKSPACE_ID, {
      text: "Prefer reviewed memory.",
      kind: "decision",
    });
    await client.updateKnowledgeMemory(WORKSPACE_ID, DOCUMENT_ID, { status: "approved" });
    expect(search.results).toEqual([]);
    expect(knowledgeSearch.results).toEqual([]);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `POST /v1/workspaces/${WORKSPACE_ID}/document-bases`,
        `GET /v1/workspaces/${WORKSPACE_ID}/document-bases`,
        `GET /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}`,
        `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents`,
        `GET /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents`,
        `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents/${DOCUMENT_ID}/reindex`,
        `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/search`,
        `POST /v1/workspaces/${WORKSPACE_ID}/knowledge/search`,
        `GET /v1/workspaces/${WORKSPACE_ID}/knowledge/memories`,
        `GET /v1/workspaces/${WORKSPACE_ID}/knowledge/memories/${DOCUMENT_ID}`,
        `POST /v1/workspaces/${WORKSPACE_ID}/knowledge/memories`,
        `PATCH /v1/workspaces/${WORKSPACE_ID}/knowledge/memories/${DOCUMENT_ID}`,
      ],
    );
    expect(JSON.parse(requests[6]!.body!)).toEqual({ query: "rollback steps", limit: 3 });
    expect(JSON.parse(requests[7]!.body!)).toEqual({
      query: "decision",
      mode: "keyword",
      limit: 2,
    });
    expect(new URL(requests[8]!.url).searchParams.get("status")).toBe("approved");
    expect(JSON.parse(requests[10]!.body!)).toEqual({
      text: "Prefer reviewed memory.",
      kind: "decision",
    });
    expect(JSON.parse(requests[11]!.body!)).toEqual({ status: "approved" });
  });

  test("deleteDocument DELETEs the document and resolves on 204", async () => {
    const { client, requests } = makeClient(() => new Response(null, { status: 204 }));
    await client.deleteDocument(WORKSPACE_ID, BASE_ID, DOCUMENT_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [`DELETE /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents/${DOCUMENT_ID}`],
    );
    expect(requests[0]!.body).toBeNull();
  });
});

describe("OpenGeniClient packs", () => {
  test("list, register, get, enable, installations, and delete (204)", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (request.url.endsWith("/packs") && request.method === "GET") {
        return jsonResponse({ packs: [], installations: [] });
      }
      return jsonResponse({ pack: { id: "acme" }, installation: null });
    });
    await client.listPacks(WORKSPACE_ID);
    await client.registerPack(WORKSPACE_ID, {
      id: "acme",
      name: "Acme",
      description: "d",
      role: "devops",
      category: "infra",
      version: "1.0.0",
    });
    await client.getPack(WORKSPACE_ID, "acme");
    await client.enablePack(WORKSPACE_ID, "acme", { environmentId: ENVIRONMENT_ID });
    await client.listPackInstallations(WORKSPACE_ID);
    await client.deletePack(WORKSPACE_ID, "acme");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/packs`,
        `POST /v1/workspaces/${WORKSPACE_ID}/packs`,
        `GET /v1/workspaces/${WORKSPACE_ID}/packs/acme`,
        `POST /v1/workspaces/${WORKSPACE_ID}/packs/acme/enable`,
        `GET /v1/workspaces/${WORKSPACE_ID}/packs/installations`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/packs/acme`,
      ],
    );
    expect(JSON.parse(requests[3]!.body!)).toEqual({ environmentId: ENVIRONMENT_ID });
  });
});

describe("OpenGeniClient capabilities", () => {
  test("list, create, enable, disable, and registry discovery (id is URL-encoded)", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ items: [], installations: [] }));
    await client.listCapabilities(WORKSPACE_ID);
    await client.createCapability(WORKSPACE_ID, {
      kind: "mcp",
      name: "Acme MCP",
      endpointUrl: "https://mcp.example.test",
    });
    await client.enableCapability(WORKSPACE_ID, "mcp:acme/tools", {
      headers: { Authorization: "Bearer t" },
    });
    await client.disableCapability(WORKSPACE_ID, "mcp:acme/tools");
    await client.discoverMcpCapabilities(WORKSPACE_ID, { query: "github", limit: 10 });
    expect(
      requests.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
    ).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/capabilities`,
      `POST /v1/workspaces/${WORKSPACE_ID}/capabilities`,
      `POST /v1/workspaces/${WORKSPACE_ID}/capabilities/mcp%3Aacme%2Ftools/enable`,
      `POST /v1/workspaces/${WORKSPACE_ID}/capabilities/mcp%3Aacme%2Ftools/disable`,
      `GET /v1/workspaces/${WORKSPACE_ID}/capabilities/discovery/mcp-registry?query=github&limit=10`,
    ]);
  });
});

describe("OpenGeniClient github", () => {
  test("app info, connect URL, repositories, sync, and app manifest", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ repositories: [] }));
    await client.getGitHubApp(WORKSPACE_ID);
    await client.listGitHubRepositories(WORKSPACE_ID);
    await client.syncGitHubRepositories(WORKSPACE_ID);
    await client.unlinkGitHubInstallation(WORKSPACE_ID, 123);
    await client.createGitHubAppManifest(WORKSPACE_ID, { organization: "acme" });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/github/app`,
        `GET /v1/workspaces/${WORKSPACE_ID}/github/repositories`,
        `POST /v1/workspaces/${WORKSPACE_ID}/github/repositories/sync`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/github/installations/123`,
        `POST /v1/workspaces/${WORKSPACE_ID}/github/app-manifest`,
      ],
    );
    expect(client.githubConnectUrl(WORKSPACE_ID, "signed-state")).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/github/connect?state=signed-state`,
    );
  });
});

describe("OpenGeniClient api keys", () => {
  test("list unwraps apiKeys; create and delete hit the expected endpoints", async () => {
    const apiKey = { id: "key-1", name: "ci" };
    const { client, requests } = makeClient((request) => {
      if (request.method === "GET") {
        return jsonResponse({ apiKeys: [apiKey] });
      }
      if (request.method === "POST") {
        return jsonResponse({ apiKey, token: "ogk_secret" }, 201);
      }
      return jsonResponse(apiKey);
    });
    const keys = await client.listApiKeys(WORKSPACE_ID);
    expect(keys).toEqual([apiKey as never]);
    const created = await client.createApiKey(WORKSPACE_ID, {
      name: "ci",
      permissions: ["sessions:read"],
    });
    expect(created.token).toBe("ogk_secret");
    await client.deleteApiKey(WORKSPACE_ID, "key-1");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/api-keys`,
        `POST /v1/workspaces/${WORKSPACE_ID}/api-keys`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/api-keys/key-1`,
      ],
    );
  });
});

describe("OpenGeniClient billing", () => {
  test("billing reads pass account/workspace selectors as query params", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ mode: "stripe", balance: null, usage: [], entitlements: {} }),
    );
    await client.getBilling({ accountId: "acc-1" });
    await client.getBillingUsage({ accountId: "acc-1", workspaceId: WORKSPACE_ID });
    await client.getBillingEntitlements();
    await client.createBillingCheckout({ amountUsd: 25 });
    expect(
      requests.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`,
      ),
    ).toEqual([
      "GET /v1/billing?accountId=acc-1",
      `GET /v1/billing/usage?accountId=acc-1&workspaceId=${WORKSPACE_ID}`,
      "GET /v1/billing/entitlements",
      "POST /v1/billing/checkout",
    ]);
    expect(JSON.parse(requests[3]!.body!)).toEqual({ amountUsd: 25 });
  });
});

describe("OpenGeniClient connections", () => {
  function fakeConnection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
    return {
      id: "conn-1",
      accountId: "acct-1",
      workspaceId: WORKSPACE_ID,
      subjectId: null,
      providerDomain: "api.example.com",
      kind: "api_key",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "subject-a",
      updatedBySubjectId: "subject-a",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      ...overrides,
    };
  }

  test("list/create/update/delete round-trip through their unwrapped connection shape", async () => {
    const connection = fakeConnection();
    const { client, requests } = makeClient((request) => {
      if (request.method === "GET") return jsonResponse({ connections: [connection] });
      return jsonResponse({ connection });
    });
    const listed = await client.listConnections(WORKSPACE_ID);
    expect(listed).toEqual([connection]);
    const created = await client.createConnection(WORKSPACE_ID, {
      providerDomain: "api.example.com",
      kind: "api_key",
      credential: { headers: { authorization: "Bearer X" } },
    });
    expect(created).toEqual(connection);
    const updated = await client.updateConnection(WORKSPACE_ID, connection.id, {
      status: "active",
      credential: {},
    });
    expect(updated).toEqual(connection);
    const deleted = await client.deleteConnection(WORKSPACE_ID, connection.id);
    expect(deleted).toEqual(connection);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        `GET /v1/workspaces/${WORKSPACE_ID}/connections`,
        `POST /v1/workspaces/${WORKSPACE_ID}/connections`,
        `PATCH /v1/workspaces/${WORKSPACE_ID}/connections/${connection.id}`,
        `DELETE /v1/workspaces/${WORKSPACE_ID}/connections/${connection.id}`,
      ],
    );
  });

  test("startConnectionOAuth POSTs to the oauth/start route and returns the authorization URL", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({
        state: "state-token",
        authorizationUrl: "https://as.example.com/authorize",
        expiresAt: "2026-06-12T00:10:00.000Z",
      }),
    );
    const result = await client.startConnectionOAuth(WORKSPACE_ID, {
      mcpUrl: "https://mcp.example.com/mcp",
      returnPath: "/integrations",
    });
    expect(result.authorizationUrl).toBe("https://as.example.com/authorize");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/connections/oauth/start`,
    );
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      mcpUrl: "https://mcp.example.com/mcp",
      returnPath: "/integrations",
    });
  });

  test("catalogAssetUrl builds a public v1 URL and is null-safe", () => {
    const { client } = makeClient(() => jsonResponse({}));
    expect(
      client.catalogAssetUrl("catalog-assets/integrations-sh/logos/example.com/abc123.png"),
    ).toBe(
      "https://api.example.test/v1/catalog-assets/integrations-sh/logos/example.com/abc123.png",
    );
    expect(client.catalogAssetUrl(null)).toBeNull();
  });
});

describe("OpenGeniClient error handling for new endpoints", () => {
  test("non-2xx responses raise OpenGeniApiError with status and body", async () => {
    const { client } = makeClient(() => new Response("goal not found", { status: 404 }));
    const error = await client.getGoal(WORKSPACE_ID, SESSION_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(404);
    expect((error as OpenGeniApiError).body).toBe("goal not found");
  });
});
