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
    delivery: "approval",
    event: {
      type: "user.approvalDecision",
      clientEventId: "approval-retry",
      payload: { approvalId: "tool-call-1", decision: "approve", message: "Proceed" },
    },
  },
  {
    label: "human-input",
    delivery: "answer",
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
  delivery: SessionProxyMessageInput["delivery"];
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
          "X-OpenGeni-Conversation-Filter": "2",
          // Upstream's own revision header must stay behind the proxy.
          "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION,
        },
      });
    }
    if (path === "/v1/access/me") {
      return Response.json({
        subjectId: "subject-u42",
        accountGrants: [
          { accountId: "acct-1", subjectId: "subject-u42", permissions: [] },
          { accountId: "acct-2", subjectId: "subject-u42", permissions: ["workspace:admin"] },
        ],
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            accountId: "acct-1",
            subjectId: "subject-u42",
            permissions: ["sessions:read", "artifacts:read"],
          },
          {
            workspaceId: OTHER_WORKSPACE_ID,
            accountId: "acct-2",
            subjectId: "subject-u42",
            permissions: ["workspace:admin"],
          },
        ],
        defaultAccountId: "acct-2",
        defaultWorkspaceId: OTHER_WORKSPACE_ID,
        credential: { kind: "api_key" },
      });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}`) {
      return Response.json({ id: WORKSPACE_ID, name: "Product" });
    }
    if (path === "/v1/workspaces") {
      return Response.json([
        { id: WORKSPACE_ID, name: "Product" },
        { id: OTHER_WORKSPACE_ID, name: "Elsewhere" },
      ]);
    }
    if (path === "/v1/catalog-assets/logos/github.svg") {
      return new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/channels/c1/stream`) {
      return new Response("event: ping\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
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
    if (path === `/v1/workspaces/${WORKSPACE_ID}/new-session-draft` && request.method === "GET") {
      return Response.json(draftAt(6));
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

function draftAt(revision: number) {
  return {
    revision,
    text: "Fill B2",
    resources: [
      { kind: "file", fileId: "f1" },
      { kind: "repository", repository: "acme/app" },
    ],
    tools: [],
    toolsProvided: false,
    model: "codex/gpt",
    reasoningEffort: "high",
    latencyMode: "standard",
    options: { visibility: "private" },
    selectionHistory: { projects: [] },
    updatedAt: null,
  };
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

  test("goal controls pass through as the resolved user, under the session check", async () => {
    const { upstream, browser } = setup();
    const goal = `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/goal`;
    await browser.getGoal(WORKSPACE_ID, SESSION_ID);
    await browser.pauseGoal(WORKSPACE_ID, SESSION_ID, { rationale: "end-user text" });
    await browser.resumeGoal(WORKSPACE_ID, SESSION_ID);
    await browser.deleteGoal(WORKSPACE_ID, SESSION_ID);
    expect(
      upstream.requests.map((request) => [request.method, request.url.pathname, request.body]),
    ).toEqual([
      ["GET", goal, undefined],
      ["PATCH", goal, { status: "paused", rationale: "end-user text" }],
      ["PATCH", goal, { status: "active" }],
      ["DELETE", goal, undefined],
    ]);
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

  test("voice-first creation is explicit, preserves retry identity and never fabricates a prompt", async () => {
    const inputs: unknown[] = [];
    const admissions: SessionProxyMessageInput[] = [];
    const { upstream, browser } = setup({
      createSession: (input) => {
        inputs.push(input);
        return { initialMessage: input.initialMessage, tools: [] };
      },
      beforeForwardMessage: (input) => {
        admissions.push(input);
      },
    });
    await browser.createSession(WORKSPACE_ID, {
      startMode: "realtime",
      idempotencyKey: "voice-create",
    });
    expect(inputs).toEqual([
      { initialMessage: "", startMode: "realtime", idempotencyKey: "voice-create" },
    ]);
    expect(admissions).toEqual([
      { delivery: "create", startMode: "realtime", clientEventId: "voice-create" },
    ]);
    expect(upstream.requests[0]!.body).toMatchObject({
      startMode: "realtime",
      idempotencyKey: "voice-create",
    });
    expect(upstream.requests[0]!.body).not.toHaveProperty("initialMessage");

    for (const fields of [
      { initialMessage: "Do not silently send this" },
      { resources: [{ kind: "file", fileId: "file-1" }] },
    ]) {
      expect(
        (
          await rejection(
            browser.createSession(WORKSPACE_ID, { startMode: "realtime", ...fields } as never),
          )
        ).status,
      ).toBe(400);
    }
    expect(upstream.requests).toHaveLength(1);
  });

  test("a simple create hook retains the browser retry key unless the server supplies its own", async () => {
    for (const serverKey of [undefined, "server-key"]) {
      const { upstream, browser } = setup({
        createSession: ({ initialMessage }) => ({
          initialMessage,
          ...(serverKey ? { idempotencyKey: serverKey } : {}),
        }),
      });
      await browser.createSession(WORKSPACE_ID, {
        initialMessage: "Hello",
        idempotencyKey: "browser-key",
      });
      expect(upstream.requests[0]!.body).toMatchObject({
        idempotencyKey: serverKey ?? "browser-key",
      });
    }
  });

  test("a create hook passes on the person's time zone unless the server chose one", async () => {
    for (const serverZone of [undefined, "Asia/Tokyo"]) {
      const { upstream, browser } = setup({
        createSession: ({ initialMessage }) => ({
          initialMessage,
          ...(serverZone ? { timeZone: serverZone } : {}),
        }),
      });
      await browser.createSession(WORKSPACE_ID, {
        initialMessage: "Remind me tomorrow at 9",
        timeZone: "Europe/Oslo",
      });
      expect(upstream.requests[0]!.body).toMatchObject({
        timeZone: serverZone ?? "Europe/Oslo",
      });
    }
    // A malformed zone from the browser is dropped, not forwarded.
    const { upstream, browser } = setup({
      createSession: ({ initialMessage }) => ({ initialMessage }),
    });
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "Hello",
      timeZone: "Not/AZone",
    });
    expect(upstream.requests[0]!.body).not.toHaveProperty("timeZone");
  });

  test("follow-up messages forward the person's time zone", async () => {
    const { upstream, browser } = setup();
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, {
      text: "And the day after?",
      timeZone: "Europe/Oslo",
    });
    expect(upstream.requests[0]!.body).toMatchObject({
      type: "user.message",
      payload: { text: "And the day after?", timeZone: "Europe/Oslo" },
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

  test("voice input is forwarded as the resolved user", async () => {
    const { upstream, browser } = setup();
    const config = await browser.getClientConfig();
    expect(config.voiceInput).toEqual({
      available: true,
      maxDurationSeconds: 60,
      maxSizeBytes: 1024,
      acceptedMimeTypes: ["audio/webm"],
      resumable: { maxDurationSeconds: 600, maxSizeBytes: 4096, maxChunkSizeBytes: 512 },
    } as never);
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
        "realtime/websocket",
        connect,
        () => browser.negotiateRealtimeWebsocket(WORKSPACE_ID, SESSION_ID, connect),
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

    // Signed-in users upload as Opengeni allows.
    expect((await setup().browser.getClientConfig()).fileUploads?.enabled).not.toBe(false);
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
    // The conversation-filter announcement reaches the browser.
    expect(page.conversationFilter).toBe(2);
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

  test("relays session SSE and the browser's resume cursor", async () => {
    const { upstream, handler } = setup();
    const response = await handler(
      new Request(
        `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events/stream`,
        { headers: { "Last-Event-ID": "5" } },
      ),
    );
    expect(response.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    const iterator = parseSseStream(response.body!)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect([first.value!.id, second.value!.id]).toEqual(["6", "7"]);
    await iterator.return?.(undefined);
    const stream = upstream.requests.find((request) => request.url.pathname.endsWith("/stream"))!;
    expect(stream.headers.get("last-event-id")).toBe("5");
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

  test("the in-chat integration Connect card reaches Opengeni as the end user", async () => {
    const { upstream, browser } = setup();
    const connect = browser.connectTransport();
    await connect.catalog(WORKSPACE_ID);
    await connect.begin(WORKSPACE_ID, {
      providerId: "microsoft-outlook-mail",
      ownership: "personal",
      returnUrl: `${PRODUCT}/chat`,
      idempotencyKey: "begin-1",
    });
    await connect.get(WORKSPACE_ID, "attempt-1");
    await connect.advance(WORKSPACE_ID, "attempt-1", {
      expectedRevision: 2,
      idempotencyKey: "advance-1",
      action: { type: "retry" },
    });
    await browser.listApiIntegrations(WORKSPACE_ID);
    await browser.updateSessionToolPolicy(WORKSPACE_ID, SESSION_ID, {
      mode: "explicit",
      tools: [{ kind: "mcp", id: "api-outlook-mail", optional: true }],
      firstPartyMcpTools: [],
      expectedVersion: 1,
    });
    await browser.continueAfterCapabilitySetup(WORKSPACE_ID, SESSION_ID, {
      capabilityId: "api:integration:microsoft-outlook-mail",
    });
    const workspace = `/v1/workspaces/${WORKSPACE_ID}`;
    expect(upstream.requests.map((request) => [request.method, request.url.pathname])).toEqual([
      ["GET", `${workspace}/connect/catalog`],
      ["POST", `${workspace}/connect/attempts`],
      ["GET", `${workspace}/connect/attempts/attempt-1`],
      ["POST", `${workspace}/connect/attempts/attempt-1/advance`],
      ["GET", `${workspace}/integrations`],
      ["PUT", `${workspace}/sessions/${SESSION_ID}/tool-policy`],
      ["POST", `${workspace}/sessions/${SESSION_ID}/capability-continuations`],
    ]);
    for (const request of upstream.requests) {
      expect(
        JSON.parse(decodeURIComponent(request.headers.get("x-opengeni-external-actor")!)),
      ).toEqual({ mode: "external", identity: { externalId: "u_42", source: "northwind" } });
    }
  });

  test("client config offers in-chat connections unless the server owns chat setup", async () => {
    const open = await setup().browser.getClientConfig();
    expect(open.chatConnections).toBe(true);
    const owned = await setup({
      createSession: ({ initialMessage }) => ({ initialMessage }),
    }).browser.getClientConfig();
    expect(owned.chatConnections).toBe(false);
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
      { sessionId: SESSION_ID, delivery: "send", browserContext: "Row 7", user: "u_42" },
      { sessionId: SESSION_ID, delivery: "steer", user: "u_42" },
      { sessionId: SESSION_ID, delivery: "submit", clientEventId: "c1", user: "u_42" },
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

  for (const { label, delivery, event } of RESPONSE_EVENTS) {
    test(`beforeForwardMessage refreshes ${label} credentials without changing the response`, async () => {
      const inputs: SessionProxyMessageInput[] = [];
      const updates = [{ id: "crm", headers: { Authorization: "test-rotation" } }];
      const { upstream, browser } = setup({
        modelSelection: false,
        beforeForwardMessage: async (input, context) => {
          inputs.push(input);
          if (input.delivery !== delivery) return;
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
      expect(inputs).toEqual([
        { sessionId: SESSION_ID, delivery, clientEventId: event.clientEventId },
      ]);
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

  test("SDK approval rejection and human-input skip reach the hook as approval and answer", async () => {
    const inputs: SessionProxyMessageInput[] = [];
    const updates = [{ id: "crm", headers: { Authorization: "test-rotation" } }];
    const { upstream, browser } = setup({
      beforeForwardMessage: (input) => {
        inputs.push(input);
        if (input.delivery !== "approval" && input.delivery !== "answer") return;
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
      { sessionId: SESSION_ID, delivery: "approval", clientEventId: "reject-retry" },
      { sessionId: SESSION_ID, delivery: "answer", clientEventId: "skip-retry" },
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

  test("response hooks run only after host authorization and for responses", async () => {
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
    // Other event types are Opengeni's to accept or refuse, unchanged.
    const allowed = setup({ beforeForwardMessage });
    await allowed.browser.sendEvent(WORKSPACE_ID, SESSION_ID, {
      type: "tool.result",
      payload: { mcpCredentialUpdates: [] },
    } as never);
    expect(hookCalls).toBe(0);
    expect(denied.upstream.requests).toHaveLength(0);
    expect(allowed.upstream.requests.map((request) => request.body)).toEqual([
      { type: "tool.result", payload: { mcpCredentialUpdates: [] } },
    ]);
  });

  test("modelSelection: false is reported in client config so UIs hide the picker", async () => {
    const locked = setup({ modelSelection: false });
    expect((await locked.browser.getClientConfig()).modelSelection).toBe(false);
    const open = setup();
    expect((await open.browser.getClientConfig()).modelSelection).toBeUndefined();
    const offered = setup({ modelSelection: true });
    expect((await offered.browser.getClientConfig()).modelSelection).toBe(true);
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
    const proxied = await setup().browser.getClientConfig();
    expect(capability).toEqual(viewer(proxied)!);
    await expect(
      artifactViewerCapability({
        client: service.asUser("u_42"),
        workspaceId: OTHER_WORKSPACE_ID,
      }),
    ).rejects.toThrow();
  });
});

describe("createSessionProxyHandler pass-through", () => {
  const mount = `${PRODUCT}/api/opengeni/v1`;
  const ws = `${mount}/workspaces/${WORKSPACE_ID}`;
  const chat = `${ws}/sessions/${SESSION_ID}`;
  const send = (
    handler: (request: Request) => Promise<Response>,
    url: string,
    init?: RequestInit,
  ) => handler(new Request(url, init));

  test("bootstraps with the resolved workspace only, never other access or the key", async () => {
    const { handler } = setup();
    const access = (await (await send(handler, `${mount}/access/me`)).json()) as Record<
      string,
      unknown
    >;
    expect(access.workspaceGrants).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE_ID, accountId: "acct-1" }),
    ]);
    expect(access.accountGrants).toEqual([expect.objectContaining({ accountId: "acct-1" })]);
    expect(access.defaultWorkspaceId).toBe(WORKSPACE_ID);
    expect(access.defaultAccountId).toBe("acct-1");
    expect(access).not.toHaveProperty("credential");
    const workspaces = (await (await send(handler, `${mount}/workspaces`)).json()) as Array<{
      id: string;
    }>;
    expect(workspaces.map((workspace) => workspace.id)).toEqual([WORKSPACE_ID]);
  });

  test("lists only the resolved workspace, read as the user, and none it cannot read", async () => {
    const { handler, upstream } = setup();
    expect(await (await send(handler, `${mount}/workspaces`)).json()).toEqual([
      { id: WORKSPACE_ID, name: "Product" },
    ]);
    const read = upstream.requests.at(-1)!;
    expect(read.url.pathname).toBe(`/v1/workspaces/${WORKSPACE_ID}`);
    expect(read.headers.get("x-opengeni-external-actor")).toContain("u_42");
    expect(upstream.requests.some((request) => request.url.pathname === "/v1/workspaces")).toBe(
      false,
    );

    const refusing = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === `/v1/workspaces/${WORKSPACE_ID}`) {
          return Response.json(
            { error: { code: "not_found", message: "Workspace not found." } },
            { status: 404 },
          );
        }
        return await upstream.fetch(request);
      },
    });
    const outsider = createSessionProxyHandler(refusing, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const empty = await send(outsider, `${mount}/workspaces`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  test("bootstraps an external actor, whose access inventory is empty, from its effective grant", async () => {
    const upstream = upstreamServer();
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === "/v1/access/me") {
          return Response.json({
            mode: "configured",
            subjectId: "subject-u42",
            accountGrants: [],
            workspaceGrants: [],
            defaultAccountId: null,
            defaultWorkspaceId: null,
          });
        }
        return await upstream.fetch(request);
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
    });
    const access = (await (await send(handler, `${mount}/access/me`)).json()) as Record<
      string,
      unknown
    >;
    expect(access.subjectId).toBe("subject-u42");
    expect(access.workspaceGrants).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        accountId: "acct-1",
        subjectId: "subject-u42",
        permissions: ["sessions:read", "artifacts:read"],
      },
    ]);
    expect(access.defaultWorkspaceId).toBe(WORKSPACE_ID);
    expect(access.defaultAccountId).toBe("acct-1");
  });

  test("reads pass through as the resolved user, streams included", async () => {
    const { handler, upstream } = setup();
    const capabilities = await send(handler, `${ws}/capabilities?view=composer`);
    expect(capabilities.status).toBe(200);
    const read = upstream.requests.at(-1)!;
    expect(read.url.pathname).toBe(`/v1/workspaces/${WORKSPACE_ID}/capabilities`);
    expect(read.url.searchParams.get("view")).toBe("composer");
    expect(read.headers.get("x-opengeni-external-actor")).toContain("u_42");

    const stream = await send(handler, `${ws}/channels/c1/stream`, {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toContain("event: ping");

    const children = await send(handler, `${chat}/children`);
    expect(children.status).toBe(200);
    expect(upstream.requests.at(-1)!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/children`,
    );

    const logo = await send(handler, `${mount}/catalog-assets/logos/github.svg`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect((await send(handler, `${mount}/catalog-assets/logos/a%2Fb.svg`)).status).toBe(404);
  });

  test("authorizeSession still guards every chat route", async () => {
    const { handler, upstream } = setup({
      authorizeSession: async () => false,
    });
    expect((await send(handler, `${chat}/children`)).status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  test("creates a chat from the session app's own create body", async () => {
    const inputs: unknown[] = [];
    const { upstream, browser } = setup({
      createSession: (input) => {
        inputs.push(input);
        return { initialMessage: input.initialMessage, modelContext: "Server context." };
      },
    });
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "Fill B2",
      visibility: "workspace",
      resources: [],
      model: "codex/gpt",
      reasoningEffort: "high",
      latencyMode: "standard",
      clientEventId: "event-1",
      idempotencyKey: "k1",
      connectionAccounts: [],
      expectedNewSessionDraftRevision: 6,
      modelContext: "Selection: Sheet1!B2",
    });
    expect(inputs).toEqual([
      {
        initialMessage: "Fill B2",
        idempotencyKey: "k1",
        model: "codex/gpt",
        reasoningEffort: "high",
        latencyMode: "standard",
      },
    ]);
    expect(upstream.requests[0]!.body).toEqual({
      initialMessage: "Fill B2",
      visibility: "private",
      agentAccess: "session",
      memoryScope: "user",
      idempotencyKey: "k1",
      model: "codex/gpt",
      reasoningEffort: "high",
      latencyMode: "standard",
      clientEventId: "event-1",
      modelContext: "Server context.\n\nSelection: Sheet1!B2",
    });
    // The hook decides the create request, so the proxy clears the sent draft
    // itself once the chat exists: text-free, repositories kept, one revision on.
    expect(upstream.requests.slice(1).map((r) => [r.method, r.url.pathname])).toEqual([
      ["GET", `/v1/workspaces/${WORKSPACE_ID}/new-session-draft`],
      ["PUT", `/v1/workspaces/${WORKSPACE_ID}/new-session-draft`],
    ]);
    expect(upstream.requests[2]!.body).toEqual({
      text: "",
      resources: [{ kind: "repository", repository: "acme/app" }],
      tools: [],
      toolsProvided: false,
      model: "codex/gpt",
      reasoningEffort: "high",
      latencyMode: "standard",
      options: { visibility: "private" },
      expectedRevision: 6,
    });
  });

  test("leaves a new-chat draft that changed after it was sent", async () => {
    const { upstream, browser } = setup({
      createSession: (input) => ({ initialMessage: input.initialMessage }),
    });
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "Fill B2",
      expectedNewSessionDraftRevision: 5,
    });
    expect(upstream.requests.map((r) => r.method)).toEqual(["POST", "GET"]);
  });

  test("refuses a connected-account choice and still refuses other configuration", async () => {
    const { upstream, browser } = setup({
      createSession: (input) => ({ initialMessage: input.initialMessage }),
    });
    const accounts = await rejection(
      browser.createSession(WORKSPACE_ID, {
        initialMessage: "hi",
        connectionAccounts: [{ serverId: "github", accountId: "a" }],
      } as never),
    );
    expect(accounts.status).toBe(403);
    expect(accounts.code).toBe("connection_account_not_allowed");
    const tools = await rejection(
      browser.createSession(WORKSPACE_ID, {
        initialMessage: "hi",
        tools: [{ kind: "mcp", id: "everything" }],
      } as never),
    );
    expect(tools.code).toBe("create_field_not_allowed");
    expect(upstream.requests).toHaveLength(0);
  });

  test("forwards any workspace route as the resolved user, body, query and status included", async () => {
    const upstream = upstreamServer();
    const seen: Request[] = [];
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(request.clone());
        if (new URL(request.url).pathname.endsWith("/projects/p1")) {
          return new Response(JSON.stringify({ id: "p1", name: "Renamed" }), {
            status: 202,
            headers: {
              "Content-Type": "application/json",
              "X-OpenGeni-Has-More": "false",
              "x-opengeni-api-contract": "upstream-later",
              "Set-Cookie": "upstream=1",
              ETag: '"v2"',
            },
          });
        }
        return await upstream.fetch(request);
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
    });
    const response = await send(handler, `${ws}/projects/p1?expand=sessions`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "product-session=secret",
        Authorization: "Bearer product-token",
        "x-opengeni-external-actor": "forged",
        "x-opengeni-access-key": "forged",
        "x-opengeni-correlation-id": "corr-1",
        "If-Match": '"v1"',
      },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "p1", name: "Renamed" });
    expect(response.headers.get("x-opengeni-has-more")).toBe("false");
    expect(response.headers.get("etag")).toBe('"v2"');
    expect(response.headers.get("x-opengeni-api-contract")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const forwarded = seen.at(-1)!;
    expect(forwarded.method).toBe("PATCH");
    expect(new URL(forwarded.url).pathname).toBe(`/v1/workspaces/${WORKSPACE_ID}/projects/p1`);
    expect(new URL(forwarded.url).searchParams.get("expand")).toBe("sessions");
    expect(await forwarded.json()).toEqual({ name: "Renamed" });
    expect(forwarded.headers.get("authorization")).toBe("Bearer og_org_key");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("x-opengeni-access-key")).toBeNull();
    expect(forwarded.headers.get("x-opengeni-correlation-id")).toBe("corr-1");
    expect(forwarded.headers.get("if-match")).toBe('"v1"');
    expect(
      JSON.parse(decodeURIComponent(forwarded.headers.get("x-opengeni-external-actor")!)),
    ).toEqual({ mode: "external", identity: { externalId: "u_42", source: "northwind" } });
  });

  test("relays Opengeni's refusals and empty answers unchanged", async () => {
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (path.endsWith("/members")) {
          return Response.json(
            { error: { code: "forbidden", message: "Missing permission." } },
            { status: 403 },
          );
        }
        return new Response(null, { status: 204 });
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    });
    const refused = await send(handler, `${ws}/members`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: "forbidden", message: "Missing permission." },
    });
    const deleted = await send(handler, `${ws}/channels/c1`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
  });

  test("outside the workspace only the bootstrap reads answer", async () => {
    const { handler, upstream } = setup();
    for (const [path, method] of [
      ["/accounts", "GET"],
      ["/accounts/acct-1/members", "GET"],
      ["/workspaces", "POST"],
      ["/access/me", "POST"],
      ["/me/settings", "GET"],
      ["/config/server", "GET"],
    ] as const) {
      const response = await send(handler, `${mount}${path}`, {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      });
      expect(response.status).toBe(404);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  test("the user's own inbox passes through as the user, pinned to the workspace", async () => {
    const { handler, upstream } = setup();
    const item = "33333333-3333-4333-8333-333333333333";
    const json = { headers: { "Content-Type": "application/json" }, body: "{}" };
    for (const [path, method] of [
      [`/inbox?workspaceId=${OTHER_WORKSPACE_ID}&extra=1`, "GET"],
      [`/inbox/items/${item}`, "PATCH"],
      ["/inbox/settings", "GET"],
      ["/inbox/settings", "PUT"],
    ] as const) {
      const response = await send(handler, `${mount}${path}`, {
        method,
        ...(method === "GET" ? {} : json),
      });
      expect(response.status).toBe(200);
    }
    expect(
      upstream.requests.map(
        (request) => `${request.method} ${request.url.pathname}${request.url.search}`,
      ),
    ).toEqual([
      `GET /v1/inbox?workspaceId=${WORKSPACE_ID}`,
      `PATCH /v1/inbox/items/${item}?workspaceId=${WORKSPACE_ID}`,
      "GET /v1/inbox/settings",
      "PUT /v1/inbox/settings",
    ]);
    for (const request of upstream.requests) {
      expect(request.headers.get("x-opengeni-external-actor")).not.toBeNull();
    }
    for (const [path, method] of [
      ["/inbox", "POST"],
      ["/inbox/items", "GET"],
      [`/inbox/items/${item}`, "GET"],
      [`/inbox/items/${item}`, "DELETE"],
      [`/inbox/items/${encodeURIComponent("not:an-id")}`, "PATCH"],
      ["/inbox/settings", "PATCH"],
      ["/inbox/other", "GET"],
    ] as const) {
      const response = await send(handler, `${mount}${path}`, {
        method,
        ...(method === "GET" || method === "DELETE" ? {} : json),
      });
      expect(response.status).toBe(404);
    }
    expect(upstream.requests).toHaveLength(4);
  });

  test("relays keys and subject ids in paths re-encoded, and refuses unsafe segments", async () => {
    const { handler, upstream } = setup();
    const relayed = await send(
      handler,
      `${ws}/members/${encodeURIComponent("user:a.b")}/allowance`,
    );
    expect(relayed.status).toBe(200);
    expect(upstream.requests.at(-1)!.url.pathname).toBe(
      `/v1/workspaces/${WORKSPACE_ID}/members/user%3Aa.b/allowance`,
    );
    const before = upstream.requests.length;
    for (const path of [
      `${ws}/files/a%2Fb`,
      `${ws}/files/a%5Cb`,
      `${ws}/files/a%00b`,
      `${ws}/files/${"x".repeat(513)}`,
      `${ws}/sessions/${encodeURIComponent("not:an-id")}`,
    ]) {
      expect((await send(handler, path)).status).toBe(404);
    }
    expect(upstream.requests).toHaveLength(before);
  });

  test("with createSession the server owns chat setup; without it Opengeni's permissions decide", async () => {
    const owned = setup({ createSession: (input) => ({ initialMessage: input.initialMessage }) });
    const open = setup();
    const routes: Array<[string, string]> = [
      ["PUT", `${chat}/agent`],
      ["PUT", `${chat}/tool-policy`],
      ["PUT", `${chat}/skills`],
      ["PUT", `${chat}/variable-sets`],
      ["PUT", `${chat}/usage-limit`],
      ["PUT", `${chat}/visibility`],
      ["POST", `${chat}/active-sandbox`],
      ["POST", `${chat}/codex-account`],
      ["POST", `${chat}/forks`],
      ["POST", `${ws}/chat/completions`],
    ];
    for (const [method, url] of routes) {
      const init = { method, headers: { "Content-Type": "application/json" }, body: "{}" };
      expect((await send(owned.handler, url, init)).status).toBe(404);
      expect((await send(open.handler, url, init)).status).toBe(200);
    }
    expect(owned.upstream.requests).toHaveLength(0);
    expect(open.upstream.requests).toHaveLength(routes.length);
    // The user's own controls stay open either way.
    for (const [method, path] of [
      ["PUT", "archive"],
      ["PUT", "pin"],
      ["PATCH", ""],
      ["PATCH", "mcp-servers/app/approval-policy"],
      ["POST", "context/compact"],
    ] as const) {
      const response = await send(owned.handler, path ? `${chat}/${path}` : chat, {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
    }
    // MCP credentials are always the server's.
    for (const { handler, upstream } of [owned, open]) {
      const before = upstream.requests.length;
      const rotate = await send(handler, `${chat}/mcp-credentials/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(rotate.status).toBe(404);
      expect(upstream.requests).toHaveLength(before);
    }
  });

  test("refuse closes routes the product keeps to itself", async () => {
    const routes: unknown[] = [];
    const { handler, upstream } = setup({
      refuse: (route) => {
        routes.push(route);
        if (route.segments[0] === "members") return true;
        if (route.segments[2] === "terminal") {
          return Response.json({ error: { code: "no_terminal" } }, { status: 403 });
        }
        return undefined;
      },
    });
    expect((await send(handler, `${ws}/members`)).status).toBe(404);
    const terminal = await send(handler, `${chat}/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(terminal.status).toBe(403);
    expect((await send(handler, `${chat}/queue`)).status).toBe(404); // upstream's own 404
    expect(upstream.requests.map((request) => request.url.pathname)).toEqual([
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue`,
    ]);
    expect(routes).toEqual([
      { method: "GET", segments: ["members"], sessionId: undefined },
      {
        method: "POST",
        segments: ["sessions", SESSION_ID, "terminal", "exec"],
        sessionId: SESSION_ID,
      },
      { method: "GET", segments: ["sessions", SESSION_ID, "queue"], sessionId: SESSION_ID },
    ]);
  });

  test("a chat named in x-opengeni-session-id passes the host's session check", async () => {
    const checked: string[] = [];
    const { handler, upstream } = setup({
      authorizeSession: (sessionId) => {
        checked.push(sessionId);
        return sessionId === SESSION_ID;
      },
    });
    const artifact = `${ws}/artifacts/a1/content`;
    expect(
      (await send(handler, artifact, { headers: { "x-opengeni-session-id": "other-chat" } }))
        .status,
    ).toBe(404);
    expect(
      (await send(handler, artifact, { headers: { "x-opengeni-session-id": SESSION_ID } })).status,
    ).toBe(200);
    expect(
      (await send(handler, artifact, { headers: { "x-opengeni-session-id": "../x" } })).status,
    ).toBe(400);
    expect(checked).toEqual(["other-chat", SESSION_ID]);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.headers.get("x-opengeni-session-id")).toBe(SESSION_ID);
  });

  test("without createSession the browser's own create request passes, with the server's additions", async () => {
    const { upstream, browser } = setup({
      chats: "shared",
      beforeForwardMessage: (input) =>
        input.delivery === "create" ? { modelContext: "Server context." } : undefined,
    });
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "Hello",
      visibility: "private",
      modelContext: "Browser context.",
      skills: ["s1"],
    } as never);
    expect(upstream.requests[0]!.body).toEqual({
      initialMessage: "Hello",
      visibility: "private",
      agentAccess: "workspace",
      memoryScope: "workspace",
      skills: ["s1"],
      modelContext: "Server context.\n\nBrowser context.",
    });
    const smuggled = await rejection(
      browser.createSession(WORKSPACE_ID, {
        initialMessage: "Hello",
        mcpCredentialUpdates: [],
      } as never),
    );
    expect(smuggled.code).toBe("credential_update_not_allowed");
    expect(upstream.requests).toHaveLength(1);
  });

  test("the default mutation policy refuses cross-site requests and form encodings", async () => {
    const { handler, upstream } = setup();
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/x-www-form-urlencoded" },
    ]) {
      const response = await send(handler, `${chat}/pin`, { method: "PUT", headers, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  test("heartbeats go only between events, never inside one", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const service = new OpenGeniClient({
      baseUrl: API,
      apiKey: "og_org_key",
      fetch: async () => {
        const encoder = new TextEncoder();
        let step = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              step += 1;
              if (step === 1) controller.enqueue(encoder.encode('id: 1\ndata: {"a":'));
              else if (step === 2) {
                await released;
                controller.enqueue(encoder.encode("1}\n\n"));
              } else await new Promise(() => undefined);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
      heartbeatMs: 10,
    });
    const response = await send(handler, `${ws}/live-events/stream`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    await Bun.sleep(60);
    release();
    while (!text.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text.startsWith('id: 1\ndata: {"a":1}\n\n: ping\n\n')).toBe(true);
  });
});
