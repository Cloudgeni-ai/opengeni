// The session view — live timeline plus one compact prompt queue above the
// composer. Enter queues and Cmd/Ctrl+Enter steers; failed sessions stay
// honest (reason + retry history) and revivable from the same composer.
import { LightboxProvider, type WorkspaceTab } from "@opengeni/react";
import { MACHINES_SESSION_POLL_MS, useMachines } from "@opengeni/react/machines";
import { HumanInputSurface, MessageTimeline, SessionChrome } from "@opengeni/react/session-ui";
import {
  creditExhaustedFromEvents,
  projectPendingApprovals,
  useComposer,
  useFileAttachments,
  useGoal,
  useHumanInputRequests,
  useSession,
  useSessionEvents,
  useSessionLineage,
  useTurnQueue,
  type AgentMessageItem,
  type AuthNeededItem,
  type PendingApproval,
  type OlderHistoryLoader,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react/session";
import { useNavigate } from "@tanstack/react-router";
import {
  BugIcon,
  CheckIcon,
  Loader2Icon,
  MenuIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  XIcon,
} from "lucide-react";
import {
  createElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { isApiErrorStatus } from "@/api";
import { ConsoleComposer } from "@/components/Composer";
import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import { PersonalResourceAttachmentControl } from "@/components/personal-resource-attachment-control";
import { LoadingPanel } from "@/components/common";
import {
  FollowUpRepositoryMenuBody,
  FollowUpRepositoryPicker,
} from "@/components/follow-up-repository-picker";
import { MarkdownText } from "@/components/markdown";
import { ModelPicker, SessionToolPicker, type SessionToolSelection } from "@/components/pickers";
import {
  FailedSessionBanner,
  TerminalSessionArchive,
  TerminalSessionBanner,
  UserMessageBody,
} from "@/components/session/banners";
import { useRail } from "@/components/rail/rail-context";
import { CLOUD_SANDBOX_LABEL } from "@/components/session/sandbox-switcher";
import { ChatViewportFileDropTarget } from "@/components/session/chat-viewport-file-drop-target";
import { SubagentTree } from "@/components/session/subagents";
import { SessionWorkspace } from "@/components/session/sandbox-workspace";
import {
  SessionVariableSetPicker,
  type SessionVariableSetPickerSharedState,
} from "@/components/session/session-variable-set-picker";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import type { EditableArtifactResource } from "@opengeni/sdk/artifacts";
import { useAppContext } from "@/context";
import { useBrowserAccountBridgeBlocker } from "@/lib/browser-account-bridge";
import type {
  SessionEditableArtifactSummary,
  SessionEditableArtifactsStatus,
} from "@/components/session/editable-artifacts-workspace";
import {
  normalizeProviderDomain,
  oauthConnectionOwnership,
  oauthConnectionRef,
} from "@/lib/capabilities";
import { startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
import { hasWorkspacePermission } from "@/lib/permissions";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import {
  isTerminalSessionStatus,
  projectSessionTimeline,
  summarizeSessionFailure,
} from "@/lib/events";
import {
  EMPTY_COMPOSER_LAUNCH,
  composerLaunchSearchAfterPolicyApply,
  composerLaunchSearchKey,
  type ComposerLaunchSearch,
} from "@/lib/composer-launch";
import {
  effortOptionsForModel,
  findPickerRow,
  runnableLatencyModesForModel,
} from "@/lib/model-policy";
import { sessionTimelineEmptyStateCopy } from "@/lib/session-empty-state";
import {
  consumeSessionComposerFocusIntent,
  FOCUS_SESSION_COMPOSER_EVENT,
  sessionComposerFocusIntentIsEligible,
  shouldFocusSessionComposer,
  type SessionComposerFocusIntent,
} from "@/lib/session-focus";
import {
  applySessionAttentionProjection,
  updateLocalSessionDeliveryAttention,
  notifySessionAttentionChanged,
  sessionReadProjectionKey,
  shouldAcknowledgeActiveSession,
  shouldProjectActiveSessionRead,
} from "@/lib/session-attention";
import {
  mergeSessionContextProjection,
  mergeSessionDetailReadProjection,
} from "@/lib/session-pins";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import { createSessionRetainedScreenshotLoader } from "@/lib/retained-screenshot-loader";
import { createWorkspaceRetainedVideoLoader } from "@/lib/retained-video-loader";
import {
  readSessionDockNavigation,
  sessionDockLayoutStorageId,
  updateSessionDockNavigation,
} from "@/lib/session-dock-preferences";
import {
  clientFirstPartyMcpToolPolicy,
  firstPartySessionToolOptionsFor,
  sessionPolicyPickerIds,
  toolsForPolicySelection,
} from "@/lib/session-tools";
import { useFollowUpRepositories } from "@/lib/use-follow-up-repositories";
import {
  useFixedResourceScopes,
  usePersonalResourceAttachment,
} from "@/lib/use-personal-resource-attachment";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import type { LineageNode, SessionRealtimeModel } from "@opengeni/sdk";
import type { ConnectionMetadata, Session, SessionEvent } from "@/types";

const LazySessionInspector = lazy(() =>
  import("@/components/session/inspector").then(({ SessionInspector }) => ({
    default: SessionInspector,
  })),
);

const LazySessionEditableArtifactsWorkspace = lazy(() =>
  import("@/components/session/editable-artifacts-workspace").then(
    ({ SessionEditableArtifactsWorkspace }) => ({
      default: SessionEditableArtifactsWorkspace,
    }),
  ),
);

const LazyCodexRealtimeControl = lazy(() =>
  import("@opengeni/react/realtime").then(({ SessionRealtimeControl }) => ({
    default: SessionRealtimeControl,
  })),
);

const LazySessionRouteAuxiliary = lazy(
  () => import("@/components/session/session-tenancy-control"),
);

export function SessionRoute({
  workspaceId,
  sessionId,
  launch = EMPTY_COMPOSER_LAUNCH,
  realtimeAutostartModel,
}: {
  workspaceId: string;
  sessionId: string;
  launch?: ComposerLaunchSearch;
  realtimeAutostartModel?: SessionRealtimeModel | undefined;
}) {
  const context = useAppContext();
  const rail = useRail();
  const navigate = useNavigate();
  const consumeRealtimeAutostart = useCallback(() => {
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId },
      search: {},
      replace: true,
    });
  }, [navigate, sessionId, workspaceId]);

  // Session record + live event log via @opengeni/react. Fresh opens load a
  // bounded tail, then stream live events with resume-by-sequence.
  const {
    events,
    sessionStatus,
    connectionState,
    initialLoading,
    hasOlder,
    loadingOlder,
    loadOlder,
    hasNewer,
    loadingNewer,
    loadNewer,
    loadingOldest,
    loadOldest,
    lastSequence: renderedThroughSequence,
    jumpToLatest,
    error: streamError,
  } = useSessionEvents(sessionId);
  const sessionDetailReadOwner = useRef<object>({});
  const beginSessionDetailRead = useCallback(
    () =>
      context.sessionChannelProjectionAuthority.beginDetailRead(sessionDetailReadOwner.current, {
        id: sessionId,
        workspaceId,
      }),
    [context.sessionChannelProjectionAuthority, sessionId, workspaceId],
  );
  const {
    session: fetchedSession,
    loading,
    error: loadError,
    readRevision: sessionReadRevision,
    readGeneration: sessionReadGeneration,
    refresh: refreshSession,
  } = useSession(sessionId, {
    events,
    beginRead: beginSessionDetailRead,
  });
  useEffect(
    () => () =>
      context.sessionChannelProjectionAuthority.finishDetailReads(sessionDetailReadOwner.current),
    [context.sessionChannelProjectionAuthority, sessionId, workspaceId],
  );
  useEffect(() => {
    if (loadError) {
      context.sessionChannelProjectionAuthority.finishDetailReads(sessionDetailReadOwner.current);
    }
  }, [context.sessionChannelProjectionAuthority, loadError]);
  const creationHandoff =
    context.sessionCreationHandoff?.session.id === sessionId && context.session?.id === sessionId
      ? context.sessionCreationHandoff
      : null;
  // Queue + goal share the timeline's event stream — one SSE connection total.
  const queue = useTurnQueue(sessionId, { events });
  const goal = useGoal(sessionId, { events });
  const humanInput = useHumanInputRequests(sessionId, { events });
  const sessionSeed = fetchedSession ?? creationHandoff?.session ?? null;
  const session = useMemo(
    () =>
      sessionSeed
        ? {
            ...sessionSeed,
            status: sessionStatus ?? sessionSeed.status,
            effectiveControl: queue.effectiveControl ?? sessionSeed.effectiveControl,
          }
        : null,
    [queue.effectiveControl, sessionSeed, sessionStatus],
  );
  // /clear-view: a LOCAL, this-device-only collapse of the transcript. It hides
  // every event at or before the sequence seen when the operator ran it; the
  // server log is untouched and newer events (higher sequence) keep streaming
  // in. Reset when the session identity changes so a new session starts clean.
  // null = never cleared (distinct from "cleared at sequence 0"): clearing an
  // empty stream still latches, so the initial-message fallback is suppressed
  // and any later events stay hidden up to the cleared sequence.
  const [viewClearedAfter, setViewClearedAfter] = useState<number | null>(null);
  useEffect(() => {
    setViewClearedAfter(null);
  }, [sessionId]);
  const clearView = useCallback(() => {
    const latestSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
    setViewClearedAfter(latestSequence);
  }, [events]);
  const visibleEvents = useMemo(
    () =>
      viewClearedAfter !== null
        ? events.filter((event) => event.sequence > viewClearedAfter)
        : events,
    [events, viewClearedAfter],
  );
  const timeline = useMemo(() => {
    if (!session) {
      return [];
    }
    // While the tail window is still being fetched, render nothing rather than
    // projectSessionTimeline's initial-message fallback — on a large session
    // that fallback painted the GENESIS message at the top for the whole fetch
    // (user-reported). The fallback is only for genuinely-empty NEW sessions,
    // i.e. after the load settles with no events.
    if (initialLoading && visibleEvents.length === 0 && !creationHandoff) {
      return [];
    }
    const projected = projectSessionTimeline(
      session,
      visibleEvents,
      creationHandoff?.clientEventId,
    );
    // projectSessionTimeline falls back to the session's initial message when
    // the projection is empty; after a clear-view that fallback would resurrect
    // the very first message, so suppress it once the view has been cleared.
    return viewClearedAfter !== null && visibleEvents.length === 0 ? [] : projected;
  }, [creationHandoff, session, visibleEvents, viewClearedAfter, initialLoading]);
  // Only approvals still awaiting a decision: the durable log replays every
  // historical `session.requiresAction`, so subtract decisions and finished
  // turns instead of rendering decided approvals as live buttons forever.
  const approvals = useMemo(() => projectPendingApprovals(events), [events]);
  // Credit death is sneaky: the engine can end the turn as a NOMINALLY
  // completed one (segmentLimit budget_exhausted), leaving the session idle and
  // healthy-looking. Track the terminal credit state from the last turn-end so
  // the banner shows for idle-but-broke sessions too, not only failed ones.
  const creditExhausted = useMemo(() => creditExhaustedFromEvents(events), [events]);
  const failure = useMemo(
    () =>
      session && (session.status === "failed" || creditExhausted)
        ? summarizeSessionFailure(events, session.status)
        : null,
    [events, session, creditExhausted],
  );

  // Keep the workspace header (title, status badge, connection pill) in sync.
  const {
    client,
    captureWorkspaceInvocation,
    ownsWorkspaceInvocation,
    setSession: setContextSession,
    setConnectionState: setContextConnectionState,
    sessionEventFeedStore,
  } = context;
  const acknowledgedProjectionRef = useRef<string | null>(null);
  const confirmedProjectionRef = useRef<string | null>(null);
  const retriedProjectionRef = useRef<string | null>(null);
  const [foreground, setForeground] = useState(() => ({
    documentVisible: document.visibilityState === "visible",
    windowFocused: document.hasFocus(),
  }));
  const [attentionRetryRevision, setAttentionRetryRevision] = useState(0);
  const reconciledSessionRead = useRef<{ sessionId: string; revision: number } | null>(null);
  useEffect(() => {
    if (!fetchedSession || sessionReadRevision === 0) return;
    if (
      reconciledSessionRead.current?.sessionId === sessionId &&
      reconciledSessionRead.current.revision === sessionReadRevision
    ) {
      return;
    }
    reconciledSessionRead.current = { sessionId, revision: sessionReadRevision };
    const accepted = context.sessionChannelProjectionAuthority.recordRead(
      fetchedSession,
      sessionReadGeneration,
    );
    setContextSession((current) =>
      mergeSessionDetailReadProjection(
        current,
        fetchedSession,
        context.sessionChannelProjectionAuthority,
        sessionReadGeneration,
        accepted,
      ),
    );
  }, [
    context.sessionChannelProjectionAuthority,
    fetchedSession,
    sessionId,
    sessionReadGeneration,
    sessionReadRevision,
    setContextSession,
  ]);
  useEffect(() => {
    setContextSession((current) =>
      mergeSessionContextProjection(
        current,
        session,
        context.sessionChannelProjectionAuthority,
        "live",
      ),
    );
  }, [context.sessionChannelProjectionAuthority, session, setContextSession]);
  useEffect(() => {
    const reconcileForeground = () => {
      setForeground({
        documentVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
      });
    };
    window.addEventListener("focus", reconcileForeground);
    window.addEventListener("blur", reconcileForeground);
    document.addEventListener("visibilitychange", reconcileForeground);
    return () => {
      window.removeEventListener("focus", reconcileForeground);
      window.removeEventListener("blur", reconcileForeground);
      document.removeEventListener("visibilitychange", reconcileForeground);
    };
  }, []);
  const projectSessionAttention = useCallback(
    (projection: Parameters<typeof notifySessionAttentionChanged>[0]) => {
      notifySessionAttentionChanged(projection);
      setContextSession((current) =>
        current?.id === projection.id
          ? applySessionAttentionProjection(current, projection)
          : current,
      );
    },
    [setContextSession],
  );
  const readThroughSequence = session
    ? Math.max(session.lastSequence, renderedThroughSequence)
    : renderedThroughSequence;
  const activeReadProjectionKey = session
    ? sessionReadProjectionKey(session.id, readThroughSequence)
    : null;
  const routeUnreadProjection = useMemo(
    () =>
      session
        ? {
            ...session,
            unread: session.unread || readThroughSequence > session.lastSequence,
          }
        : null,
    [readThroughSequence, session],
  );
  useLayoutEffect(() => {
    if (!session || !activeReadProjectionKey) return;
    if (
      confirmedProjectionRef.current === activeReadProjectionKey ||
      !shouldProjectActiveSessionRead({
        activeSessionId: sessionId,
        workspaceId,
        session: routeUnreadProjection,
        ...foreground,
      })
    ) {
      return;
    }

    const optimisticProjection = {
      id: session.id,
      workspaceId: session.workspaceId,
      unread: false,
      attentionVersion: session.attentionVersion,
      lastSequence: readThroughSequence,
    };
    projectSessionAttention(optimisticProjection);
  }, [
    activeReadProjectionKey,
    foreground,
    projectSessionAttention,
    readThroughSequence,
    routeUnreadProjection,
    session,
    sessionId,
    workspaceId,
  ]);
  useEffect(() => {
    const projectionKey = activeReadProjectionKey;
    if (
      !session ||
      !projectionKey ||
      acknowledgedProjectionRef.current === projectionKey ||
      !shouldAcknowledgeActiveSession({
        activeSessionId: sessionId,
        workspaceId,
        session: routeUnreadProjection,
        ...foreground,
      })
    ) {
      return;
    }
    let active = true;
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    acknowledgedProjectionRef.current = projectionKey;
    void client
      .updateSessionAttention(workspaceId, session.id, {
        unread: false,
        acknowledgedThroughSequence: readThroughSequence,
      })
      .then((updated) => {
        if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
        confirmedProjectionRef.current = projectionKey;
        // The rail owns separately polled page objects. Keep this exact
        // frontier result there so a stale list poll cannot resurrect or
        // prematurely clear the unread dot.
        projectSessionAttention(updated);
      })
      .catch(() => {
        // Retry one transient failure for this exact frontier. Keeping the
        // receipt after the second failure prevents a permanent 4xx/5xx from
        // becoming an unbounded request and log loop.
        if (
          active &&
          ownsWorkspaceInvocation(workspaceId, acceptedTransition) &&
          acknowledgedProjectionRef.current === projectionKey &&
          retriedProjectionRef.current !== projectionKey
        ) {
          retriedProjectionRef.current = projectionKey;
          acknowledgedProjectionRef.current = null;
          setAttentionRetryRevision((revision) => revision + 1);
          return;
        }
        // A transient failure must never resurrect a dot the user already
        // cleared. Release the attempt receipt so a later focus/navigation
        // can retry this exact frontier; a reload still reads durable truth
        // if both attempts failed.
        if (acknowledgedProjectionRef.current === projectionKey) {
          acknowledgedProjectionRef.current = null;
        }
      });
    return () => {
      active = false;
    };
  }, [
    attentionRetryRevision,
    activeReadProjectionKey,
    captureWorkspaceInvocation,
    client,
    foreground,
    ownsWorkspaceInvocation,
    projectSessionAttention,
    readThroughSequence,
    routeUnreadProjection,
    session,
    sessionId,
    workspaceId,
  ]);
  useEffect(() => {
    setContextConnectionState(connectionState);
  }, [connectionState, setContextConnectionState]);
  useEffect(() => {
    sessionEventFeedStore.set({ sessionId, events });
  }, [events, sessionId, sessionEventFeedStore]);
  useEffect(
    () => () => {
      setContextSession(null);
      setContextConnectionState("idle");
      if (sessionEventFeedStore.getSnapshot()?.sessionId === sessionId) {
        sessionEventFeedStore.set(null);
      }
    },
    [sessionId, sessionEventFeedStore, setContextConnectionState, setContextSession],
  );
  useEffect(() => {
    if (streamError && !isApiErrorStatus(streamError, 404)) {
      toast.error("Event stream disconnected", {
        description: streamError.message,
      });
    }
  }, [streamError]);
  useEffect(() => {
    if (loadError && !isApiErrorStatus(loadError, 404)) {
      toast.error("Failed to load session", { description: String(loadError) });
    }
  }, [loadError]);
  // A reconnect OAuth round-trip lands back here (the reconnect card set
  // returnPath to this session). The connection is refreshed server-side, but
  // the original tool call was settled as an error and is never replayed. Strip
  // the params and tell the user to start a new turn.
  const oauthReturnHandled = useRef(false);
  const capabilityClient = context.client;
  const capabilityCatalog = context.workspaceCapabilityCatalog;
  const capabilityCatalogReady = context.workspaceMcpCatalogReady;
  const refreshCapabilityCatalog = context.refreshWorkspaceMcpServers;
  useEffect(() => {
    if (oauthReturnHandled.current || !capabilityCatalogReady) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("integration_oauth");
    if (!outcome) {
      return;
    }
    oauthReturnHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    const capabilityId = params.get("capability_auth");
    if (outcome !== "success") {
      toast.error("Reconnect failed", {
        description: params.get("reason") ?? undefined,
      });
      return;
    }
    if (!capabilityId) {
      toast.success("Connection restored", {
        description: "The earlier tool call wasn't replayed. Send a new message to try again.",
      });
      return;
    }
    void (async () => {
      const item = capabilityCatalog.find((candidate) => candidate.id === capabilityId);
      const connectionId = params.get("connectionId");
      const providerDomain = params.get("providerDomain");
      const ownership = oauthConnectionOwnership(params.get("ownership"));
      if (!item || item.kind !== "mcp" || !connectionId || !providerDomain || !ownership) {
        throw new Error("The authorized capability could not be resolved from the live catalog.");
      }
      await capabilityClient.enableCapability(workspaceId, item.id, {
        connectionRef: oauthConnectionRef(ownership, connectionId, providerDomain),
      });
      await refreshCapabilityCatalog(workspaceId);
      toast.success(`${item.name} connected`, {
        description: "It is available to new tool calls in this session.",
      });
    })().catch((error) => {
      toast.error("Connection succeeded, but setup needs attention", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [
    capabilityCatalog,
    capabilityCatalogReady,
    capabilityClient,
    refreshCapabilityCatalog,
    workspaceId,
  ]);

  const githubReturnHandled = useRef(false);
  useEffect(() => {
    if (githubReturnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") !== "connected") return;
    githubReturnHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    toast.success("GitHub connected", {
      description: "Repository access is now available to new tool calls in this session.",
    });
  }, []);

  // Start the recovery flow for a lapsed connection surfaced inline in the
  // timeline. OAuth connections reconnect in place (reuse the connectionId) and
  // return to this session; api-key ones can't OAuth, so hand off to credential
  // re-entry on the capabilities sheet for that provider. Throwing bubbles a
  // calm inline error on the reconnect card.
  const onReconnect = useCallback(
    async (item: AuthNeededItem) => {
      if (item.authoritySource === "host") {
        if (!item.authorizationUrl) {
          throw new Error(
            "This connection is managed by the embedding host and has no recovery link.",
          );
        }
        window.location.assign(item.authorizationUrl);
        return;
      }
      if (item.capability) {
        const returnPath = `${window.location.pathname}?capability_auth=${encodeURIComponent(item.capability.id)}`;
        if (item.capability.id === "api:github-app") {
          const status = await context.client.getGitHubApp(workspaceId, {
            returnPath,
          });
          if (status.status === "bound") {
            toast.success("GitHub is already connected");
            return;
          }
          if (!status.linkUrl) {
            throw new Error(
              status.configured
                ? "Your account cannot manage this workspace's GitHub connection."
                : "GitHub is not configured on this deployment.",
            );
          }
          window.location.assign(status.linkUrl);
          return;
        }
        if (item.capability.id === "mcp:codex_apps") {
          window.location.assign(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
          return;
        }
        const catalogItem = context.workspaceCapabilityCatalog.find(
          (candidate) => candidate.id === item.capability?.id,
        );
        const canInstall =
          hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin") &&
          hasWorkspacePermission(context.accessContext, workspaceId, "connections:write");
        const mcpUrl = catalogItem?.mcpUrl ?? catalogItem?.endpointUrl ?? null;
        if (
          canInstall &&
          catalogItem?.kind === "mcp" &&
          catalogItem.authKind === "oauth2" &&
          mcpUrl
        ) {
          const response = await startMcpOAuthWithTimeout(context.client, workspaceId, {
            mcpUrl,
            ...(catalogItem.providerDomain ? { providerDomain: catalogItem.providerDomain } : {}),
            ownership: "workspace",
            returnPath,
          });
          if (!response.authorizationUrl) {
            throw new Error("The provider did not return an authorization link.");
          }
          window.location.assign(response.authorizationUrl);
          return;
        }
        window.location.assign(
          `/workspaces/${encodeURIComponent(workspaceId)}/capabilities?suggested_capability=${encodeURIComponent(item.capability.id)}`,
        );
        return;
      }
      if (item.serverId === "codex_apps") {
        // Codex Apps is authorized by the designated workspace subscription,
        // not by the generic connection broker. Send the user to the existing
        // Codex subscription control instead of starting a meaningless OAuth
        // flow for chatgpt.com.
        window.location.assign(`/workspaces/${encodeURIComponent(workspaceId)}/settings`);
        return;
      }
      const connections = await context.client
        .listConnections(workspaceId)
        .catch(() => [] as ConnectionMetadata[]);
      const connection = item.connectionId
        ? (connections.find((candidate) => candidate.id === item.connectionId) ?? null)
        : null;
      if (connection?.kind === "api_key") {
        window.location.assign(
          `/workspaces/${encodeURIComponent(workspaceId)}/capabilities?reconnect_domain=${encodeURIComponent(item.providerDomain)}`,
        );
        return;
      }
      const returnPath = `${window.location.pathname}${window.location.search}`;
      const response = await context.client.startConnectionOAuth(workspaceId, {
        providerDomain: item.providerDomain,
        ...(item.connectionId ? { connectionId: item.connectionId } : {}),
        ...(item.resource ? { resource: item.resource } : {}),
        returnPath,
      });
      if (!response.authorizationUrl) {
        throw new Error("The provider did not return an authorization link.");
      }
      window.location.assign(response.authorizationUrl);
    },
    [context.accessContext, context.client, context.workspaceCapabilityCatalog, workspaceId],
  );

  // The workspace shell already needs the capability catalog for session tool
  // policy. Reuse that authoritative read for timeline logos instead of
  // downloading the same large catalog again from the session route.
  const providerLogos = useMemo(() => {
    const logos = new Map<string, string>();
    for (const capability of context.workspaceCapabilityCatalog) {
      const domain = capability.providerDomain ?? capability.connectionRef?.providerDomain ?? null;
      const url = context.client.catalogAssetUrl(capability.logoAssetPath);
      if (domain && url) {
        const key = normalizeProviderDomain(domain);
        if (!logos.has(key)) logos.set(key, url);
      }
    }
    return logos;
  }, [context.client, context.workspaceCapabilityCatalog]);
  const resolveProviderLogo = useCallback(
    (domain: string) => providerLogos.get(normalizeProviderDomain(domain)) ?? null,
    [providerLogos],
  );
  // One lineage read feeds the single composer-anchored agents surface. Events
  // refresh it instantly on spawn/worker-completion, and a 30s poll ensures the pill's
  // "running" count doesn't go stale on CHILD-side status changes that emit no
  // event on this parent's feed. Must sit above the loading/error early-returns
  // — it's a hook, so it has to run unconditionally on every render.
  const lineage = useSessionLineage(sessionId, {
    events,
    pollIntervalMs: 30_000,
  });
  const agentNodes = lineage.lineage?.children ?? [];
  const sandboxFileRequestSeq = useRef(0);
  const [sandboxFileRequest, setSandboxFileRequest] = useState<{
    path: string;
    line?: number;
    requestId: number;
  } | null>(null);
  useEffect(() => {
    setSandboxFileRequest(null);
  }, [sessionId]);
  const setInspectorOpen = context.setInspectorOpen;
  const openSandboxFile = useCallback(
    (path: string, line?: number) => {
      setSandboxFileRequest({
        path,
        line,
        requestId: ++sandboxFileRequestSeq.current,
      });
      setInspectorOpen(true);
    },
    [setInspectorOpen],
  );

  if (!session) {
    if (loadError) {
      return (
        <Suspense fallback={<LoadingPanel label="Looking for this session" />}>
          <LazySessionRouteAuxiliary
            workspaceId={workspaceId}
            sessionId={sessionId}
            loadError={loadError}
          />
        </Suspense>
      );
    }
    return (
      <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        <SessionDock
          workspaceId={workspaceId}
          sessionId={sessionId}
          session={null}
          events={events}
          connectionState={connectionState}
          primary={<LoadingPanel label={loading ? "Opening session" : "Preparing session"} />}
          onReloadSession={refreshSession}
          dockCollapsed={!context.inspectorOpen}
          onDockCollapsedChange={(collapsed) => context.setInspectorOpen(!collapsed)}
          openFileRequest={sandboxFileRequest}
          onOpenNavigation={() => {
            context.setInspectorOpen(false);
            rail.setDrawerOpen(true);
          }}
        />
      </div>
    );
  }

  const chatPane = (
    <SessionChatPane
      key={session.id}
      session={session}
      events={events}
      timeline={timeline}
      initialLoading={initialLoading}
      launch={launch}
      realtimeAutostartModel={realtimeAutostartModel}
      onRealtimeAutostartConsumed={consumeRealtimeAutostart}
      approvals={approvals}
      humanInput={humanInput}
      failure={failure}
      creditExhausted={creditExhausted}
      goal={goal}
      queue={queue}
      agentNodes={agentNodes}
      hasOlder={hasOlder}
      loadingOlder={loadingOlder}
      onLoadOlder={loadOlder}
      hasNewer={hasNewer}
      loadingNewer={loadingNewer}
      onLoadNewer={loadNewer}
      loadingOldest={loadingOldest}
      onJumpToStart={loadOldest}
      onJumpToLatest={jumpToLatest}
      onClearView={clearView}
      onOpenSession={(nextSessionId) =>
        void navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: nextSessionId },
        })
      }
      onMemoryClick={(memoryId) =>
        void navigate({
          to: "/workspaces/$workspaceId/memory",
          params: { workspaceId },
          search: { memory: memoryId },
        })
      }
      onNewSession={() =>
        void navigate({
          to: "/workspaces/$workspaceId/sessions",
          params: { workspaceId },
        })
      }
      onApprove={(approvalId) => approve(approvalId, "approve")}
      onReject={(approvalId) => approve(approvalId, "reject")}
      onReconnect={onReconnect}
      resolveProviderLogo={resolveProviderLogo}
      onReloadSession={refreshSession}
      onOpenSandboxFile={openSandboxFile}
    />
  );

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
      <SessionDock
        workspaceId={workspaceId}
        sessionId={sessionId}
        session={session}
        events={events}
        connectionState={connectionState}
        primary={chatPane}
        onReloadSession={refreshSession}
        dockCollapsed={!context.inspectorOpen}
        onDockCollapsedChange={(collapsed) => context.setInspectorOpen(!collapsed)}
        openFileRequest={sandboxFileRequest}
        onOpenNavigation={() => {
          context.setInspectorOpen(false);
          rail.setDrawerOpen(true);
        }}
      />
    </div>
  );

  async function approve(approvalId: string, decision: "approve" | "reject") {
    try {
      await context.client.sendApprovalDecision(workspaceId, sessionId, {
        approvalId,
        decision,
      });
    } catch (error) {
      toast.error("Couldn't submit the decision", {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

/**
 * The resizable Workspace dock: chat on the left, a collapsible/maximizable dock
 * on the right with the capability-gated sandbox surfaces (Files |
 * Terminal | Desktop) + Debug. Replaces the old fixed 390px aside.
 */
function SessionDock(props: {
  workspaceId: string;
  sessionId: string;
  session: Session | null;
  events: SessionEvent[];
  connectionState: ReturnType<typeof useSessionEvents>["connectionState"];
  primary: React.ReactNode;
  onReloadSession: () => Promise<void>;
  dockCollapsed: boolean;
  onDockCollapsedChange: (collapsed: boolean) => void;
  onOpenNavigation: () => void;
  openFileRequest?: {
    path: string;
    line?: number | null;
    requestId: number;
  } | null;
}) {
  const context = useAppContext();
  const dockLayoutStorageId = sessionDockLayoutStorageId(
    context.accessContext.subjectId,
    props.sessionId,
  );
  const dockNavigation = useMemo(
    () => readSessionDockNavigation(dockLayoutStorageId),
    [dockLayoutStorageId],
  );
  const rememberArtifact = useCallback(
    (artifactId: string | null) => updateSessionDockNavigation(dockLayoutStorageId, { artifactId }),
    [dockLayoutStorageId],
  );
  // The workbench (Changes | Files | Terminal | Desktop + machine chip) lives in
  // the package now; the app injects durable artifacts and Debug around it.
  // Heavy editor/runtime code stays lazy until the user opens the tab.
  const artifactRefreshSequence = useMemo(() => {
    for (let index = props.events.length - 1; index >= 0; index -= 1) {
      const event = props.events[index];
      if (
        event &&
        (event.type === "agent.toolCall.output" ||
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled")
      ) {
        return event.sequence;
      }
    }
    return 0;
  }, [props.events]);
  const artifactState = useSessionEditableArtifactSummaries({
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    refreshSequence: artifactRefreshSequence,
  });
  const artifactSummaries = artifactState.artifacts;
  const trailingTabs: WorkspaceTab[] = [
    {
      id: "artifacts",
      label: "Artifacts",
      icon: <PanelsTopLeftIcon />,
      ...(artifactSummaries.length > 0
        ? {
            badge: (
              <span className="rounded-og-xs bg-og-accent-soft px-1 text-og-xs text-og-fg-muted">
                {artifactSummaries.length}
              </span>
            ),
          }
        : {}),
      content: (
        <Suspense fallback={<LoadingPanel label="Opening artifact" />}>
          <LazySessionEditableArtifactsWorkspace
            key={props.sessionId}
            workspaceId={props.workspaceId}
            artifacts={artifactSummaries}
            status={artifactState.status}
            onRetry={artifactState.retry}
            initialSelectedArtifactId={dockNavigation.artifactId}
            onSelectedArtifactIdChange={rememberArtifact}
          />
        </Suspense>
      ),
    },
  ];
  if (props.session) {
    trailingTabs.push({
      id: "debug",
      label: "Debug",
      icon: <BugIcon />,
      content: (
        <Suspense fallback={<LoadingPanel label="Opening debug inspector" />}>
          <LazySessionInspector
            session={props.session}
            events={props.events}
            connectionState={props.connectionState}
            onReloadSession={props.onReloadSession}
          />
        </Suspense>
      ),
    });
  }

  return (
    <SessionWorkspace
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      preferenceOwnerId={context.accessContext.subjectId}
      events={props.events}
      primary={props.primary}
      trailingTabs={trailingTabs}
      collapsed={props.dockCollapsed}
      onCollapsedChange={props.onDockCollapsedChange}
      {...(props.openFileRequest ? { openFileRequest: props.openFileRequest } : {})}
      mobileLeadingControl={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open navigation"
          onClick={props.onOpenNavigation}
          className="size-11"
        >
          <MenuIcon className="size-4" />
        </Button>
      }
    />
  );
}

function useSessionEditableArtifactSummaries(input: {
  workspaceId: string;
  sessionId: string;
  refreshSequence: number;
}): Readonly<{
  artifacts: readonly SessionEditableArtifactSummary[];
  status: SessionEditableArtifactsStatus;
  retry: () => void;
}> {
  const context = useAppContext();
  const authorityKey = `${input.workspaceId}:${input.sessionId}:${context.accessKeyVersion}`;
  const [retrySequence, setRetrySequence] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    status: SessionEditableArtifactsStatus;
    artifacts: readonly EditableArtifactResource[];
  } | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded((previous) =>
      previous?.key === authorityKey && previous.status === "ready"
        ? previous
        : {
            key: authorityKey,
            status: "loading",
            artifacts: previous?.key === authorityKey ? previous.artifacts : [],
          },
    );
    void Promise.all([
      import("@/lib/editable-artifact-client"),
      import("@/lib/editable-artifact-browser"),
    ])
      .then(async ([{ editableArtifactClient }, { createConsoleEditableArtifactReplicaId }]) => {
        const result = await editableArtifactClient.listSessionEditableArtifacts(
          input.workspaceId,
          input.sessionId,
          {
            replicaId: createConsoleEditableArtifactReplicaId(),
          },
        );
        if (current) {
          setLoaded({
            key: authorityKey,
            status: "ready",
            artifacts: result.artifacts,
          });
        }
      })
      .catch(() => {
        if (!current) return;
        setLoaded((previous) => ({
          key: authorityKey,
          status: "error",
          artifacts: previous?.key === authorityKey ? previous.artifacts : [],
        }));
      });
    return () => {
      // The stale-result fence is sufficient for this bounded metadata GET.
      // Aborting Chrome fetch during React StrictMode cleanup surfaced an
      // unhandled AbortError from the SDK/fetch boundary on every mount.
      current = false;
    };
  }, [authorityKey, input.refreshSequence, input.sessionId, input.workspaceId, retrySequence]);

  const retry = useCallback(() => setRetrySequence((value) => value + 1), []);
  return loaded?.key === authorityKey
    ? { artifacts: loaded.artifacts, status: loaded.status, retry }
    : { artifacts: [], status: "loading", retry };
}

function SessionChatPane(props: {
  session: Session;
  events: SessionEvent[];
  timeline: TimelineItem[];
  initialLoading: boolean;
  launch?: ComposerLaunchSearch;
  realtimeAutostartModel?: SessionRealtimeModel | undefined;
  onRealtimeAutostartConsumed: () => void;
  approvals: PendingApproval[];
  humanInput: ReturnType<typeof useHumanInputRequests>;
  failure: ReturnType<typeof summarizeSessionFailure> | null;
  /** The last turn ended budget_exhausted — the workspace is out of credits. */
  creditExhausted: boolean;
  goal: ReturnType<typeof useGoal>;
  queue: ReturnType<typeof useTurnQueue>;
  /** Spawned-worker lineage children — feeds SessionChrome agents segment. */
  agentNodes: LineageNode[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: OlderHistoryLoader;
  hasNewer: boolean;
  loadingNewer: boolean;
  onLoadNewer: () => Promise<boolean>;
  loadingOldest: boolean;
  onJumpToStart: () => Promise<boolean>;
  onJumpToLatest: () => Promise<void>;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Deep-link a timeline memory step to its first-class workspace Memory record. */
  onMemoryClick: (memoryId: string) => void;
  onNewSession: () => void;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  onReconnect: (item: AuthNeededItem) => void | Promise<void>;
  resolveProviderLogo: (providerDomain: string) => string | null;
  onReloadSession: () => Promise<void>;
  onOpenSandboxFile: (path: string, line?: number) => void;
}) {
  const context = useAppContext();
  const modelCatalog = useWorkspaceModelCatalog(props.session.workspaceId);
  const fleet = useMachines({
    sessionId: props.session.id,
    pollIntervalMs: MACHINES_SESSION_POLL_MS,
  });
  const computeLabel =
    fleet.machines.find((machine) => machine.active)?.name ?? CLOUD_SANDBOX_LABEL;
  const loadRetainedScreenshot = useMemo(
    () =>
      createSessionRetainedScreenshotLoader(
        context.client,
        props.session.workspaceId,
        props.session.id,
      ),
    [context.client, props.session.id, props.session.workspaceId],
  );
  const loadRetainedArtifact = useMemo(
    () => createWorkspaceRetainedArtifactLoader(context.client, props.session.workspaceId),
    [context.client, props.session.workspaceId],
  );
  const loadVideoArtifactPlayback = useMemo(
    () => createWorkspaceRetainedVideoLoader(context.client, props.session.workspaceId),
    [context.client, props.session.workspaceId],
  );
  const terminal = isTerminalSessionStatus(props.session.status);
  const composerRegionRef = useRef<HTMLDivElement | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  useEffect(() => {
    const onFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<SessionComposerFocusIntent>).detail;
      if (
        detail?.workspaceId === props.session.workspaceId &&
        detail.sessionId === props.session.id
      ) {
        setComposerFocusSignal(detail.nonce);
      }
    };
    globalThis.addEventListener(FOCUS_SESSION_COMPOSER_EVENT, onFocusRequest);
    return () => globalThis.removeEventListener(FOCUS_SESSION_COMPOSER_EVENT, onFocusRequest);
  }, [props.session.id, props.session.workspaceId]);
  useEffect(() => {
    const intent = consumeSessionComposerFocusIntent(props.session.workspaceId, props.session.id);
    if (!intent) return;
    if (
      !sessionComposerFocusIntentIsEligible({
        viewportWidth: globalThis.innerWidth,
        coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
        terminal,
        requiresAction: props.session.status === "requires_action",
        pendingHumanInput: props.humanInput.requests.length > 0,
        pendingApproval: props.approvals.length > 0,
      })
    ) {
      return;
    }
    const frame = globalThis.requestAnimationFrame(() => {
      const textarea = composerRegionRef.current?.querySelector("textarea");
      if (!textarea || textarea.disabled) return;
      const dialogOpen = Boolean(
        document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]'),
      );
      if (
        !shouldFocusSessionComposer(
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
          props.session.id,
          document.body,
          dialogOpen,
        )
      ) {
        return;
      }
      textarea.focus();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [
    composerFocusSignal,
    props.approvals.length,
    props.humanInput.requests.length,
    props.session.id,
    props.session.status,
    props.session.workspaceId,
    terminal,
  ]);
  const agentsSignal = useMemo(() => {
    const agents = props.agentNodes;
    if (agents.length === 0) return undefined;
    const runningAgents = agents.filter(
      (node) =>
        node.session.status === "running" && node.session.effectiveControl.state === "active",
    ).length;
    const pausedAgents = agents.filter(
      (node) => node.session.effectiveControl.state === "paused",
    ).length;
    return {
      count: agents.length,
      detail:
        runningAgents > 0
          ? `${runningAgents} running`
          : pausedAgents > 0
            ? `${pausedAgents} paused`
            : "Idle",
      tone: (runningAgents > 0 ? "running" : pausedAgents > 0 ? "waiting" : "neutral") as
        | "running"
        | "waiting"
        | "neutral",
    };
  }, [props.agentNodes]);
  const codexConnected = modelCatalog.models.some(
    (candidate) =>
      candidate.provider === "codex-subscription" &&
      candidate.credentialReadiness.status === "ready",
  );
  // Soft-hide dictate while realtime voice owns the mic (model + mutes stay on the bar).
  const [voiceActive, setVoiceActive] = useState(false);
  const onVoiceActiveChange = useCallback((active: boolean) => {
    setVoiceActive(active);
  }, []);
  const [variableSetPickerState, setVariableSetPickerState] =
    useState<SessionVariableSetPickerSharedState>({
      saving: false,
      committedSelection: null,
    });
  const variableSetComposerBlocked =
    variableSetPickerState.saving ||
    variableSetPickerState.committedSelection?.sessionId === props.session.id;
  // Per-approval decision state: an in-flight decision disables both buttons for
  // that approval and shows progress; a settled one can never double-submit even
  // if the strip lingers for a beat before the status flips.
  const [approvalPending, setApprovalPending] = useState<Record<string, "approve" | "reject">>({});
  const [approvalSettled, setApprovalSettled] = useState<Record<string, "approve" | "reject">>({});
  // Decision state is scoped to ONE requires_action pause. Once the session
  // resumes, both maps reset — otherwise a later approval that reuses an id
  // (including the index-fallback ids) would render permanently disabled, and
  // long sessions would accumulate stale entries.
  useEffect(() => {
    if (props.session.status !== "requires_action") {
      setApprovalPending((current) => (Object.keys(current).length ? {} : current));
      setApprovalSettled((current) => (Object.keys(current).length ? {} : current));
    }
  }, [props.session.status]);
  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      if (approvalPending[approvalId] || approvalSettled[approvalId]) {
        return;
      }
      setApprovalPending((current) => ({ ...current, [approvalId]: decision }));
      try {
        await (decision === "approve" ? props.onApprove(approvalId) : props.onReject(approvalId));
        setApprovalSettled((current) => ({
          ...current,
          [approvalId]: decision,
        }));
      } catch {
        // The route already surfaced a toast; leave the buttons live to retry.
      } finally {
        setApprovalPending((current) => {
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
      }
    },
    [approvalPending, approvalSettled, props],
  );
  // Workspace-scoped: the provider (mounted on the workspace route) supplies
  // the workspaceId, so the hook needs no positional argument.
  const attachments = useFileAttachments();
  const repositories = useFollowUpRepositories(props.session);
  const firstPartyToolOptions = firstPartySessionToolOptionsFor(
    clientFirstPartyMcpToolPolicy(context.clientConfig).allowed,
  );
  const selectableSessionMcpServers = context.toolMcpServers;
  const selectableToolIds = useMemo(
    () => selectableSessionMcpServers.map((server) => server.id),
    [selectableSessionMcpServers],
  );
  const policyToolIds = useMemo(
    () => sessionPolicyPickerIds(props.session, selectableToolIds, context.workspaceDefaultToolIds),
    [context.workspaceDefaultToolIds, props.session, selectableToolIds],
  );
  const [durableToolSelection, setDurableToolSelection] = useState<SessionToolSelection>(() => ({
    mcpServerIds: new Set(policyToolIds),
    firstPartyToolIds: new Set(props.session.firstPartyMcpTools),
  }));
  const [durableToolPolicyVersion, setDurableToolPolicyVersion] = useState(
    () => props.session.toolPolicyVersion,
  );
  const [durableToolsHydrated, setDurableToolsHydrated] = useState(false);
  const durableToolsSessionId = useRef(props.session.id);
  const [durableToolsSaving, setDurableToolsSaving] = useState(false);
  const [durableToolsError, setDurableToolsError] = useState<string | null>(null);
  const navigate = useNavigate();
  const launch = props.launch ?? EMPTY_COMPOSER_LAUNCH;
  const launchModel = launch.model;
  const launchEffort = launch.effort;
  const launchLatency = launch.latency;
  const launchRealtime = launch.realtime;
  const launchKey = composerLaunchSearchKey(launch);
  const appliedLaunchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (durableToolsSessionId.current !== props.session.id) {
      durableToolsSessionId.current = props.session.id;
      setDurableToolsHydrated(false);
      return;
    }
    if (!context.workspaceMcpCatalogReady) {
      if (durableToolsHydrated) {
        setDurableToolsHydrated(false);
      }
      return;
    }
    if (durableToolsHydrated) {
      return;
    }
    setDurableToolSelection({
      mcpServerIds: new Set(policyToolIds),
      firstPartyToolIds: new Set(props.session.firstPartyMcpTools),
    });
    setDurableToolPolicyVersion(props.session.toolPolicyVersion);
    setDurableToolsHydrated(true);
  }, [
    context.workspaceMcpCatalogReady,
    durableToolsHydrated,
    policyToolIds,
    props.session.id,
    props.session.firstPartyMcpTools,
    props.session.toolPolicyVersion,
  ]);
  const saveDurableToolPolicy = useCallback(
    async (next: SessionToolSelection) => {
      setDurableToolSelection({
        mcpServerIds: new Set(next.mcpServerIds),
        firstPartyToolIds: new Set(next.firstPartyToolIds),
      });
      setDurableToolsSaving(true);
      setDurableToolsError(null);
      try {
        const tools = toolsForPolicySelection({
          selectedMcpServerIds: next.mcpServerIds,
          baselineMcpServerIds: [],
          forceExplicit: true,
        });
        const updated = await context.client.updateSessionToolPolicy(
          props.session.workspaceId,
          props.session.id,
          {
            mode: "explicit",
            tools: tools ?? [],
            firstPartyMcpTools: [...next.firstPartyToolIds],
            expectedVersion: durableToolPolicyVersion,
          },
        );
        setDurableToolSelection({
          mcpServerIds: sessionPolicyPickerIds(
            updated,
            selectableToolIds,
            context.workspaceDefaultToolIds,
          ),
          firstPartyToolIds: new Set(updated.firstPartyMcpTools),
        });
        setDurableToolPolicyVersion(updated.toolPolicyVersion);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDurableToolsError(message);
        toast.error("Failed to save session tools", { description: message });
        // Reconcile with the server after both a 409 and a transport failure;
        // the failed local click must never be presented as durable truth.
        try {
          const refreshed = await context.client.getSession(
            props.session.workspaceId,
            props.session.id,
          );
          setDurableToolSelection({
            mcpServerIds: sessionPolicyPickerIds(
              refreshed,
              selectableToolIds,
              context.workspaceDefaultToolIds,
            ),
            firstPartyToolIds: new Set(refreshed.firstPartyMcpTools),
          });
          setDurableToolPolicyVersion(refreshed.toolPolicyVersion);
        } catch {
          // Keep the last authoritative selection when reconciliation is also
          // unavailable; the visible error makes the state non-silent.
        }
      } finally {
        setDurableToolsSaving(false);
      }
    },
    [
      context.client,
      context.workspaceDefaultToolIds,
      durableToolPolicyVersion,
      props.session.id,
      props.session.workspaceId,
      selectableToolIds,
    ],
  );
  const composerPolicyValidRef = useRef(false);
  const workspace =
    context.workspaces.find((candidate) => candidate.id === props.session.workspaceId) ?? null;
  const fixedResourceCatalogEnabled = props.session.sandboxBackend !== "selfhosted";
  const sessionVariableSetIds =
    props.session.variableSetIds ??
    (props.session.variableSetId ? [props.session.variableSetId] : []);
  const [fixedVariableSetScopes, fixedRigScope] = useFixedResourceScopes(
    context.client,
    workspace?.id ?? null,
    sessionVariableSetIds,
    props.session.rigId,
    fixedResourceCatalogEnabled,
  );
  const fixedVariableSetScope = fixedVariableSetScopes.at(-1) ?? null;
  const personalAttachment = usePersonalResourceAttachment({
    client: context.client,
    authMode: context.clientConfig.auth.mode,
    authSession: context.authSession,
    accessSubjectId: context.accessContext.subjectId,
    managedSelfContext: context.managedSelfContext,
    workspace,
    session: props.session,
    enabled: props.session.sandboxBackend !== "selfhosted",
    fixed: {
      variableSetIds: sessionVariableSetIds,
      variableSetScopes: fixedVariableSetScopes,
      variableSetId: props.session.variableSetId,
      variableSetScope: fixedVariableSetScope,
      rigId: props.session.rigId,
      rigScope: fixedRigScope,
      connectedMachine: null,
    },
    personalWorkspaceTarget: isPersonalWorkspace(workspace, context.managedSelfContext),
    onReloadSession: props.onReloadSession,
  });
  const composer = useComposer(props.session.id, {
    events: props.events,
    sendExtras: () => ({
      resources: [...attachments.readyResources, ...repositories.pendingResources],
      ...(repositories.pendingResources.some(
        (resource) =>
          resource.kind === "repository" && resource.connectionType === "github_personal",
      ) && context.personalGitHubAuthority
        ? { connectionAuthorities: [context.personalGitHubAuthority] }
        : {}),
      ...(personalAttachment.intent
        ? { personalResourceAttachment: personalAttachment.intent }
        : {}),
    }),
    sendBlocked: () =>
      attachments.hasUnresolved ||
      repositories.error !== null ||
      !composerPolicyValidRef.current ||
      variableSetComposerBlocked ||
      personalAttachment.requiresDecision ||
      personalAttachment.loading ||
      personalAttachment.refreshing,
    effectiveControl: props.queue.effectiveControl ?? props.session.effectiveControl,
    sendDestination: () =>
      props.session.activeTurnId !== null || props.queue.queue.length > 0 ? "queue" : "chat",
    // Ordinary Send is acknowledged locally. Clear only resources captured in
    // that immutable optimistic operation; later additions belong to the next
    // draft, while retry keeps the original resource refs in the failed bubble.
    onSubmitted: (_text, input) => {
      attachments.removeReadyFiles(
        (input.resources ?? []).flatMap((resource) =>
          resource.kind === "file" ? [resource.fileId] : [],
        ),
      );
      repositories.commitSent(input.resources ?? []);
    },
    onSent: (_text, input) => personalAttachment.onAccepted(input),
    onDeliveryError: personalAttachment.onDeliveryError,
  });
  useBrowserAccountBridgeBlocker(`session-composer:${props.session.id}`, () => {
    if (attachments.hasUnresolved) {
      return {
        id: "ignored",
        label: "A file upload is not settled",
        detail: "Wait for the upload or remove it before changing accounts.",
      };
    }
    if (composer.sending || composer.draftSaving || durableToolsSaving) {
      return {
        id: "ignored",
        label: "A session mutation is still running",
        detail: "Wait for the current save or send to finish.",
      };
    }
    return composer.hasDraftContent()
      ? {
          id: "ignored",
          label: "This session has an unsent draft",
          detail: "Continuing clears the account-bound composer state.",
        }
      : null;
  });
  const composerPolicy = composer.policy;
  const composerDraftLoading = composer.draftLoading;
  const setComposerModel = composer.setModel;
  const setComposerReasoningEffort = composer.setReasoningEffort;
  const setComposerLatencyMode = composer.setLatencyMode;
  const hasComposerPolicy = composerPolicy !== null;
  const model = composerPolicy?.model ?? props.session.model;
  const reasoningEffort = composerPolicy?.reasoningEffort ?? props.session.reasoningEffort;
  const latencyMode = composerPolicy?.latencyMode ?? props.session.latencyMode;
  const selectedPolicyRow = findPickerRow(modelCatalog.rows, model);
  const matchesFrozenSessionPolicy = Boolean(
    composerPolicy &&
    composerPolicy.model === props.session.model &&
    composerPolicy.reasoningEffort === props.session.reasoningEffort &&
    composerPolicy.latencyMode === props.session.latencyMode,
  );
  const catalogComboValid = Boolean(
    selectedPolicyRow?.selectable &&
    (props.session.codexCompactionMode !== "remote_v2" ||
      selectedPolicyRow.catalog.source === "codex") &&
    effortOptionsForModel(selectedPolicyRow.catalog).includes(reasoningEffort) &&
    (latencyMode === "standard" ||
      runnableLatencyModesForModel(selectedPolicyRow.catalog).includes(latencyMode)),
  );
  const composerPolicyValid = Boolean(
    composerPolicy && (catalogComboValid || matchesFrozenSessionPolicy),
  );
  const composerPolicyError =
    composerPolicy && !modelCatalog.loading && !composerPolicyValid
      ? "Choose a model, reasoning level, and speed supported by this session."
      : null;
  composerPolicyValidRef.current = composerPolicyValid;

  useEffect(() => {
    if (
      !launchKey ||
      appliedLaunchKeyRef.current === launchKey ||
      composerDraftLoading ||
      !hasComposerPolicy
    ) {
      return;
    }
    const hasPolicy = Boolean(launchModel || launchEffort || launchLatency);
    appliedLaunchKeyRef.current = launchKey;
    if (!hasPolicy) return;
    if (launchModel) setComposerModel(launchModel);
    if (launchEffort) setComposerReasoningEffort(launchEffort);
    if (launchLatency) setComposerLatencyMode(launchLatency);
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: {
        workspaceId: props.session.workspaceId,
        sessionId: props.session.id,
      },
      search: composerLaunchSearchAfterPolicyApply({
        model: launchModel,
        effort: launchEffort,
        latency: launchLatency,
        realtime: launchRealtime,
      }),
      replace: true,
    });
  }, [
    composerDraftLoading,
    hasComposerPolicy,
    launchEffort,
    launchKey,
    launchLatency,
    launchModel,
    launchRealtime,
    navigate,
    props.session.id,
    props.session.workspaceId,
    setComposerLatencyMode,
    setComposerModel,
    setComposerReasoningEffort,
  ]);
  const acceptedClientEventIds = useMemo(
    () =>
      new Set(
        props.events
          .filter((event) => event.type === "user.message" && event.clientEventId)
          .map((event) => event.clientEventId as string),
      ),
    [props.events],
  );
  const { optimisticMessages, retryOptimisticMessage, removeOptimisticMessage } = composer;
  const failedOptimisticMessageCount = (optimisticMessages ?? []).filter(
    (message) => message.state === "failed" && !acceptedClientEventIds.has(message.clientEventId),
  ).length;
  useEffect(() => {
    updateLocalSessionDeliveryAttention({
      workspaceId: props.session.workspaceId,
      sessionId: props.session.id,
      failedMessageCount: failedOptimisticMessageCount,
    });
  }, [failedOptimisticMessageCount, props.session.id, props.session.workspaceId]);
  const timelineWithOptimisticSends = useMemo<TimelineItem[]>(() => {
    const queuedEventIds = new Set(
      props.queue.queue
        .filter((turn) => turn.metadata.delivery !== "steer")
        .map((turn) => turn.triggerEventId),
    );
    const optimisticQueuedClientIds = new Set(
      (optimisticMessages ?? [])
        .filter(
          (message) =>
            message.destination === "queue" &&
            !(
              message.turnId &&
              message.appliedQueueVersion !== null &&
              message.appliedQueueVersion !== undefined &&
              props.queue.snapshot &&
              props.queue.snapshot.version >= message.appliedQueueVersion &&
              !props.queue.queue.some((turn) => turn.id === message.turnId)
            ),
        )
        .map((message) => message.clientEventId),
    );
    const visibleTimeline = props.timeline.filter((item) => {
      if (item.kind !== "user-message") return true;
      if (queuedEventIds.has(item.id)) return false;
      const clientEventId = item.reconciliationKey?.startsWith("user-message:")
        ? item.reconciliationKey.slice("user-message:".length)
        : null;
      return !clientEventId || !optimisticQueuedClientIds.has(clientEventId);
    });
    const visibleTimelineClientEventIds = new Set(
      visibleTimeline
        .filter((item) => item.kind === "user-message")
        .flatMap((item) => {
          const key = item.reconciliationKey;
          return key?.startsWith("user-message:") ? [key.slice("user-message:".length)] : [];
        }),
    );
    const optimisticItems: UserMessageItem[] = (optimisticMessages ?? [])
      .filter(
        (message) =>
          message.destination === "chat" &&
          !visibleTimelineClientEventIds.has(message.clientEventId),
      )
      .map((message) => ({
        kind: "user-message",
        id: `optimistic:${message.clientEventId}`,
        reconciliationKey: `user-message:${message.clientEventId}`,
        text: message.text,
        annotations: message.annotations.map((annotation, ordinal) => ({
          ...annotation,
          ordinal,
        })),
        resources: message.resources,
        tools: [],
        occurredAt: message.occurredAt,
        delivery: {
          state: message.state,
          ...(message.error ? { error: message.error } : {}),
          ...(message.state === "failed"
            ? {
                onRetry: () => retryOptimisticMessage?.(message.clientEventId),
                onRemove: () => removeOptimisticMessage?.(message.clientEventId),
              }
            : {}),
        },
      }));
    const visibleTimelineEventIds = new Set(
      visibleTimeline.filter((item) => item.kind === "user-message").map((item) => item.id),
    );
    const acceptedQueueSteers: UserMessageItem[] = (props.queue.acceptedSteers ?? [])
      .filter((steer) => !visibleTimelineEventIds.has(steer.triggerEventId))
      .map((steer) => ({
        kind: "user-message",
        id: steer.triggerEventId,
        text: steer.text,
        annotations: steer.annotations,
        resources: steer.resources,
        tools: steer.tools,
        occurredAt: steer.occurredAt,
        delivery: { state: steer.state },
      }));
    return [...visibleTimeline, ...optimisticItems, ...acceptedQueueSteers];
  }, [
    optimisticMessages,
    removeOptimisticMessage,
    props.queue.acceptedSteers,
    props.queue.queue,
    props.queue.snapshot,
    props.timeline,
    retryOptimisticMessage,
  ]);
  const repositoryPickerProps = repositories.pickerProps(terminal || composer.sending);
  const timelineEmptyStateCopy = sessionTimelineEmptyStateCopy(
    props.session.status,
    (props.queue.effectiveControl ?? props.session.effectiveControl).state === "paused",
  );

  // Slash-command palette context: the operator controls (/goal, /clear,
  // /compact, /help) act on THIS session. Permissions come from the workspace
  // grant so the palette hides commands the operator can't run.
  const workspacePermissions = useMemo(
    () =>
      context.accessContext.workspaceGrants.find(
        (grant) => grant.workspaceId === props.session.workspaceId,
      )?.permissions ?? [],
    [context.accessContext.workspaceGrants, props.session.workspaceId],
  );
  const commandContext = useMemo(
    () => ({
      client: context.client,
      workspaceId: props.session.workspaceId,
      sessionId: props.session.id,
      status: props.session.status,
      permissions: workspacePermissions,
    }),
    [
      context.client,
      props.session.workspaceId,
      props.session.id,
      props.session.status,
      workspacePermissions,
    ],
  );

  const renderMessageText = useCallback(
    (text: string, item: AgentMessageItem | UserMessageItem) => {
      if (item.kind === "user-message") {
        return <UserMessageBody workspaceId={props.session.workspaceId} item={item} />;
      }
      return (
        <div data-testid="assistant-markdown">
          <MarkdownText
            text={text}
            streaming={item.streaming}
            onSandboxFile={props.onOpenSandboxFile}
          />
        </div>
      );
    },
    [props.onOpenSandboxFile, props.session.workspaceId],
  );

  return createElement(
    LightboxProvider,
    null,
    <ChatViewportFileDropTarget
      data-workspace-scroll-owner="self-managed"
      enabled={!terminal && context.clientConfig.fileUploads.enabled === true}
      onFiles={attachments.addFiles}
    >
      {terminal ? (
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
          <TerminalSessionBanner session={props.session} onNewSession={props.onNewSession} />
          <TerminalSessionArchive session={props.session} eventCount={props.timeline.length} />
        </div>
      ) : (
        <>
          {/* Credit death also surfaces on an IDLE session: a budget_exhausted
              turn completes "cleanly", so waiting for status === "failed" would
              hide the one banner that explains why nothing works anymore. It
              hides again while a turn is actually running (someone topped up
              and is trying), so the recovery turn isn't shadowed by it. */}
          {props.failure &&
          (props.session.status === "failed" ||
            (props.creditExhausted && props.session.status === "idle")) ? (
            <FailedSessionBanner
              failure={props.failure}
              creditExhausted={props.creditExhausted}
              workspaceId={props.session.workspaceId}
            />
          ) : null}
          <div data-testid="session-timeline" className="min-h-0 min-w-0 flex-1">
            <MessageTimeline
              className="h-full"
              items={timelineWithOptimisticSends}
              status={props.session.status}
              computeLabel={computeLabel}
              renderMessageText={renderMessageText}
              onAnnotate={composer.addAnnotation}
              onOpenSession={props.onOpenSession}
              onMemoryClick={props.onMemoryClick}
              onReconnect={props.onReconnect}
              resolveProviderLogo={props.resolveProviderLogo}
              loadRetainedScreenshot={loadRetainedScreenshot}
              loadRetainedArtifact={loadRetainedArtifact}
              loadVideoArtifactPlayback={loadVideoArtifactPlayback}
              hasOlder={props.hasOlder}
              loadingOlder={props.loadingOlder}
              onLoadOlder={props.onLoadOlder}
              hasNewer={props.hasNewer}
              loadingNewer={props.loadingNewer}
              onLoadNewer={props.onLoadNewer}
              loadingOldest={props.loadingOldest}
              onJumpToStart={async () => {
                await props.onJumpToStart();
              }}
              onJumpToLatest={props.onJumpToLatest}
              trailingState={
                props.humanInput.requests.length > 0 &&
                props.session.status === "requires_action" ? (
                  <div className="pb-1" data-human-input-timeline-surface="">
                    <HumanInputSurface
                      requests={props.humanInput.requests}
                      respondingRequestId={props.humanInput.respondingRequestId}
                      error={props.humanInput.mutationError?.message}
                      onSubmit={(requestId, response) =>
                        props.humanInput.respond(requestId, response).then(() => undefined)
                      }
                    />
                  </div>
                ) : undefined
              }
              emptyState={
                props.queue.stoppingPreviousAttempt ? (
                  <EmptyState
                    className="min-h-[24rem]"
                    icon={
                      <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
                    }
                    title={
                      props.queue.effectiveControl?.state === "paused"
                        ? "Stopping current work"
                        : "Stopping previous work"
                    }
                    description={
                      props.queue.effectiveControl?.state === "paused"
                        ? "Waiting for the current command to stop safely. Queued work stays saved."
                        : "Your direction is saved. It starts after the previous command stops safely."
                    }
                  />
                ) : props.initialLoading ? (
                  // History is still fetching — a quiet shimmer, not the
                  // "waiting for the first step" copy (that's for NEW sessions).
                  <div className="grid min-h-[24rem] place-items-center text-sm">
                    <span className="og-shimmer-text font-medium">Loading conversation…</span>
                  </div>
                ) : (
                  <EmptyState
                    className="min-h-[24rem]"
                    icon={
                      props.session.status === "running" ||
                      props.session.status === "recovering" ? (
                        <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <MessagesSquareIcon className="size-4" />
                      )
                    }
                    title={timelineEmptyStateCopy.title}
                    description={timelineEmptyStateCopy.description}
                  />
                )
              }
            />
          </div>
        </>
      )}

      {/* Live decision strip: only while the session is actually paused on
          an approval — a replayed log or a stale stream must never render
          actionable Approve/Reject buttons for an already-resumed turn. */}
      {props.approvals.length > 0 && props.session.status === "requires_action" ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 sm:px-6">
          <div className="grid max-h-64 gap-3 overflow-y-auto pb-2">
            {props.approvals.map((approval) => {
              const pending = approvalPending[approval.id];
              const settled = approvalSettled[approval.id];
              const busy = Boolean(pending) || Boolean(settled);
              const payload = JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2);
              return (
                <Notice key={approval.id} tone="waiting" title={approval.name}>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2/60 p-2.5 font-mono text-xs leading-5 text-fg-muted">
                    {payload}
                  </pre>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void decideApproval(approval.id, "approve")}
                    >
                      {pending === "approve" ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <CheckIcon className="size-3.5" />
                      )}
                      {settled === "approve" ? "Approved" : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void decideApproval(approval.id, "reject")}
                    >
                      {pending === "reject" ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <XIcon className="size-3.5" />
                      )}
                      {settled === "reject" ? "Rejected" : "Reject"}
                    </Button>
                  </div>
                </Notice>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Compact session chrome above the composer — incoming, queue, goal,
          and agents as one dock. Hides entirely when there are no signals. */}
      <div className="mb-2 w-full shrink-0 px-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <SessionChrome
            queue={props.queue}
            composer={terminal ? undefined : composer}
            goal={props.goal}
            readOnly={terminal}
            agentsSignal={agentsSignal}
            agentsPanel={
              props.agentNodes.length > 0 ? (
                <SubagentTree workspaceId={props.session.workspaceId} nodes={props.agentNodes} />
              ) : null
            }
          />
        </div>
      </div>

      <div ref={composerRegionRef} className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <PersonalResourceAttachmentControl
            controller={personalAttachment}
            disabled={terminal || composer.sending}
            compact
          />
          <ConsoleComposer
            workspaceId={props.session.workspaceId}
            composer={composer}
            attachments={attachments}
            effectiveControl={composer.effectiveControl}
            queuedAheadCount={props.queue.queue.length}
            canControlWorkspace={workspacePermissions.includes("workspace:admin")}
            controlLinks={{
              workspaceHref: `/workspaces/${props.session.workspaceId}`,
              sessionHref: (sessionId) =>
                `/workspaces/${props.session.workspaceId}/sessions/${sessionId}`,
            }}
            disabled={terminal}
            commandContext={commandContext}
            onClearView={props.onClearView}
            fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
            transcriptionSuppressed={voiceActive}
            controlsLeading={
              <>
                <ComposerMobilePlus
                  disabled={terminal || composer.sending}
                  fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
                  servers={selectableSessionMcpServers}
                  firstPartyTools={firstPartyToolOptions}
                  selection={durableToolSelection}
                  toolsDisabled={
                    composer.sending || terminal || durableToolsSaving || !durableToolsHydrated
                  }
                  onToolSelectionChange={(next) => void saveDurableToolPolicy(next)}
                  repositories={{
                    selectedCount: repositories.selectionCount,
                    disabled: terminal || composer.sending,
                    panel: <FollowUpRepositoryMenuBody {...repositoryPickerProps} />,
                  }}
                />
                <SessionVariableSetPicker
                  session={props.session}
                  canControl={workspacePermissions.includes("sessions:control")}
                  canAttach={workspacePermissions.includes("variable-sets:attach")}
                  canUse={workspacePermissions.includes("variable-sets:use")}
                  canList={
                    workspacePermissions.includes("variable-sets:list") &&
                    workspacePermissions.includes("secrets:list")
                  }
                  disabled={terminal}
                  busy={
                    voiceActive ||
                    composer.sending ||
                    props.session.activeTurnId !== null ||
                    props.queue.queue.length > 0
                  }
                  goalActive={props.goal.isActive}
                  voiceActive={voiceActive}
                  sharedState={variableSetPickerState}
                  setSharedState={setVariableSetPickerState}
                  compact
                  triggerClassName="sm:hidden"
                  onReloadSession={props.onReloadSession}
                />
              </>
            }
            actions={
              !terminal ? (
                <Suspense fallback={null}>
                  <LazyCodexRealtimeControl
                    client={context.client}
                    workspaceId={props.session.workspaceId}
                    sessionId={props.session.id}
                    sessionStatus={props.session.status}
                    effectiveControl={
                      props.queue.effectiveControl ?? props.session.effectiveControl
                    }
                    events={props.events}
                    eventsReady={!props.initialLoading}
                    codexConnected={codexConnected}
                    realtimeAutostartModel={props.realtimeAutostartModel}
                    onRealtimeAutostartConsumed={props.onRealtimeAutostartConsumed}
                    onVoiceActiveChange={onVoiceActiveChange}
                  />
                </Suspense>
              ) : null
            }
            placeholder={
              props.session.status === "cancelled"
                ? "This session was cancelled."
                : props.creditExhausted &&
                    (props.session.status === "failed" || props.session.status === "idle")
                  ? // "Send a message to revive" is a dead end without credits —
                    // the reply turn dies the same budget death.
                    "Out of OpenGeni credits — add credits to continue."
                  : props.session.status === "failed"
                    ? props.failure?.safetyRefusal
                      ? "The model provider blocked the previous request."
                      : "This session failed — send a message to revive it."
                    : "Send a follow-up…"
            }
            controls={
              <div className="flex min-w-0 items-center gap-1.5 max-sm:min-w-0 max-sm:flex-nowrap">
                <ModelPicker
                  rows={modelCatalog.rows}
                  model={model}
                  effort={reasoningEffort}
                  latencyMode={latencyMode}
                  disabled={composer.sending || composer.draftLoading || !hasComposerPolicy}
                  loading={modelCatalog.loading || composer.draftLoading}
                  error={modelCatalog.error ?? composerPolicyError}
                  sessionKey={props.session.id}
                  menuSide="top"
                  codexOnly={props.session.codexCompactionMode === "remote_v2"}
                  onModelChange={composer.setModel}
                  onEffortChange={composer.setReasoningEffort}
                  onLatencyModeChange={composer.setLatencyMode}
                />
                <SessionToolPicker
                  menuSide="top"
                  servers={selectableSessionMcpServers}
                  firstPartyTools={firstPartyToolOptions}
                  selection={durableToolSelection}
                  triggerClassName="max-sm:hidden"
                  disabled={
                    composer.sending || terminal || durableToolsSaving || !durableToolsHydrated
                  }
                  saving={durableToolsSaving}
                  onChange={(next) => void saveDurableToolPolicy(next)}
                />
                <FollowUpRepositoryPicker
                  {...repositoryPickerProps}
                  triggerClassName="max-sm:hidden"
                />
                <SessionVariableSetPicker
                  session={props.session}
                  canControl={workspacePermissions.includes("sessions:control")}
                  canAttach={workspacePermissions.includes("variable-sets:attach")}
                  canUse={workspacePermissions.includes("variable-sets:use")}
                  canList={
                    workspacePermissions.includes("variable-sets:list") &&
                    workspacePermissions.includes("secrets:list")
                  }
                  disabled={terminal}
                  busy={
                    voiceActive ||
                    composer.sending ||
                    props.session.activeTurnId !== null ||
                    props.queue.queue.length > 0
                  }
                  goalActive={props.goal.isActive}
                  voiceActive={voiceActive}
                  sharedState={variableSetPickerState}
                  setSharedState={setVariableSetPickerState}
                  triggerClassName="max-sm:hidden"
                  onReloadSession={props.onReloadSession}
                />
                {durableToolsError ? (
                  <span className="sr-only" role="alert">
                    {durableToolsError}
                  </span>
                ) : null}
              </div>
            }
          />
        </div>
      </div>
    </ChatViewportFileDropTarget>,
  );
}
