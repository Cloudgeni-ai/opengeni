import { MenuIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CreatedConversation,
  NewConversationCreateOptions,
} from "../hooks/use-new-conversation";
import { cn } from "../lib/cn";
import { notifyObserver } from "../lib/notify-observer";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { NewConversation } from "./new-conversation";
import { useClientConfigFlags } from "../hooks/use-client-config-flags";
import { SessionConversation, type SessionConversationProps } from "./session-conversation";
import { SessionList, type SessionListLabels, type SessionListProps } from "./session-list";
import { SessionProxyScope, type SessionProxyBaseUrl } from "./session-proxy-scope";

export type OpenGeniChatLabels = SessionListLabels & {
  openChats: string;
  closeChats: string;
  newChatPlaceholder: string;
  /** Heading above the new-chat composer; empty hides it. */
  newChatTitle: string;
  send: string;
  newChatUnavailable: string;
  newChatRetry?: string | undefined;
  newChatPending?: string | undefined;
  newChatFinishingUploads?: string | undefined;
};

const DEFAULT_LABELS: Omit<OpenGeniChatLabels, keyof SessionListLabels> = {
  openChats: "Open chats",
  closeChats: "Close chats",
  newChatPlaceholder: "Ask anything…",
  newChatTitle: "How can I help?",
  send: "Send",
  newChatUnavailable: "New chats are not enabled for this product.",
};

/** What the first message carries besides its text. */
export type OpenGeniChatCreateOptions = NewConversationCreateOptions;

export type OpenGeniChatProps = ClientOverride &
  SessionProxyBaseUrl & {
    /** Controlled selection. `null` shows the new-chat composer. */
    sessionId?: string | null | undefined;
    /** Initial selection when uncontrolled. Defaults to a new chat. */
    defaultSessionId?: string | null | undefined;
    onSessionChange?: ((sessionId: string | null) => void) | undefined;
    /**
     * Create a chat from its first message. Defaults to `client.createSession`
     * with `{ initialMessage, idempotencyKey }` plus the attached files and any
     * model choice, which `createSessionProxyHandler` accepts when the server
     * supplies a `createSession` hook. Return the new id.
     */
    createSession?:
      | ((
          initialMessage: string,
          idempotencyKey: string,
          options: OpenGeniChatCreateOptions,
        ) => Promise<string>)
      | undefined;
    /**
     * Hide the "New chat" entry point. It is also hidden when the session proxy
     * reports chat creation unavailable (no `createSession` hook) and no
     * `createSession` prop is given.
     */
    newChat?: boolean | undefined;
    /**
     * Forwarded to the conversation (message rendering, tool renderers,
     * composer...). `attachments`, `modelPicker`, `modelPickerProps`, and
     * `composerProps` also apply to the new-chat composer.
     */
    conversationProps?: Omit<
      SessionConversationProps,
      "sessionId" | "client" | "workspaceId" | "baseUrl" | "headers" | "fetch"
    >;
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

/**
 * A complete chat experience: the user's chat list plus the conversation.
 * The list is a sidebar when the component is wide and a drawer when narrow
 * (container-based, so it adapts inside panels as well as full pages).
 * `<OpenGeniChat baseUrl="/api/opengeni" />` needs no provider: it talks to
 * your session proxy and uses the workspace the proxy resolves.
 */
export function OpenGeniChat({ baseUrl, headers, fetch, ...props }: OpenGeniChatProps) {
  if (baseUrl === undefined) return <Chat {...props} />;
  const { client, workspaceId, ...rest } = props;
  return (
    <SessionProxyScope
      baseUrl={baseUrl}
      workspaceId={workspaceId}
      client={client}
      headers={headers}
      fetch={fetch}
    >
      <Chat {...rest} />
    </SessionProxyScope>
  );
}

function Chat({
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
}: Omit<OpenGeniChatProps, "baseUrl" | "headers" | "fetch">) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides } as OpenGeniChatLabels;
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const [uncontrolled, setUncontrolled] = useState<string | null>(defaultSessionId);
  const selected = controlledSessionId !== undefined ? controlledSessionId : uncontrolled;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [handoff, setHandoff] = useState<CreatedConversation | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(root, { theme, surface });
  const config = useClientConfigFlags(context.client);
  // A host creator replaces the proxy route; otherwise trust the proxy's report.
  const canCreate = createSession !== undefined || config.sessionCreation;

  const select = useCallback(
    (next: string | null) => {
      setHandoff(null);
      if (controlledSessionId === undefined) setUncontrolled(next);
      notifyObserver(onSessionChange, next);
      setDrawerOpen(false);
    },
    [controlledSessionId, onSessionChange],
  );

  useEffect(() => {
    if (!handoff) return;
    // The child's native composer captures its seed on mount. Do not seed it
    // again after later navigation; voice keeps its separate one-shot handoff
    // until the lazy control reports consumption.
    if (selected === handoff.sessionId && !handoff.realtimeModel) setHandoff(null);
    else if (selected !== null && selected !== handoff.sessionId) setHandoff(null);
  }, [handoff, selected]);

  const list = (
    <SessionList
      {...scope}
      {...listProps}
      labels={labels}
      selectedSessionId={selected}
      onSelect={select}
      onNewChat={newChat && canCreate ? () => select(null) : undefined}
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
              composerOptions={{
                ...conversationProps?.composerOptions,
                ...(handoff?.sessionId === selected ? { initialDraft: handoff.draft } : {}),
              }}
              realtimeVoiceProps={{
                ...conversationProps?.realtimeVoiceProps,
                ...(handoff?.sessionId === selected && handoff.realtimeModel
                  ? {
                      realtimeAutostartModel: handoff.realtimeModel,
                      onRealtimeAutostartConsumed: () => {
                        setHandoff(null);
                        notifyObserver(
                          conversationProps?.realtimeVoiceProps?.onRealtimeAutostartConsumed,
                        );
                      },
                    }
                  : {}),
              }}
              // Sub-agent chats open in place, like a chat from the list.
              onOpenSession={conversationProps?.onOpenSession ?? select}
              {...scope}
              sessionId={selected}
              height="100%"
            />
          ) : (
            <NewConversation
              {...scope}
              attachments={conversationProps?.attachments}
              modelPicker={conversationProps?.modelPicker}
              modelPickerProps={conversationProps?.modelPickerProps}
              composerProps={conversationProps?.composerProps}
              voiceInput={conversationProps?.voiceInput}
              realtimeVoice={conversationProps?.realtimeVoice}
              realtimeVoiceProps={conversationProps?.realtimeVoiceProps}
              labels={{
                ...(labels.newChatRetry ? { retry: labels.newChatRetry } : {}),
                ...(labels.newChatPending ? { pending: labels.newChatPending } : {}),
                ...(labels.newChatFinishingUploads
                  ? { finishingUploads: labels.newChatFinishingUploads }
                  : {}),
                title: labels.newChatTitle,
                send: labels.send,
                unavailable: labels.newChatUnavailable,
                placeholder:
                  labelOverrides?.newChatPlaceholder ??
                  conversationProps?.composerProps?.placeholder ??
                  labels.newChatPlaceholder,
              }}
              enabled={canCreate}
              createSession={createSession}
              onCreated={(created) => {
                setListRevision((revision) => revision + 1);
                select(created.sessionId);
                setHandoff(created);
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
