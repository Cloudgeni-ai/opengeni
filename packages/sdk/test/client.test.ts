import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiContractMismatchError, OpenGeniApiError } from "../src/errors";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "../src/types";
import { collect, makeEvent, SESSION_ID, sseBlock, WORKSPACE_ID } from "./helpers";

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
      body: init?.body !== undefined && init?.body !== null ? String(init.body) : null,
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
    baseUrl: "https://api.example.test/",
    apiKey: "og_test_key",
    fetch,
  });
  return { client, requests };
}

describe("OpenGeniClient", () => {
  test("identity-scoped workspace reads forward AbortSignal cancellation", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const abort = new AbortController();
    const request = client.getWorkspaceCapture(WORKSPACE_ID, SESSION_ID, {
      signal: abort.signal,
    });
    abort.abort();

    expect(receivedSignal).toBe(abort.signal);
    await expect(request).rejects.toHaveProperty("name", "AbortError");
  });

  test("machine polling forwards AbortSignal cancellation", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const abort = new AbortController();
    const request = client.listMachines(WORKSPACE_ID, {
      sessionId: SESSION_ID,
      signal: abort.signal,
    });
    abort.abort();

    expect(receivedSignal).toBe(abort.signal);
    await expect(request).rejects.toHaveProperty("name", "AbortError");
  });

  test("createSession posts the request with bearer auth and strips the trailing base slash", async () => {
    const session = {
      id: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      status: "queued",
      initialTurnId: "00000000-0000-4000-8000-000000000099",
    };
    const { client, requests } = makeClient(() => jsonResponse(session, 202));
    const created = await client.createSession(WORKSPACE_ID, {
      initialMessage: "hello",
      sandboxBackend: "none",
      expectedNewSessionDraftRevision: 4,
    });
    expect(created).toEqual(session as never);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions`);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer og_test_key");
    expect(request.headers[OPENGENI_API_CONTRACT_HEADER]).toBe(OPENGENI_API_CONTRACT_REVISION);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body!)).toEqual({
      initialMessage: "hello",
      sandboxBackend: "none",
      expectedNewSessionDraftRevision: 4,
    });
  });

  test("gets and saves the actor-private new-session draft", async () => {
    const draft = {
      revision: 3,
      text: "recover me",
      resources: [],
      tools: [],
      model: "gpt-5.4",
      reasoningEffort: "medium",
      options: { sandboxBackend: "none" },
      updatedAt: "2026-07-20T01:02:03.000Z",
    };
    const { client, requests } = makeClient(() => jsonResponse(draft));

    expect(await client.getNewSessionDraft(WORKSPACE_ID)).toEqual(draft as never);
    expect(
      await client.saveNewSessionDraft(WORKSPACE_ID, {
        expectedRevision: 2,
        text: draft.text,
        resources: [],
        tools: [],
        model: draft.model,
        reasoningEffort: "medium",
        options: { sandboxBackend: "none" },
      }),
    ).toEqual(draft as never);

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/new-session-draft`],
      ["PUT", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/new-session-draft`],
    ]);
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      expectedRevision: 2,
      text: "recover me",
      resources: [],
      tools: [],
      model: "gpt-5.4",
      reasoningEffort: "medium",
      options: { sandboxBackend: "none" },
    });
  });

  test("getSession and listEvents hit the expected paths and query params", async () => {
    const { client, requests } = makeClient((request) =>
      request.url.includes("/events")
        ? jsonResponse([makeEvent(3)])
        : jsonResponse({ id: SESSION_ID }),
    );
    await client.getSession(WORKSPACE_ID, SESSION_ID);
    const events = await client.listEvents(WORKSPACE_ID, SESSION_ID, {
      after: 2,
      before: 9,
      limit: 10,
      compact: true,
    });
    expect(events.map((event) => event.sequence)).toEqual([3]);
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
    );
    expect(requests[1]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events?after=2&before=9&limit=10&compact=1`,
    );
  });

  test("listEventPage round-trips monitoring filters and exact page headers", async () => {
    const event = makeEvent(42, "turn.completed", { result: "authoritative" });
    const body = JSON.stringify([event]);
    const { client, requests } = makeClient(
      () =>
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "X-OpenGeni-Event-Mode": "forensic",
            "X-OpenGeni-Event-Direction": "after",
            "X-OpenGeni-Payload-Mode": "full",
            "X-OpenGeni-Page-Bytes": "321",
            "X-OpenGeni-Page-Max-Bytes": "1048576",
            "X-OpenGeni-Page-Truncated": "true",
            "X-OpenGeni-Has-More": "true",
            "X-OpenGeni-Truncated-By": "bytes",
            "X-OpenGeni-Covered-First": "42",
            "X-OpenGeni-Covered-Last": "42",
            "X-OpenGeni-Next-After": "42",
            "X-OpenGeni-Forensic-Exact": "true",
          },
        }),
    );

    const page = await client.listEventPage(WORKSPACE_ID, SESSION_ID, {
      after: 12,
      before: 99,
      limit: 3,
      compact: true,
      mode: "forensic",
      direction: "after",
      payloadMode: "full",
      includeTypes: ["turn.completed", "turn.failed"],
      excludeTypes: ["turn.failed"],
      includeClasses: ["terminal", "checkpoint"],
      excludeClasses: ["failure"],
    });

    expect(page).toEqual({
      events: [event],
      mode: "forensic",
      payloadMode: "full",
      direction: "after",
      bytes: 321,
      maxBytes: 1_048_576,
      truncated: true,
      hasMore: true,
      truncatedBy: "bytes",
      coveredSequence: { first: 42, last: 42 },
      nextAfter: 42,
      nextBefore: null,
      forensicExact: true,
    });
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events?after=12&before=99&limit=3&compact=1&mode=forensic&direction=after&payloadMode=full&includeTypes=turn.completed%2Cturn.failed&excludeTypes=turn.failed&includeClasses=terminal%2Ccheckpoint&excludeClasses=failure`,
    );
  });

  test("listEventPage sends exclusive latest lookups and rejects runtime filter conflicts", async () => {
    const event = makeEvent(42, "turn.completed", { result: "authoritative" });
    const { client, requests } = makeClient(() => jsonResponse([event]));

    await client.listEventPage(WORKSPACE_ID, SESSION_ID, {
      latest: "terminal",
      payloadMode: "summary",
    });
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events?payloadMode=summary&latest=terminal`,
    );

    await expect(
      client.listEventPage(WORKSPACE_ID, SESSION_ID, {
        latest: "terminal",
        includeClasses: ["failure"],
      } as never),
    ).rejects.toThrow("latest cannot be combined with event filters");
    expect(requests).toHaveLength(1);
  });

  test("sendMessage wraps text in a user.message control event", async () => {
    const accepted = makeEvent(4, "user.message", { text: "do the thing" });
    const { client, requests } = makeClient(() => jsonResponse(accepted, 202));
    const result = await client.sendMessage(WORKSPACE_ID, SESSION_ID, {
      text: "do the thing",
      clientEventId: "ce-1",
    });
    expect(result.sequence).toBe(4);
    const request = requests[0]!;
    expect(request.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events`,
    );
    expect(JSON.parse(request.body!)).toEqual({
      type: "user.message",
      clientEventId: "ce-1",
      payload: { text: "do the thing" },
    });
  });

  test("pause uses atomic control while approval posts a typed event", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({ event: makeEvent(5, "user.pause") }, 202),
    );
    await client.pauseSession(WORKSPACE_ID, SESSION_ID, { reason: "pause" });
    await client.sendApprovalDecision(WORKSPACE_ID, SESSION_ID, {
      approvalId: "ap-1",
      decision: "approve",
    });
    expect(JSON.parse(requests[0]!.body!)).toMatchObject({
      action: "pause",
      reason: "pause",
    });
    expect(JSON.parse(requests[0]!.body!).clientEventId).toEqual(expect.any(String));
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      type: "user.approvalDecision",
      payload: { approvalId: "ap-1", decision: "approve" },
    });
  });

  test("lists, reads, and settles structured human-input requests", async () => {
    const request = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: "44444444-4444-4444-8444-444444444444",
      turnGeneration: 1,
      creationAttemptId: "55555555-5555-4555-8555-555555555555",
      toolCallId: "human-call-1",
      status: "pending" as const,
      questions: [
        {
          id: "choice",
          kind: "single_select" as const,
          prompt: "Choose",
          options: [{ id: "staging", label: "Staging" }],
          required: true,
          allowOther: false,
        },
      ],
      allowSkip: false,
      response: null,
      respondedBy: null,
      respondedAt: null,
      expiresAt: null,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    let call = 0;
    const accepted = makeEvent(6, "user.humanInputResponse", {
      requestId: request.id,
      response: { outcome: "answered", answers: [{ questionId: "choice", values: ["staging"] }] },
    });
    const { client, requests } = makeClient(() => {
      call += 1;
      if (call === 1) return jsonResponse({ requests: [request] });
      if (call === 2) return jsonResponse(request);
      return jsonResponse(accepted, 202);
    });

    expect(
      await client.listHumanInputRequests(WORKSPACE_ID, SESSION_ID, { status: "pending" }),
    ).toEqual([request]);
    expect(await client.getHumanInputRequest(WORKSPACE_ID, SESSION_ID, request.id)).toEqual(
      request,
    );
    expect(
      await client.submitHumanInputResponse(
        WORKSPACE_ID,
        SESSION_ID,
        request.id,
        {
          outcome: "answered",
          answers: [{ questionId: "choice", values: ["staging"] }],
        },
        { clientEventId: "human-response-1" },
      ),
    ).toEqual(accepted);

    expect(requests[0]!.url).toEndWith(
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/human-input-requests?status=pending`,
    );
    expect(requests[1]!.url).toEndWith(
      `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/human-input-requests/${request.id}`,
    );
    expect(JSON.parse(requests[2]!.body!)).toEqual({
      type: "user.humanInputResponse",
      clientEventId: "human-response-1",
      payload: {
        requestId: request.id,
        response: {
          outcome: "answered",
          answers: [{ questionId: "choice", values: ["staging"] }],
        },
      },
    });
  });

  test("clearSessionContext posts an explicit confirm to the context/clear route (204, no body)", async () => {
    const { client, requests } = makeClient(() => new Response(null, { status: 204 }));
    await client.clearSessionContext(WORKSPACE_ID, SESSION_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/context/clear`,
    );
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body!)).toEqual({ confirm: true });
  });

  test("clearSessionContext surfaces a 409 (cannot clear mid-turn) as OpenGeniApiError", async () => {
    const { client } = makeClient(() => new Response("session is running", { status: 409 }));
    const error = await client.clearSessionContext(WORKSPACE_ID, SESSION_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(409);
  });

  test("compactSessionContext posts to context/compact and returns the trigger result", async () => {
    const { client, requests } = makeClient(() =>
      jsonResponse({
        status: "pending",
        message: "Compaction will run at the next safe boundary.",
      }),
    );
    const result = await client.compactSessionContext(WORKSPACE_ID, SESSION_ID);
    expect(result).toEqual({
      status: "pending",
      message: "Compaction will run at the next safe boundary.",
    });
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/context/compact`,
    );
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body!)).toEqual({});
  });

  test("non-2xx responses raise OpenGeniApiError with status and body", async () => {
    const { client } = makeClient(() => new Response("workspace not found", { status: 404 }));
    const error = await client.getSession(WORKSPACE_ID, SESSION_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((error as OpenGeniApiError).status).toBe(404);
    expect((error as OpenGeniApiError).body).toBe("workspace not found");
    expect((error as OpenGeniApiError).code).toBeUndefined();
    expect((error as OpenGeniApiError).message).toBe("OpenGeni API 404: workspace not found");
  });

  test("decodes structured API error code/message while retaining the raw body", async () => {
    const body = JSON.stringify({
      code: "INVALID_SESSION_CREATE_REQUEST",
      message: "Invalid session create request: initialMessage failed schema validation",
    });
    const { client } = makeClient(
      () => new Response(body, { status: 422, headers: { "content-type": "application/json" } }),
    );
    const error = await client.createSession(WORKSPACE_ID, { initialMessage: "private text" }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "INVALID_SESSION_CREATE_REQUEST",
      body,
      message:
        "OpenGeni API 422: Invalid session create request: initialMessage failed schema validation",
    });
  });

  test("JSON and void requests fail closed when the API response contract differs", async () => {
    const mismatchHeaders = { [OPENGENI_API_CONTRACT_HEADER]: "future-contract" };
    const jsonClient = makeClient(
      () => new Response(JSON.stringify({ id: SESSION_ID }), { headers: mismatchHeaders }),
    ).client;
    await expect(jsonClient.getSession(WORKSPACE_ID, SESSION_ID)).rejects.toEqual(
      expect.objectContaining({
        name: "OpenGeniApiContractMismatchError",
        expected: OPENGENI_API_CONTRACT_REVISION,
        actual: "future-contract",
      }),
    );

    const voidClient = makeClient(
      () => new Response(null, { status: 204, headers: mismatchHeaders }),
    ).client;
    await expect(voidClient.clearSessionContext(WORKSPACE_ID, SESSION_ID)).rejects.toBeInstanceOf(
      OpenGeniApiContractMismatchError,
    );
  });

  test("client bootstrap validates its payload contract even if a proxy strips the header", async () => {
    const { client } = makeClient(() => jsonResponse({ apiContractRevision: "future-contract" }));
    await expect(client.getClientConfig()).rejects.toMatchObject({
      name: "OpenGeniApiContractMismatchError",
      expected: OPENGENI_API_CONTRACT_REVISION,
      actual: "future-contract",
    });
  });

  test("merges extra headers from a header factory", async () => {
    const { fetch, requests } = recordingFetch(() => jsonResponse([]));
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "og_test_key",
      headers: () => ({ "x-request-id": "rid-1" }),
      fetch,
    });
    await client.listSessions(WORKSPACE_ID, { limit: 5 });
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions?limit=5`,
    );
    expect(requests[0]!.headers["x-request-id"]).toBe("rid-1");
    expect(requests[0]!.headers.authorization).toBe("Bearer og_test_key");
  });

  test("listSessions stays array-shaped while listSessionPage adds pin cursors", async () => {
    const { client, requests } = makeClient((request) =>
      request.url.includes("view=page")
        ? jsonResponse({ pinned: [], sessions: [], nextCursor: null })
        : jsonResponse([]),
    );
    await client.listSessions(WORKSPACE_ID, { limit: 5, parentSessionId: null });
    await client.listSessions(WORKSPACE_ID, { parentSessionId: SESSION_ID });
    await client.listSessionPage(WORKSPACE_ID, {
      limit: 7,
      cursor: "opaque-cursor",
      search: "  pinned work  ",
    });
    await client.getSessionLineage(WORKSPACE_ID, SESSION_ID);
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions?limit=5&parentSessionId=null`,
    );
    expect(requests[1]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions?parentSessionId=${SESSION_ID}`,
    );
    expect(requests[2]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions?view=page&limit=7&cursor=opaque-cursor&search=pinned+work`,
    );
    expect(requests[3]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/lineage`,
    );
  });

  test("workspace-control list exposes truthful continuation metadata", async () => {
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: WORKSPACE_ID,
      sequence: 7,
      revision: 7,
      type: "workspace.control.changed" as const,
      scope: "workspace" as const,
      rootSessionId: null,
      action: "pause" as const,
      automatic: false,
      reason: null,
      actor: "operator",
      occurredAt: new Date().toISOString(),
    };
    const body = JSON.stringify([event]);
    const { client, requests } = makeClient(
      () =>
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "X-OpenGeni-Page-Bytes": String(new TextEncoder().encode(body).byteLength),
            "X-OpenGeni-Page-Truncated": "true",
            "X-OpenGeni-Next-After": "7",
          },
        }),
    );

    await expect(
      client.listWorkspaceControlEvents(WORKSPACE_ID, { after: 3, limit: 1 }),
    ).resolves.toEqual([event]);
    await expect(
      client.listWorkspaceControlEventPage(WORKSPACE_ID, { after: 3, limit: 1 }),
    ).resolves.toEqual({
      events: [event],
      bytes: new TextEncoder().encode(body).byteLength,
      truncated: true,
      nextAfter: 7,
    });
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/control-events?after=3&limit=1`,
    );
    expect(requests[1]!.url).toBe(requests[0]!.url);
  });

  test("streamEvents consumes the SSE endpoint end to end through fetch", async () => {
    const wire = [makeEvent(1), makeEvent(2)].map(sseBlock).join("");
    const { client, requests } = makeClient((request) => {
      if (request.url.includes("/events/stream")) {
        return new Response(wire, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected request: ${request.url}`);
    });
    const events = await collect(
      client.streamEvents(WORKSPACE_ID, SESSION_ID, { reconnect: false }),
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events/stream?after=0`,
    );
    expect(requests[0]!.headers.accept).toBe("text/event-stream");
    expect(requests[0]!.headers.authorization).toBe("Bearer og_test_key");
  });

  test("openEventStream rejects non-2xx responses with OpenGeniApiError", async () => {
    const { client } = makeClient(() => new Response("no access", { status: 403 }));
    await expect(client.openEventStream(WORKSPACE_ID, SESSION_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  test("both raw SSE transports reject contract skew without entering reconnect loops", async () => {
    const { client } = makeClient(
      () =>
        new Response("", {
          headers: {
            "Content-Type": "text/event-stream",
            [OPENGENI_API_CONTRACT_HEADER]: "future-contract",
          },
        }),
    );
    await expect(client.openEventStream(WORKSPACE_ID, SESSION_ID)).rejects.toBeInstanceOf(
      OpenGeniApiContractMismatchError,
    );
    await expect(client.openWorkspaceControlEventStream(WORKSPACE_ID)).rejects.toBeInstanceOf(
      OpenGeniApiContractMismatchError,
    );
  });
});
