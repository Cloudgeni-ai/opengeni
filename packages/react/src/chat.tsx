import {
  CHAT_CONVERSATION_HEADER,
  CHAT_FORMAT_HEADER,
  parseChatChunkStream,
  type ChatPending,
} from "@opengeni/sdk/chat";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { HumanInputForm, type HumanInputFormProps } from "./components/human-input-form";
import { Markdown } from "./components/markdown";

/**
 * Chat component that talks only to the host's `createChatHandler` endpoint:
 * it restores the conversation with `GET` on mount, POSTs `{ message }`
 * (native format), renders the streamed reply, shows a card for a pending
 * approval or human-input request, and answers it through
 * `${handlerUrl}/respond`. No provider or OpenGeni credentials in the browser.
 */

export type OpenGeniChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  /** Tool names the agent used while producing this reply. */
  tools: string[];
};

export type OpenGeniChatProps = {
  /** The host endpoint served by `createChatHandler`. */
  handlerUrl: string;
  /** Sent as the `x-opengeni-conversation` header so the host's `resolve` can pick it up. */
  conversation?: string | undefined;
  /**
   * Host authentication headers, resolved on each host render. Changed values
   * reset the chat. Re-render the host when a callback's credentials change.
   */
  headers?: Record<string, string> | (() => Record<string, string>) | undefined;
  /**
   * Stable authenticated user/tenant identity. Change this on sign-in, sign-out
   * or tenant switches when authentication uses cookies or otherwise changes
   * without changing the headers. This resets local state; it is not sent.
   */
  authKey?: string | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  renderMessage?: ((message: OpenGeniChatMessage) => ReactNode) | undefined;
};

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    minHeight: 0,
    color: "var(--og-color-fg)",
    fontFamily: "var(--og-font-sans)",
    fontSize: "var(--og-font-size-base)",
  },
  list: { display: "flex", flexDirection: "column", gap: "0.5rem", overflowY: "auto" },
  user: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    whiteSpace: "pre-wrap",
    padding: "0.5rem 0.75rem",
    borderRadius: "var(--og-radius-lg)",
    background: "var(--og-color-accent-soft)",
  },
  assistant: { alignSelf: "stretch", padding: "0.25rem 0" },
  meta: { color: "var(--og-color-fg-muted)", fontSize: "var(--og-font-size-xs)" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.75rem",
    border: "1px solid var(--og-color-border)",
    borderRadius: "var(--og-radius-md)",
    background: "var(--og-color-surface-2)",
  },
  row: { display: "flex", gap: "0.5rem", alignItems: "flex-end" },
  input: {
    flex: 1,
    minHeight: "2.5rem",
    padding: "0.5rem 0.75rem",
    border: "1px solid var(--og-color-border)",
    borderRadius: "var(--og-radius-md)",
    background: "var(--og-color-surface-1)",
    color: "inherit",
    font: "inherit",
    resize: "vertical",
  },
  button: {
    padding: "0.5rem 0.9rem",
    border: "1px solid var(--og-color-border-strong)",
    borderRadius: "var(--og-radius-md)",
    background: "var(--og-color-accent)",
    color: "var(--og-color-accent-fg)",
    font: "inherit",
    cursor: "pointer",
  },
  secondary: {
    padding: "0.5rem 0.9rem",
    border: "1px solid var(--og-color-border)",
    borderRadius: "var(--og-radius-md)",
    background: "var(--og-color-surface-1)",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  error: { color: "var(--og-color-danger)", fontSize: "var(--og-font-size-sm)" },
} satisfies Record<string, CSSProperties>;

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

type HostHeaders = Record<string, string>;

function requestHeaders(conversation: string | undefined, headers: HostHeaders) {
  return {
    [CHAT_FORMAT_HEADER]: "native",
    ...(conversation ? { [CHAT_CONVERSATION_HEADER]: conversation } : {}),
    ...headers,
  };
}

/** Messages from the handler's `GET` history response; anything unexpected is dropped. */
function restoredMessages(payload: unknown): OpenGeniChatMessage[] {
  const list = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return [];
  const restored: OpenGeniChatMessage[] = [];
  for (const entry of list) {
    const record = (entry ?? {}) as { role?: unknown; text?: unknown };
    if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string")
      continue;
    restored.push({ id: uid(), role: record.role, text: record.text, streaming: false, tools: [] });
  }
  return restored;
}

export function OpenGeniChat(props: OpenGeniChatProps) {
  // Normalize actual HTTP values so an inline object/callback or header casing
  // change does not erase a draft. Resolve callbacks once per host render: GET
  // and POST must use the same authentication snapshot as the displayed state.
  const headers = Object.fromEntries(
    [...new Headers(typeof props.headers === "function" ? props.headers() : props.headers)]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const identity = JSON.stringify([
    props.handlerUrl,
    props.conversation ?? null,
    props.authKey ?? null,
    headers,
  ]);
  // A keyed boundary drops private state in the same commit, before effects
  // run. Unmount cleanup aborts old history and streams; late completions can
  // only address the unmounted instance, never the new user's conversation.
  return <ChatConversation key={identity} {...props} headers={headers} />;
}

function ChatConversation({
  handlerUrl,
  conversation,
  headers,
  placeholder = "Message",
  className,
  renderMessage,
}: Omit<OpenGeniChatProps, "headers"> & { headers: HostHeaders }) {
  const [messages, setMessages] = useState<OpenGeniChatMessage[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ChatPending[]>([]);
  const pending = pendingRequests[0] ?? null;
  const [restoring, setRestoring] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const headersRef = useRef<HostHeaders>(headers);
  headersRef.current = headers;

  // Restore the conversation on mount and whenever it changes. The composer
  // waits for restoration so a late snapshot cannot resurrect a decided card.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    setBusy(false);
    setRestoring(true);
    setError(null);
    setMessages([]);
    setPendingRequests([]);
    void (async () => {
      try {
        const response = await fetch(handlerUrl, {
          method: "GET",
          headers: requestHeaders(conversation, headersRef.current),
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { pending?: ChatPending[] };
        if (controller.signal.aborted) return;
        setMessages(restoredMessages(payload));
        setPendingRequests(Array.isArray(payload.pending) ? payload.pending : []);
      } catch {
        // Hosts without history may still accept sends.
      } finally {
        if (!controller.signal.aborted) setRestoring(false);
      }
    })();
    return () => {
      controller.abort();
      abortRef.current?.abort();
    };
  }, [handlerUrl, conversation]);

  const update = useCallback(
    (id: string, patch: (message: OpenGeniChatMessage) => OpenGeniChatMessage) =>
      setMessages((prev) => prev.map((message) => (message.id === id ? patch(message) : message))),
    [],
  );

  const consume = useCallback(
    async (url: string, body: unknown, assistantId: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...requestHeaders(conversation, headers) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Chat request failed (${response.status}).`);
        }
        for await (const chunk of parseChatChunkStream(response.body)) {
          if (controller.signal.aborted) return;
          if (chunk.type === "text") {
            update(assistantId, (m) => ({ ...m, text: m.text + chunk.text }));
          } else if (chunk.type === "tool" && chunk.status === "started") {
            update(assistantId, (m) => ({ ...m, tools: [...m.tools, chunk.name] }));
          } else if (chunk.type === "pending") {
            setPendingRequests([chunk.pending]);
          } else if (chunk.type === "done") {
            setPendingRequests(chunk.reply.pending ? [chunk.reply.pending] : []);
          }
        }
      } catch (caught) {
        if (
          !controller.signal.aborted &&
          !(caught instanceof Error && caught.name === "AbortError")
        ) {
          setError(caught instanceof Error ? caught.message : "Chat request failed.");
        }
      } finally {
        if (!controller.signal.aborted) {
          update(assistantId, (m) => ({ ...m, streaming: false }));
          setBusy(false);
        }
      }
    },
    [conversation, headers, update],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || restoring) return;
    setDraft("");
    const assistantId = uid();
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", text, streaming: false, tools: [] },
      { id: assistantId, role: "assistant", text: "", streaming: true, tools: [] },
    ]);
    void consume(handlerUrl, { message: text }, assistantId);
  };

  const respond = (input: Record<string, unknown>) => {
    if (!pending || busy || restoring) return;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const assistantId = last?.id ?? uid();
    if (last) update(assistantId, (m) => ({ ...m, streaming: true }));
    else
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", text: "", streaming: true, tools: [] },
      ]);
    void consume(
      `${handlerUrl.replace(/\/+$/, "")}/respond`,
      { requestId: pending.requestId, ...input },
      assistantId,
    );
  };

  return (
    <div className={`og-root og-chat${className ? ` ${className}` : ""}`} style={styles.root}>
      <div className="og-chat-messages" style={styles.list}>
        {messages.map((message) =>
          renderMessage ? (
            <div key={message.id}>{renderMessage(message)}</div>
          ) : message.role === "user" ? (
            <div key={message.id} className="og-chat-user" style={styles.user}>
              {message.text}
            </div>
          ) : (
            <div key={message.id} className="og-chat-assistant" style={styles.assistant}>
              {message.tools.length > 0 ? (
                <div style={styles.meta}>Used {message.tools.join(", ")}</div>
              ) : null}
              {message.text ? (
                <Markdown streaming={message.streaming}>{message.text}</Markdown>
              ) : message.streaming ? (
                <div style={styles.meta}>Thinking</div>
              ) : null}
            </div>
          ),
        )}
      </div>
      {pending ? (
        <div className="og-chat-pending" style={styles.card}>
          {pending.kind === "approval" ? (
            <>
              <div>The agent wants to run {pending.name ?? "a tool"}.</div>
              <div style={styles.row}>
                <button
                  type="button"
                  style={styles.button}
                  onClick={() => respond({ decision: "approve" })}
                >
                  Approve
                </button>
                <button
                  type="button"
                  style={styles.secondary}
                  onClick={() => respond({ decision: "reject" })}
                >
                  Reject
                </button>
              </div>
            </>
          ) : (
            <HumanInputForm
              request={pending.payload as HumanInputFormProps["request"]}
              submitting={busy || restoring}
              error={error}
              onSubmit={(response) =>
                respond(
                  response.outcome === "answered" ? { answers: response.answers } : { skip: true },
                )
              }
            />
          )}
        </div>
      ) : null}
      {error ? (
        <div className="og-chat-error" style={styles.error}>
          {error}
        </div>
      ) : null}
      <form className="og-chat-composer" style={styles.row} onSubmit={submit}>
        <textarea
          style={styles.input}
          value={draft}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" style={styles.button} disabled={busy || restoring || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
