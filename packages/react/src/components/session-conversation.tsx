import {
  resolveWorkspaceVoiceInputEnabled,
  SESSION_SCOPE_HEADER,
  type ClientVoiceInputConfig,
  type OpenGeniClient,
  type SendMessageInput,
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
import { useOpenGeni, type ClientOverride } from "../session-context";
import { useWorkspaceModelCatalog } from "../hooks/use-available-models";
import { ModelPolicyPicker, type ModelPolicyPickerProps } from "./model-policy-picker";
import { useSessionEvents } from "../hooks/use-session-events";
import { useSession } from "../hooks/use-session";
import { useTurnQueue } from "../hooks/use-turn-queue";
import { useComposer } from "../hooks/use-composer";
import { useHumanInputRequests } from "../hooks/use-human-input";
import { useFileAttachments } from "../hooks/use-file-attachments";
import { useSessionControl } from "../hooks/use-session-control";
import { useGoal, type UseGoalOptions } from "../hooks/use-goal";
import { useClientConfigFlags } from "../hooks/use-client-config-flags";
import {
  createSessionRetainedScreenshotLoader,
  createWorkspaceRetainedArtifactLoader,
  createWorkspaceRetainedVideoLoader,
} from "../timeline/retained-loaders";
import { useRealtimeVoiceModels } from "../hooks/use-realtime-voice-models";
import { projectPendingApprovals } from "../approvals";
import { ApprovalSurface } from "./approval-surface";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import type { ComposerTranscriptionControlProps } from "./composer-transcription-control";
import { SessionChrome } from "./session-chrome";
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
import { conversationTimeline } from "../conversation-timeline";
import { cn } from "../lib/cn";
import { SessionProxyScope, type SessionProxyBaseUrl } from "./session-proxy-scope";
import { useErrorMessage } from "../lib/error-message";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";

export type SessionConversationLabels = {
  /** Banner action after a refresh failure; the conversation stays mounted. */
  retry: string;
  /** Action when the conversation could not load at all. */
  tryAgain: string;
  /** Shown in place of a Site preview when the session proxy does not serve Sites. */
  sitePreviewUnavailable: string;
};

const DEFAULT_CONVERSATION_LABELS: SessionConversationLabels = {
  retry: "Retry",
  tryAgain: "Try again",
  sitePreviewUnavailable: "Site preview unavailable",
};

export type SessionConversationProps = ClientOverride &
  SessionProxyBaseUrl & {
    sessionId: string;
    /** Host-owned artifact links, previews and other message presentation. */
    renderMessageText?: MessageTimelineProps["renderMessageText"];
    /**
     * Open OpenGeni object links in agent replies (`artifact:`, `sandbox:`,
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
     * Inline previews for assistant `opengeni-site` / `opengeni-html` fences.
     * Defaults to the OpenGeni preview. Behind a session proxy without its
     * `artifacts` option, Sites show as unavailable without a request; `false`
     * shows the fence as code.
     */
    renderInteractiveBlock?: MessageTimelineProps["renderInteractiveBlock"] | false;
    /** Product-specific tool-call renderers; defaults to the built-in registry. */
    toolRegistry?: MessageTimelineProps["toolRegistry"];
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
     */
    attachments?: boolean | undefined;
    /**
     * Composer microphone (dictation into the draft). Defaults to true; it
     * appears only when the client config reports voice input available
     * (`createSessionProxyHandler({ voiceInput: false })` turns it off).
     */
    voiceInput?: boolean | undefined;
    /**
     * Live speech-to-speech voice in the composer. Defaults to true; the voice
     * button appears only when the workspace offers an available voice model
     * and the proxy has not turned it off (`realtimeVoice: false`).
     */
    realtimeVoice?: boolean | undefined;
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
    /** Presentation/custom controls only; queue and delivery wiring stay owned here. */
    composerProps?: Omit<
      ChatComposerProps,
      "composer" | "effectiveControl" | "queuedAheadCount" | "attachments"
    >;
  };

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
  if (baseUrl === undefined) return <RetryingConversation {...props} />;
  const { client, workspaceId, ...rest } = props;
  return (
    <SessionProxyScope
      baseUrl={baseUrl}
      workspaceId={workspaceId}
      client={client}
      headers={headers}
      fetch={fetch}
    >
      <RetryingConversation {...rest} />
    </SessionProxyScope>
  );
}

function RetryingConversation(props: Omit<SessionConversationProps, "baseUrl">) {
  // A failed initial load retries by remounting the whole conversation.
  const [attempt, setAttempt] = useState(0);
  return (
    <Conversation
      key={`${props.workspaceId ?? ""}:${props.sessionId}:${attempt}`}
      {...props}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

function Conversation({
  sessionId,
  renderMessageText,
  resolveLink,
  onOpenArtifact,
  onOpenSession,
  renderInteractiveBlock,
  toolRegistry,
  renderAllowanceExhausted,
  allowanceExhaustedLabels,
  attachments: attachmentsRequested = true,
  voiceInput: voiceInputRequested = true,
  realtimeVoice: realtimeVoiceRequested = true,
  modelPicker,
  modelPickerProps,
  userMessageDisclosureLabels,
  loadSkillReview,
  client,
  workspaceId,
  className,
  height = "100%",
  theme,
  surface,
  labels: labelOverrides,
  composerProps,
  onRetry,
}: SessionConversationProps & { onRetry: () => void }) {
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const formatError = useErrorMessage();
  const config = useClientConfigFlags(context.client);
  const showModelPicker = modelPicker ?? config.modelSelection;
  const catalog = useWorkspaceModelCatalog({
    client: context.client,
    workspaceId: context.workspaceId,
    enabled: showModelPicker,
  });
  const feed = useSessionEvents(sessionId, scope);
  const options = { ...scope, events: feed.events };
  const detail = useSession(sessionId, options);
  const queue = useTurnQueue(sessionId, options);
  const human = useHumanInputRequests(sessionId, options);
  const control = useSessionControl(sessionId, scope);
  const approvals = useMemo(() => projectPendingApprovals(feed.events), [feed.events]);
  const files = useFileAttachments(scope);
  const uploadsEnabled = attachmentsRequested && config.uploads;
  const status = feed.sessionStatus ?? detail.session?.status;
  const terminal = status === "cancelled";
  const importedArchive = detail.session?.importedArchive?.readOnly === true;
  const releaseSentFiles = (input: SendMessageInput) =>
    files.removeReadyFiles(
      (input.resources ?? []).flatMap((resource) =>
        resource.kind === "file" ? [resource.fileId] : [],
      ),
    );
  const composer = useComposer(sessionId, {
    ...options,
    effectiveControl: queue.effectiveControl ?? detail.session?.effectiveControl,
    sendDestination: () => (queue.queue.length > 0 || status === "running" ? "queue" : "chat"),
    ...(uploadsEnabled
      ? {
          sendExtras: () => ({ resources: files.readyResources }),
          sendBlocked: () => files.hasUnresolved,
          onSubmitted: (_text, input) => releaseSentFiles(input),
          onSent: (_text, input) => releaseSentFiles(input),
        }
      : {}),
  });
  const region = useRef<HTMLDivElement>(null);
  const hostTheme = useHostTheme(region, { theme, surface });
  const defaultInteractiveBlock = useDefaultInteractiveBlock(
    context.client,
    context.workspaceId,
    sessionId,
    config.artifacts,
    labelOverrides?.sitePreviewUnavailable ?? DEFAULT_CONVERSATION_LABELS.sitePreviewUnavailable,
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
      sessionLinkResolver({
        client: context.client,
        workspaceId: context.workspaceId,
        sessionId,
        sandboxFiles: config.sandboxFiles,
      }),
    [context.client, context.workspaceId, sessionId, config.sandboxFiles],
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
  const labels = { ...DEFAULT_CONVERSATION_LABELS, ...labelOverrides };
  const error = detail.error ?? feed.error ?? human.error;
  // Only an event feed that never loaded replaces the timeline; anything else
  // is a refresh failure shown above a conversation that stays usable.
  const loadFailed = Boolean(feed.error) && feed.events.length === 0;
  const retryInPlace = () => {
    if (detail.error) void detail.refresh();
    if (human.error) void human.refresh();
    if (feed.error) void feed.jumpToLatest();
  };
  const running = status === "running" || status === "recovering" || status === "waiting_capacity";
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
  const voiceControl =
    composer.effectiveControl ?? queue.effectiveControl ?? detail.session?.effectiveControl;
  const voice =
    voiceModels.length > 0 && status && !terminal && voiceControl ? (
      <Suspense fallback={null}>
        <LazyEmbeddedRealtimeVoice
          client={context.client}
          workspaceId={context.workspaceId}
          models={voiceModels}
          sessionId={sessionId}
          sessionStatus={status}
          effectiveControl={voiceControl}
          events={feed.events}
          eventsReady={!feed.initialLoading}
          onVoiceActiveChange={setVoiceActive}
        />
      </Suspense>
    ) : null;
  return (
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
          renderAllowanceExhausted={renderAllowanceExhausted}
          allowanceExhaustedLabels={allowanceExhaustedLabels}
          // Isolated and clipped: floating navigation stays inside the timeline.
          className="isolate min-h-0 flex-1 overflow-hidden"
          {...(toolRegistry ? { toolRegistry } : {})}
          {...retainedLoaders}
          {...(onOpenSession ? { onOpenSession } : {})}
          events={feed.events}
          items={conversationTimeline(feed.timeline, queue, composer)}
          turnSummary={{ rolling: true }}
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
          Archived conversation · Read only
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
              loadSkillReview={loadSkillReview}
              requests={human.requests}
              onSubmit={async (id, response) => {
                await human.respond(id, response);
              }}
              respondingRequestId={human.respondingRequestId}
              error={human.mutationError ? formatError(human.mutationError) : null}
              autoFocus={false}
              decisionButtons
            />
            <ConversationChrome
              sessionId={sessionId}
              client={context.client}
              workspaceId={context.workspaceId}
              events={feed.events}
              chrome={
                terminal
                  ? { queue, sessionStatus: status, readOnly: true, onOpenSession }
                  : {
                      queue,
                      composer,
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
              composer={composer}
              attachments={uploadsEnabled ? files : undefined}
              disabled={terminal || composerProps?.disabled}
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
                    disabled={terminal}
                    sessionKey={sessionId}
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
            />
          </div>
        </>
      )}
    </div>
  );
}

type ConversationChromeProps = {
  sessionId: string;
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
  return canReachGoals ? <GoalChrome {...props} /> : <SessionChrome {...props.chrome} />;
}

function GoalChrome({ sessionId, client, workspaceId, events, chrome }: ConversationChromeProps) {
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
function sessionScoped<T>(client: T, sessionId: string): T {
  const candidate = client as { withHeaders?: (headers: Readonly<Record<string, string>>) => T };
  return typeof candidate.withHeaders === "function"
    ? candidate.withHeaders({ [SESSION_SCOPE_HEADER]: sessionId })
    : client;
}

/** Inline Site/HTML preview reading through this conversation's session scope. */
function useDefaultInteractiveBlock(
  client: unknown,
  workspaceId: string,
  sessionId: string,
  sitesAvailable: boolean,
  sitePreviewUnavailable: string,
): NonNullable<MessageTimelineProps["renderInteractiveBlock"]> {
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
        <Suspense fallback={<span role="status">Loading preview…</span>}>
          <LazyChatInteractiveBlock workspaceId={workspaceId} client={scoped} {...block} />
        </Suspense>
      ),
    [scoped, workspaceId, sitesAvailable, sitePreviewUnavailable],
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
 * through this conversation's session scope (a session proxy only serves
 * media that session produced). Clients without the SDK reads get none.
 */
function useRetainedLoaders(
  client: unknown,
  workspaceId: string,
  sessionId: string,
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
            loadRetainedArtifact: (artifact, signal) =>
              createWorkspaceRetainedArtifactLoader(
                get() as Required<RetainedLoaderClient>,
                workspaceId,
              )(artifact, signal),
          }
        : {}),
      ...(typeof base.downloadRetainedScreenshot === "function"
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
