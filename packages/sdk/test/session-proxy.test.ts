import { describe, expect, spyOn, test } from "bun:test";
import { Opengeni } from "../src/chat";
import { OpenGeniApiError } from "../src/errors";
import {
  OpenGeniClient,
  artifactViewerCapability,
  createSessionProxyHandler,
  type ClientSessionEventInput,
  type SessionProxyHandlerOptions,
  type SessionProxyMessageInput,
} from "../src/index";
import { parseSseStream } from "../src/sse";
import { OPENGENI_API_CONTRACT_REVISION, type ClientConfig } from "../src/types";
import {
  SESSION_PROXY_SITE_HTML_MAX_BYTES,
  SessionProxySiteHtmlTooLargeError,
} from "../src/session-proxy";
import { hangingBytesStream, makeEvent, SESSION_ID, sseBlock, WORKSPACE_ID } from "./helpers";

/** The artifact-viewer capability, or undefined when the proxy reports none. */
function viewer(config: { artifacts?: ClientConfig["artifacts"] }) {
  return config.artifacts || undefined;
}

const OTHER_WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";
const EDITABLE_ID = "0123456789abcdef0123456789abcdef";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "https://product.example.test";
const REALTIME_ID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const OWNER = { browserInstanceId: "browser-1", ownerKey: "k".repeat(32) };
const VOICE_MODEL = {
  id: "opengeni-azure/gpt-live-1",
  label: "GPT Live 1",
  provider: "OpenGeni",
  description: "Realtime voice with session delegation",
  available: true,
  unavailableReason: null,
  recommended: true,
};
const API = "https://api.example.test";
const RESPONSE_EVENTS = [
  {
    label: "approval",
    event: {
      type: "user.approvalDecision",
      clientEventId: "approval-retry",
      payload: { approvalId: "tool-call-1", decision: "approve", message: "Proceed" },
    },
  },
  {
    label: "human-input",
    event: {
      type: "user.humanInputResponse",
      clientEventId: "human-input-retry",
      payload: {
        requestId: "request-1",
        response: {
          outcome: "answered",
          answers: [{ questionId: "question-1", values: ["yes"], other: "Keep this answer" }],
        },
      },
    },
  },
] satisfies Array<{
  label: string;
  event: ClientSessionEventInput;
}>;

type Recorded = { method: string; url: URL; headers: Headers; body: unknown };

function upstreamServer() {
  const requests: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const multipart = /^multipart\/form-data/i.test(request.headers.get("content-type") ?? "");
    const text = request.method === "GET" || multipart ? "" : await request.text();
    requests.push({
      method: request.method,
      url,
      headers: request.headers,
      body: multipart ? await request.formData() : text ? JSON.parse(text) : undefined,
    });
    const path = url.pathname;
    if (path.endsWith("/goal") && request.method === "GET" && url.searchParams.has("absent")) {
      // A goal-less session read through the `absent=null` opt-in.
      return Response.json(null);
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/realtime-model-catalog`) {
      return Response.json({ models: [VOICE_MODEL] });
    }
    if (path.endsWith("/mcp-credentials/rotate")) {
      return Response.json({
        operationKey: "k",
        sessionId: SESSION_ID,
        servers: [],
        appliedAt: "",
      });
    }
    if (path.includes(`/sessions/${SESSION_ID}/realtime`)) {
      return Response.json({ mode: { id: REALTIME_ID, state: "active" }, replay: false });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/transcriptions`) {
      return Response.json({ text: "transcribed words", languages: ["en"] });
    }
    if (path.endsWith("/live-events/stream")) {
      const control = {
        id: "33333333-3333-4333-8333-333333333333",
        type: "workspace.control.changed",
        workspaceId: WORKSPACE_ID,
        sequence: 4,
      };
      return new Response(
        hangingBytesStream(
          [`event: ${control.type}\ndata: ${JSON.stringify(control)}\n\n`],
          request.signal,
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (path.endsWith("/events/stream")) {
      return new Response(
        hangingBytesStream([sseBlock(makeEvent(6)), sseBlock(makeEvent(7))], request.signal),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (path.endsWith("/events") && request.method === "GET") {
      return Response.json([makeEvent(1)], {
        headers: {
          "X-OpenGeni-Has-More": "true",
          "X-OpenGeni-Next-Before": "1",
          // Upstream's own revision header must stay behind the proxy.
          "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION,
        },
      });
    }
    if (path === "/v1/access/me") {
      return Response.json({
        subjectId: "subject-u42",
        accountGrants: [],
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: "acct-1",
            subjectId: "subject-u42",
            permissions: ["sessions:read", "artifacts:read"],
          },
        ],
      });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/access/grant`) {
      return Response.json({
        workspaceId: WORKSPACE_ID,
        accountId: "acct-1",
        subjectId: "subject-u42",
        permissions: ["sessions:read", "artifacts:read"],
      });
    }
    if (path.endsWith("/access/grant")) {
      return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    }
    if (path.includes("/artifact-associations/")) {
      return path.endsWith(`/${EDITABLE_ID}`) || path.endsWith(`/${SITE_ID}`)
        ? Response.json({
            sessionId: SESSION_ID,
            artifactId: path.endsWith(EDITABLE_ID) ? EDITABLE_ID : SITE_ID,
            kind: path.endsWith(EDITABLE_ID) ? "editable" : "site",
          })
        : Response.json({ error: { code: "artifact_not_found" } }, { status: 404 });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/editable-artifacts` && request.method === "GET") {
      return Response.json({ artifacts: [{ id: EDITABLE_ID, title: "Weekly report" }] });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/artifact-catalog`) {
      return Response.json({ items: [{ id: SITE_ID, kind: "site" }], nextCursor: null });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}/html`) {
      return new Response("<h1>Dashboard</h1>", { headers: { "Content-Type": "text/html" } });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions` && request.method === "GET") {
      return Response.json({
        ...(url.searchParams.get("createdByKind") ? { filtersApplied: true } : {}),
        pinned: [{ id: "pinned-other" }],
        sessions: [{ id: SESSION_ID }],
        nextCursor: null,
      });
    }
    if (path === "/v1/config/client") {
      return Response.json({
        apiContractRevision: "upstream-deployed-later",
        defaultModel: "m",
        voiceInput: {
          available: true,
          maxDurationSeconds: 60,
          maxSizeBytes: 1024,
          acceptedMimeTypes: ["audio/webm"],
          resumable: { maxDurationSeconds: 600, maxSizeBytes: 4096, maxChunkSizeBytes: 512 },
        },
      });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions` && request.method === "POST") {
      return Response.json({ session: { id: SESSION_ID } });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue`) {
      return Response.json(
        { error: { code: "session_not_found", message: "Session not found." } },
        { status: 404 },
      );
    }
    return Response.json({ id: SESSION_ID, workspaceId: WORKSPACE_ID, status: "idle" });
  };
  return { requests, fetch };
}

function setup(overrides: Partial<SessionProxyHandlerOptions> = {}) {
  const upstream = upstreamServer();
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_org_key", fetch: upstream.fetch });
  const handler = createSessionProxyHandler(service, {
    resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
    ...overrides,
  });
  // The unmodified browser client, pointed at the same-origin mount.
  const browser = new OpenGeniClient({
    baseUrl: `${PRODUCT}/api/opengeni`,
    fetch: async (input, init) => await handler(new Request(input, init)),
  });
  return { upstream, handler, browser };
}

async function rejection(promise: Promise<unknown>): Promise<OpenGeniApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenGeniApiError) return error;
    throw error;
  }
  throw new Error("expected the request to be rejected");
}

describe("createSessionProxyHandler", () => {
  test("upstream capabilities cannot enable artifacts on this product proxy", async () => {
    for (const enabled of [false, true]) {
      const upstream = upstreamServer();
      const service = new OpenGeniClient({
        baseUrl: API,
        apiKey: "og_org_key",
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname;
          if (path === "/v1/config/client")
            return Response.json({
              apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
              artifacts: {
                editableLiveUrl: "wss://untrusted.example/",
                cachePartition: {
                  accountId: "other",
                  principalId: "other",
                  authorizationEpoch: "other",
                },
              },
            });
          if (path.endsWith("/access/grant")) return Response.json({}, { status: 404 });
          return upstream.fetch(input, init);
        },
      });
      const handler = createSessionProxyHandler(service, {
        artifacts: enabled,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
      });
      const response = await handler(new Request(`${PRODUCT}/api/opengeni/v1/config/client`));
      expect(response.status).toBe(200);
      expect((await response.json()).artifacts).toBe(false);
    }
  });

  test("old APIs keep conversation bootstrap while artifact capability fails closed", async () => {
    const upstream = upstreamServer();
    let supported = false;
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (
          !supported &&
          (path.endsWith("/access/grant") || path.includes("/artifact-associations/"))
        ) {
          return Response.json(
            { error: { code: "not_found", message: "Not found." } },
            { status: 404 },
          );
        }
        return upstream.fetch(input, init);
      },
    });
    const handler = createSessionProxyHandler(service, {
      artifacts: true,
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const browser = new OpenGeniClient({
      baseUrl: `${PRODUCT}/api/opengeni`,
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const config = await browser.getClientConfig();
    expect(config.artifacts).toBe(false);
    expect(config.apiContractRevision).toBe(OPENGENI_API_CONTRACT_REVISION);
    expect((await browser.getSession(WORKSPACE_ID, SESSION_ID)).id).toBe(SESSION_ID);
    const artifact = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${EDITABLE_ID}`,
        { headers: { "x-opengeni-session-id": SESSION_ID } },
      ),
    );
    expect(artifact.status).toBe(404);
    expect(
      upstream.requests.some((request) =>
        request.url.pathname.endsWith(`/editable-artifacts/${EDITABLE_ID}`),
      ),
    ).toBe(false);
    // A deployment upgrade is discovered without a sticky negative cache.
    supported = true;
    expect(viewer(await browser.getClientConfig())?.cachePartition.principalId).toBe("subject-u42");
  });

  test("viewer negotiation does not turn permission or transient errors into missing capability", async () => {
    for (const status of [403, 503]) {
      const upstream = upstreamServer();
      const service = new OpenGeniClient({
        baseUrl: API,
        apiKey: "og_org_key",
        fetch: async (input, init) => {
          if (
            new URL(input instanceof Request ? input.url : input).pathname.endsWith("/access/grant")
          ) {
            return Response.json({ error: { code: "denied_or_unavailable" } }, { status });
          }
          return upstream.fetch(input, init);
        },
      });
      const handler = createSessionProxyHandler(service, {
        artifacts: true,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
      });
      expect((await handler(new Request(`${PRODUCT}/api/opengeni/v1/config/client`))).status).toBe(
        status,
      );
    }
  });
  test("returns the host's 401 and never calls Opengeni without authentication", async () => {
    const { upstream, browser } = setup({
      resolve: () => new Response("Unauthorized", { status: 401 }),
    });
    const error = await rejection(browser.getSession(WORKSPACE_ID, SESSION_ID));
    expect(error.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  test("an upstream 401 keeps its status and tells the developer once to replace the key", async () => {
    const rejected = async () =>
      Response.json(
        {
          error: {
            status: 401,
            code: "unauthenticated",
            message: "authentication required",
            retryable: false,
            requestId: "eb32912d-1acd-44f5-9830-b0bf629f32a3",
          },
        },
        { status: 401 },
      );
    const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_expired", fetch: rejected });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await handler(new Request(`${PRODUCT}/api/opengeni/v1/config/client`));
        expect(response.status).toBe(401);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "unauthenticated",
        );
      }
      const notices = warn.mock.calls.filter((call) =>
        String(call[0]).includes("rejected the session proxy's API key"),
      );
      expect(notices).toHaveLength(1);
      expect(String(notices[0]![0])).toContain("Organization settings > Developer");
      expect(String(notices[0]![0])).toContain("eb32912d-1acd-44f5-9830-b0bf629f32a3");
    } finally {
      warn.mockRestore();
    }
  });

  test("a missing API key fails requests, not module load, and names the env var in the server log", async () => {
    // `new Opengeni({ apiKey: process.env.OPENGENI_API_KEY! })` runs at module
    // scope in a Next.js route; `next build` imports it without runtime secrets.
    const og = new Opengeni({ apiKey: undefined as unknown as string, organizationId: "org" });
    const handler = createSessionProxyHandler(og, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const logged = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await handler(new Request(`${PRODUCT}/api/opengeni/v1/config/client`));
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "proxy_error",
      );
      expect(logged.mock.calls.map((call) => String(call[1]))).toContain(
        "TypeError: Opengeni requires an apiKey. Set OPENGENI_API_KEY in the server environment.",
      );
    } finally {
      logged.mockRestore();
    }
  });

  test("a resolution without a user is rejected instead of using service authority", async () => {
    const { upstream, browser } = setup({
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "" }),
    });
    expect((await rejection(browser.getSession(WORKSPACE_ID, SESSION_ID))).status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  test("rejects a workspace other than the resolved one", async () => {
    const { upstream, browser } = setup();
    const error = await rejection(browser.getSession(OTHER_WORKSPACE_ID, SESSION_ID));
    expect(error.status).toBe(403);
    expect(error.code).toBe("workspace_not_allowed");
    expect(upstream.requests).toHaveLength(0);
  });

  test("rejects routes outside the conversation allowlist", async () => {
    const { upstream, browser, handler } = setup();
    for (const attempt of [
      browser.listScheduledTasks(WORKSPACE_ID),
      browser.cancelSession(WORKSPACE_ID, SESSION_ID),
      browser.getSessionModelContext(WORKSPACE_ID, SESSION_ID),
      browser.listEvents(WORKSPACE_ID, SESSION_ID, { mode: "forensic" }),
    ]) {
      expect([403, 404]).toContain((await rejection(attempt)).status);
    }
    const traversal = await handler(
      new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/..%2F..%2Fkeys`),
    );
    expect(traversal.status).toBe(404);
    const deleted = await handler(
      new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`, {
        method: "DELETE",
      }),
    );
    // DELETE reaches routing only to clear a goal; nothing else is deletable.
    expect(deleted.status).toBe(404);
    const options = await handler(
      new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}`, { method: "OPTIONS" }),
    );
    expect(options.status).toBe(405);
    expect(options.headers.get("allow")).toBe("GET, POST, PUT, PATCH, DELETE");
    expect(upstream.requests).toHaveLength(0);
  });

  test("goal controls: read, pause/resume only, and clear", async () => {
    const { upstream, browser, handler } = setup();
    const goal = `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`;
    await browser.getGoal(WORKSPACE_ID, SESSION_ID);
    await browser.pauseGoal(WORKSPACE_ID, SESSION_ID, { rationale: "end-user text" });
    await browser.resumeGoal(WORKSPACE_ID, SESSION_ID);
    await browser.deleteGoal(WORKSPACE_ID, SESSION_ID);
    expect(
      upstream.requests.map((request) => [request.method, request.url.pathname, request.body]),
    ).toEqual([
      ["GET", goal, undefined],
      ["PATCH", goal, { status: "paused" }],
      ["PATCH", goal, { status: "active" }],
      ["DELETE", goal, undefined],
    ]);
    upstream.requests.length = 0;
    // The objective, limits, completion and rationale stay server-side.
    for (const body of [
      { status: "completed" },
      { objective: "Something else" },
      { status: "active", maxAutoContinuations: 99 },
    ]) {
      const refused = await rejection(browser.updateGoal(WORKSPACE_ID, SESSION_ID, body as never));
      expect(refused.status).toBe(403);
      expect(refused.code).toBe("goal_update_not_allowed");
    }
    // Goal revisions stay out of the browser boundary, and DELETE only clears.
    expect((await rejection(browser.listGoalRevisions(WORKSPACE_ID, SESSION_ID))).status).toBe(404);
    for (const path of [
      `${goal}/revisions`,
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue`,
    ]) {
      const response = await handler(
        new Request(`${PRODUCT}/api/opengeni${path}`, { method: "DELETE" }),
      );
      expect(response.status).toBe(404);
    }
    expect(upstream.requests).toHaveLength(0);
    // A product-level session check guards the goal too.
    const guarded = setup({ authorizeSession: () => false });
    expect((await rejection(guarded.browser.deleteGoal(WORKSPACE_ID, SESSION_ID))).status).toBe(
      404,
    );
    expect(guarded.upstream.requests).toHaveLength(0);
  });

  test("goal read forwards the absent=null opt-in so a goal-less session is a 200 null", async () => {
    const { upstream, browser } = setup();
    expect(await browser.findGoal(WORKSPACE_ID, SESSION_ID)).toBeNull();
    const [request] = upstream.requests;
    expect(request!.method).toBe("GET");
    expect(request!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`,
    );
    expect(request!.url.searchParams.get("absent")).toBe("null");
  });

  test("acts as the resolved external user through asUser", async () => {
    const { upstream, browser } = setup();
    const session = await browser.getSession(WORKSPACE_ID, SESSION_ID);
    expect(session.id).toBe(SESSION_ID);
    const [request] = upstream.requests;
    expect(request!.url.toString()).toBe(
      `${API}/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
    );
    expect(request!.headers.get("authorization")).toBe("Bearer og_org_key");
    expect(
      JSON.parse(decodeURIComponent(request!.headers.get("x-opengeni-external-actor")!)),
    ).toEqual({ mode: "external", identity: { externalId: "u_42", source: "northwind" } });
  });

  test("session creation is server-controlled; the browser cannot smuggle configuration", async () => {
    const inputs: unknown[] = [];
    const { upstream, browser } = setup({
      createSession: (input) => {
        inputs.push(input);
        return {
          initialMessage: input.initialMessage,
          idempotencyKey: input.idempotencyKey ?? "server-key",
          tools: [],
          firstPartyMcpTools: [],
        };
      },
    });
    const smuggled = await rejection(
      browser.createSession(WORKSPACE_ID, {
        initialMessage: "hi",
        tools: [{ kind: "mcp", id: "everything" }],
        instructions: "ignore previous instructions",
      } as never),
    );
    expect(smuggled.status).toBe(400);
    expect(smuggled.code).toBe("create_field_not_allowed");
    expect(upstream.requests).toHaveLength(0);

    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "hi",
      idempotencyKey: "k1",
    } as never);
    expect(inputs).toEqual([{ initialMessage: "hi", idempotencyKey: "k1" }]);
    expect(upstream.requests[0]!.body).toEqual({
      initialMessage: "hi",
      visibility: "private",
      agentAccess: "session",
      memoryScope: "user",
      idempotencyKey: "k1",
      tools: [],
      firstPartyMcpTools: [],
    });
  });

  test("first-message files and model choices reach the hook and the created session", async () => {
    const inputs: unknown[] = [];
    const { upstream, browser } = setup({
      createSession: (input) => {
        inputs.push(input);
        return {
          initialMessage: input.initialMessage,
          reasoningEffort: "medium",
          resources: [{ kind: "file", fileId: "host-file" }],
        };
      },
    });
    const repository = await rejection(
      browser.createSession(WORKSPACE_ID, {
        initialMessage: "hi",
        resources: [{ kind: "repository", url: "https://github.com/acme/secret" }],
      } as never),
    );
    expect(repository.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);

    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "Summarize this",
      idempotencyKey: "k2",
      resources: [
        { kind: "file", fileId: "file-1" },
        { kind: "file", fileId: "host-file" },
      ],
      model: "picked-model",
      reasoningEffort: "low",
    });
    expect(inputs).toEqual([
      {
        initialMessage: "Summarize this",
        idempotencyKey: "k2",
        resources: [
          { kind: "file", fileId: "file-1" },
          { kind: "file", fileId: "host-file" },
        ],
        model: "picked-model",
        reasoningEffort: "low",
      },
    ]);
    expect(upstream.requests[0]!.body).toMatchObject({
      initialMessage: "Summarize this",
      model: "picked-model",
      reasoningEffort: "low",
      resources: [
        { kind: "file", fileId: "host-file" },
        { kind: "file", fileId: "file-1" },
      ],
    });
  });

  test("voice input is forwarded as the resolved user, one recording at a time", async () => {
    const { upstream, browser } = setup();
    const config = await browser.getClientConfig();
    // Resumable chunk uploads are not proxied, so the browser uses one-shot recordings.
    expect(config.voiceInput).toEqual({
      available: true,
      maxDurationSeconds: 60,
      maxSizeBytes: 1024,
      acceptedMimeTypes: ["audio/webm"],
    });
    const result = await browser.transcribeAudio(WORKSPACE_ID, {
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
      durationSeconds: 2,
    });
    expect(result.text).toBe("transcribed words");
    const forwarded = upstream.requests.find((request) =>
      request.url.pathname.endsWith("/transcriptions"),
    )!;
    expect(forwarded.url.pathname).toBe(`/v1/workspaces/${WORKSPACE_ID}/transcriptions`);
    expect(
      JSON.parse(decodeURIComponent(forwarded.headers.get("x-opengeni-external-actor")!)),
    ).toEqual({ mode: "external", identity: { externalId: "u_42", source: "northwind" } });
    const form = forwarded.body as FormData;
    expect((form.get("audio") as File).size).toBe(3);
    expect(form.get("mimeType")).toBe("audio/webm");
    expect(form.get("durationSeconds")).toBe("2");

    const other = await rejection(
      browser.transcribeAudio(OTHER_WORKSPACE_ID, {
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      }),
    );
    expect(other.status).toBe(403);
  });

  test("voiceInput: false reports voice unavailable and refuses recordings", async () => {
    const { upstream, browser } = setup({ voiceInput: false });
    expect((await browser.getClientConfig()).voiceInput?.available).toBe(false);
    const refused = await rejection(
      browser.transcribeAudio(WORKSPACE_ID, {
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      }),
    );
    expect(refused.status).toBe(404);
    expect(
      upstream.requests.some((request) => request.url.pathname.endsWith("/transcriptions")),
    ).toBe(false);
  });

  test("live voice routes are forwarded unchanged as the resolved user", async () => {
    const checked: string[] = [];
    const { upstream, browser } = setup({
      authorizeSession: (sessionId) => {
        checked.push(sessionId);
        return true;
      },
    });
    expect((await browser.getClientConfig()).realtimeVoice).toBeUndefined();
    const catalog = await browser.getWorkspaceRealtimeModelCatalog(WORKSPACE_ID);
    expect(catalog.models.map((model) => model.id)).toEqual(["opengeni-azure/gpt-live-1"]);
    const connect = {
      ...OWNER,
      realtimeId: REALTIME_ID,
      operationId: OPERATION_ID,
      expectedVersion: 1,
      expectedConnectionEpoch: 1,
      rotate: false,
    };
    const begin = { ...OWNER, operationId: OPERATION_ID, model: "opengeni-azure/gpt-live-1" };
    const webrtc = { ...connect, sdp: "v=0", version: "v3", browserActivation: "required" };
    const activate = {
      ...OWNER,
      operationId: OPERATION_ID,
      connectionEpoch: 2,
      expectedVersion: 1,
      expectedConnectionEpoch: 1,
    };
    const heartbeat = { ...OWNER, expectedVersion: 2 };
    const sync = {
      ...OWNER,
      expectedVersion: 2,
      connectionId: CONNECTION_ID,
      connectionEpoch: 2,
      entries: [
        {
          operationId: OPERATION_ID,
          kind: "delegation_call",
          text: "Invoices",
          modelContext: "Row 7",
        },
      ],
      clientAckThroughSequence: 3,
    };
    const end = { ...OWNER, expectedVersion: 2, reason: "user_stop" };
    const calls: Array<[string, string, unknown, () => Promise<unknown>]> = [
      [
        "POST",
        "realtime",
        begin,
        () => browser.beginSessionRealtime(WORKSPACE_ID, SESSION_ID, begin as never),
      ],
      [
        "POST",
        "realtime/webrtc",
        webrtc,
        () => browser.negotiateCodexRealtimeWebrtc(WORKSPACE_ID, SESSION_ID, webrtc as never),
      ],
      [
        "POST",
        "realtime/gateway",
        connect,
        () => browser.negotiateGatewayRealtime(WORKSPACE_ID, SESSION_ID, connect),
      ],
      [
        "POST",
        "realtime/supergrok",
        connect,
        () => browser.negotiateXaiSubscriptionRealtime(WORKSPACE_ID, SESSION_ID, connect),
      ],
      [
        "POST",
        `realtime/${REALTIME_ID}/connections/${CONNECTION_ID}/activate`,
        activate,
        () =>
          browser.activateCodexRealtimeConnection(
            WORKSPACE_ID,
            SESSION_ID,
            REALTIME_ID,
            CONNECTION_ID,
            activate,
          ),
      ],
      [
        "PATCH",
        `realtime/${REALTIME_ID}/heartbeat`,
        heartbeat,
        () => browser.heartbeatSessionRealtime(WORKSPACE_ID, SESSION_ID, REALTIME_ID, heartbeat),
      ],
      [
        "POST",
        `realtime/${REALTIME_ID}/sync`,
        sync,
        () =>
          browser.syncSessionRealtimeLedger(WORKSPACE_ID, SESSION_ID, REALTIME_ID, sync as never),
      ],
      [
        "DELETE",
        `realtime/${REALTIME_ID}`,
        end,
        () => browser.endSessionRealtime(WORKSPACE_ID, SESSION_ID, REALTIME_ID, end as never),
      ],
    ];
    for (const [method, path, body, call] of calls) {
      const before = upstream.requests.length;
      await call();
      const forwarded = upstream.requests.slice(before);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]!.method).toBe(method);
      expect(forwarded[0]!.url.pathname).toBe(
        `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/${path}`,
      );
      expect(forwarded[0]!.body).toEqual(body);
      expect(
        JSON.parse(decodeURIComponent(forwarded[0]!.headers.get("x-opengeni-external-actor")!)),
      ).toEqual({ mode: "external", identity: { externalId: "u_42", source: "northwind" } });
    }
    expect(checked).toEqual(calls.map(() => SESSION_ID));
  });

  test("live voice routes are exact and keep the session check", async () => {
    const session = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`;
    const send = (
      handler: (request: Request) => Promise<Response>,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      handler(
        new Request(`${session}/${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const denied = setup({ authorizeSession: () => false });
    const refused = await send(denied.handler, "POST", "realtime", OWNER);
    expect(refused.status).toBe(404);
    expect((await refused.json()).error.code).toBe("session_not_found");
    const open = setup();
    for (const [method, path] of [
      ["GET", "realtime"],
      ["DELETE", "realtime"],
      ["POST", `realtime/${REALTIME_ID}`],
      ["POST", "realtime/codex"],
      ["POST", `realtime/${REALTIME_ID}/heartbeat`],
      ["PATCH", `realtime/${REALTIME_ID}/sync`],
      ["POST", `realtime/${REALTIME_ID}/connections/${CONNECTION_ID}`],
      ["POST", `realtime/${REALTIME_ID}/ledger`],
    ] as const) {
      expect((await send(open.handler, method, path, OWNER)).status).toBe(404);
    }
    expect((await send(open.handler, "POST", "realtime")).status).toBe(400);
    expect(denied.upstream.requests).toHaveLength(0);
    expect(open.upstream.requests).toHaveLength(0);
  });

  test("only an explicit realtimeVoice: true offers voice to stock UIs", async () => {
    expect((await setup().browser.getClientConfig()).realtimeVoice).toBeUndefined();
    expect((await setup({ realtimeVoice: true }).browser.getClientConfig()).realtimeVoice).toBe(
      true,
    );
  });

  test("anonymous visitors cannot upload unless visitorUploads is set", async () => {
    const visitor = {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "visitor:abc", visitor: true }),
    };
    const upload = (handler: (request: Request) => Promise<Response>, path: string) =>
      handler(
        new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/files/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope: "session",
            filename: "a.txt",
            contentType: "text/plain",
            sizeBytes: 1,
          }),
        }),
      );
    const refused = setup(visitor);
    expect((await refused.browser.getClientConfig()).fileUploads?.enabled).toBe(false);
    expect((await upload(refused.handler, "uploads")).status).toBe(404);
    expect((await upload(refused.handler, "uploads/up_1/complete")).status).toBe(404);
    expect(refused.upstream.requests.some((r) => r.url.pathname.includes("/files/uploads"))).toBe(
      false,
    );
    // Agent-produced files still download.
    await refused.browser.createFileDownloadUrl(
      WORKSPACE_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(refused.upstream.requests.at(-1)!.url.pathname).toContain("/download-url");

    const allowed = setup({ ...visitor, visitorUploads: true });
    expect((await allowed.browser.getClientConfig()).fileUploads?.enabled).not.toBe(false);
    await upload(allowed.handler, "uploads");
    expect(allowed.upstream.requests.at(-1)!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/files/uploads`,
    );

    // Signed-in users follow `files`; `files: false` now also reports uploads off.
    expect((await setup().browser.getClientConfig()).fileUploads?.enabled).not.toBe(false);
    expect((await setup({ files: false }).browser.getClientConfig()).fileUploads?.enabled).toBe(
      false,
    );
  });

  test("realtimeVoice: false reports voice off and refuses every voice route", async () => {
    const { upstream, browser } = setup({ realtimeVoice: false });
    expect((await browser.getClientConfig()).realtimeVoice).toBe(false);
    const catalog = await rejection(browser.getWorkspaceRealtimeModelCatalog(WORKSPACE_ID));
    expect(catalog.status).toBe(404);
    const begin = await rejection(
      browser.beginSessionRealtime(WORKSPACE_ID, SESSION_ID, {
        ...OWNER,
        operationId: OPERATION_ID,
        model: "opengeni-azure/gpt-live-1",
      }),
    );
    expect(begin.status).toBe(404);
    const end = await rejection(
      browser.endSessionRealtime(WORKSPACE_ID, SESSION_ID, REALTIME_ID, {
        ...OWNER,
        expectedVersion: 1,
        reason: "user_stop",
      }),
    );
    expect(end.status).toBe(404);
    expect(upstream.requests.some((request) => request.url.pathname.includes("realtime"))).toBe(
      false,
    );
  });

  test("beforeForwardMessage gates voice start and adds context to spoken messages", async () => {
    const inputs: unknown[] = [];
    let refuse = false;
    const { upstream, browser } = setup({
      beforeForwardMessage: (input) => {
        inputs.push(input);
        if (refuse) return new Response("Plan required", { status: 402 });
        return { modelContext: "Page: /billing" };
      },
    });
    const begin = () =>
      browser.beginSessionRealtime(WORKSPACE_ID, SESSION_ID, {
        ...OWNER,
        operationId: OPERATION_ID,
        model: "opengeni-azure/gpt-live-1",
      });
    const sync = (entries: unknown[]) =>
      browser.syncSessionRealtimeLedger(WORKSPACE_ID, SESSION_ID, REALTIME_ID, {
        ...OWNER,
        expectedVersion: 2,
        connectionId: CONNECTION_ID,
        connectionEpoch: 2,
        entries: entries as never,
      });
    await begin();
    // Acks and interruptions carry no message, so the hook is not consulted.
    await sync([]);
    await sync([{ operationId: OPERATION_ID, kind: "interruption" }]);
    expect(inputs).toEqual([{ sessionId: SESSION_ID, delivery: "realtime" }]);
    await sync([
      { operationId: OPERATION_ID, kind: "delegation_call", text: "a", modelContext: "Row 7" },
      { operationId: OPERATION_ID, kind: "user_transcript", role: "user", text: "b" },
      { operationId: OPERATION_ID, kind: "interruption" },
    ]);
    expect((upstream.requests.at(-1)!.body as { entries: unknown[] }).entries).toEqual([
      {
        operationId: OPERATION_ID,
        kind: "delegation_call",
        text: "a",
        modelContext: "Page: /billing\n\nRow 7",
      },
      {
        operationId: OPERATION_ID,
        kind: "user_transcript",
        role: "user",
        text: "b",
        modelContext: "Page: /billing",
      },
      { operationId: OPERATION_ID, kind: "interruption" },
    ]);
    refuse = true;
    const count = upstream.requests.length;
    expect((await rejection(begin())).status).toBe(402);
    const spoken = sync([{ operationId: OPERATION_ID, kind: "delegation_call", text: "a" }]);
    expect((await rejection(spoken)).status).toBe(402);
    expect(upstream.requests).toHaveLength(count);
  });

  test("voice start refreshes the session's MCP credentials best-effort", async () => {
    const rotations: unknown[] = [];
    let rotateStatus = 200;
    const upstream = upstreamServer();
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/mcp-credentials/rotate")) {
          rotations.push(await request.clone().json());
          if (rotateStatus !== 200) {
            return Response.json(
              { error: { code: "SESSION_MCP_CREDENTIALS_BUSY", message: "busy" } },
              { status: rotateStatus },
            );
          }
        }
        if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`) {
          return Response.json({
            id: SESSION_ID,
            workspaceId: WORKSPACE_ID,
            status: "idle",
            mcpServers: [{ id: "crm", url: "https://crm.example.test/mcp", credentialVersion: 3 }],
          });
        }
        return upstream.fetch(request);
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
      beforeForwardMessage: () => ({
        mcpCredentialUpdates: [
          { id: "crm", headers: { Authorization: "Bearer fresh" } },
          { id: "not-attached", headers: { Authorization: "Bearer other" } },
        ],
      }),
    });
    const browser = new OpenGeniClient({
      baseUrl: `${PRODUCT}/api/opengeni`,
      fetch: async (input, init) => await handler(new Request(input, init)),
    });
    const begin = () =>
      browser.beginSessionRealtime(WORKSPACE_ID, SESSION_ID, {
        ...OWNER,
        operationId: OPERATION_ID,
        model: "opengeni-azure/gpt-live-1",
      });
    await begin();
    expect(rotations).toEqual([
      {
        operationKey: expect.any(String),
        updates: [
          {
            id: "crm",
            expectedCredentialVersion: 3,
            expectedServerUrl: "https://crm.example.test/mcp",
            headers: { Authorization: "Bearer fresh" },
          },
        ],
      },
    ]);
    // A running turn refuses rotation; the call still starts.
    rotateStatus = 409;
    await begin();
    expect(rotations).toHaveLength(2);
    const begun = upstream.requests.filter((request) => request.url.pathname.endsWith("/realtime"));
    expect(begun).toHaveLength(2);
  });

  test("creation is unavailable unless the server supplies a createSession hook", async () => {
    const { upstream, browser } = setup();
    expect(
      (await rejection(browser.createSession(WORKSPACE_ID, { initialMessage: "hi" } as never)))
        .status,
    ).toBe(404);
    expect(upstream.requests).toHaveLength(0);
    // Reported so stock UIs hide "New chat" instead of failing on send.
    expect((await browser.getClientConfig()).sessionCreation).toBe(false);
    const hooked = setup({ createSession: (input) => input });
    expect((await hooked.browser.getClientConfig()).sessionCreation).toBe(true);
  });

  test("messages cannot rotate MCP credentials or attach non-file resources", async () => {
    const { upstream, browser } = setup();
    const credentials = await rejection(
      browser.sendMessage(WORKSPACE_ID, SESSION_ID, {
        text: "hi",
        mcpCredentialUpdates: [{ serverId: "crm", headers: { Authorization: "x" } }],
      } as never),
    );
    expect(credentials.status).toBe(403);
    const repository = await rejection(
      browser.steerMessage(WORKSPACE_ID, SESSION_ID, {
        text: "hi",
        resources: [{ kind: "repository", url: "https://github.com/acme/secret" }],
      } as never),
    );
    expect(repository.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);

    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, "hello");
    expect(upstream.requests[0]!.body).toMatchObject({
      type: "user.message",
      payload: { text: "hello" },
    });
  });

  test("modelSelection: false strips per-message model policy", async () => {
    const { upstream, browser } = setup({ modelSelection: false });
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, {
      text: "hi",
      model: "expensive-model",
      reasoningEffort: "high",
      latencyMode: "priority",
    } as never);
    expect(upstream.requests[0]!.body).toEqual({ type: "user.message", payload: { text: "hi" } });
    await browser.steerMessage(WORKSPACE_ID, SESSION_ID, {
      text: "steer",
      model: "expensive-model",
      reasoningEffort: "high",
      latencyMode: "fast",
    });
    expect(upstream.requests[1]!.body).toEqual({ text: "steer" });
    expect(
      (
        await rejection(
          browser.requestJson(
            "PUT",
            `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/model-policy`,
            { model: "expensive-model" },
          ),
        )
      ).status,
    ).toBe(404);
    expect(upstream.requests).toHaveLength(2);
  });

  test("modelSelection: false preserves host-owned creation policy", async () => {
    const { upstream, browser } = setup({
      modelSelection: false,
      createSession: ({ initialMessage }) => ({
        initialMessage,
        model: "host-model",
        reasoningEffort: "high",
        latencyMode: "priority",
      }),
    });
    for (const policy of [{ model: "client-model" }, { latencyMode: "fast" }] as const) {
      expect(
        (await rejection(browser.createSession(WORKSPACE_ID, { initialMessage: "hi", ...policy })))
          .status,
      ).toBe(400);
    }
    expect(upstream.requests).toHaveLength(0);
    await browser.createSession(WORKSPACE_ID, { initialMessage: "hi" });
    expect(upstream.requests[0]!.body).toMatchObject({
      initialMessage: "hi",
      model: "host-model",
      reasoningEffort: "high",
      latencyMode: "priority",
    });
  });

  test("mutations honor authorizeMutation and default cross-site protection", async () => {
    const denied = setup({ authorizeMutation: () => false });
    expect((await rejection(denied.browser.pauseSession(WORKSPACE_ID, SESSION_ID))).status).toBe(
      403,
    );
    const crossSite = setup();
    const response = await crossSite.handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/control`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
          body: JSON.stringify({ action: "pause", clientEventId: "c1" }),
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(denied.upstream.requests).toHaveLength(0);
    expect(crossSite.upstream.requests).toHaveLength(0);
  });

  test("bounds request bodies", async () => {
    const { upstream, browser } = setup({ maxBodyBytes: 64 });
    const error = await rejection(browser.sendMessage(WORKSPACE_ID, SESSION_ID, "x".repeat(200)));
    expect(error.status).toBe(413);
    expect(upstream.requests).toHaveLength(0);
  });

  test("preserves the upstream error envelope for the browser SDK", async () => {
    const { browser } = setup();
    const error = await rejection(browser.getQueue(WORKSPACE_ID, SESSION_ID));
    expect(error.status).toBe(404);
    expect(error.code).toBe("session_not_found");
  });

  test("forwards event pages with their paging headers", async () => {
    const { upstream, browser } = setup();
    const page = await browser.listEventPage(WORKSPACE_ID, SESSION_ID, {
      before: 5,
      limit: 1,
      compact: true,
      payloadMode: "full",
    });
    expect(page.events.map((event) => event.sequence)).toEqual([1]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe(1);
    const query = upstream.requests[0]!.url.searchParams;
    expect(query.get("before")).toBe("5");
    expect(query.get("payloadMode")).toBe("full");
  });

  test("passes unknown additive query parameters through on allowlisted reads", async () => {
    const { upstream, handler } = setup();
    const response = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events?after=3&futureOption=yes`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OpenGeni-Has-More")).toBe("true");
    const query = upstream.requests[0]!.url.searchParams;
    expect(query.get("after")).toBe("3");
    expect(query.get("futureOption")).toBe("yes");
    await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue?view=next`,
      ),
    );
    expect(upstream.requests[1]!.url.searchParams.get("view")).toBe("next");
  });

  test("serves the provider's workspace read, live stream, and workspace resume only", async () => {
    const { upstream, browser } = setup();
    await browser.getWorkspace(WORKSPACE_ID);
    expect(upstream.requests[0]!.url.pathname).toBe(`/v1/workspaces/${WORKSPACE_ID}`);

    const controller = new AbortController();
    const live = browser.streamWorkspaceLiveEvents(WORKSPACE_ID, {
      controlAfter: 2,
      signal: controller.signal,
    });
    const first = await live[Symbol.asyncIterator]().next();
    controller.abort();
    expect(first.value).toMatchObject({ type: "workspace.control.changed", sequence: 4 });
    const stream = upstream.requests.find((request) =>
      request.url.pathname.endsWith("/live-events/stream"),
    )!;
    expect(stream.url.searchParams.get("controlAfter")).toBe("2");
    expect(stream.headers.get("x-opengeni-external-actor")).not.toBeNull();

    const before = upstream.requests.length;
    const pause = await rejection(
      browser.setWorkspaceInferenceState(WORKSPACE_ID, { action: "pause", clientEventId: "c1" }),
    );
    expect(pause.status).toBe(403);
    const cancel = await rejection(browser.cancelSession(WORKSPACE_ID, SESSION_ID));
    expect(cancel.status).toBe(403);
    expect(upstream.requests).toHaveLength(before);
    await browser.setWorkspaceInferenceState(WORKSPACE_ID, {
      action: "resume",
      clientEventId: "c2",
    });
    expect(upstream.requests.at(-1)!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/inference-control`,
    );
  });

  test("keeps a quiet session stream alive under Bun.serve's 10-second idle timeout", async () => {
    const { handler } = setup();
    const response = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events/stream`,
        { headers: { "Last-Event-ID": "5" } },
      ),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const started = Date.now();
    let text = "";
    // Upstream sends two events, then goes quiet; only the default heartbeat may follow.
    while (!text.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain(": ping");
    // Bun.serve closes a connection that sends nothing for 10 seconds by default.
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 15_000);

  test("re-streams session SSE and honors the browser resume cursor", async () => {
    const { upstream, handler } = setup();
    const response = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events/stream`,
        { headers: { "Last-Event-ID": "5" } },
      ),
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    const iterator = parseSseStream(response.body!)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect([first.value!.id, second.value!.id]).toEqual(["6", "7"]);
    await iterator.return?.(undefined);
    const stream = upstream.requests.find((request) => request.url.pathname.endsWith("/stream"))!;
    expect(stream.url.searchParams.get("after")).toBe("5");
    expect(stream.headers.get("x-opengeni-external-actor")).not.toBeNull();
  });

  test("never leaks the upstream contract revision to the embedded browser", async () => {
    const { browser, handler } = setup();
    // The browser SDK throws on a revision mismatch; through the proxy it matches.
    const config = await browser.getClientConfig();
    expect(config.defaultModel).toBe("m");
    const events = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
      ),
    );
    expect(events.headers.get("x-opengeni-api-contract")).toBeNull();
    expect(events.headers.get("X-OpenGeni-Has-More")).toBe("true");
  });

  test("client config pins the resolved host workspace even when the browser supplies another", async () => {
    const { browser, upstream } = setup();
    await browser.getClientConfig({ workspaceId: OTHER_WORKSPACE_ID });
    const configRequest = upstream.requests.find(
      (request) => request.url.pathname === "/v1/config/client",
    )!;
    expect(configRequest.url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
  });

  test("beforeForwardMessage adds server context and MCP credential rotation to every message", async () => {
    const inputs: unknown[] = [];
    const { upstream, browser } = setup({
      modelSelection: false,
      createSession: ({ initialMessage }) => ({ initialMessage, modelContext: "Workspace plan" }),
      beforeForwardMessage: (input, context) => {
        inputs.push({ ...input, user: context.user });
        return {
          modelContext: "Page: /reports · TZ: Europe/Oslo · 2026-09-29",
          mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer short-lived" } }],
        };
      },
    });
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi", modelContext: "Row 7" });
    expect(upstream.requests[0]!.body).toEqual({
      type: "user.message",
      payload: {
        text: "hi",
        modelContext: "Page: /reports · TZ: Europe/Oslo · 2026-09-29\n\nRow 7",
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer short-lived" } }],
      },
    });
    await browser.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    expect(upstream.requests[1]!.body).toMatchObject({
      text: "now",
      mcpCredentialUpdates: [{ id: "crm" }],
    });
    await browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
      text: "draft",
      annotations: [],
      resources: [],
      model: "saved-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      expectedDraftRevision: 1,
      clientEventId: "c1",
      delivery: "send",
    });
    expect(upstream.requests[2]!.body).toMatchObject({
      text: "draft",
      model: "saved-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      modelContext: expect.any(String),
    });
    await browser.createSession(WORKSPACE_ID, { initialMessage: "start" } as never);
    expect(upstream.requests[3]!.body).toEqual({
      initialMessage: "start",
      visibility: "private",
      agentAccess: "session",
      memoryScope: "user",
      modelContext: "Page: /reports · TZ: Europe/Oslo · 2026-09-29\n\nWorkspace plan",
    });
    expect(inputs).toEqual([
      { sessionId: SESSION_ID, delivery: "send", user: "u_42" },
      { sessionId: SESSION_ID, delivery: "steer", user: "u_42" },
      { sessionId: SESSION_ID, delivery: "submit", user: "u_42" },
      { delivery: "create", user: "u_42" },
    ]);
    // The browser still cannot rotate credentials itself.
    const smuggled = await rejection(
      browser.sendMessage(WORKSPACE_ID, SESSION_ID, {
        text: "hi",
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "x" } }],
      } as never),
    );
    expect(smuggled.status).toBe(403);
  });

  test("beforeForwardMessage can refuse a message", async () => {
    const { upstream, browser } = setup({
      beforeForwardMessage: () => new Response("Token expired", { status: 401 }),
    });
    expect((await rejection(browser.sendMessage(WORKSPACE_ID, SESSION_ID, "hi"))).status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  for (const { label, event } of RESPONSE_EVENTS) {
    test(`existing send-only hook refreshes ${label} credentials without changing the response`, async () => {
      const inputs: SessionProxyMessageInput[] = [];
      const updates = [{ id: "crm", headers: { Authorization: "test-rotation" } }];
      const { upstream, browser } = setup({
        modelSelection: false,
        beforeForwardMessage: async (input, context) => {
          inputs.push(input);
          if (input.delivery !== "send") return;
          expect(context.workspaceId).toBe(WORKSPACE_ID);
          expect(context.user).toBe("u_42");
          expect(context.source).toBe("northwind");
          expect(new URL(context.request.url).pathname).toBe(
            `/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
          );
          return {
            mcpCredentialUpdates: updates,
            modelContext: "Messages only",
            metadata: { privateHostState: "Not an event field" },
          };
        },
      });
      const response = await browser.sendEvent(WORKSPACE_ID, SESSION_ID, event);
      expect(inputs).toEqual([{ sessionId: SESSION_ID, delivery: "send" }]);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]!.method).toBe("POST");
      expect(upstream.requests[0]!.url.pathname).toBe(
        `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
      );
      expect(upstream.requests[0]!.headers.get("x-opengeni-external-actor")).not.toBeNull();
      expect(upstream.requests[0]!.body).toEqual({
        ...event,
        payload: { ...event.payload, mcpCredentialUpdates: updates },
      });
      expect(response).not.toHaveProperty("mcpCredentialUpdates");
      expect(response).not.toHaveProperty("metadata");
    });

    test(`${label} payloads stay unchanged without credential extras`, async () => {
      for (const extras of [
        undefined,
        {},
        { modelContext: "Messages only" },
        { mcpCredentialUpdates: [] },
      ]) {
        const { upstream, browser } = setup({
          ...(extras === undefined ? {} : { beforeForwardMessage: () => extras }),
        });
        await browser.sendEvent(WORKSPACE_ID, SESSION_ID, event);
        expect(upstream.requests[0]!.body).toEqual(event);
      }
    });

    test(`browser ${label} credential updates are rejected before the hook`, async () => {
      let hookCalls = 0;
      const { upstream, browser } = setup({
        beforeForwardMessage: () => {
          hookCalls++;
          return {
            mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "test-rotation" } }],
          };
        },
      });
      for (const updates of [
        [],
        null,
        [{ id: "crm", headers: { Authorization: "browser-input" } }],
      ]) {
        const error = await rejection(
          browser.sendEvent(WORKSPACE_ID, SESSION_ID, {
            ...event,
            payload: { ...event.payload, mcpCredentialUpdates: updates },
          } as never),
        );
        expect(error.status).toBe(403);
        expect(error.code).toBe("credential_update_not_allowed");
      }
      expect(hookCalls).toBe(0);
      expect(upstream.requests).toHaveLength(0);
    });

    test(`beforeForwardMessage can refuse ${label} without forwarding`, async () => {
      const { upstream, handler } = setup({
        beforeForwardMessage: () =>
          new Response("Reauthenticate", {
            status: 401,
            headers: { "x-host-auth": "required" },
          }),
      });
      const response = await handler(
        new Request(
          `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
          },
        ),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("x-host-auth")).toBe("required");
      expect(await response.text()).toBe("Reauthenticate");
      expect(upstream.requests).toHaveLength(0);
    });

    test(`malformed ${label} payloads do not invoke the hook or forward`, async () => {
      let hookCalls = 0;
      const { upstream, browser } = setup({
        beforeForwardMessage: () => {
          hookCalls++;
        },
      });
      for (const payload of [undefined, null, [], "invalid"]) {
        const error = await rejection(
          browser.sendEvent(WORKSPACE_ID, SESSION_ID, { ...event, payload } as never),
        );
        expect(error.status).toBe(400);
        expect(error.code).toBe("invalid_body");
      }
      expect(hookCalls).toBe(0);
      expect(upstream.requests).toHaveLength(0);
    });
  }

  test("SDK approval rejection and human-input skip use the same credential hook", async () => {
    const inputs: SessionProxyMessageInput[] = [];
    const updates = [{ id: "crm", headers: { Authorization: "test-rotation" } }];
    const { upstream, browser } = setup({
      beforeForwardMessage: (input) => {
        inputs.push(input);
        if (input.delivery !== "send") return;
        return { mcpCredentialUpdates: updates };
      },
    });
    await browser.sendApprovalDecision(WORKSPACE_ID, SESSION_ID, {
      approvalId: "tool-call-1",
      decision: "reject",
      clientEventId: "reject-retry",
    });
    await browser.submitHumanInputResponse(
      WORKSPACE_ID,
      SESSION_ID,
      "request-1",
      { outcome: "skipped" },
      { clientEventId: "skip-retry" },
    );
    expect(inputs).toEqual([
      { sessionId: SESSION_ID, delivery: "send" },
      { sessionId: SESSION_ID, delivery: "send" },
    ]);
    expect(upstream.requests.map((request) => request.body)).toEqual([
      {
        type: "user.approvalDecision",
        clientEventId: "reject-retry",
        payload: { approvalId: "tool-call-1", decision: "reject", mcpCredentialUpdates: updates },
      },
      {
        type: "user.humanInputResponse",
        clientEventId: "skip-retry",
        payload: {
          requestId: "request-1",
          response: { outcome: "skipped" },
          mcpCredentialUpdates: updates,
        },
      },
    ]);
  });

  test("response hooks run only after host authorization and event allowlisting", async () => {
    let hookCalls = 0;
    const beforeForwardMessage = () => {
      hookCalls++;
      return undefined;
    };
    const denied = setup({ authorizeSession: () => false, beforeForwardMessage });
    for (const { event } of RESPONSE_EVENTS) {
      expect(
        (await rejection(denied.browser.sendEvent(WORKSPACE_ID, SESSION_ID, event))).status,
      ).toBe(404);
    }
    const allowed = setup({ beforeForwardMessage });
    expect(
      (
        await rejection(
          allowed.browser.sendEvent(WORKSPACE_ID, SESSION_ID, {
            type: "tool.result",
            payload: {},
          } as never),
        )
      ).status,
    ).toBe(403);
    expect(hookCalls).toBe(0);
    expect(denied.upstream.requests).toHaveLength(0);
    expect(allowed.upstream.requests).toHaveLength(0);
  });

  test("modelSelection: false is reported in client config so UIs hide the picker", async () => {
    const locked = setup({ modelSelection: false });
    expect((await locked.browser.getClientConfig()).modelSelection).toBe(false);
    const open = setup();
    expect((await open.browser.getClientConfig()).modelSelection).toBeUndefined();
    const offered = setup({ modelSelection: true });
    expect((await offered.browser.getClientConfig()).modelSelection).toBe(true);
  });

  test("lists only the resolved user's chats by default, filtered server-side", async () => {
    const { upstream, browser } = setup();
    const page = await browser.listSessionPage(WORKSPACE_ID, {
      parentSessionId: null,
      createdBy: { kind: "subject", subjectId: "someone-else" },
    });
    expect(page.sessions.map((session) => session.id)).toEqual([SESSION_ID]);
    expect(page.pinned).toEqual([]);
    await browser.listSessionPage(WORKSPACE_ID, { cursor: "c2" });
    const lists = upstream.requests.filter((request) => request.url.pathname.endsWith("/sessions"));
    for (const list of lists) {
      expect(list.url.searchParams.get("createdByKind")).toBe("subject");
      expect(list.url.searchParams.get("createdBySubjectId")).toBe("subject-u42");
      expect(list.headers.get("x-opengeni-external-actor")).not.toBeNull();
    }
    expect(lists[1]!.url.searchParams.get("cursor")).toBe("c2");
    // The acting subject is resolved once and cached.
    expect(upstream.requests.filter((r) => r.url.pathname === "/v1/access/me")).toHaveLength(1);
    // The legacy array form is refused rather than silently unfiltered.
    expect((await rejection(browser.listSessions(WORKSPACE_ID))).status).toBe(400);
  });

  test("visible lists pass through; false disables listing", async () => {
    const visible = setup({ sessionList: "visible" });
    await visible.browser.listSessionPage(WORKSPACE_ID);
    expect(visible.upstream.requests[0]!.url.searchParams.get("createdByKind")).toBeNull();
    const off = setup({ sessionList: false });
    expect((await rejection(off.browser.listSessionPage(WORKSPACE_ID))).status).toBe(404);
  });

  test("archives and restores the user's chat unless disabled", async () => {
    const { upstream, browser } = setup();
    await browser.updateSessionArchive(WORKSPACE_ID, SESSION_ID, {
      archived: true,
      expectedVersion: 2,
    });
    expect(upstream.requests[0]!.method).toBe("PUT");
    expect(upstream.requests[0]!.body).toEqual({ archived: true, expectedVersion: 2 });
    const off = setup({ archive: false });
    expect(
      (
        await rejection(
          off.browser.updateSessionArchive(WORKSPACE_ID, SESSION_ID, { archived: true }),
        )
      ).status,
    ).toBe(404);
    // Reported so stock UIs hide "Archive" instead of failing on click.
    expect((await browser.getClientConfig()).archive).toBe(true);
    expect((await off.browser.getClientConfig()).archive).toBe(false);
  });

  test("retained media a session produced is served under files, scoped and association-checked", async () => {
    const RETAINED = "44444444-4444-4444-8444-444444444444";
    const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";
    const workspace = `/v1/workspaces/${WORKSPACE_ID}`;
    const sessionPath = `${workspace}/sessions/${SESSION_ID}`;
    const page = (range: string | null) =>
      new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "2",
          "Content-Range": "bytes 1-2/4",
          "Accept-Ranges": "bytes",
          "X-Range": range ?? "",
        },
      });
    const build = (overrides: Partial<SessionProxyHandlerOptions> = {}) => {
      const base = upstreamServer();
      const seen: string[] = [];
      const fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const path = url.pathname;
        seen.push(`${request.method} ${path}${url.search}`);
        if (path.endsWith(`/artifact-associations/${RETAINED}`)) {
          return path.startsWith(`${sessionPath}/`) && url.searchParams.get("kind") === "retained"
            ? Response.json({ sessionId: SESSION_ID, artifactId: RETAINED, kind: "retained" })
            : Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        if (path === `${workspace}/artifacts/${RETAINED}/content`) {
          return page(request.headers.get("range"));
        }
        if (path === `${workspace}/artifacts/${RETAINED}/playback-source`) {
          return Response.json({ artifactId: RETAINED, url: "https://objects.example/v.mp4" });
        }
        if (path === `${sessionPath}/artifacts/${RETAINED}`) {
          return Response.json({ artifactId: RETAINED, available: true });
        }
        if (path === `${sessionPath}/artifacts/${RETAINED}/content`) {
          return page(request.headers.get("range"));
        }
        return await base.fetch(request);
      };
      const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_org_key", fetch });
      const handler = createSessionProxyHandler(service, {
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
        ...overrides,
      });
      return { handler, seen };
    };
    const at = (path: string) => `${PRODUCT}/api/opengeni${path}`;
    const scoped = (sessionId = SESSION_ID) => ({
      "x-opengeni-session-id": sessionId,
      range: "bytes=1-2",
    });
    const content = at(`${workspace}/artifacts/${RETAINED}/content`);
    const playback = at(`${workspace}/artifacts/${RETAINED}/playback-source`);

    const on = build();
    const read = await on.handler(new Request(content, { headers: scoped() }));
    expect(read.status).toBe(206);
    expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([2, 3]);
    expect(read.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(read.headers.get("accept-ranges")).toBe("bytes");
    expect(read.headers.get("content-security-policy")).toBe("sandbox");
    expect(on.seen).toEqual([
      `GET ${sessionPath}/artifact-associations/${RETAINED}?kind=retained`,
      `GET ${workspace}/artifacts/${RETAINED}/content`,
    ]);
    const minted = await on.handler(
      new Request(playback, {
        method: "POST",
        headers: { ...scoped(), "Content-Type": "application/json" },
      }),
    );
    expect(minted.status).toBe(200);
    expect(on.seen.at(-1)).toBe(`POST ${workspace}/artifacts/${RETAINED}/playback-source`);

    // The session must be named, readable by the product, and the producer.
    on.seen.length = 0;
    expect((await on.handler(new Request(content))).status).toBe(400);
    expect(
      (await on.handler(new Request(content, { headers: scoped(OTHER_SESSION) }))).status,
    ).toBe(404);
    expect(on.seen.some((line) => line.includes("/content"))).toBe(false);
    const refused = build({ authorizeSession: () => false });
    expect((await refused.handler(new Request(content, { headers: scoped() }))).status).toBe(404);
    expect(refused.seen).toEqual([]);
    // Only content reads and playback minting; never metadata or other verbs.
    for (const [url, method] of [
      [at(`${workspace}/artifacts/${RETAINED}`), "GET"],
      [content, "POST"],
      [playback, "GET"],
    ] as const) {
      const response = await on.handler(
        new Request(url, {
          method,
          headers: { ...scoped(), "Content-Type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(
      (await on.handler(new Request(content, { headers: { ...scoped(), range: "bytes=\u0001" } })))
        .status,
    ).toBe(400);

    // Screenshots are read through the session the browser can already read.
    on.seen.length = 0;
    const metadata = await on.handler(
      new Request(at(`${sessionPath}/artifacts/${RETAINED}`), { headers: scoped() }),
    );
    expect(metadata.status).toBe(200);
    const shot = await on.handler(
      new Request(at(`${sessionPath}/artifacts/${RETAINED}/content`), { headers: scoped() }),
    );
    expect(shot.status).toBe(206);
    expect(on.seen.filter((line) => line.includes("/artifacts/"))).toEqual([
      `GET ${sessionPath}/artifacts/${RETAINED}`,
      `GET ${sessionPath}/artifacts/${RETAINED}/content`,
    ]);

    // files: false closes every retained-media route.
    const off = build({ files: false });
    for (const url of [content, at(`${sessionPath}/artifacts/${RETAINED}/content`)]) {
      expect((await off.handler(new Request(url, { headers: scoped() }))).status).toBe(404);
    }
    expect(off.seen.some((line) => line.includes("/artifacts/"))).toBe(false);
  });

  test("sandbox link downloads forward only the file read, unless disabled", async () => {
    const { upstream, browser, handler } = setup({ sandboxFiles: true });
    await browser.fsRead(WORKSPACE_ID, SESSION_ID, {
      path: "reports/weekly.pdf",
      encoding: "base64",
      maxBytes: 1024,
      workspaceOnly: true,
    });
    expect(upstream.requests.at(-1)!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/fs/read-workspace`,
    );
    expect(upstream.requests.at(-1)!.body).toEqual({
      path: "reports/weekly.pdf",
      encoding: "base64",
      maxBytes: 1024,
      workspaceOnly: true,
    });
    // A browser cannot pick another compute route or smuggle extra fields.
    const smuggled = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/fs/read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "a.txt", route: { sandboxId: "other" }, extra: true }),
        },
      ),
    );
    expect(smuggled.status).toBe(200);
    expect(upstream.requests.at(-1)!.body).toEqual({ path: "a.txt", workspaceOnly: true });
    const count = upstream.requests.length;
    for (const body of [
      {},
      { path: "a.txt", encoding: "hex" },
      { path: "a", maxBytes: "1" },
      { path: "a", maxBytes: 0 },
      { path: "a", maxBytes: -1 },
      { path: "a", maxBytes: 26214401 },
    ]) {
      const rejected = await handler(
        new Request(
          `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/fs/read`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
      );
      expect(rejected.status).toBe(400);
    }
    // Writes stay outside the conversation allowlist.
    expect(
      (
        await rejection(
          browser.fsWrite(WORKSPACE_ID, SESSION_ID, { path: "a.txt", content: "x" } as never),
        )
      ).status,
    ).toBe(404);
    expect(upstream.requests).toHaveLength(count);
    const off = setup({ sandboxFiles: false });
    expect(
      (await rejection(off.browser.fsRead(WORKSPACE_ID, SESSION_ID, { path: "a.txt" } as never)))
        .status,
    ).toBe(404);
    expect(off.upstream.requests).toHaveLength(0);
  });

  test("sandbox reads are opt-in independently of file-id downloads and pin workspaceOnly", async () => {
    for (const options of [{}, { files: false }]) {
      const off = setup(options);
      expect(
        (await rejection(off.browser.fsRead(WORKSPACE_ID, SESSION_ID, { path: "a" }))).status,
      ).toBe(404);
      expect(off.upstream.requests).toHaveLength(0);
      expect((await off.browser.getClientConfig()).sandboxFiles).toBe(false);
    }
    const enabled = setup({ sandboxFiles: true });
    await enabled.browser.fsRead(WORKSPACE_ID, SESSION_ID, { path: "src/a", workspaceOnly: false });
    expect(enabled.upstream.requests.at(-1)!.body).toEqual({ path: "src/a", workspaceOnly: true });
    expect((await enabled.browser.getClientConfig()).sandboxFiles).toBe(true);
    const defaults = setup();
    await defaults.browser.createFileDownloadUrl(
      WORKSPACE_ID,
      "33333333-3333-4333-8333-333333333333",
    );
    expect(defaults.upstream.requests.at(-1)!.url.pathname).toContain("/download-url");
  });

  test("workspace Sites are opt-in, read-only and need no session", async () => {
    const site = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}`;
    const list = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts`;
    // Off by default: the session-scoped artifact path still requires a session.
    expect((await setup({ artifacts: true }).handler(new Request(site))).status).toBe(400);
    expect((await setup().handler(new Request(site))).status).toBe(404);

    const on = setup({ sites: true });
    const forwarded = async (url: string) => {
      const response = await on.handler(new Request(url));
      expect(response.status).toBe(200);
      return on.upstream.requests.at(-1)!.url;
    };
    expect((await forwarded(site)).pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}`,
    );
    const content = await forwarded(`${site}/content?versionId=v1&smuggled=1`);
    expect(content.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}/content`,
    );
    expect(Object.fromEntries(content.searchParams)).toEqual({ versionId: "v1" });
    const listed = await forwarded(`${list}?limit=5&sourceSessionId=x`);
    expect(Object.fromEntries(listed.searchParams)).toEqual({ limit: "5" });
    const html = await on.handler(new Request(`${site}/html?versionId=v1`));
    expect(await html.text()).toBe("<h1>Dashboard</h1>");
    expect((await on.handler(new Request(`${site}/html`))).status).toBe(400);

    // Writes stay closed without a session, and so do editable artifacts.
    for (const [url, method] of [
      [`${site}/rollback`, "POST"],
      [`${site}/status`, "PUT"],
    ] as const) {
      const response = await on.handler(
        new Request(url, { method, headers: { "Content-Type": "application/json" }, body: "{}" }),
      );
      expect(response.status).toBe(404);
    }
    const editable = site.replace("published-artifacts", "editable-artifacts");
    expect((await on.handler(new Request(editable))).status).toBe(404);
  });

  test("artifact viewer routes are opt-in, session-scoped, and association-checked", async () => {
    const item = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${EDITABLE_ID}`;
    const scoped = { "x-opengeni-session-id": SESSION_ID };
    const off = setup();
    expect((await off.handler(new Request(item, { headers: scoped }))).status).toBe(404);
    expect((await off.browser.getClientConfig()).artifacts).toBe(false);
    expect(off.upstream.requests.some((r) => r.url.pathname.includes("artifacts/"))).toBe(false);

    const on = setup({ artifacts: true });
    const config = await on.browser.getClientConfig();
    expect(viewer(config)?.editableLiveUrl).toBe(
      "wss://api.example.test/v1/editable-artifacts/live",
    );
    expect(viewer(config)?.cachePartition).toMatchObject({
      accountId: "acct-1",
      principalId: "subject-u42",
    });
    expect(viewer(config)?.cachePartition.authorizationEpoch).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The session must be named, and a product check can refuse it.
    expect((await on.handler(new Request(item))).status).toBe(400);
    const refused = setup({ artifacts: true, authorizeSession: () => false });
    expect((await refused.handler(new Request(item, { headers: scoped }))).status).toBe(404);

    const read = await on.handler(
      new Request(`${item}?replicaId=1234567890abcdef&extra=1`, { headers: scoped }),
    );
    expect(read.status).toBe(200);
    const forwarded = on.upstream.requests.at(-1)!;
    expect(forwarded.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${EDITABLE_ID}`,
    );
    expect(Object.fromEntries(forwarded.url.searchParams)).toEqual({
      replicaId: "1234567890abcdef",
    });
    const listing = on.upstream.requests.find((r) =>
      r.url.pathname.endsWith(`/artifact-associations/${EDITABLE_ID}`),
    )!;
    expect(listing.url.pathname).toContain(`/sessions/${SESSION_ID}/`);
    expect(Object.fromEntries(listing.url.searchParams)).toEqual({ kind: "editable" });

    const ticket = await on.handler(
      new Request(`${item}/live-ticket`, {
        method: "POST",
        headers: { ...scoped, "Content-Type": "application/json" },
        body: JSON.stringify({
          replicaId: "1234567890abcdef",
          modality: "document",
          smuggled: true,
        }),
      }),
    );
    expect(ticket.status).toBe(201);
    expect(on.upstream.requests.at(-1)!.body).toEqual({
      replicaId: "1234567890abcdef",
      modality: "document",
      sourceSessionId: SESSION_ID,
    });

    // An artifact Opengeni does not list for this session is not served.
    const other = await on.handler(
      new Request(item.replace(EDITABLE_ID, "fedcba9876543210fedcba9876543210"), {
        headers: scoped,
      }),
    );
    expect(other.status).toBe(404);
    // Writes and other artifact operations stay closed.
    for (const [path, method] of [
      [`${item}/versions`, "POST"],
      [`${item}/materializations`, "POST"],
      [
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}/rollback`,
        "POST",
      ],
    ] as const) {
      const response = await on.handler(
        new Request(path, {
          method,
          headers: { ...scoped, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(404);
    }

    const site = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}`;
    expect((await on.handler(new Request(`${site}/html`, { headers: scoped }))).status).toBe(400);
    const html = await on.handler(
      new Request(`${site}/html?versionId=${SESSION_ID}`, { headers: scoped }),
    );
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<h1>Dashboard</h1>");
    expect(html.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(html.headers.get("content-disposition")).toContain("attachment");
    const catalog = on.upstream.requests.find((r) =>
      r.url.pathname.endsWith(`/artifact-associations/${SITE_ID}`),
    )!;
    expect(catalog.url.pathname).toContain(`/sessions/${SESSION_ID}/`);
    expect(Object.fromEntries(catalog.url.searchParams)).toEqual({ kind: "site" });
  });

  test("reauthorizes source sessions on repeated association reads without a positive cache", async () => {
    const upstream = upstreamServer();
    let allowed = true;
    let checks = 0;
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/artifact-associations/")) {
          checks += 1;
          if (!allowed) {
            return Response.json({ error: { code: "session_not_found" } }, { status: 404 });
          }
        }
        return upstream.fetch(input, init);
      },
    });
    const handler = createSessionProxyHandler(service, {
      artifacts: true,
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const request = () =>
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${EDITABLE_ID}`,
        {
          headers: { "x-opengeni-session-id": SESSION_ID },
        },
      );
    expect((await handler(request())).status).toBe(200);
    allowed = false;
    expect((await handler(request())).status).toBe(404);
    expect(checks).toBe(2);
    expect(
      upstream.requests.filter((r) =>
        r.url.pathname.endsWith(`/editable-artifacts/${EDITABLE_ID}`),
      ),
    ).toHaveLength(1);
  });

  test("refreshes effective grants and changes the authorization epoch on config reread", async () => {
    const upstream = upstreamServer();
    let permissions = ["sessions:read", "artifacts:read", "artifacts:publish"];
    let reads = 0;
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        if (
          new URL(input instanceof Request ? input.url : input).pathname.endsWith("/access/grant")
        ) {
          reads += 1;
          return Response.json({
            accountId: "acct-1",
            workspaceId: WORKSPACE_ID,
            subjectId: "subject-u42",
            permissions,
          });
        }
        return upstream.fetch(input, init);
      },
    });
    const handler = createSessionProxyHandler(service, {
      artifacts: true,
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const config = async () => {
      const response = await handler(new Request(`${PRODUCT}/api/opengeni/v1/config/client`));
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await config();
    permissions = ["sessions:read", "artifacts:read"];
    const after = await config();
    expect(after.artifacts.cachePartition.authorizationEpoch).not.toBe(
      before.artifacts.cachePartition.authorizationEpoch,
    );
    expect(reads).toBe(2);
  });

  test("streams Site HTML with backpressure and an actual-byte ceiling without buffering", async () => {
    const upstream = upstreamServer();
    let pulls = 0;
    let cancelled: unknown;
    const chunk = new Uint8Array(64 * 1024);
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        if (new URL(input instanceof Request ? input.url : input).pathname.endsWith("/html")) {
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls += 1;
                  controller.enqueue(chunk);
                },
                cancel(reason) {
                  cancelled = reason;
                },
              },
              { highWaterMark: 0 },
            ),
            // Even an incorrect declared length cannot bypass the actual-byte check.
            { headers: { "Content-Length": "1" } },
          );
        }
        return upstream.fetch(input, init);
      },
    });
    const handler = createSessionProxyHandler(service, {
      artifacts: true,
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const response = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}/html?versionId=v1`,
        {
          headers: { "x-opengeni-session-id": SESSION_ID },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) throw new Error("An infinite upstream should exceed the ceiling");
        bytes += result.value.byteLength;
      }
    } catch (error) {
      expect(error).toBeInstanceOf(SessionProxySiteHtmlTooLargeError);
      expect((error as SessionProxySiteHtmlTooLargeError).code).toBe("site_html_too_large");
    } finally {
      reader.releaseLock();
    }
    expect(bytes).toBe(SESSION_PROXY_SITE_HTML_MAX_BYTES);
    expect(pulls).toBe(SESSION_PROXY_SITE_HTML_MAX_BYTES / chunk.byteLength + 1);
    expect(cancelled).toBeInstanceOf(SessionProxySiteHtmlTooLargeError);
  });

  test("cancels upstream Site HTML on downstream cancellation and request abort", async () => {
    for (const mode of ["cancel", "abort"] as const) {
      const upstream = upstreamServer();
      let cancelled: unknown;
      let pulls = 0;
      const abort = new AbortController();
      const service = new OpenGeniClient({
        baseUrl: API,
        apiKey: "og_org_key",
        fetch: async (input, init) => {
          if (new URL(input instanceof Request ? input.url : input).pathname.endsWith("/html")) {
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    pulls += 1;
                    controller.enqueue(new Uint8Array([42]));
                  },
                  cancel(reason) {
                    cancelled = reason;
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          }
          return upstream.fetch(input, init);
        },
      });
      const handler = createSessionProxyHandler(service, {
        artifacts: true,
        resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
      });
      const response = await handler(
        new Request(
          `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/published-artifacts/${SITE_ID}/html?versionId=v1`,
          {
            headers: { "x-opengeni-session-id": SESSION_ID },
            signal: abort.signal,
          },
        ),
      );
      expect(pulls).toBe(0);
      if (mode === "cancel") await response.body!.cancel("consumer closed");
      else abort.abort("request closed");
      await Promise.resolve();
      expect(cancelled).toBe(mode === "cancel" ? "consumer closed" : "request closed");
      expect(pulls).toBe(0);
    }
  });

  test("artifactViewerCapability gives a custom proxy the same client-config capability", async () => {
    const { upstream } = setup();
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: upstream.fetch,
    });
    const capability = await artifactViewerCapability({
      client: service.asUser("u_42", { source: "northwind" }),
      workspaceId: WORKSPACE_ID,
      source: "northwind",
    });
    const proxied = await setup({ artifacts: true }).browser.getClientConfig();
    expect(capability).toEqual(viewer(proxied)!);
    await expect(
      artifactViewerCapability({
        client: service.asUser("u_42"),
        workspaceId: OTHER_WORKSPACE_ID,
      }),
    ).rejects.toThrow();
  });
});
