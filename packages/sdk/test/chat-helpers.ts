import { OpenGeni } from "../src/chat";
import type { CreateSessionRequest, Session, SessionEvent } from "../src/types";
import { sseBlock, WORKSPACE_ID } from "./helpers";

/**
 * In-memory fake of the few OpenGeni routes the chat facade uses. Every
 * accepted prompt appends a scripted agent turn to a per-session timeline;
 * the SSE stream replays that timeline after the requested cursor.
 */

export type ScriptedEvent = {
  type: SessionEvent["type"];
  payload?: unknown;
  /** Override the turn id the event is stamped with (null for a turn-less event). */
  turnId?: string | null;
};

export type ScriptInput = { text: string; turnId: string; kind: "create" | "message" | "steer" };
export type ContinuationInput = { type: string; payload: Record<string, unknown>; turnId: string };

export type FakeServerOptions = {
  authorizeSession?: ((user: string | null, sessionId: string) => boolean) | undefined;
  reply?: ((input: ScriptInput) => ScriptedEvent[]) | undefined;
  continuation?: ((input: ContinuationInput) => ScriptedEvent[]) | undefined;
  source?: string | undefined;
};

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  json: () => Record<string, unknown>;
};

export type FakeSessionState = { session: Session; events: SessionEvent[]; turns: number };

export type FakeServer = {
  og: OpenGeni;
  fetch: typeof fetch;
  requests: RecordedRequest[];
  creates: CreateSessionRequest[];
  sessions: Map<string, FakeSessionState>;
  requestsTo: (method: string, pathSuffix: string) => RecordedRequest[];
};

export const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BASE_URL = "https://api.example.test";

export function helloReply(): ScriptedEvent[] {
  return [
    { type: "agent.message.delta", payload: { text: "Hel" } },
    { type: "agent.message.delta", payload: { text: "lo" } },
    { type: "agent.message.completed", payload: { text: "Hello", phase: "final" } },
    { type: "turn.completed", payload: {} },
  ];
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const reply = options.reply ?? helloReply;
  const continuation = options.continuation ?? (() => []);
  const requests: RecordedRequest[] = [];
  const creates: CreateSessionRequest[] = [];
  const sessions = new Map<string, FakeSessionState>();
  const pendingTurn = new Map<string, string>();

  const append = (state: FakeSessionState, scripted: ScriptedEvent, turnId: string | null) => {
    const sequence = state.events.length + 1;
    const event: SessionEvent = {
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      workspaceId: state.session.workspaceId,
      sessionId: state.session.id,
      sequence,
      type: scripted.type,
      payload: scripted.payload ?? {},
      occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
      clientEventId: null,
      turnId: scripted.turnId === undefined ? turnId : scripted.turnId,
    };
    state.events.push(event);
    (state.session as { lastSequence: number }).lastSequence = sequence;
    if (event.type === "session.requiresAction" || event.type === "session.humanInput.requested") {
      if (turnId) pendingTurn.set(state.session.id, turnId);
    }
    return event;
  };

  const runTurn = (
    state: FakeSessionState,
    text: string,
    kind: ScriptInput["kind"],
  ): { accepted: SessionEvent; turnId: string } => {
    state.turns += 1;
    const turnId = `turn-${state.turns}`;
    const accepted = append(state, { type: "user.message", payload: { text } }, turnId);
    for (const scripted of reply({ text, turnId, kind })) append(state, scripted, turnId);
    return { accepted, turnId };
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const notFound = () => json({ error: { code: "not_found", message: "Session not found." } }, 404);

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const bodyText = init?.body !== undefined && init?.body !== null ? String(init.body) : null;
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: bodyText,
      json: () => (bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}),
    };
    requests.push(recorded);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "PUT" && url.pathname === "/v1/workspaces/external") {
      const body = recorded.json();
      return json({
        workspace: { id: WORKSPACE_ID, accountId: body.accountId, name: body.name },
        created: true,
      });
    }
    // /v1/workspaces/:ws/sessions[...]
    if (parts[0] !== "v1" || parts[1] !== "workspaces" || parts[3] !== "sessions") {
      return notFound();
    }
    const workspaceId = parts[2] ?? "";
    const sessionId = parts[4];
    const tail = parts.slice(5).join("/");
    const actorHeader = request.headers.get("x-opengeni-external-actor");
    const externalUser = actorHeader
      ? (JSON.parse(decodeURIComponent(actorHeader)) as { identity: { externalId: string } })
          .identity.externalId
      : null;
    if (
      sessionId &&
      options.authorizeSession &&
      !options.authorizeSession(externalUser, sessionId)
    ) {
      return json({ error: { code: "forbidden", message: "Session access denied" } }, 403);
    }

    if (!sessionId) {
      if (request.method === "GET") {
        return json([...sessions.values()].map((state) => state.session));
      }
      const body = recorded.json() as unknown as CreateSessionRequest;
      creates.push(body);
      const requestedId = body.requestedSessionId ?? crypto.randomUUID();
      const existing = sessions.get(requestedId);
      if (existing) return json({ ...existing.session, initialTurnId: "turn-1" }, 200);
      const session = {
        id: requestedId,
        workspaceId,
        accountId: ORGANIZATION_ID,
        status: "idle",
        initialMessage: body.initialMessage ?? "",
        title: null,
        metadata: body.metadata ?? {},
        model: body.model ?? "default-model",
        createIdempotencyKey: body.idempotencyKey ?? null,
        lastSequence: 0,
        agentAccess: body.agentAccess ?? "workspace",
        scopeSubjectId: externalUser ? `external_user:${externalUser}` : null,
        memoryScope: body.memoryScope ?? "workspace",
        sandboxBackend: body.sandboxBackend ?? "docker",
      } as unknown as Session;
      const state: FakeSessionState = { session, events: [], turns: 0 };
      sessions.set(requestedId, state);
      append(state, { type: "session.created", payload: {} }, null);
      const { turnId } = runTurn(state, body.initialMessage ?? "", "create");
      return json({ ...session, initialTurnId: turnId }, 201);
    }

    const state = sessions.get(sessionId);
    if (!state) return notFound();

    if (tail === "" && request.method === "GET") return json(state.session);
    if (tail === "events" && request.method === "POST") {
      const body = recorded.json();
      const type = String(body.type);
      const payload = (body.payload ?? {}) as Record<string, unknown>;
      if (type === "user.message") {
        return json(runTurn(state, String(payload.text ?? ""), "message").accepted);
      }
      const turnId = pendingTurn.get(sessionId) ?? `turn-${state.turns}`;
      const accepted = append(state, { type, payload }, turnId);
      for (const scripted of continuation({ type, payload, turnId }))
        append(state, scripted, turnId);
      return json(accepted);
    }
    if (tail === "steer" && request.method === "POST") {
      const body = recorded.json();
      const { accepted, turnId } = runTurn(state, String(body.text ?? ""), "steer");
      return json({
        accepted,
        turn: { id: turnId, sessionId, status: "running" },
        receipt: { operationId: crypto.randomUUID() },
        routing: { destination: "queue" },
        interruptionCount: 0,
        replay: false,
      });
    }
    if (tail === "events/stream" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const wire = state.events
        .filter((event) => event.sequence > after)
        .map((event) => sseBlock(event))
        .join("");
      return new Response(wire, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (tail === "events" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const includeTypes = url.searchParams.get("includeTypes")?.split(",") ?? null;
      const events = state.events.filter(
        (event) =>
          event.sequence > after && (includeTypes === null || includeTypes.includes(event.type)),
      );
      return json(events, 200, { "X-OpenGeni-Has-More": "false" });
    }
    return notFound();
  }) as typeof fetch;

  const og = new OpenGeni({
    apiKey: "og_test_key",
    organizationId: ORGANIZATION_ID,
    baseUrl: BASE_URL,
    fetch: impl,
    ...(options.source ? { source: options.source } : {}),
  });

  return {
    og,
    fetch: impl,
    requests,
    creates,
    sessions,
    requestsTo: (method, pathSuffix) =>
      requests.filter(
        (request) =>
          request.method === method && new URL(request.url).pathname.endsWith(pathSuffix),
      ),
  };
}

/** Read a whole SSE/text response body as a string. */
export async function readBody(response: Response): Promise<string> {
  return await response.text();
}

/** The `data:` payloads of an SSE body, in order (raw strings). */
export function sseDataLines(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}
