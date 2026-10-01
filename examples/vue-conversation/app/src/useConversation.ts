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

type Context = { workspaceId: string; storageScope: string; csrf: string };
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
  const busy = ref(false);
  const connection = ref("offline");
  const pending = ref<Pending | null>(null);
  let context: Context;
  let client: OpenGeniClient;
  let abort: AbortController | undefined;
  let generation = 0;
  let refreshRevision = 0;
  const view = computed(() => project(events.value));
  const key = () => `harbor:${context.storageScope}`;
  const savePending = () => {
    if (pending.value) sessionStorage.setItem(`${key()}:pending`, JSON.stringify(pending.value));
    else sessionStorage.removeItem(`${key()}:pending`);
  };
  const fail = (cause: unknown) => {
    error.value = friendlyError(cause);
  };

  async function refresh(expected = generation) {
    const revision = ++refreshRevision;
    const id = active.value?.id;
    if (!id) return;
    const [session, requests] = await Promise.all([
      client.getSession(context.workspaceId, id),
      client.listHumanInputRequests(context.workspaceId, id, { status: "pending" }),
    ]);
    if (expected !== generation || active.value?.id !== id || revision !== refreshRevision) return;
    active.value = session;
    questions.value = requests;
    sessions.value = sessions.value.map((s) => (s.id === id ? session : s));
  }

  async function select(session: Session) {
    abort?.abort();
    const current = ++generation;
    const controller = new AbortController();
    abort = controller;
    events.value = [];
    questions.value = [];
    active.value = session;
    error.value = "";
    sessionStorage.setItem(`${key()}:session`, session.id);
    try {
      // Start from 0 because the in-memory projection was reset. The SDK owns
      // replay, sequence deduplication, gap backfill and reconnect pacing.
      for await (const event of client.streamEvents(context.workspaceId, session.id, {
        signal: controller.signal,
        onStateChange: (state) => {
          if (current === generation) connection.value = state;
        },
        beforeLive: () => refresh(current),
      })) {
        if (current !== generation) return;
        events.value.push(event);
        if (
          event.type.startsWith("session.") ||
          event.type.startsWith("turn.") ||
          event.type.startsWith("user.")
        ) {
          void refresh(current).catch((cause) => {
            if (current === generation) fail(cause);
          });
        }
      }
    } catch (cause) {
      if (current === generation && !controller.signal.aborted) {
        connection.value = "offline";
        fail(cause);
      }
    }
  }

  async function load() {
    abort?.abort();
    ++generation;
    active.value = null;
    sessions.value = [];
    events.value = [];
    questions.value = [];
    pending.value = null;
    signedIn.value = false;
    error.value = "";
    try {
      const response = await fetch("/api/context", { credentials: "same-origin" });
      if (response.status === 401) return;
      if (!response.ok) throw new Error("Host context unavailable");
      context = await response.json();
      // Credentials are cookies only; no API key, tenant or actor headers.
      client = new OpenGeniClient({
        baseUrl: `${location.origin}/api/conversation`,
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (!["GET", "HEAD"].includes(init?.method ?? "GET"))
            headers.set("x-host-csrf", context.csrf);
          return fetch(input, { ...init, headers, credentials: "same-origin" });
        },
      });
      signedIn.value = true;
      const page = await client.listSessionPage(context.workspaceId, {
        limit: 50,
        parentSessionId: null,
      });
      sessions.value = [...page.pinned, ...page.sessions];
      const saved = sessionStorage.getItem(`${key()}:pending`);
      if (saved) {
        try {
          pending.value = JSON.parse(saved);
        } catch {
          sessionStorage.removeItem(`${key()}:pending`);
        }
      }
      const selected =
        sessions.value.find((s) => s.id === sessionStorage.getItem(`${key()}:session`)) ??
        sessions.value[0];
      if (selected) void select(selected);
    } catch (cause) {
      fail(cause);
    }
  }

  async function login() {
    const response = await fetch("/api/demo-login", { method: "POST", credentials: "same-origin" });
    if (!response.ok) {
      error.value = "Demo sign-in is unavailable. Use your host's normal sign-in.";
      return;
    }
    await load();
  }

  function newChat() {
    abort?.abort();
    ++generation;
    active.value = null;
    events.value = [];
    questions.value = [];
    connection.value = "offline";
    error.value = "";
    sessionStorage.removeItem(`${key()}:session`);
  }

  async function send(text: string) {
    if (busy.value || !text.trim() || pending.value) return;
    pending.value = {
      kind: active.value ? "send" : "create",
      text: text.trim(),
      id: crypto.randomUUID(),
      ...(active.value ? { sessionId: active.value.id } : {}),
    };
    savePending();
    await retry();
  }

  async function retry() {
    const request = pending.value;
    if (!request || busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      if (request.kind === "create") {
        const session = await client.createSession(context.workspaceId, {
          initialMessage: request.text,
          idempotencyKey: request.id,
        });
        sessions.value = [session, ...sessions.value.filter((s) => s.id !== session.id)];
        void select(session);
      } else {
        await client.sendMessage(context.workspaceId, request.sessionId!, {
          text: request.text,
          clientEventId: request.id,
        });
      }
      pending.value = null;
      savePending();
    } catch (cause) {
      fail(cause);
    } finally {
      busy.value = false;
    }
  }

  async function action(operation: () => Promise<unknown>) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await operation();
      await refresh();
    } catch (cause) {
      fail(cause);
    } finally {
      busy.value = false;
    }
  }
  const decisionIds = new Map<string, string>();
  const operationId = (scope: string) => {
    if (!decisionIds.has(scope)) decisionIds.set(scope, crypto.randomUUID());
    return decisionIds.get(scope)!;
  };
  const approve = (approvalId: string, decision: "approve" | "reject") =>
    action(() =>
      client.sendApprovalDecision(context.workspaceId, active.value!.id, {
        approvalId,
        decision,
        clientEventId: operationId(`${active.value!.id}:${approvalId}:${decision}`),
      }),
    );
  const answer = (requestId: string, response: SubmitHumanInputResponseRequest) =>
    action(() =>
      client.submitHumanInputResponse(context.workspaceId, active.value!.id, requestId, response, {
        clientEventId: operationId(`${active.value!.id}:${requestId}:${JSON.stringify(response)}`),
      }),
    );
  const togglePause = () =>
    action(() =>
      active.value!.effectiveControl?.state === "paused"
        ? client.resumeSession(context.workspaceId, active.value!.id)
        : client.pauseSession(context.workspaceId, active.value!.id),
    );
  onBeforeUnmount(() => {
    abort?.abort();
    ++generation;
  });
  return {
    sessions,
    active,
    view,
    questions,
    error,
    signedIn,
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
