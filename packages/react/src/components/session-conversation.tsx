import type { SendMessageInput } from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useOpenGeni, type ClientOverride } from "../session-context";
import { useWorkspaceModelCatalog } from "../hooks/use-available-models";
import { ModelPolicyPicker } from "./model-policy-picker";
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
  type OpenGeniLinkResolver,
} from "./open-geni-links";
import type { UserMessageDisclosureLabels } from "./user-message-body";
import { conversationTimeline } from "../conversation-timeline";
import { cn } from "../lib/cn";

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
  /** Product-specific tool-call renderers; defaults to the built-in registry. */
  toolRegistry?: MessageTimelineProps["toolRegistry"];
  /**
   * File attachments in the composer. Defaults to true; the attach control
   * appears only when the deployment's client config enables file uploads.
   */
  attachments?: boolean | undefined;
  /**
   * Show the model/reasoning picker. Defaults to shown unless the client config
   * reports `modelSelection: false` (a host proxy that fixes the model policy).
   */
  modelPicker?: boolean | undefined;
  /** Localized actions for already-sent user-message disclosure. */
  userMessageDisclosureLabels?: UserMessageDisclosureLabels | undefined;
  loadSkillReview?: HumanInputSurfaceProps["loadSkillReview"];
  className?: string;
  /** Defaults to filling the host. The host owns available height. */
  height?: CSSProperties["height"];
  /** Presentation/custom controls only; queue and delivery wiring stay owned here. */
  composerProps?: Omit<
    ChatComposerProps,
    "composer" | "effectiveControl" | "queuedAheadCount" | "attachments"
  >;
};

/** Complete existing-session conversation. Uses the provider's normal SDK client
 * (including Site clients), one shared event feed, and authoritative queue state. */
export function SessionConversation(props: SessionConversationProps) {
  return <Conversation key={`${props.workspaceId ?? ""}:${props.sessionId}`} {...props} />;
}

function Conversation({
  sessionId,
  renderMessageText,
  resolveLink,
  toolRegistry,
  attachments: attachmentsRequested = true,
  modelPicker,
  userMessageDisclosureLabels,
  loadSkillReview,
  client,
  workspaceId,
  className,
  height = "100%",
  composerProps,
}: SessionConversationProps) {
  const scope = { client, workspaceId };
  const context = useOpenGeni(scope);
  const scopeRef = useRef(context);
  scopeRef.current = context;
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
  const [queueFocusTarget, setQueueFocusTarget] = useState<{
    turnId: string;
    requestId: number;
  }>();
  const human = useHumanInputRequests(sessionId, options);
  const control = useSessionControl(sessionId, scope);
  const approvals = useMemo(() => projectPendingApprovals(feed.events), [feed.events]);
  const files = useFileAttachments(scope);
  const uploadsEnabled = attachmentsRequested && config.uploads;
  const status = feed.sessionStatus ?? detail.session?.status;
  const terminal = status === "cancelled";
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
  const links = useMemo(
    () => chainLinkResolvers(resolveLink, inheritedLinks, defaultLinks) ?? undefined,
    [resolveLink, inheritedLinks, defaultLinks],
  );
  const error = detail.error ?? feed.error ?? human.error;
  return (
    <div
      className={cn(
        "og-root flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-og-bg text-og-fg",
        className,
      )}
      ref={region}
      style={{ height }}
      data-og-conversation=""
    >
      {error && <p role="alert">{error.message}</p>}
      <MessageTimeline
        renderMessageText={renderMessageText}
        resolveLink={links}
        userMessageDisclosureLabels={userMessageDisclosureLabels}
        className="min-h-0 flex-1"
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
        onJumpToLatestQuestion={
          feed.initialHistoryReady
            ? () =>
                feed.jumpToLatestQuestion({
                  onQueuedQuestion: async (turn, navigation) => {
                    await queue.refresh();
                    if (
                      !navigation.isCurrent() ||
                      scopeRef.current.client !== context.client ||
                      scopeRef.current.workspaceId !== context.workspaceId
                    )
                      return;
                    setQueueFocusTarget((previous) => ({
                      turnId: turn.id,
                      requestId: (previous?.requestId ?? 0) + 1,
                    }));
                  },
                })
            : undefined
        }
        onAnnotate={composer.addAnnotation}
      />
      <div className="min-h-0 max-h-[40%] shrink-0 overflow-y-auto" data-og-conversation-inputs="">
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
          loadSkillReview={loadSkillReview}
          requests={human.requests}
          onSubmit={async (id, response) => {
            await human.respond(id, response);
          }}
          respondingRequestId={human.respondingRequestId}
          error={human.mutationError?.message}
          autoFocus={false}
        />
        {terminal ? (
          <SessionChrome
            queue={queue}
            queueFocusTarget={queueFocusTarget}
            sessionStatus={status}
            readOnly
          />
        ) : (
          <SessionChrome
            queue={queue}
            queueFocusTarget={queueFocusTarget}
            composer={composer}
            sessionStatus={status}
            onComposerFocus={() =>
              region.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
            }
          />
        )}
      </div>
      <div className="shrink-0" data-og-conversation-composer="">
        <ChatComposer
          {...composerProps}
          composer={composer}
          attachments={uploadsEnabled ? files : undefined}
          disabled={terminal || composerProps?.disabled}
          controlsStart={
            composerProps?.controlsStart ??
            (showModelPicker && composer.policy && (
              <ModelPolicyPicker
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
            composer.effectiveControl ?? queue.effectiveControl ?? detail.session?.effectiveControl
          }
          queuedAheadCount={queue.queue.length}
        />
      </div>
    </div>
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
  const [flags, setFlags] = useState({ uploads: false, modelSelection: true, sandboxFiles: false });
  useEffect(() => {
    let live = true;
    client.getClientConfig().then(
      (config) => {
        if (live) {
          setFlags({
            uploads: config.fileUploads?.enabled === true,
            modelSelection: config.modelSelection !== false,
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
