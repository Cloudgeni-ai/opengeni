import type { OpenGeniClient } from "@opengeni/sdk";
import { ArrowUpIcon, LoaderCircleIcon, MenuIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { SessionConversation, type SessionConversationProps } from "./session-conversation";
import { SessionList, type SessionListLabels, type SessionListProps } from "./session-list";

export type OpenGeniChatLabels = SessionListLabels & {
  openChats: string;
  closeChats: string;
  newChatPlaceholder: string;
  /** Heading above the new-chat composer; empty hides it. */
  newChatTitle: string;
  send: string;
  newChatUnavailable: string;
};

const DEFAULT_LABELS: Omit<OpenGeniChatLabels, keyof SessionListLabels> = {
  openChats: "Open chats",
  closeChats: "Close chats",
  newChatPlaceholder: "Ask anything…",
  newChatTitle: "How can I help?",
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
  /**
   * Light or dark. Defaults to `auto`: follow the host page (an enclosing
   * `data-og-theme`, `class="dark"`/`data-theme` on <html> or <body>, the
   * host's `color-scheme`, then its background), not the OS setting alone.
   */
  theme?: HostThemePreference | undefined;
  /**
   * `host` (default) derives backgrounds and cards from the host background so
   * the chat blends in; `theme` uses the `--og-color-*` surface tokens as they
   * are. Customized surface tokens are always kept.
   */
  surface?: HostSurfacePreference | undefined;
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
  theme,
  surface,
}: OpenGeniChatProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides } as OpenGeniChatLabels;
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const [uncontrolled, setUncontrolled] = useState<string | null>(defaultSessionId);
  const selected = controlledSessionId !== undefined ? controlledSessionId : uncontrolled;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(root, { theme, surface });

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
      ref={root}
      className={cn(
        "og-root og-chat relative flex min-h-0 min-w-0 bg-og-bg text-og-base text-og-fg",
        className,
      )}
      style={{ ...hostTheme.style, height }}
      data-og-theme={hostTheme.attribute}
      data-og-host-theme=""
      data-og-chat=""
    >
      <aside
        className="og-chat-sidebar min-h-0 w-64 shrink-0 flex-col border-r border-og-border"
        data-og-chat-sidebar=""
      >
        {list}
      </aside>
      {drawerOpen ? (
        <div className="og-chat-drawer absolute inset-0 z-30 flex" data-og-chat-drawer="">
          <div className="flex h-full w-[min(20rem,85%)] flex-col border-r border-og-border bg-og-bg shadow-og-lg">
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
            className="flex-1 bg-black/25"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="og-chat-menu flex items-center gap-2 px-2 py-1">
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
        <div className="og-chat-main min-h-0 flex-1 px-3 pb-3 pt-1">
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
      className="mx-auto box-border flex h-full w-full max-w-3xl flex-col gap-4 p-3"
      data-og-new-chat-composer=""
    >
      {/* Sits a little above center, relative to the panel rather than the page. */}
      <div aria-hidden className="min-h-0 flex-[2]" />
      {labels.newChatTitle ? (
        <p className="text-center text-og-md font-medium text-og-fg">{labels.newChatTitle}</p>
      ) : null}
      <div
        className={cn(
          "flex items-end gap-2 rounded-og-lg border border-og-border/90 bg-og-surface-1 p-2 pl-3.5 shadow-og-sm",
          "transition-[border-color,box-shadow] duration-200 ease-og-out",
          "focus-within:border-og-accent/50 focus-within:shadow-og-glow",
        )}
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={labels.newChatPlaceholder}
          aria-label={labels.newChatPlaceholder}
          rows={2}
          disabled={sending}
          className="min-h-12 flex-1 resize-none bg-transparent py-1 text-og-composer text-og-fg outline-hidden placeholder:text-og-fg-subtle md:text-og-composer-wide"
        />
        <button
          type="submit"
          aria-label={labels.send}
          disabled={sending || !text.trim()}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-og-md pointer-coarse:size-11",
            "border border-og-primary-border bg-og-primary text-og-primary-fg",
            "transition-[background-color,transform,opacity] duration-150 ease-og-spring",
            "hover:bg-og-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {sending ? (
            <LoaderCircleIcon className="size-4 animate-og-spin" aria-hidden />
          ) : (
            <ArrowUpIcon className="size-4" aria-hidden />
          )}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-center text-og-sm text-og-status-failed">
          {formatError(
            error.cause,
            error.cause instanceof Error && error.cause.message === labels.newChatUnavailable
              ? labels.newChatUnavailable
              : undefined,
          )}
        </p>
      ) : null}
      <div aria-hidden className="min-h-0 flex-[3]" />
    </form>
  );
}
