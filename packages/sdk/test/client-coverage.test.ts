import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import type { SessionTurn } from "../src/types";
import { makeEvent, SESSION_ID, WORKSPACE_ID } from "./helpers";

const ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const UPLOAD_ID = "66666666-6666-4666-8666-666666666666";
const BASE_ID = "77777777-7777-4777-8777-777777777777";
const DOCUMENT_ID = "88888888-8888-4888-8888-888888888888";
const TURN_A = "99999999-9999-4999-8999-999999999991";
const TURN_B = "99999999-9999-4999-8999-999999999992";

type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: string | null };

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
      body: init?.body !== undefined && init?.body !== null
        ? typeof init.body === "string" ? init.body : await new Response(init.body as BodyInit).text()
        : null,
    };
    requests.push(recorded);
    return responder(recorded);
  }) as typeof fetch;
  return { fetch: impl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(responder: (request: RecordedRequest) => Response): { client: OpenGeniClient; requests: RecordedRequest[] } {
  const { fetch, requests } = recordingFetch(responder);
  const client = new OpenGeniClient({ baseUrl: "https://api.example.test", apiKey: "og_test_key", fetch });
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
    metadata: {},
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("OpenGeniClient turn queue", () => {
  test("updateQueuedTurn PATCHes the turn with the edit payload", async () => {
    const { client, requests } = makeClient(() => jsonResponse(fakeTurn({ prompt: "new prompt" })));
    const turn = await client.updateQueuedTurn(WORKSPACE_ID, SESSION_ID, TURN_A, { prompt: "new prompt", reasoningEffort: "high" });
    expect(turn.prompt).toBe("new prompt");
    expect(requests[0]!.method).toBe("PATCH");
    expect(requests[0]!.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/turns/${TURN_A}`);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ prompt: "new prompt", reasoningEffort: "high" });
  });

  test("reorderQueuedTurns POSTs turnIds and returns the new queue", async () => {
    const queue = [fakeTurn({ id: TURN_B, position: 1 }), fakeTurn({ id: TURN_A, position: 2 })];
    const { client, requests } = makeClient(() => jsonResponse(queue));
    const turns = await client.reorderQueuedTurns(WORKSPACE_ID, SESSION_ID, [TURN_B, TURN_A]);
    expect(turns.map((turn) => turn.id)).toEqual([TURN_B, TURN_A]);
    expect(requests[0]!.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/turns/reorder`);
    expect(JSON.parse(requests[0]!.body!)).toEqual({ turnIds: [TURN_B, TURN_A] });
  });

  test("deleteQueuedTurn DELETEs and returns the cancelled turn", async () => {
    const { client, requests } = makeClient(() => jsonResponse(fakeTurn({ status: "cancelled" })));
    const turn = await client.deleteQueuedTurn(WORKSPACE_ID, SESSION_ID, TURN_A);
    expect(turn.status).toBe("cancelled");
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/turns/${TURN_A}`);
  });

  test("steerMessage queues, promotes to the queue front, and interrupts a running session", async () => {
    const accepted = makeEvent(7, "user.message", { text: "do this now" });
    const steerTurn = fakeTurn({ id: TURN_B, position: 2, triggerEventId: accepted.id });
    const olderTurn = fakeTurn({ id: TURN_A, position: 1 });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([olderTurn, steerTurn, fakeTurn({ id: "done", status: "completed" })]);
      }
      if (request.url.endsWith("/turns/reorder")) {
        return jsonResponse([steerTurn, olderTurn]);
      }
      if (request.url.endsWith(`/sessions/${SESSION_ID}`)) {
        return jsonResponse({ id: SESSION_ID, status: "running" });
      }
      throw new Error(`unexpected request: ${request.url}`);
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "do this now");
    expect(result.accepted.id).toBe(accepted.id);
    expect(result.turn?.id).toBe(TURN_B);
    expect(result.interrupted).toBe(true);
    const urls = requests.map((request) => new URL(request.url).pathname);
    expect(urls).toEqual([
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/turns`,
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/turns/reorder`,
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
    ]);
    expect(JSON.parse(requests[2]!.body!)).toEqual({ turnIds: [TURN_B, TURN_A] });
    expect(JSON.parse(requests[4]!.body!)).toEqual({ type: "user.interrupt", payload: { reason: "steer" } });
  });

  test("steerMessage skips the interrupt when the session already claimed the steer turn", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    const steerTurn = fakeTurn({ id: TURN_B, position: 1, triggerEventId: accepted.id });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([steerTurn]);
      }
      // The running turn finished mid-call and the session claimed the steer
      // turn itself: interrupting now would cancel the steered message.
      return jsonResponse({ id: SESSION_ID, status: "running", activeTurnId: TURN_B });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(result.turn?.id).toBe(TURN_B);
    expect(result.interrupted).toBe(false);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(0);
  });

  test("steerMessage retries the turn lookup while the server materializes it", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    const steerTurn = fakeTurn({ id: TURN_B, position: 2, triggerEventId: accepted.id });
    let turnListings = 0;
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        turnListings += 1;
        // First listing races the turn creation; the retry sees it.
        return jsonResponse(turnListings === 1 ? [fakeTurn({ id: TURN_A })] : [fakeTurn({ id: TURN_A }), steerTurn]);
      }
      if (request.url.endsWith("/turns/reorder")) {
        return jsonResponse([steerTurn, fakeTurn({ id: TURN_A, position: 2 })]);
      }
      return jsonResponse({ id: SESSION_ID, status: "running" });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(turnListings).toBe(2);
    expect(result.turn?.id).toBe(TURN_B);
    expect(result.interrupted).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/turns/reorder"))).toBe(true);
  });

  test("steerMessage skips the interrupt when the steer turn cannot be promoted over queued work", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        // The steer turn never shows up, but another queued turn exists:
        // interrupting would promote that one instead of the steer message.
        return jsonResponse([fakeTurn({ id: TURN_A })]);
      }
      return jsonResponse({ id: SESSION_ID, status: "running" });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(result.turn).toBeNull();
    expect(result.interrupted).toBe(false);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(0);
    expect(requests.filter((request) => request.url.endsWith("/turns"))).toHaveLength(4);
  });

  test("steerMessage with an empty queue still interrupts (next claim is the steer turn)", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([fakeTurn({ id: "done", status: "completed" })]);
      }
      return jsonResponse({ id: SESSION_ID, status: "running" });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(result.turn).toBeNull();
    expect(result.interrupted).toBe(true);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(1);
  });

  test("steerMessage skips the interrupt when the steer turn was claimed before it was ever seen queued", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    // The worker claimed the steer turn between sendMessage and the first
    // turns listing: it never appears queued, only running. The queue is
    // empty and the session reads "running" — interrupting here would cancel
    // the steered message itself.
    const claimedSteerTurn = fakeTurn({ id: TURN_B, status: "running", triggerEventId: accepted.id, startedAt: "2026-06-12T00:00:01.000Z" });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([fakeTurn({ id: "done", status: "completed" }), claimedSteerTurn]);
      }
      return jsonResponse({ id: SESSION_ID, status: "running", activeTurnId: TURN_B });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(result.turn?.id).toBe(TURN_B);
    expect(result.turn?.status).toBe("running");
    expect(result.interrupted).toBe(false);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(0);
    expect(requests.filter((request) => request.url.endsWith("/reorder"))).toHaveLength(0);
  });

  test("steerMessage skips the interrupt when the steer turn already finished mid-call", async () => {
    const accepted = makeEvent(9, "user.message", { text: "now" });
    // Fast turn: claimed AND completed before the first listing. The session
    // is already running someone else's next turn — interrupting would cancel
    // unrelated work over a message that was fully delivered.
    const finishedSteerTurn = fakeTurn({ id: TURN_B, status: "completed", triggerEventId: accepted.id, finishedAt: "2026-06-12T00:00:02.000Z" });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([finishedSteerTurn, fakeTurn({ id: TURN_A, status: "running" })]);
      }
      return jsonResponse({ id: SESSION_ID, status: "running", activeTurnId: TURN_A });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(result.turn?.id).toBe(TURN_B);
    expect(result.interrupted).toBe(false);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(0);
  });

  test("steerMessage does not interrupt an idle session", async () => {
    const accepted = makeEvent(3, "user.message", { text: "later" });
    const steerTurn = fakeTurn({ triggerEventId: accepted.id });
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/events")) {
        return jsonResponse(accepted, 202);
      }
      if (request.url.endsWith("/turns")) {
        return jsonResponse([steerTurn]);
      }
      return jsonResponse({ id: SESSION_ID, status: "queued" });
    });
    const result = await client.steerMessage(WORKSPACE_ID, SESSION_ID, "later");
    expect(result.interrupted).toBe(false);
    // Single queued turn: no reorder call, no interrupt call.
    expect(requests.filter((request) => request.url.endsWith("/reorder"))).toHaveLength(0);
    expect(requests.filter((request) => request.body?.includes("user.interrupt"))).toHaveLength(0);
  });
});

describe("OpenGeniClient goals", () => {
  test("getGoal GETs the session goal", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: "goal-1", status: "active" }));
    const goal = await client.getGoal(WORKSPACE_ID, SESSION_ID);
    expect(goal.status).toBe("active");
    expect(requests[0]!.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`);
  });

  test("pauseGoal and resumeGoal PATCH the documented status transitions", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: "goal-1", status: "paused" }));
    await client.pauseGoal(WORKSPACE_ID, SESSION_ID, { rationale: "manual review" });
    await client.resumeGoal(WORKSPACE_ID, SESSION_ID);
    expect(requests[0]!.method).toBe("PATCH");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ status: "paused", rationale: "manual review" });
    expect(JSON.parse(requests[1]!.body!)).toEqual({ status: "active" });
  });
});

describe("OpenGeniClient access + workspaces", () => {
  test("getAccessContext and workspace CRUD hit the expected endpoints", async () => {
    const { client, requests } = makeClient((request) => {
      if (request.url.endsWith("/v1/access/me")) {
        return jsonResponse({ mode: "local", subjectId: "s", accountGrants: [], workspaceGrants: [], defaultAccountId: null, defaultWorkspaceId: null });
      }
      return jsonResponse({ id: WORKSPACE_ID, name: "Ops" });
    });
    await client.getAccessContext();
    await client.listWorkspaces();
    await client.createWorkspace({ name: "Ops" });
    await client.getWorkspace(WORKSPACE_ID);
    await client.updateWorkspace(WORKSPACE_ID, { name: "Ops 2", slug: null });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/access/me",
      "GET /v1/workspaces",
      "POST /v1/workspaces",
      `GET /v1/workspaces/${WORKSPACE_ID}`,
      `PATCH /v1/workspaces/${WORKSPACE_ID}`,
    ]);
    expect(JSON.parse(requests[4]!.body!)).toEqual({ name: "Ops 2", slug: null });
  });

  test("getClientConfig fetches the public bootstrap endpoint and returns the provider-grouped models", async () => {
    const config = {
      deploymentRevision: "rev-1",
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5", "accounts/fireworks/models/glm-5p2"],
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", providerLabel: "OpenAI", api: "responses", contextWindowTokens: 400000 },
        { id: "accounts/fireworks/models/glm-5p2", label: "GLM 5.2", provider: "fireworks", providerLabel: "Fireworks AI", api: "chat", contextWindowTokens: 1048576 },
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
    expect(result.defaultModel).toBe("gpt-5.5");
    expect(result.models.map((model) => `${model.provider}:${model.id}:${model.api}`)).toEqual([
      "openai:gpt-5.5:responses",
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
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
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

describe("OpenGeniClient environments", () => {
  test("environment CRUD + write-only variable PUT/DELETE", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ id: ENVIRONMENT_ID, variables: [] }));
    await client.listEnvironments(WORKSPACE_ID);
    await client.createEnvironment(WORKSPACE_ID, { name: "staging", variables: [{ name: "EXAMPLE_TOKEN", value: "v" }] });
    await client.getEnvironment(WORKSPACE_ID, ENVIRONMENT_ID);
    await client.updateEnvironment(WORKSPACE_ID, ENVIRONMENT_ID, { description: "staging env" });
    await client.setEnvironmentVariable(WORKSPACE_ID, ENVIRONMENT_ID, "EXAMPLE_TOKEN", "v2");
    await client.deleteEnvironmentVariable(WORKSPACE_ID, ENVIRONMENT_ID, "EXAMPLE_TOKEN");
    await client.deleteEnvironment(WORKSPACE_ID, ENVIRONMENT_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/environments`,
      `POST /v1/workspaces/${WORKSPACE_ID}/environments`,
      `GET /v1/workspaces/${WORKSPACE_ID}/environments/${ENVIRONMENT_ID}`,
      `PATCH /v1/workspaces/${WORKSPACE_ID}/environments/${ENVIRONMENT_ID}`,
      `PUT /v1/workspaces/${WORKSPACE_ID}/environments/${ENVIRONMENT_ID}/variables/EXAMPLE_TOKEN`,
      `DELETE /v1/workspaces/${WORKSPACE_ID}/environments/${ENVIRONMENT_ID}/variables/EXAMPLE_TOKEN`,
      `DELETE /v1/workspaces/${WORKSPACE_ID}/environments/${ENVIRONMENT_ID}`,
    ]);
    // The variable PUT sends only the value; nothing else carries the secret.
    expect(JSON.parse(requests[4]!.body!)).toEqual({ value: "v2" });
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
    expect(JSON.parse(requests[0]!.body!)).toEqual({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 11 });
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
        return jsonResponse({ fileId: FILE_ID, uploadId: UPLOAD_ID, putUrl: "https://storage.example.test/put/x", requiredHeaders: {}, expiresAt: "", maxSizeBytes: 1 }, 201);
      }
      return new Response("denied", { status: 403 });
    });
    const error = await client.uploadFile(WORKSPACE_ID, { filename: "a", contentType: "text/plain", data: "x" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(403);
    expect(requests.some((request) => request.url.includes("/complete"))).toBe(false);
  });

  test("getFile and createFileDownloadUrl hit the expected endpoints", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ url: "https://storage.example.test/get/x", expiresAt: "" }));
    await client.getFile(WORKSPACE_ID, FILE_ID);
    await client.createFileDownloadUrl(WORKSPACE_ID, FILE_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/files/${FILE_ID}`,
      `POST /v1/workspaces/${WORKSPACE_ID}/files/${FILE_ID}/download-url`,
    ]);
  });
});

describe("OpenGeniClient documents", () => {
  test("bases, documents, reindex, and search", async () => {
    const { client, requests } = makeClient((request) =>
      request.url.endsWith("/search") ? jsonResponse({ results: [] }) : jsonResponse({ id: BASE_ID }));
    await client.createDocumentBase(WORKSPACE_ID, { name: "runbooks" });
    await client.listDocumentBases(WORKSPACE_ID);
    await client.getDocumentBase(WORKSPACE_ID, BASE_ID);
    await client.addDocument(WORKSPACE_ID, BASE_ID, { fileId: FILE_ID });
    await client.listDocuments(WORKSPACE_ID, BASE_ID);
    await client.reindexDocument(WORKSPACE_ID, BASE_ID, DOCUMENT_ID);
    const search = await client.searchDocuments(WORKSPACE_ID, BASE_ID, { query: "rollback steps", limit: 3 });
    expect(search.results).toEqual([]);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `POST /v1/workspaces/${WORKSPACE_ID}/document-bases`,
      `GET /v1/workspaces/${WORKSPACE_ID}/document-bases`,
      `GET /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}`,
      `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents`,
      `GET /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents`,
      `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents/${DOCUMENT_ID}/reindex`,
      `POST /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/search`,
    ]);
    expect(JSON.parse(requests[6]!.body!)).toEqual({ query: "rollback steps", limit: 3 });
  });

  test("deleteDocument DELETEs the document and resolves on 204", async () => {
    const { client, requests } = makeClient(() => new Response(null, { status: 204 }));
    await client.deleteDocument(WORKSPACE_ID, BASE_ID, DOCUMENT_ID);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `DELETE /v1/workspaces/${WORKSPACE_ID}/document-bases/${BASE_ID}/documents/${DOCUMENT_ID}`,
    ]);
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
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/packs`,
      `POST /v1/workspaces/${WORKSPACE_ID}/packs`,
      `GET /v1/workspaces/${WORKSPACE_ID}/packs/acme`,
      `POST /v1/workspaces/${WORKSPACE_ID}/packs/acme/enable`,
      `GET /v1/workspaces/${WORKSPACE_ID}/packs/installations`,
      `DELETE /v1/workspaces/${WORKSPACE_ID}/packs/acme`,
    ]);
    expect(JSON.parse(requests[3]!.body!)).toEqual({ environmentId: ENVIRONMENT_ID });
  });
});

describe("OpenGeniClient capabilities", () => {
  test("list, create, enable, disable, and registry discovery (id is URL-encoded)", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ items: [], installations: [] }));
    await client.listCapabilities(WORKSPACE_ID);
    await client.createCapability(WORKSPACE_ID, { kind: "mcp", name: "Acme MCP", endpointUrl: "https://mcp.example.test" });
    await client.enableCapability(WORKSPACE_ID, "mcp:acme/tools", { headers: { Authorization: "Bearer t" } });
    await client.disableCapability(WORKSPACE_ID, "mcp:acme/tools");
    await client.discoverMcpCapabilities(WORKSPACE_ID, { query: "github", limit: 10 });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
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
    await client.createGitHubAppManifest(WORKSPACE_ID, { organization: "acme" });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/github/app`,
      `GET /v1/workspaces/${WORKSPACE_ID}/github/repositories`,
      `POST /v1/workspaces/${WORKSPACE_ID}/github/repositories/sync`,
      `POST /v1/workspaces/${WORKSPACE_ID}/github/app-manifest`,
    ]);
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
    const created = await client.createApiKey(WORKSPACE_ID, { name: "ci", permissions: ["sessions:read"] });
    expect(created.token).toBe("ogk_secret");
    await client.deleteApiKey(WORKSPACE_ID, "key-1");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/api-keys`,
      `POST /v1/workspaces/${WORKSPACE_ID}/api-keys`,
      `DELETE /v1/workspaces/${WORKSPACE_ID}/api-keys/key-1`,
    ]);
  });
});

describe("OpenGeniClient billing", () => {
  test("billing reads pass account/workspace selectors as query params", async () => {
    const { client, requests } = makeClient(() => jsonResponse({ mode: "stripe", balance: null, usage: [], entitlements: {} }));
    await client.getBilling({ accountId: "acc-1" });
    await client.getBillingUsage({ accountId: "acc-1", workspaceId: WORKSPACE_ID });
    await client.getBillingEntitlements();
    await client.createBillingCheckout({ amountUsd: 25 });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      "GET /v1/billing?accountId=acc-1",
      `GET /v1/billing/usage?accountId=acc-1&workspaceId=${WORKSPACE_ID}`,
      "GET /v1/billing/entitlements",
      "POST /v1/billing/checkout",
    ]);
    expect(JSON.parse(requests[3]!.body!)).toEqual({ amountUsd: 25 });
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
