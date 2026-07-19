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
    const session = { id: SESSION_ID, workspaceId: WORKSPACE_ID, status: "queued" };
    const { client, requests } = makeClient(() => jsonResponse(session, 202));
    const created = await client.createSession(WORKSPACE_ID, {
      initialMessage: "hello",
      sandboxBackend: "none",
    });
    expect(created).toEqual(session as never);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions`);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer og_test_key");
    expect(request.headers[OPENGENI_API_CONTRACT_HEADER]).toBe(OPENGENI_API_CONTRACT_REVISION);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body!)).toEqual({ initialMessage: "hello", sandboxBackend: "none" });
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

  test("revokeEnrollment posts to the permanent connected-machine lifecycle route", async () => {
    const enrollmentId = "22222222-2222-4222-8222-222222222222";
    const { client, requests } = makeClient(() => jsonResponse({ revoked: false }));
    const result = await client.revokeEnrollment(WORKSPACE_ID, enrollmentId);
    expect(result).toEqual({ revoked: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/enrollments/${enrollmentId}/revoke`,
    );
    expect(requests[0]!.body).toBeNull();
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
