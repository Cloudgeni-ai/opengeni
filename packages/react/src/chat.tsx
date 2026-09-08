import {
  CHAT_CONVERSATION_HEADER,
  CHAT_FORMAT_HEADER,
  parseChatChunkStream,
  type ChatPending,
} from "@opengeni/sdk/chat";
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Markdown } from "./components/markdown";

/**
 * Drop-in chat that talks only to the host's `createChatHandler` endpoint:
 * it POSTs `{ message }` (native format), renders the streamed reply, shows a
 * card for a pending approval or human-input request, and answers it through
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
  headers?: Record<string, string> | (() => Record<string, string>) | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  renderMessage?: ((message: OpenGeniChatMessage) => ReactNode) | undefined;
};

type Question = { id: string; prompt: string; options?: Array<{ id: string; label: string }> };

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

export function OpenGeniChat({
  handlerUrl,
  conversation,
  headers,
  placeholder = "Message",
  className,
  renderMessage,
}: OpenGeniChatProps) {
  const [messages, setMessages] = useState<OpenGeniChatMessage[]>([]);
  const [pending, setPending] = useState<ChatPending | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      setPending(null);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CHAT_FORMAT_HEADER]: "native",
            ...(conversation ? { [CHAT_CONVERSATION_HEADER]: conversation } : {}),
            ...(typeof headers === "function" ? headers() : (headers ?? {})),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Chat request failed (${response.status}).`);
        }
        for await (const chunk of parseChatChunkStream(response.body)) {
          if (chunk.type === "text") {
            update(assistantId, (m) => ({ ...m, text: m.text + chunk.text }));
          } else if (chunk.type === "tool" && chunk.status === "started") {
            update(assistantId, (m) => ({ ...m, tools: [...m.tools, chunk.name] }));
          } else if (chunk.type === "pending") {
            setPending(chunk.pending);
            setAnswers({});
          }
        }
      } catch (caught) {
        if (!(caught instanceof Error && caught.name === "AbortError")) {
          setError(caught instanceof Error ? caught.message : "Chat request failed.");
        }
      } finally {
        update(assistantId, (m) => ({ ...m, streaming: false }));
        setBusy(false);
      }
    },
    [conversation, headers, update],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
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
    if (!pending || busy) return;
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

  const payload = (pending?.payload ?? {}) as { questions?: Question[]; allowSkip?: boolean };
  const questions = Array.isArray(payload.questions) ? payload.questions : [];

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
            <>
              {questions.map((question) => (
                <label
                  key={question.id}
                  style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}
                >
                  <span>{question.prompt}</span>
                  {question.options?.length ? (
                    <select
                      style={styles.input}
                      value={answers[question.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [question.id]: e.target.value }))}
                    >
                      <option value="">Choose</option>
                      {question.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      style={styles.input}
                      value={answers[question.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [question.id]: e.target.value }))}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setAnswers((a) => ({ ...a, [question.id]: value }));
                      }}
                    />
                  )}
                </label>
              ))}
              <div style={styles.row}>
                <button
                  type="button"
                  style={styles.button}
                  onClick={() =>
                    respond({
                      answers: questions.map((q) => ({
                        questionId: q.id,
                        values: answers[q.id] ? [answers[q.id] as string] : [],
                      })),
                    })
                  }
                >
                  Send answer
                </button>
                {payload.allowSkip ? (
                  <button
                    type="button"
                    style={styles.secondary}
                    onClick={() => respond({ skip: true })}
                  >
                    Skip
                  </button>
                ) : null}
              </div>
            </>
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
        <button type="submit" style={styles.button} disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
