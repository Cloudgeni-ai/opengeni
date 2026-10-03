import { SESSION_SCOPE_HEADER, type SendMessageInput } from "@opengeni/sdk";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { projectPendingApprovals } from "../approvals";
import { ApprovalSurface } from "./approval-surface";
import { ChatComposer, type ChatComposerProps } from "./chat-composer";
import { SessionChrome } from "./session-chrome";
import { HumanInputSurface, type HumanInputSurfaceProps } from "./human-input-surface";
import { MessageTimeline, type MessageTimelineProps } from "./message-timeline";
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
import { useErrorMessage } from "../lib/error-message";
import {
  useHostTheme,
  type HostSurfacePreference,
  type HostThemePreference,
} from "../lib/host-theme";

export type SessionConversationProps = ClientOverride & {
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
   * Inline previews for assistant `opengeni-site` / `opengeni-html` fences.
   * Defaults to the OpenGeni preview (Site reads need the proxy's
   * `artifacts` option); `false` shows the fence as code.
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
  /** Presentation/custom controls only; queue and delivery wiring stay owned here. */
  composerProps?: Omit<
    ChatComposerProps,
    "composer" | "effectiveControl" | "queuedAheadCount" | "attachments"
  >;
};

/** Complete existing-session conversation. Uses the provider's normal SDK client
 * (including Site clients), one shared event feed, and authoritative queue state. */
export function SessionConversation(props: SessionConversationProps) {
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
  renderInteractiveBlock,
  toolRegistry,
  renderAllowanceExhausted,
  allowanceExhaustedLabels,
  attachments: attachmentsRequested = true,
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
  const error = detail.error ?? feed.error ?? human.error;
  const loadFailed = error !== null && error !== undefined && feed.events.length === 0;
  const running = status === "running" || status === "recovering" || status === "waiting_capacity";
  return (
    <div
      className={cn(
        "og-root flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-og-bg text-og-base text-og-fg",
        className,
      )}
      ref={region}
      style={{ ...hostTheme.style, height }}
      data-og-theme={hostTheme.attribute}
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
            onClick={onRetry}
            className="shrink-0 rounded-og-sm px-2 py-1 font-medium text-og-fg hover:bg-og-hover"
          >
            Retry
          </button>
        </div>
      ) : null}
      {loadFailed ? (
        <div
          role="alert"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
          data-og-conversation-error=""
        >
          <p className="max-w-sm text-og-base text-og-fg-muted">{formatError(error)}</p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-9 items-center rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg hover:bg-og-surface-2"
          >
            Try again
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
            />
            {terminal ? (
              <SessionChrome queue={queue} sessionStatus={status} readOnly />
            ) : (
              <SessionChrome
                queue={queue}
                composer={composer}
                sessionStatus={status}
                onComposerFocus={() =>
                  region.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
                }
              />
            )}
          </div>
          <div
            className="relative z-20 mx-auto w-full max-w-3xl shrink-0"
            data-og-conversation-composer=""
          >
            <ChatComposer
              runControl="stop"
              running={running}
              {...composerProps}
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

const LazyChatInteractiveBlock = lazy(() =>
  import("./artifacts/chat-interactive-block").then((module) => ({
    default: module.ChatInteractiveBlock,
  })),
);

type ScopableClient = SiteSnapshotClient & {
  withHeaders?: (headers: Readonly<Record<string, string>>) => SiteSnapshotClient;
};

/** Inline Site/HTML preview reading through this conversation's session scope. */
function useDefaultInteractiveBlock(
  client: unknown,
  workspaceId: string,
  sessionId: string,
): NonNullable<MessageTimelineProps["renderInteractiveBlock"]> {
  // Scope lazily: only a rendered preview reads, and some clients (a Site's
  // own client) cannot add headers.
  const scoped = useMemo((): SiteSnapshotClient => {
    let resolved: SiteSnapshotClient | null = null;
    const get = () => {
      const candidate = client as ScopableClient;
      resolved ??=
        typeof candidate.withHeaders === "function"
          ? candidate.withHeaders({ [SESSION_SCOPE_HEADER]: sessionId })
          : candidate;
      return resolved;
    };
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
    (block) => (
      <Suspense fallback={<span role="status">Loading preview…</span>}>
        <LazyChatInteractiveBlock workspaceId={workspaceId} client={scoped} {...block} />
      </Suspense>
    ),
    [scoped, workspaceId],
  );
}

/** Deployment/proxy flags from the client config: uploads, and whether model choice is open. */
function useClientConfigFlags(client: {
  getClientConfig: () => Promise<{
    fileUploads?: { enabled?: boolean };
    modelSelection?: boolean | undefined;
    sandboxFiles?: boolean | undefined;
  }>;
}): { uploads: boolean; modelSelection: boolean; sandboxFiles: boolean } {
  const [flags, setFlags] = useState({
    uploads: false,
    modelSelection: false,
    sandboxFiles: false,
  });
  useEffect(() => {
    let live = true;
    client.getClientConfig().then(
      (config) => {
        if (live) {
          setFlags({
            uploads: config.fileUploads?.enabled === true,
            // Only an explicit offer shows end users the picker.
            modelSelection: config.modelSelection === true,
            sandboxFiles: config.sandboxFiles !== false,
          });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return flags;
}
