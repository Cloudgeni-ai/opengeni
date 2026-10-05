import {
  OpenGeniApiError,
  type FileResourceRef,
  type LatencyMode,
  type OpenGeniClient,
  type ReasoningEffort,
} from "@opengeni/sdk";
import { MenuIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useWorkspaceModelCatalog } from "../hooks/use-available-models";
import { FILE_ONLY_MESSAGE_TEXT, type ComposerState } from "../hooks/use-composer";
import { useFileAttachments } from "../hooks/use-file-attachments";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { ChatComposer } from "./chat-composer";
import { ModelPolicyPicker } from "./model-policy-picker";
import { useClientConfigFlags } from "../hooks/use-client-config-flags";
import {
  SessionConversation,
  useComposerTranscription,
  type SessionConversationProps,
} from "./session-conversation";
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
export type OpenGeniChatCreateOptions = {
  /** Files attached in the new-chat composer. */
  resources?: FileResourceRef[] | undefined;
  /** Present only when the user changed it in the model picker. */
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  latencyMode?: LatencyMode | undefined;
};

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

type CreateClient = Partial<Pick<OpenGeniClient, "createSession">>;

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
  const root = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(root, { theme, surface });
  const config = useClientConfigFlags(context.client);
  // A host creator replaces the proxy route; otherwise trust the proxy's report.
  const canCreate = createSession !== undefined || config.sessionCreation;

  const select = useCallback(
    (next: string | null) => {
      if (controlledSessionId === undefined) setUncontrolled(next);
      onSessionChange?.(next);
      setDrawerOpen(false);
    },
    [controlledSessionId, onSessionChange],
  );

  const create = useCallback(
    async (
      initialMessage: string,
      idempotencyKey: string,
      options: OpenGeniChatCreateOptions,
    ): Promise<string> => {
      if (createSession) return await createSession(initialMessage, idempotencyKey, options);
      const creator = (context.client as unknown as CreateClient).createSession;
      if (typeof creator !== "function") throw new Error(labels.newChatUnavailable);
      try {
        const created = await creator.call(context.client, context.workspaceId, {
          initialMessage,
          idempotencyKey,
          ...options,
        } as Parameters<NonNullable<CreateClient["createSession"]>>[1]);
        return created.id;
      } catch (error) {
        // A proxy without a createSession hook refuses the route itself.
        if (error instanceof OpenGeniApiError && error.code === "route_not_allowed") {
          throw new Error(labels.newChatUnavailable, { cause: error });
        }
        throw error;
      }
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
              // Sub-agent chats open in place, like a chat from the list.
              onOpenSession={conversationProps?.onOpenSession ?? select}
              {...scope}
              sessionId={selected}
              height="100%"
            />
          ) : (
            <NewChat
              scope={scope}
              labels={labels}
              placeholderOverride={labelOverrides?.newChatPlaceholder}
              conversationProps={conversationProps}
              available={canCreate}
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

const NOOP_ASYNC = async () => {};

/**
 * The first message of a new chat, in the same composer as follow-ups: file
 * attachments, the model picker when offered, and the host's `composerProps`
 * (custom controls, voice input, copy).
 */
function NewChat({
  scope,
  labels,
  placeholderOverride,
  conversationProps,
  available,
  create,
  onCreated,
}: {
  scope: ClientOverride;
  labels: OpenGeniChatLabels;
  placeholderOverride: string | undefined;
  conversationProps: OpenGeniChatProps["conversationProps"];
  /** False when this product cannot start chats; the composer is disabled and says so. */
  available: boolean;
  create: (
    initialMessage: string,
    idempotencyKey: string,
    options: OpenGeniChatCreateOptions,
  ) => Promise<string>;
  onCreated: (sessionId: string) => void;
}) {
  const context = useOpenGeni(scope);
  const config = useClientConfigFlags(context.client);
  const composerProps = conversationProps?.composerProps;
  const modelPickerProps = conversationProps?.modelPickerProps;
  const showModelPicker = conversationProps?.modelPicker ?? config.modelSelection;
  const catalog = useWorkspaceModelCatalog({
    client: context.client,
    workspaceId: context.workspaceId,
    enabled: showModelPicker,
  });
  const files = useFileAttachments(scope);
  const uploadsEnabled = (conversationProps?.attachments ?? true) && config.uploads;
  const transcription = useComposerTranscription(
    context.client,
    context.workspaceId,
    (conversationProps?.voiceInput ?? true) && available ? config.voiceInput : null,
  );
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  // Only what the user changed is sent; everything else stays server-owned.
  const [choice, setChoice] = useState<
    Pick<OpenGeniChatCreateOptions, "model" | "reasoningEffort" | "latencyMode">
  >({});
  const formatError = useErrorMessage();
  // One key per attempted payload, so a retried send returns the same chat
  // and an edited retry is a new request rather than an idempotency conflict.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const resources = uploadsEnabled ? files.readyResources : [];
  const pendingFiles = uploadsEnabled && files.hasUnresolved;

  const submit = async (): Promise<boolean> => {
    const initialMessage = text.trim() || (resources.length > 0 ? FILE_ONLY_MESSAGE_TEXT : "");
    if (!initialMessage || sending || pendingFiles || !available) return false;
    const options: OpenGeniChatCreateOptions = {
      ...(resources.length > 0 ? { resources } : {}),
      ...(showModelPicker ? choice : {}),
    };
    const fingerprint = JSON.stringify([initialMessage, options]);
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    }
    setSending(true);
    setError(null);
    try {
      const id = await create(initialMessage, attempt.current.key, options);
      attempt.current = null;
      setText("");
      files.removeReadyFiles(resources.map((resource) => resource.fileId));
      onCreated(id);
      return true;
    } catch (cause) {
      setError({ cause });
      return false;
    } finally {
      setSending(false);
    }
  };

  const defaultModel = catalog.defaultModel;
  const policy =
    showModelPicker && (choice.model ?? defaultModel)
      ? {
          model: (choice.model ?? defaultModel)!,
          reasoningEffort:
            choice.reasoningEffort ?? config.defaultReasoningEffort ?? ("medium" as const),
          latencyMode: choice.latencyMode ?? ("standard" as const),
        }
      : null;

  const composer: ComposerState = {
    value: text,
    setValue: setText,
    hasDraftContent: () => text.length > 0 || files.attachments.length > 0,
    send: submit,
    steer: submit,
    sending,
    canSend:
      available && (text.trim().length > 0 || resources.length > 0) && !sending && !pendingFiles,
    pause: NOOP_ASYNC,
    pausing: false,
    resume: NOOP_ASYNC,
    resumeScope: NOOP_ASYNC,
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    policy,
    setModel: (model) => setChoice((current) => ({ ...current, model })),
    setReasoningEffort: (reasoningEffort) =>
      setChoice((current) => ({ ...current, reasoningEffort })),
    setLatencyMode: (latencyMode) => setChoice((current) => ({ ...current, latencyMode })),
    draftPersistence: "disabled",
    applyDraft: () => {},
    reloadDraft: NOOP_ASYNC,
    resolveDraftConflict: NOOP_ASYNC,
    restoredResources: [],
    removeRestoredResource: () => {},
    // Shown below with the product's own copy.
    error: null,
    clearError: () => setError(null),
  };

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      className="mx-auto box-border flex h-full w-full max-w-3xl flex-col gap-4 p-3"
      data-og-new-chat-composer=""
    >
      {/* Sits a little above center, relative to the panel rather than the page. */}
      <div aria-hidden className="min-h-0 flex-[2]" />
      {labels.newChatTitle ? (
        <p className="text-center text-og-md font-medium text-og-fg">{labels.newChatTitle}</p>
      ) : null}
      <ChatComposer
        {...composerProps}
        {...(transcription && composerProps?.transcription === undefined ? { transcription } : {})}
        composer={composer}
        attachments={uploadsEnabled ? files : undefined}
        disabled={!available || composerProps?.disabled}
        runControl="none"
        running={false}
        placeholder={placeholderOverride ?? composerProps?.placeholder ?? labels.newChatPlaceholder}
        inputProps={{
          "aria-label": placeholderOverride ?? labels.newChatPlaceholder,
          ...composerProps?.inputProps,
        }}
        messages={{ sendMessageAriaLabel: labels.send, ...composerProps?.messages }}
        controlsStart={
          composerProps?.controlsStart ??
          (policy ? (
            <ModelPolicyPicker
              groupPresentation={modelPickerProps?.groupPresentation}
              messages={modelPickerProps?.messages}
              rows={catalog.rows}
              model={policy.model}
              effort={policy.reasoningEffort}
              latencyMode={policy.latencyMode}
              loading={catalog.loading}
              error={catalog.error?.message}
              disabled={sending}
              menuSide="bottom"
              onOpenChange={(open) => {
                if (open) void catalog.refresh();
              }}
              onModelChange={composer.setModel!}
              onEffortChange={composer.setReasoningEffort!}
              onLatencyModeChange={composer.setLatencyMode!}
            />
          ) : undefined)
        }
        responsiveBasis={composerProps?.responsiveBasis ?? "container"}
      />
      {!available ? (
        <p className="text-center text-og-sm text-og-fg-muted" data-og-new-chat-unavailable="">
          {labels.newChatUnavailable}
        </p>
      ) : error ? (
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
