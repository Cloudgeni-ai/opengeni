import type { OpenGeniClient } from "@opengeni/sdk";
import { MenuIcon, SendIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { SessionConversation, type SessionConversationProps } from "./session-conversation";
import { SessionList, type SessionListLabels, type SessionListProps } from "./session-list";

export type OpenGeniChatLabels = SessionListLabels & {
  openChats: string;
  closeChats: string;
  newChatPlaceholder: string;
  send: string;
  newChatUnavailable: string;
};

const DEFAULT_LABELS: Omit<OpenGeniChatLabels, keyof SessionListLabels> = {
  openChats: "Open chats",
  closeChats: "Close chats",
  newChatPlaceholder: "Start a new chat…",
  send: "Send",
  newChatUnavailable: "New chats are not enabled for this product.",
};

export type OpenGeniChatProps = ClientOverride & {
  /** Controlled selection. `null` shows the new-chat composer. */
  sessionId?: string | null | undefined;
  /** Initial selection when uncontrolled. Defaults to a new chat. */
  defaultSessionId?: string | null | undefined;
  onSessionChange?: ((sessionId: string | null) => void) | undefined;
  /**
   * Create a chat from its first message. Defaults to `client.createSession`
   * with `{ initialMessage, idempotencyKey }`, which `createSessionProxyHandler`
   * accepts when the server supplies a `createSession` hook. Return the new id.
   */
  createSession?: ((initialMessage: string, idempotencyKey: string) => Promise<string>) | undefined;
  /** Hide the "New chat" entry point. */
  newChat?: boolean | undefined;
  /** Forwarded to the conversation (message rendering, tool renderers, composer...). */
  conversationProps?: Omit<SessionConversationProps, "sessionId" | "client" | "workspaceId">;
  /** Forwarded to the list (rename/archive toggles, page size). */
  listProps?: Pick<SessionListProps, "rename" | "archive" | "pageSize"> | undefined;
  labels?: Partial<OpenGeniChatLabels> | undefined;
  className?: string | undefined;
  /** Defaults to filling the host. */
  height?: CSSProperties["height"];
};

type CreateClient = Partial<Pick<OpenGeniClient, "createSession">>;

/**
 * A complete chat experience: the user's chat list plus the conversation.
 * The list is a sidebar when the component is wide and a drawer when narrow
 * (container-based, so it adapts inside panels as well as full pages).
 */
export function OpenGeniChat({
  client,
  workspaceId,
  sessionId: controlledSessionId,
  defaultSessionId = null,
  onSessionChange,
  createSession,
  newChat = true,
  conversationProps,
  listProps,
  labels: labelOverrides,
  className,
  height = "100%",
}: OpenGeniChatProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides } as OpenGeniChatLabels;
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const [uncontrolled, setUncontrolled] = useState<string | null>(defaultSessionId);
  const selected = controlledSessionId !== undefined ? controlledSessionId : uncontrolled;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listRevision, setListRevision] = useState(0);

  const select = useCallback(
    (next: string | null) => {
      if (controlledSessionId === undefined) setUncontrolled(next);
      onSessionChange?.(next);
      setDrawerOpen(false);
    },
    [controlledSessionId, onSessionChange],
  );

  const create = useCallback(
    async (initialMessage: string, idempotencyKey: string): Promise<string> => {
      if (createSession) return await createSession(initialMessage, idempotencyKey);
      const creator = (context.client as unknown as CreateClient).createSession;
      if (typeof creator !== "function") throw new Error(labels.newChatUnavailable);
      const created = await creator.call(context.client, context.workspaceId, {
        initialMessage,
        idempotencyKey,
      } as Parameters<NonNullable<CreateClient["createSession"]>>[1]);
      return created.id;
    },
    [context.client, context.workspaceId, createSession, labels.newChatUnavailable],
  );

  const list = (
    <SessionList
      {...scope}
      {...listProps}
      labels={labels}
      selectedSessionId={selected}
      onSelect={select}
      onNewChat={newChat ? () => select(null) : undefined}
      onArchived={(archivedId) => {
        if (archivedId === selected) select(null);
      }}
      refreshKey={listRevision}
      className="h-full"
    />
  );

  return (
    <div
      className={cn("og-root og-chat relative flex min-h-0 min-w-0 bg-og-bg text-og-fg", className)}
      style={{ height }}
      data-og-chat=""
    >
      <aside
        className="og-chat-sidebar min-h-0 w-64 shrink-0 flex-col border-r border-og-border"
        data-og-chat-sidebar=""
      >
        {list}
      </aside>
      {drawerOpen ? (
        <div className="og-chat-drawer absolute inset-0 z-20 flex" data-og-chat-drawer="">
          <div className="flex h-full w-[min(20rem,85%)] flex-col border-r border-og-border bg-og-bg shadow-xl">
            <div className="flex justify-end p-1">
              <button
                type="button"
                aria-label={labels.closeChats}
                onClick={() => setDrawerOpen(false)}
                className="rounded p-1.5 text-og-fg-muted hover:bg-og-surface-2"
              >
                <XIcon className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1">{list}</div>
          </div>
          <button
            type="button"
            aria-label={labels.closeChats}
            className="flex-1 bg-og-bg/60"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="og-chat-menu flex items-center gap-2 border-b border-og-border px-2 py-1">
          <button
            type="button"
            aria-label={labels.openChats}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="rounded p-1.5 text-og-fg-muted hover:bg-og-surface-2"
            data-og-chat-menu=""
          >
            <MenuIcon className="size-4" aria-hidden />
          </button>
          <span className="text-og-sm font-semibold text-og-fg-muted">{labels.heading}</span>
        </div>
        <div className="min-h-0 flex-1 px-3 pb-3 pt-1">
          {selected ? (
            <SessionConversation
              {...conversationProps}
              {...scope}
              sessionId={selected}
              height="100%"
            />
          ) : (
            <NewChat
              labels={labels}
              create={create}
              onCreated={(id) => {
                setListRevision((revision) => revision + 1);
                select(id);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function NewChat({
  labels,
  create,
  onCreated,
}: {
  labels: OpenGeniChatLabels;
  create: (initialMessage: string, idempotencyKey: string) => Promise<string>;
  onCreated: (sessionId: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const formatError = useErrorMessage();
  // One key per draft, so a retried send returns the same chat.
  const idempotencyKey = useRef(crypto.randomUUID());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const initialMessage = text.trim();
    if (!initialMessage || sending) return;
    setSending(true);
    setError(null);
    try {
      const id = await create(initialMessage, idempotencyKey.current);
      idempotencyKey.current = crypto.randomUUID();
      setText("");
      onCreated(id);
    } catch (cause) {
      setError({ cause });
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex h-full flex-col justify-end gap-2 p-3"
      data-og-new-chat-composer=""
    >
      {error ? (
        <p role="alert" className="text-og-xs text-og-status-failed">
          {formatError(
            error.cause,
            error.cause instanceof Error && error.cause.message === labels.newChatUnavailable
              ? labels.newChatUnavailable
              : undefined,
          )}
        </p>
      ) : null}
      <div className="flex items-end gap-2 rounded-lg border border-og-border bg-og-surface-1 p-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={labels.newChatPlaceholder}
          aria-label={labels.newChatPlaceholder}
          rows={2}
          disabled={sending}
          className="min-h-10 flex-1 resize-none bg-transparent text-og-base text-og-fg outline-hidden placeholder:text-og-fg-subtle"
        />
        <button
          type="submit"
          aria-label={labels.send}
          disabled={sending || !text.trim()}
          className="rounded-md bg-og-accent p-2 text-og-accent-fg disabled:opacity-50"
        >
          <SendIcon className="size-4" aria-hidden />
        </button>
      </div>
    </form>
  );
}
