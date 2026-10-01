import { computed, onBeforeUnmount, ref } from "vue";
import {
  OpenGeniApiError,
  OpenGeniClient,
  type Session,
  type SessionEvent,
  type SessionHumanInputRequest,
  type SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { project } from "./projection";

type Context = Readonly<{ workspaceId: string; storageScope: string; csrf: string }>;
type Pending = { kind: "create" | "send"; text: string; id: string; sessionId?: string };

export function friendlyError(error: unknown): string {
  if (error instanceof OpenGeniApiError) {
    if (error.status === 401) return "Your sign-in expired. Sign in again to continue.";
    if (error.status === 403) return "This conversation is not available to your account.";
    if (error.status === 402 || error.code === "allowance_exhausted")
      return "Your assistant usage limit has been reached.";
    if (error.status === 422)
      return "The assistant is not configured for this request. Ask your service administrator to check its settings.";
    if (error.status === 409)
      return "The conversation changed. Refresh its status before trying again.";
    return error.outcomeUnknown
      ? "The connection dropped. Retry the saved request; it will not be sent twice."
      : "The assistant is unavailable. Retry or refresh the conversation.";
  }
  return "The connection dropped. Retry or refresh the conversation.";
}

export function useConversation() {
  const sessions = ref<Session[]>([]);
  const active = ref<Session | null>(null);
  const events = ref<SessionEvent[]>([]);
  const questions = ref<SessionHumanInputRequest[]>([]);
  const error = ref("");
  const signedIn = ref(false);
  const identityScope = ref("");
  const busy = ref(false);
  const connection = ref("offline");
  const pending = ref<Pending | null>(null);
  let context: Context | undefined;
  let client: OpenGeniClient | undefined;
  let abort: AbortController | undefined;
  let generation = 0;
  let identityEpoch = 0;
  let refreshRevision = 0;
  const view = computed(() => project(events.value));
  const key = (scope: Context) => `harbor:${scope.storageScope}`;
  const savePending = (scope: Context, request: Pending | null) => {
    if (request) sessionStorage.setItem(`${key(scope)}:pending`, JSON.stringify(request));
    else sessionStorage.removeItem(`${key(scope)}:pending`);
  };
  const fail = (cause: unknown) => {
    error.value = friendlyError(cause);
  };

  async function refresh(expected = generation) {
    const epoch = identityEpoch;
    const scope = context;
    const scopedClient = client;
    if (expected !== generation || !scope || !scopedClient || !signedIn.value) return;
    const revision = ++refreshRevision;
    const id = active.value?.id;
    if (!id) return;
    const [session, requests] = await Promise.all([
      scopedClient.getSession(scope.workspaceId, id),
      scopedClient.listHumanInputRequests(scope.workspaceId, id, { status: "pending" }),
    ]);
    if (
      epoch !== identityEpoch ||
      expected !== generation ||
      active.value?.id !== id ||
      revision !== refreshRevision
    )
      return;
    active.value = session;
    questions.value = requests;
    sessions.value = sessions.value.map((s) => (s.id === id ? session : s));
  }

  async function select(session: Session) {
    const epoch = identityEpoch;
    const scope = context;
    const scopedClient = client;
    if (!scope || !scopedClient || !signedIn.value) return;
    abort?.abort();
    const current = ++generation;
    const controller = new AbortController();
    abort = controller;
    events.value = [];
    questions.value = [];
    active.value = session;
    error.value = "";
    sessionStorage.setItem(`${key(scope)}:session`, session.id);
    try {
      // Start from 0 because the in-memory projection was reset. The SDK owns
      // replay, sequence deduplication, gap backfill and reconnect pacing.
      for await (const event of scopedClient.streamEvents(scope.workspaceId, session.id, {
        signal: controller.signal,
        onStateChange: (state) => {
          if (epoch === identityEpoch && current === generation) connection.value = state;
        },
        beforeLive: () => refresh(current),
      })) {
        if (epoch !== identityEpoch || current !== generation) return;
        events.value.push(event);
        if (
          event.type.startsWith("session.") ||
          event.type.startsWith("turn.") ||
          event.type.startsWith("user.")
        ) {
          void refresh(current).catch((cause) => {
            if (epoch === identityEpoch && current === generation) fail(cause);
          });
        }
      }
    } catch (cause) {
      if (epoch === identityEpoch && current === generation && !controller.signal.aborted) {
        connection.value = "offline";
        fail(cause);
      }
    }
  }

  async function load() {
    abort?.abort();
    const epoch = ++identityEpoch;
    ++generation;
    context = undefined;
    client = undefined;
    active.value = null;
    sessions.value = [];
    events.value = [];
    questions.value = [];
    pending.value = null;
    signedIn.value = false;
    identityScope.value = "";
    busy.value = false;
    connection.value = "offline";
    error.value = "";
    try {
      const response = await fetch("/api/context", { credentials: "same-origin" });
      if (epoch !== identityEpoch) return;
      if (response.status === 401) return;
      if (!response.ok) throw new Error("Host context unavailable");
      const scope: Context = Object.freeze(await response.json());
      if (epoch !== identityEpoch) return;
      // Credentials are cookies only; no API key, tenant or actor headers.
      const scopedClient = new OpenGeniClient({
        baseUrl: `${location.origin}/api/conversation`,
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (!["GET", "HEAD"].includes(init?.method ?? "GET"))
            headers.set("x-host-csrf", scope.csrf);
          return fetch(input, { ...init, headers, credentials: "same-origin" });
        },
      });
      const page = await scopedClient.listSessionPage(scope.workspaceId, {
        limit: 50,
        parentSessionId: null,
      });
      if (epoch !== identityEpoch) return;
      context = scope;
      client = scopedClient;
      signedIn.value = true;
      identityScope.value = scope.storageScope;
      sessions.value = [...page.pinned, ...page.sessions];
      const saved = sessionStorage.getItem(`${key(scope)}:pending`);
      if (saved) {
        try {
          pending.value = JSON.parse(saved);
        } catch {
          sessionStorage.removeItem(`${key(scope)}:pending`);
        }
      }
      const selected =
        sessions.value.find((s) => s.id === sessionStorage.getItem(`${key(scope)}:session`)) ??
        sessions.value[0];
      if (selected) void select(selected);
    } catch (cause) {
      if (epoch === identityEpoch) fail(cause);
    }
  }

  async function login() {
    const epoch = identityEpoch;
    const response = await fetch("/api/demo-login", { method: "POST", credentials: "same-origin" });
    if (epoch !== identityEpoch) return;
    if (!response.ok) {
      error.value = "Demo sign-in is unavailable. Use your host's normal sign-in.";
      return;
    }
    await load();
  }

  function newChat() {
    if (!context || !signedIn.value || busy.value) return;
    abort?.abort();
    ++generation;
    active.value = null;
    events.value = [];
    questions.value = [];
    connection.value = "offline";
    error.value = "";
    sessionStorage.removeItem(`${key(context)}:session`);
  }

  async function send(text: string) {
    if (!context || !signedIn.value || busy.value || !text.trim() || pending.value) return;
    pending.value = {
      kind: active.value ? "send" : "create",
      text: text.trim(),
      id: crypto.randomUUID(),
      ...(active.value ? { sessionId: active.value.id } : {}),
    };
    savePending(context, pending.value);
    await retry();
  }

  async function retry() {
    const epoch = identityEpoch;
    const scope = context;
    const scopedClient = client;
    const request = pending.value;
    if (!scope || !scopedClient || !signedIn.value || !request || busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      if (request.kind === "create") {
        const session = await scopedClient.createSession(scope.workspaceId, {
          initialMessage: request.text,
          idempotencyKey: request.id,
        });
        if (epoch !== identityEpoch) return;
        sessions.value = [session, ...sessions.value.filter((s) => s.id !== session.id)];
        void select(session);
      } else {
        await scopedClient.sendMessage(scope.workspaceId, request.sessionId!, {
          text: request.text,
          clientEventId: request.id,
        });
      }
      if (epoch !== identityEpoch) return;
      pending.value = null;
      savePending(scope, null);
    } catch (cause) {
      if (epoch === identityEpoch) fail(cause);
    } finally {
      if (epoch === identityEpoch) busy.value = false;
    }
  }

  async function action(
    operation: (
      scopedClient: OpenGeniClient,
      scope: Context,
      session: Session | null,
    ) => Promise<unknown>,
  ) {
    const epoch = identityEpoch;
    const current = generation;
    const scope = context;
    const scopedClient = client;
    const selected = active.value;
    if (!scope || !scopedClient || !signedIn.value || busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await operation(scopedClient, scope, selected);
      if (epoch === identityEpoch && current === generation) await refresh(current);
    } catch (cause) {
      if (epoch === identityEpoch && current === generation) fail(cause);
    } finally {
      if (epoch === identityEpoch) busy.value = false;
    }
  }
  const decisionIds = new Map<string, string>();
  const operationId = (scope: string) => {
    if (!decisionIds.has(scope)) decisionIds.set(scope, crypto.randomUUID());
    return decisionIds.get(scope)!;
  };
  const approve = (approvalId: string, decision: "approve" | "reject") =>
    action((scopedClient, scope, selected) =>
      scopedClient.sendApprovalDecision(scope.workspaceId, selected!.id, {
        approvalId,
        decision,
        clientEventId: operationId(`${key(scope)}:${selected!.id}:${approvalId}:${decision}`),
      }),
    );
  const answer = (requestId: string, response: SubmitHumanInputResponseRequest) =>
    action((scopedClient, scope, selected) =>
      scopedClient.submitHumanInputResponse(scope.workspaceId, selected!.id, requestId, response, {
        clientEventId: operationId(
          `${key(scope)}:${selected!.id}:${requestId}:${JSON.stringify(response)}`,
        ),
      }),
    );
  const togglePause = () =>
    action((scopedClient, scope, selected) =>
      selected!.effectiveControl?.state === "paused"
        ? scopedClient.resumeSession(scope.workspaceId, selected!.id)
        : scopedClient.pauseSession(scope.workspaceId, selected!.id),
    );
  onBeforeUnmount(() => {
    abort?.abort();
    ++identityEpoch;
    ++generation;
  });
  return {
    sessions,
    active,
    view,
    questions,
    error,
    signedIn,
    identityScope,
    busy,
    connection,
    pending,
    load,
    login,
    select,
    newChat,
    send,
    retry,
    approve,
    answer,
    togglePause,
    refresh: () => action(() => refresh()),
  };
}
