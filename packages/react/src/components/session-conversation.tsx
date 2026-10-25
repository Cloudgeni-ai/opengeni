import {
  resolveWorkspaceVoiceInputEnabled,
  SESSION_SCOPE_HEADER,
  type ClientVoiceInputConfig,
  type OpenGeniClient,
  type SessionEvent,
} from "@opengeni/sdk";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import type { SiteSnapshotClient } from "./artifacts/chat-interactive-block";
import type { ClientOverride } from "../session-context";
import { ModelPolicyPicker, type ModelPolicyPickerProps } from "./model-policy-picker";
import { ConversationRenderBoundary } from "./conversation-render-boundary";
import {
  useSessionConversation,
  type SessionConversationController,
  type UseSessionConversationOptions,
} from "../hooks/use-session-conversation";
import { useGoal, type UseGoalOptions } from "../hooks/use-goal";
import { useQueuedPromptRecall } from "../hooks/use-queued-prompt-recall";
import { useDocumentForeground, useElementOnScreen } from "../hooks/use-foreground-visibility";
import { useSessionReadAcknowledgement } from "../hooks/use-session-read-acknowledgement";
import {
  createSessionRetainedScreenshotLoader,
  createWorkspaceRetainedArtifactLoader,
  createWorkspaceRetainedVideoLoader,
} from "../timeline/retained-loaders";
import { useRealtimeVoiceModels } from "../hooks/use-realtime-voice-models";
import type { SessionRealtimeControl } from "../realtime/realtime-control";
import { EMBEDDED_GENIE_LOADING, type GenieLoadingOptions } from "../timeline/genie-loading";
import { ApprovalSurface } from "./approval-surface";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import type { ComposerTranscriptionControlProps } from "./composer-transcription-control";
import { SessionChrome, type SessionChromeProps } from "./session-chrome";
import { HumanInputSurface, type HumanInputSurfaceProps } from "./human-input-surface";
import { MessageTimeline, type MessageTimelineProps } from "./message-timeline";
import { ProviderRecoveryNotice } from "./provider-recovery-notice";
import { currentProviderRecovery } from "../lib/provider-recovery";
import {
  chainLinkResolvers,
  sessionLinkResolver,
  useOpenGeniLinkResolver,
  viewerLinkResolver,
  type OpenGeniLinkResolver,
  type OpenGeniViewerTarget,
} from "./open-geni-links";
import type { UserMessageDisclosureLabels } from "./user-message-body";
import { cn } from "../lib/cn";
import { useComposerWithStreamState } from "../lib/use-calm-service-failure";
import { SessionProxyScope, type SessionProxyBaseUrl } from "./session-proxy-scope";
import { useErrorMessage } from "../lib/error-message";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";
import { SingleSendWording, useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { ThisComputerCard, type ThisComputerCardProps } from "./this-computer/this-computer-card";

export type SessionConversationLabels = {
  /** Banner action after a refresh failure; the conversation stays mounted. */
  retry: string;
  /** Action when the conversation could not load at all. */
  tryAgain: string;
  /** Shown in place of a Site preview when the client config reports `artifacts: false`. */
  sitePreviewUnavailable: string;
};

const DEFAULT_CONVERSATION_LABELS = (t: OpenGeniText): SessionConversationLabels => ({
  retry: t("sessionConversation.retry"),
  tryAgain: t("sessionConversation.tryAgain"),
  sitePreviewUnavailable: t("sessionConversation.sitePreviewUnavailable"),
});

export type SessionConversationProps = ClientOverride &
  SessionProxyBaseUrl & {
    /**
     * `null` while your server is still creating the session. Render the
     * conversation as soon as the person sends, with `pendingPrompt`, then
     * pass the id when creation returns: it is the same mounted conversation,
     * so the prompt and its startup row stay put and nothing flashes.
     */
    sessionId: string | null;
    /** See `useSessionConversation`'s `pendingPrompt`. Read once per conversation. */
    pendingPrompt?: UseSessionConversationOptions["pendingPrompt"];
    /** Product-owned desktop connection flow for computer offers. No console URLs or shell commands are assumed. */
    computerConnection?: Omit<ThisComputerCardProps, "rationale">;
    /** Host-owned artifact links, previews and other message presentation. */
    renderMessageText?: MessageTimelineProps["renderMessageText"];
    /**
     * Open Opengeni object links in agent replies (`artifact:`, `sandbox:`,
     * editable artifacts, Sites). Asked first; by default retained files and
     * sandbox files download only when the proxy explicitly enables them, while
     * editable artifacts and Sites stay unavailable until the host resolves them.
     */
    resolveLink?: OpenGeniLinkResolver | undefined;
    /**
     * Open agent links to editable artifacts and Sites in a host viewer, for
     * example `SessionArtifactViewer` mounted beside the conversation. Asked
     * after `resolveLink`.
     */
    onOpenArtifact?: ((target: OpenGeniViewerTarget) => void) | undefined;
    /**
     * Open another session the conversation points at: a sub-agent's chat from
     * its worker card or a child update. `OpenGeniChat` opens it in place;
     * without it those entries are not links.
     */
    onOpenSession?: ((sessionId: string) => void) | undefined;
    /**
     * Current title for a session id, used to name the agents this
     * conversation spawns, messages, and hears from. Without it, agents keep
     * the title they were spawned with, or generic labels.
     */
    resolveSessionTitle?: ((sessionId: string) => string | null | undefined) | undefined;
    /**
     * Inline previews for assistant `opengeni-site` / `opengeni-html` fences.
     * Defaults to the Opengeni preview. When the client config reports
     * `artifacts: false`, Sites show as unavailable without a request; `false`
     * shows the fence as code.
     */
    renderInteractiveBlock?: MessageTimelineProps["renderInteractiveBlock"] | false;
    /** Product-specific tool-call renderers; defaults to the built-in registry. */
    toolRegistry?: MessageTimelineProps["toolRegistry"];
    /** Host presentation without replacing native history, navigation or annotations. */
    timelineProps?:
      | Pick<
          MessageTimelineProps,
          "turnSummary" | "renderAuthNeeded" | "emptyState" | "renderMessageSender"
        >
      | undefined;
    /**
     * Replace the "usage limit reached" row for an `allowance_exhausted`
     * refusal, for example to link your own plan or admin page.
     */
    renderAllowanceExhausted?: MessageTimelineProps["renderAllowanceExhausted"];
    /** Replace the words of the default "usage limit reached" row. */
    allowanceExhaustedLabels?: MessageTimelineProps["allowanceExhaustedLabels"];
    /**
     * File attachments in the composer. Defaults to true; the attach control
     * appears only when the deployment's client config enables file uploads.
     * A session proxy reports them off for anonymous visitors (`visitor: true`
     * from `resolve`) unless it sets `visitorUploads`.
     */
    attachments?: boolean | undefined;
    /**
     * Composer microphone (dictation into the draft). Defaults to true; it
     * appears only when the client config reports voice input available.
     */
    voiceInput?: boolean | undefined;
    /**
     * Live speech-to-speech voice in the composer. Opt-in: a call spends the
     * workspace's credits and asks for the microphone, so it is off unless this
     * is `true` (or an older session proxy reports `realtimeVoice: true`). The
     * button then appears only when the workspace offers an available voice
     * model and the config has not turned voice off (`realtimeVoice: false`).
     */
    realtimeVoice?: boolean | undefined;
    /** Optional connection/voice handoff; the stock control owns call lifecycle and admission. */
    realtimeVoiceProps?:
      | Partial<
          Pick<
            ComponentProps<typeof SessionRealtimeControl>,
            | "codexConnected"
            | "realtimeAutostartModel"
            | "onRealtimeAutostartConsumed"
            | "onVoiceActiveChange"
            | "modelMenu"
            | "voiceSettings"
          >
        >
      | undefined;
    /**
     * Copy and visual for the "working" indicator before the first reply.
     * Defaults to neutral copy ("Thinking…"); omitted fields keep those
     * defaults. See `MessageTimeline`'s `genieLoading`.
     */
    genieLoading?: GenieLoadingOptions | undefined;
    /**
     * Show the model/reasoning picker. End users of an embedded product rarely
     * choose models, so it is hidden unless this is `true` or the client config
     * reports `modelSelection: true` (`createSessionProxyHandler({ modelSelection: true })`).
     */
    modelPicker?: boolean | undefined;
    /** Model-picker appearance only; visibility, policy and delivery remain owned here. */
    modelPickerProps?: Pick<ModelPolicyPickerProps, "groupPresentation" | "messages"> | undefined;
    /** Localized actions for already-sent user-message disclosure. */
    userMessageDisclosureLabels?: UserMessageDisclosureLabels | undefined;
    loadSkillReview?: HumanInputSurfaceProps["loadSkillReview"];
    className?: string;
    /** Defaults to filling the host. The host owns available height. */
    height?: CSSProperties["height"];
    /**
     * Mark the conversation read while the person can see it. Defaults to
     * true: whenever the timeline is on screen, the page is visible and the
     * window focused, each delivered reply, question or failure is
     * acknowledged for the signed-in person (once per reply, not per streamed
     * token). Unread state, and notifications a host derives from it (for
     * example from `turn.completed` webhooks that check `session.unread`),
     * then skip replies the person already watched. A hidden or collapsed
     * timeline, a background tab, or an unfocused window acknowledges nothing.
     * Set `false` when viewing must not count as reading.
     */
    readAcknowledgement?: boolean | undefined;
    /**
     * Called once for each event that arrives while the conversation is open,
     * after its history first loaded (never for that history or for older
     * pages read later). For hosts that react to the agent's work, for
     * example reloading a preview when a tool call returns.
     */
    onEvent?: ((event: SessionEvent) => void) | undefined;
    /**
     * Light or dark. Defaults to `auto`: follow the host page (an enclosing
     * `data-og-theme`, `class="dark"`/`data-theme` on <html> or <body>, the
     * host's `color-scheme`, then its background), not the OS setting alone.
     */
    theme?: HostThemePreference | undefined;
    /**
     * `host` (default) derives backgrounds and cards from the host background so
     * the conversation blends in; `theme` uses the `--og-color-*` surface tokens
     * as they are. Customized surface tokens are always kept.
     */
    surface?: HostSurfacePreference | undefined;
    /** Conversation-owned copy (error actions). */
    labels?: Partial<SessionConversationLabels> | undefined;
    /**
     * The signed-in person's subject id, as recorded on their turns
     * (`turn.initiator.subjectId`). When set, Up in an empty composer pulls
     * their latest waiting prompt back for editing; prompts from anyone else,
     * including ones your backend sends with a service key, are never
     * recalled. Omit it and Up keeps its normal behaviour.
     */
    viewerSubjectId?: string | null | undefined;
    /** Presentation/custom controls only; queue and delivery wiring stay owned here. */
    composerProps?: Omit<
      ChatComposerProps,
      "composer" | "effectiveControl" | "queuedAheadCount" | "attachments"
    >;
    /** Optional host context and notifications; stock delivery remains authoritative. */
    composerOptions?: UseSessionConversationOptions["composerOptions"];
    /** Extra status panels without replacing stock queue/goal behavior. */
    chromeProps?: Omit<
      SessionChromeProps,
      "queue" | "composer" | "goal" | "sessionStatus" | "readOnly" | "onComposerFocus"
    >;
    /** Localized questions and presentation; responses remain stock. */
    humanInputProps?: Pick<
      HumanInputSurfaceProps,
      "messages" | "autoFocus" | "decisionButtons" | "allowedSaveTo" | "className"
    >;
    /** Product approval presentation; permission decisions remain stock. */
    approvalProps?: Omit<
      ComponentProps<typeof ApprovalSurface>,
      "approvals" | "onApprove" | "onReject" | "responding" | "error"
    >;
  };

export type SessionConversationViewProps = Omit<
  SessionConversationProps,
  | "sessionId"
  | "client"
  | "workspaceId"
  | "baseUrl"
  | "headers"
  | "fetch"
  | "attachments"
  | "modelPicker"
  | "composerOptions"
  | "pendingPrompt"
> & {
  conversation: SessionConversationController;
};

/**
 * One mount per conversation. A host-created session goes from `null` to its
 * id inside the same conversation; any other change of id is a new one.
 */
function useConversationIdentity(workspaceId: string | undefined, sessionId: string | null) {
  const ref = useRef<{ workspaceId: string | undefined; sessionId: string | null; key: string }>(
    null,
  );
  const previous = ref.current;
  if (
    !previous ||
    previous.workspaceId !== workspaceId ||
    (previous.sessionId !== sessionId && previous.sessionId !== null)
  )
    ref.current = { workspaceId, sessionId, key: `${workspaceId ?? ""}:${sessionId ?? "new"}` };
  else if (previous.sessionId !== sessionId) ref.current = { ...previous, sessionId };
  return ref.current!.key;
}

/** Complete existing-session conversation. Uses the provider's normal SDK client
 * (including Site clients), one shared event feed, and authoritative queue state.
 * `<SessionConversation baseUrl="/api/opengeni" sessionId={id} />` needs no
 * provider: it talks to your session proxy and its resolved workspace. */
export function SessionConversation({
  baseUrl,
  headers,
  fetch,
  ...props
}: SessionConversationProps) {
  const resetKey = useConversationIdentity(props.workspaceId, props.sessionId);
  if (baseUrl === undefined)
    return (
      <ConversationRenderBoundary resetKey={resetKey}>
        <RetryingConversation {...props} />
      </ConversationRenderBoundary>
    );
  const { client, workspaceId, ...rest } = props;
  return (
    <ConversationRenderBoundary resetKey={resetKey}>
      <SessionProxyScope
        baseUrl={baseUrl}
        workspaceId={workspaceId}
        client={client}
        headers={headers}
        fetch={fetch}
      >
        <RetryingConversation {...rest} />
      </SessionProxyScope>
    </ConversationRenderBoundary>
  );
}

/**
 * `onEvent` for each event newer than any seen since the history first
 * loaded. The first ready read only sets where "new" starts, so loading the
 * history, an older page or a reconnect's replay calls nothing again.
 */
function useLiveEvents(
  sessionId: string | null,
  events: readonly SessionEvent[],
  ready: boolean,
  onEvent: ((event: SessionEvent) => void) | undefined,
) {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const seen = useRef<{ sessionId: string | null; sequence: number | null }>({
    sessionId,
    sequence: null,
  });
  useEffect(() => {
    if (seen.current.sessionId !== sessionId) seen.current = { sessionId, sequence: null };
    if (!ready || sessionId === null) return;
    const previous = seen.current.sequence;
    const newest = events.reduce((max, event) => Math.max(max, event.sequence), previous ?? 0);
    seen.current = { sessionId, sequence: newest };
    if (previous === null) return;
    const fresh = events
      .filter((event) => event.sequence > previous)
      .sort((a, b) => a.sequence - b.sequence);
    for (const event of fresh) callback.current?.(event);
  }, [events, ready, sessionId]);
}

function RetryingConversation(props: Omit<SessionConversationProps, "baseUrl">) {
  // A failed initial load retries by remounting the whole conversation.
  const [attempt, setAttempt] = useState(0);
  const identity = useConversationIdentity(props.workspaceId, props.sessionId);
  return (
    <Conversation
      key={`${identity}:${attempt}`}
      {...props}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function Conversation(props: SessionConversationProps & { onRetry: () => void }) {
  const conversation = useSessionConversation(props.sessionId, props);
  return <ConversationView {...props} conversation={conversation} />;
}

/** Stock view for a controller mounted in a stable host. No second event feed or draft. */
export function SessionConversationView(props: SessionConversationViewProps) {
  const identity = useConversationIdentity(
    props.conversation.workspaceId,
    props.conversation.sessionId,
  );
  return (
    <ConversationView key={identity} {...props} onRetry={() => void props.conversation.retry()} />
  );
}

function ConversationView({
  conversation,
  renderMessageText,
  resolveLink,
  onOpenArtifact,
  onOpenSession,
  resolveSessionTitle,
  renderInteractiveBlock,
  toolRegistry,
  timelineProps,
  computerConnection,
  renderAllowanceExhausted,
  allowanceExhaustedLabels,
  voiceInput: voiceInputRequested = true,
  realtimeVoice: realtimeVoiceProp,
  realtimeVoiceProps,
  genieLoading,
  modelPickerProps,
  userMessageDisclosureLabels,
  loadSkillReview,
  className,
  height = "100%",
  readAcknowledgement = true,
  onEvent,
  theme,
  surface,
  labels: labelOverrides,
  composerProps,
  viewerSubjectId,
  chromeProps,
  humanInputProps,
  approvalProps,
  onRetry,
}: SessionConversationViewProps & { onRetry: () => void }) {
  const t = useOpenGeniText();
  const {
    sessionId,
    config,
    showModelPicker,
    catalog,
    feed,
    detail,
    queue,
    human,
    control,
    approvals,
    files,
    uploadsEnabled,
    status,
    terminal,
    importedArchive,
    composer,
    running,
    error,
    loadFailed,
  } = conversation;
  const context = conversation;
  // A dropped event stream (an update or brief outage) reads as "updating" in
  // the composer while it reconnects.
  const composerView = useComposerWithStreamState(
    composer,
    feed.connectionState,
    feed.initialLoading,
  );
  const builtInQueuedRecall = useQueuedPromptRecall({
    queue,
    composer,
    subjectId: viewerSubjectId,
    enabled: sessionId !== null && !terminal && Boolean(viewerSubjectId),
  });
  // One recall drives both the composer key and the queue row's ↑ hint.
  const queuedRecall = composerProps?.queuedRecall ?? builtInQueuedRecall;
  const formatError = useErrorMessage();
  useLiveEvents(sessionId, feed.events, feed.initialHistoryReady, onEvent);
  const region = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(region, { theme, surface });
  // Read means seen: the timeline itself must be on screen (hosts may hide it
  // while keeping the composer), in a visible, focused page, showing the live
  // end of the conversation rather than an older page of history.
  const foreground = useDocumentForeground();
  const timelineOnScreen = useElementOnScreen(
    () => region.current?.querySelector("[data-og-timeline-scroller]") ?? null,
    loadFailed,
  );
  useSessionReadAcknowledgement({
    client: context.client,
    workspaceId: context.workspaceId,
    sessionId,
    session: detail.session,
    events: feed.events,
    active:
      readAcknowledgement &&
      foreground &&
      timelineOnScreen &&
      feed.initialHistoryReady &&
      !loadFailed &&
      !feed.hasNewer,
  });
  const defaultInteractiveBlock = useDefaultInteractiveBlock(
    context.client,
    context.workspaceId,
    sessionId,
    config.artifacts,
    labelOverrides?.sitePreviewUnavailable ?? DEFAULT_CONVERSATION_LABELS(t).sitePreviewUnavailable,
  );
  const retainedLoaders = useRetainedLoaders(context.client, context.workspaceId, sessionId);
  const transcription = useComposerTranscription(
    context.client,
    context.workspaceId,
    voiceInputRequested && !importedArchive ? config.voiceInput : null,
  );
  const inheritedLinks = useOpenGeniLinkResolver();
  const defaultLinks = useMemo(
    () =>
      sessionId
        ? sessionLinkResolver(t, {
            client: context.client,
            workspaceId: context.workspaceId,
            sessionId,
            sandboxFiles: config.sandboxFiles,
          })
        : null,
    [context.client, context.workspaceId, sessionId, config.sandboxFiles, t],
  );
  const onOpenArtifactRef = useRef(onOpenArtifact);
  onOpenArtifactRef.current = onOpenArtifact;
  const opensArtifacts = onOpenArtifact !== undefined;
  const viewerLinks = useMemo(
    () =>
      opensArtifacts
        ? viewerLinkResolver({
            workspaceId: context.workspaceId,
            open: (target) => onOpenArtifactRef.current?.(target),
          })
        : null,
    [context.workspaceId, opensArtifacts],
  );
  const links = useMemo(
    () => chainLinkResolvers(resolveLink, viewerLinks, inheritedLinks, defaultLinks) ?? undefined,
    [resolveLink, viewerLinks, inheritedLinks, defaultLinks],
  );
  const labels = { ...DEFAULT_CONVERSATION_LABELS(t), ...labelOverrides };
  const retryInPlace = () => void conversation.retry();
  const realtimeVoiceRequested = realtimeVoiceProp ?? config.realtimeVoiceOffered;
  const loadingOptions = useMemo(() => embeddedGenieLoading(t, genieLoading), [genieLoading, t]);
  const providerRecovery = useMemo(
    () =>
      detail.session
        ? currentProviderRecovery(
            {
              id: detail.session.id,
              status,
              activeTurnId: detail.session.activeTurnId,
              effectiveControl:
                queue.effectiveControl ?? detail.session.effectiveControl ?? undefined,
            },
            feed.events,
          )
        : null,
    [detail.session, status, queue.effectiveControl, feed.events],
  );
  const voiceModels = useRealtimeVoiceModels(
    context.client,
    context.workspaceId,
    realtimeVoiceRequested && config.realtimeVoice && !importedArchive,
  );
  const [voiceActive, setVoiceActive] = useState(false);
  const notifyVoiceActive = realtimeVoiceProps?.onVoiceActiveChange;
  const onVoiceActiveChange = useCallback(
    (active: boolean) => {
      setVoiceActive(active);
      notifyVoiceActive?.(active);
    },
    [notifyVoiceActive],
  );
  const voiceControl =
    composer.effectiveControl ?? queue.effectiveControl ?? detail.session?.effectiveControl;
  const voice =
    sessionId && voiceModels.length > 0 && status && !terminal && voiceControl ? (
      <Suspense fallback={null}>
        <LazyEmbeddedRealtimeVoice
          {...realtimeVoiceProps}
          client={
            context.client as unknown as ComponentProps<typeof SessionRealtimeControl>["client"]
          }
          workspaceId={context.workspaceId}
          codexConnected={realtimeVoiceProps?.codexConnected ?? false}
          sessionId={sessionId}
          sessionStatus={status}
          effectiveControl={voiceControl}
          events={feed.events}
          eventsReady={!feed.initialLoading}
          getModelContext={conversation.getModelContext}
          onVoiceActiveChange={onVoiceActiveChange}
        />
      </Suspense>
    ) : null;
  return (
    <SingleSendWording enabled={composer.singleSend === true}>
      <div
        className={cn(
          "og-root flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-og-bg text-og-base text-og-fg",
          className,
        )}
        ref={region}
        style={{ ...hostTheme.style, height }}
        data-og-theme={hostTheme.attribute}
        data-og-host-theme=""
        data-og-conversation=""
      >
        {error && !loadFailed ? (
          <div
            role="alert"
            className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-3 rounded-og-md border border-og-status-failed/30 bg-og-status-failed/10 px-3 py-2 text-og-sm text-og-fg"
            data-og-conversation-error=""
          >
            <span className="min-w-0 flex-1">{formatError(error)}</span>
            <button
              type="button"
              onClick={retryInPlace}
              className="shrink-0 rounded-og-sm px-2 py-1 font-medium text-og-fg hover:bg-og-hover"
            >
              {labels.retry}
            </button>
          </div>
        ) : null}
        {loadFailed ? (
          <div
            role="alert"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
            data-og-conversation-error=""
          >
            <p className="max-w-sm text-og-base text-og-fg-muted">{formatError(feed.error)}</p>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-9 items-center rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg hover:bg-og-surface-2"
            >
              {labels.tryAgain}
            </button>
          </div>
        ) : (
          <MessageTimeline
            renderMessageText={renderMessageText}
            resolveLink={links}
            renderInteractiveBlock={
              renderInteractiveBlock === false
                ? undefined
                : (renderInteractiveBlock ?? defaultInteractiveBlock)
            }
            userMessageDisclosureLabels={userMessageDisclosureLabels}
            genieLoading={loadingOptions}
            renderAllowanceExhausted={renderAllowanceExhausted}
            allowanceExhaustedLabels={allowanceExhaustedLabels}
            // Isolated and clipped: floating navigation stays inside the timeline.
            className="isolate min-h-0 flex-1 overflow-hidden"
            {...(toolRegistry ? { toolRegistry } : {})}
            {...retainedLoaders}
            {...(onOpenSession ? { onOpenSession } : {})}
            {...(resolveSessionTitle ? { resolveSessionTitle } : {})}
            events={feed.events}
            items={conversation.timeline}
            turnSummary={timelineProps?.turnSummary ?? { rolling: true }}
            renderAuthNeeded={(item) =>
              timelineProps?.renderAuthNeeded?.(item) ??
              (item.capability?.id === "api:connected-machine" && computerConnection ? (
                <ThisComputerCard {...computerConnection} rationale={item.capability.rationale} />
              ) : undefined)
            }
            emptyState={timelineProps?.emptyState}
            renderMessageSender={timelineProps?.renderMessageSender}
            status={status}
            hasOlder={feed.hasOlder}
            loadingOlder={feed.loadingOlder}
            onLoadOlder={feed.loadOlder}
            hasNewer={feed.hasNewer}
            loadingNewer={feed.loadingNewer}
            onLoadNewer={feed.loadNewer}
            onJumpToStart={async () => {
              await feed.loadOldest();
            }}
            loadingOldest={feed.loadingOldest}
            onJumpToLatest={feed.jumpToLatest}
            onAnnotate={importedArchive ? undefined : composer.addAnnotation}
            // A narrow embed above a decision card has no room for the pill.
            questionNavMinViewportHeight={320}
          />
        )}
        {importedArchive ? (
          <p className="shrink-0 px-4 py-2 text-center text-sm text-og-muted" role="status">
            {t("sessionConversation.archivedConversationReadOnly")}
          </p>
        ) : (
          <>
            <div
              // Above the timeline's floating navigation, which may never paint
              // over a decision card.
              className="relative z-20 min-h-0 max-h-[40%] shrink-0 overflow-y-auto empty:hidden"
              data-og-conversation-inputs=""
            >
              {approvals.length > 0 && !terminal ? (
                <ApprovalSurface
                  className="mx-auto max-w-3xl"
                  {...approvalProps}
                  approvals={approvals}
                  onApprove={async (approval) => {
                    await control.approve(approval.id);
                  }}
                  onReject={async (approval) => {
                    await control.reject(approval.id);
                  }}
                  responding={control.responding}
                  error={control.error}
                />
              ) : null}
              <ProviderRecoveryNotice
                className="mx-auto max-w-3xl px-1"
                recovery={providerRecovery}
              />
              <HumanInputSurface
                className="mx-auto max-w-3xl"
                autoFocus={false}
                decisionButtons
                {...humanInputProps}
                loadSkillReview={loadSkillReview}
                requests={human.requests}
                onSubmit={async (id, response) => {
                  // `respond` reports a failed send as null. Reject so the card
                  // keeps what was typed (including a secret) for a retry.
                  if (!(await human.respond(id, response))) {
                    throw new Error(t("sessionConversation.yourAnswerWasnTSent"));
                  }
                }}
                respondingRequestId={human.respondingRequestId}
                error={human.mutationError ? formatError(human.mutationError) : null}
              />
              <ConversationChrome
                sessionId={sessionId}
                client={context.client}
                workspaceId={context.workspaceId}
                events={feed.events}
                chrome={
                  terminal
                    ? {
                        ...chromeProps,
                        queue,
                        sessionStatus: status,
                        readOnly: true,
                        onOpenSession,
                      }
                    : {
                        ...chromeProps,
                        queue,
                        composer,
                        queuedRecall,
                        sessionStatus: status,
                        onOpenSession,
                        onComposerFocus: () =>
                          region.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(),
                      }
                }
              />
            </div>
            <div
              className="relative z-20 mx-auto w-full max-w-3xl shrink-0"
              data-og-conversation-composer=""
            >
              <ChatComposer
                runControl="stop"
                running={running}
                {...composerProps}
                {...(transcription && composerProps?.transcription === undefined
                  ? { transcription }
                  : {})}
                actionsStart={
                  voice ? (
                    <>
                      {composerProps?.actionsStart}
                      {voice}
                    </>
                  ) : (
                    composerProps?.actionsStart
                  )
                }
                transcriptionSuppressed={composerProps?.transcriptionSuppressed ?? voiceActive}
                composer={composerView}
                attachments={uploadsEnabled ? files : undefined}
                // Nothing can be written (typed, dictated or chosen) into a
                // session the host is still creating.
                disabled={sessionId === null || terminal || composerProps?.disabled}
                controlsStart={
                  composerProps?.controlsStart ??
                  (showModelPicker && composer.policy && (
                    <ModelPolicyPicker
                      groupPresentation={modelPickerProps?.groupPresentation}
                      messages={modelPickerProps?.messages}
                      rows={catalog.rows}
                      model={composer.policy.model}
                      effort={composer.policy.reasoningEffort}
                      latencyMode={composer.policy.latencyMode}
                      loading={catalog.loading}
                      error={catalog.error?.message}
                      disabled={sessionId === null || terminal}
                      // A session frozen on Codex remote compaction refuses
                      // other providers' models; offer them only as disabled.
                      codexOnly={detail.session?.codexCompactionMode === "remote_v2"}
                      sessionKey={sessionId ?? undefined}
                      onOpenChange={(open) => {
                        if (open) void catalog.refresh();
                      }}
                      onModelChange={(model) => composer.setModel?.(model)}
                      onEffortChange={(effort) => composer.setReasoningEffort?.(effort)}
                      onLatencyModeChange={(mode) => composer.setLatencyMode?.(mode)}
                    />
                  ))
                }
                responsiveBasis={composerProps?.responsiveBasis ?? "container"}
                effectiveControl={
                  composer.effectiveControl ??
                  queue.effectiveControl ??
                  detail.session?.effectiveControl
                }
                queuedAheadCount={queue.queue.length}
                queuedRecall={queuedRecall}
              />
            </div>
          </>
        )}
      </div>
    </SingleSendWording>
  );
}

/** Neutral embedded defaults under the host's overrides; an empty phrase list keeps them. */
function embeddedGenieLoading(
  t: OpenGeniText,
  options: GenieLoadingOptions | undefined,
): GenieLoadingOptions {
  if (!options) return EMBEDDED_GENIE_LOADING(t);
  return {
    ...EMBEDDED_GENIE_LOADING(t),
    ...options,
    phrases: options.phrases?.length ? options.phrases : EMBEDDED_GENIE_LOADING(t).phrases,
    messages: { ...EMBEDDED_GENIE_LOADING(t).messages, ...options.messages },
  };
}

type ConversationChromeProps = {
  sessionId: string | null;
  client: unknown;
  workspaceId: string;
  events: UseGoalOptions["events"];
  chrome: Omit<ComponentProps<typeof SessionChrome>, "goal">;
};

/** Session chrome with the goal pill and its Pause/Resume/Clear when the client can reach goals. */
function ConversationChrome(props: ConversationChromeProps) {
  const goals = props.client as Partial<Record<"getGoal" | "updateGoal" | "deleteGoal", unknown>>;
  const canReachGoals =
    typeof goals.getGoal === "function" &&
    typeof goals.updateGoal === "function" &&
    typeof goals.deleteGoal === "function";
  return canReachGoals && props.sessionId ? (
    <GoalChrome {...props} sessionId={props.sessionId} />
  ) : (
    <SessionChrome {...props.chrome} />
  );
}

function GoalChrome({
  sessionId,
  client,
  workspaceId,
  events,
  chrome,
}: ConversationChromeProps & { sessionId: string }) {
  const goal = useGoal(sessionId, {
    client: client as UseGoalOptions["client"],
    workspaceId,
    events,
  });
  return <SessionChrome {...chrome} goal={goal} />;
}
const LazyEmbeddedRealtimeVoice = lazy(() => import("../realtime/embedded-voice"));

const LazyChatInteractiveBlock = lazy(() =>
  import("./artifacts/chat-interactive-block").then((module) => ({
    default: module.ChatInteractiveBlock,
  })),
);

/** This client with the conversation's session scope header, when it can add headers. */
function sessionScoped<T>(client: T, sessionId: string | null): T {
  const candidate = client as { withHeaders?: (headers: Readonly<Record<string, string>>) => T };
  // Nothing in a conversation whose session is still being created can read.
  return sessionId && typeof candidate.withHeaders === "function"
    ? candidate.withHeaders({ [SESSION_SCOPE_HEADER]: sessionId })
    : client;
}

/** Inline Site/HTML preview reading through this conversation's session scope. */
function useDefaultInteractiveBlock(
  client: unknown,
  workspaceId: string,
  sessionId: string | null,
  sitesAvailable: boolean,
  sitePreviewUnavailable: string,
): NonNullable<MessageTimelineProps["renderInteractiveBlock"]> {
  const t = useOpenGeniText();
  // Scope lazily: only a rendered preview reads, and some clients (a Site's
  // own client) cannot add headers.
  const scoped = useMemo((): SiteSnapshotClient => {
    let resolved: SiteSnapshotClient | null = null;
    const get = () => (resolved ??= sessionScoped(client as SiteSnapshotClient, sessionId));
    return {
      getWorkspaceArtifact: (...args) => get().getWorkspaceArtifact(...args),
      getWorkspaceArtifactHtml: (...args) => get().getWorkspaceArtifactHtml(...args),
      getWorkspaceArtifactContent: (...args) => {
        const target = get();
        if (!target.getWorkspaceArtifactContent) throw new Error("Site version unavailable");
        return target.getWorkspaceArtifactContent(...args);
      },
    };
  }, [client, sessionId]);
  return useCallback(
    (block) =>
      block.kind === "site" && !sitesAvailable ? (
        // The proxy does not serve Sites: say so instead of offering a load
        // that can only fail.
        <div
          className="rounded-og-md border border-og-border bg-og-surface-1 px-3 py-2 text-og-sm text-og-fg-muted"
          data-og-site-preview-unavailable=""
        >
          {sitePreviewUnavailable}
        </div>
      ) : (
        <Suspense fallback={<span role="status">{t("sessionConversation.loadingPreview")}</span>}>
          <LazyChatInteractiveBlock workspaceId={workspaceId} client={scoped} {...block} />
        </Suspense>
      ),
    [scoped, workspaceId, sitesAvailable, sitePreviewUnavailable, t],
  );
}

type RetainedLoaderClient = Partial<
  Pick<
    OpenGeniClient,
    | "createRetainedArtifactDownloadUrl"
    | "downloadRetainedArtifact"
    | "downloadRetainedScreenshot"
    | "createVideoArtifactPlaybackSource"
  >
>;

/**
 * Generated images, published files, screenshots and generated video, read
 * through this conversation's session scope (`x-opengeni-session-id`, which
 * a session proxy's `authorizeSession` checks). Clients without the SDK reads
 * get none.
 */
function useRetainedLoaders(
  client: unknown,
  workspaceId: string,
  sessionId: string | null,
): Pick<
  MessageTimelineProps,
  "loadRetainedArtifact" | "loadRetainedScreenshot" | "loadVideoArtifactPlayback"
> {
  return useMemo(() => {
    const base = client as RetainedLoaderClient;
    // Scope lazily: only a rendered receipt reads.
    let scoped: RetainedLoaderClient | null = null;
    const get = () => (scoped ??= sessionScoped(base, sessionId));
    return {
      ...(typeof base.downloadRetainedArtifact === "function" &&
      typeof base.createRetainedArtifactDownloadUrl === "function"
        ? {
            loadRetainedArtifact: (artifact, signal, options) =>
              createWorkspaceRetainedArtifactLoader(
                get() as Required<RetainedLoaderClient>,
                workspaceId,
              )(artifact, signal, options),
          }
        : {}),
      ...(sessionId && typeof base.downloadRetainedScreenshot === "function"
        ? {
            loadRetainedScreenshot: (artifact, signal) =>
              createSessionRetainedScreenshotLoader(
                get() as Required<RetainedLoaderClient>,
                workspaceId,
                sessionId,
              )(artifact, signal),
          }
        : {}),
      ...(typeof base.createVideoArtifactPlaybackSource === "function"
        ? {
            loadVideoArtifactPlayback: (artifactId, signal) =>
              createWorkspaceRetainedVideoLoader(
                get() as Required<RetainedLoaderClient>,
                workspaceId,
              )(artifactId, signal),
          }
        : {}),
    } satisfies Pick<
      MessageTimelineProps,
      "loadRetainedArtifact" | "loadRetainedScreenshot" | "loadVideoArtifactPlayback"
    >;
  }, [client, workspaceId, sessionId]);
}

/**
 * The composer microphone: shown when the deployment can transcribe, enabled
 * once the workspace's voice-input setting allows it.
 */
export function useComposerTranscription(
  client: unknown,
  workspaceId: string,
  capability: ClientVoiceInputConfig | null,
): ComposerTranscriptionControlProps | null {
  const [workspaceEnabled, setWorkspaceEnabled] = useState<{
    key: string;
    enabled: boolean;
  } | null>(null);
  const reader = client as Partial<Pick<OpenGeniClient, "getWorkspace" | "transcribeAudio">>;
  const supported = capability !== null && typeof reader.transcribeAudio === "function";
  useEffect(() => {
    if (!supported) return;
    let live = true;
    const key = workspaceId;
    if (typeof reader.getWorkspace !== "function") {
      setWorkspaceEnabled({ key, enabled: true });
      return;
    }
    reader.getWorkspace(workspaceId).then(
      (workspace) => {
        if (live) {
          setWorkspaceEnabled({
            key,
            enabled: resolveWorkspaceVoiceInputEnabled(workspace.settings) ?? true,
          });
        }
      },
      // The transcription request still enforces the setting.
      () => live && setWorkspaceEnabled({ key, enabled: true }),
    );
    return () => {
      live = false;
    };
  }, [reader, workspaceId, supported]);
  return useMemo(
    () =>
      supported
        ? {
            client: reader as Pick<OpenGeniClient, "transcribeAudio">,
            workspaceId,
            capability,
            workspaceEnabled:
              workspaceEnabled?.key === workspaceId ? workspaceEnabled.enabled : false,
          }
        : null,
    [supported, reader, workspaceId, capability, workspaceEnabled],
  );
}

export { useClientConfigFlags } from "../hooks/use-client-config-flags";
