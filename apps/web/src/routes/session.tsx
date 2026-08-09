// The session view — live timeline plus one compact prompt queue above the
// composer. Enter queues and Cmd/Ctrl+Enter steers; failed sessions stay
// honest (reason + retry history) and revivable from the same composer.
import { useMachines } from "@opengeni/react/machines";
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
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react/session";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, Loader2Icon, MenuIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { isApiErrorStatus } from "@/api";
import { ConsoleComposer } from "@/components/Composer";
import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import { LoadingPanel, ProblemPanel } from "@/components/common";
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
import { SubagentTree } from "@/components/session/subagents";
import { SessionWorkspace } from "@/components/session/sandbox-workspace";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import type { WorkspaceTab } from "@opengeni/react";
import { useAppContext } from "@/context";
import { normalizeProviderDomain } from "@/lib/capabilities";
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
import { coerceReasoningEffortForModel, findPickerRow } from "@/lib/model-policy";
import { resolveSessionComposerModel } from "@/lib/session-model";
import { mergeSessionContextProjection } from "@/lib/session-pins";
import { createWorkspaceRetainedArtifactLoader } from "@/lib/retained-artifact-loader";
import { createSessionRetainedScreenshotLoader } from "@/lib/retained-screenshot-loader";
import {
  firstPartySessionToolOptions,
  isIntelligenceEffort,
  sessionPolicyPickerIds,
  toolsForPolicySelection,
} from "@/lib/session-tools";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import type { ComposerDraft, LineageNode, SessionRealtimeModel } from "@opengeni/sdk";
import type { ConnectionMetadata, Session, SessionEvent } from "@/types";

const LazySessionInspector = lazy(() =>
  import("@/components/session/inspector").then(({ SessionInspector }) => ({
    default: SessionInspector,
  })),
);

const LazyCodexRealtimeControl = lazy(() =>
  import("@opengeni/react/realtime").then(({ SessionRealtimeControl }) => ({
    default: SessionRealtimeControl,
  })),
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
    jumpToLatest,
    error: streamError,
  } = useSessionEvents(sessionId);
  const { session: fetchedSession, loading, error: loadError } = useSession(sessionId, { events });
  // Queue + goal share the timeline's event stream — one SSE connection total.
  const queue = useTurnQueue(sessionId, { events });
  const goal = useGoal(sessionId, { events });
  const humanInput = useHumanInputRequests(sessionId, { events });
  const session = useMemo(
    () =>
      fetchedSession
        ? {
            ...fetchedSession,
            status: sessionStatus ?? fetchedSession.status,
            effectiveControl: queue.effectiveControl ?? fetchedSession.effectiveControl,
          }
        : null,
    [fetchedSession, queue.effectiveControl, sessionStatus],
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
    if (initialLoading && visibleEvents.length === 0) {
      return [];
    }
    const projected = projectSessionTimeline(session, visibleEvents);
    // projectSessionTimeline falls back to the session's initial message when
    // the projection is empty; after a clear-view that fallback would resurrect
    // the very first message, so suppress it once the view has been cleared.
    return viewClearedAfter !== null && visibleEvents.length === 0 ? [] : projected;
  }, [session, visibleEvents, viewClearedAfter, initialLoading]);
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
    setSession: setContextSession,
    setConnectionState: setContextConnectionState,
    sessionEventFeedStore,
  } = context;
  useEffect(() => {
    setContextSession((current) => mergeSessionContextProjection(current, session));
  }, [session, setContextSession]);
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
  useEffect(() => {
    if (oauthReturnHandled.current) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("integration_oauth");
    if (!outcome) {
      return;
    }
    oauthReturnHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "success") {
      toast.success("Connection restored", {
        description: "The earlier tool call wasn't replayed. Send a new message to try again.",
      });
    } else {
      toast.error("Reconnect failed", {
        description: params.get("reason") ?? undefined,
      });
    }
  }, []);

  // Start the recovery flow for a lapsed connection surfaced inline in the
  // timeline. OAuth connections reconnect in place (reuse the connectionId) and
  // return to this session; api-key ones can't OAuth, so hand off to credential
  // re-entry on the capabilities sheet for that provider. Throwing bubbles a
  // calm inline error on the reconnect card.
  const onReconnect = useCallback(
    async (item: AuthNeededItem) => {
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
    [context.client, workspaceId],
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

  if (!session) {
    if (loadError) {
      return isApiErrorStatus(loadError, 404) ? (
        <ProblemPanel
          title="Session not found in this workspace"
          description="The session ID is not available under the workspace in the URL."
          action={
            <Button asChild type="button" variant="secondary">
              <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }}>
                Back to sessions
              </Link>
            </Button>
          }
        />
      ) : (
        <ProblemPanel
          title="Unable to open session"
          description={loadError instanceof Error ? loadError.message : String(loadError)}
          action={
            <Button asChild type="button" variant="secondary">
              <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }}>
                Back to sessions
              </Link>
            </Button>
          }
        />
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
          dockCollapsed={!context.inspectorOpen}
          onDockCollapsedChange={(collapsed) => context.setInspectorOpen(!collapsed)}
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
        dockCollapsed={!context.inspectorOpen}
        onDockCollapsedChange={(collapsed) => context.setInspectorOpen(!collapsed)}
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
  dockCollapsed: boolean;
  onDockCollapsedChange: (collapsed: boolean) => void;
  onOpenNavigation: () => void;
}) {
  // The workbench (Changes | Files | Terminal | Desktop + machine chip) lives in
  // the package now; the app injects Debug around it. Agents remain in the one
  // compact composer-adjacent surface.
  const trailingTabs: WorkspaceTab[] = props.session
    ? [
        {
          id: "debug",
          label: "Debug",
          content: (
            <Suspense fallback={<LoadingPanel label="Opening debug inspector" />}>
              <LazySessionInspector
                session={props.session}
                events={props.events}
                connectionState={props.connectionState}
              />
            </Suspense>
          ),
        },
      ]
    : [];

  return (
    <SessionWorkspace
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      events={props.events}
      primary={props.primary}
      trailingTabs={trailingTabs}
      collapsed={props.dockCollapsed}
      onCollapsedChange={props.onDockCollapsedChange}
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
  onLoadOlder: () => Promise<boolean>;
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
}) {
  const context = useAppContext();
  const modelCatalog = useWorkspaceModelCatalog(props.session.workspaceId);
  const fleet = useMachines({ sessionId: props.session.id, pollIntervalMs: 5000 });
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
  const terminal = isTerminalSessionStatus(props.session.status);
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
  const { effortForSession, latencyMode } = context;
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
  // Session-scoped pick (seeded from durable session.model). Prefer that
  // durable id before ensure/draft hydrate — never flash the deployment default
  // (wrong provider) on an open Codex session. On remote_v2, never keep a stale
  // non-Codex override over the durable Codex model.
  const requestedModel = context.modelForSession(props.session.id, props.session.model);
  const model = resolveSessionComposerModel({
    requested: requestedModel,
    durableSessionModel: props.session.model,
    codexCompactionMode: props.session.codexCompactionMode,
  });
  const reasoningEffort = effortForSession(props.session.id);
  const {
    setModelForSession,
    setEffortForSession,
    ensureModelForSession,
    ensureEffortForSession,
    setLatencyMode,
  } = context;
  // Once the operator touches the picker, draft reloads must not stomp it.
  const pickerTouchedRef = useRef(false);
  useEffect(() => {
    pickerTouchedRef.current = false;
  }, [props.session.id]);
  const navigate = useNavigate();
  const launch = props.launch ?? EMPTY_COMPOSER_LAUNCH;
  const launchModel = launch.model;
  const launchEffort = launch.effort;
  const launchLatency = launch.latency;
  const launchRealtime = launch.realtime;
  const launchKey = composerLaunchSearchKey(launch);
  const appliedLaunchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!launchKey || appliedLaunchKeyRef.current === launchKey) return;
    const hasPolicy = Boolean(launchModel || launchEffort || launchLatency);
    if (!hasPolicy) {
      appliedLaunchKeyRef.current = launchKey;
      return;
    }
    appliedLaunchKeyRef.current = launchKey;
    pickerTouchedRef.current = true;
    if (launchModel) setModelForSession(props.session.id, launchModel);
    if (launchEffort) setEffortForSession(props.session.id, launchEffort);
    if (launchLatency) setLatencyMode(launchLatency);
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId: props.session.workspaceId, sessionId: props.session.id },
      search: composerLaunchSearchAfterPolicyApply({
        model: launchModel,
        effort: launchEffort,
        latency: launchLatency,
        realtime: launchRealtime,
      }),
      replace: true,
    });
  }, [
    launchEffort,
    launchLatency,
    launchModel,
    launchRealtime,
    launchKey,
    navigate,
    props.session.id,
    props.session.workspaceId,
    setEffortForSession,
    setLatencyMode,
    setModelForSession,
  ]);
  // Seed once from durable session facts so open sessions never inherit the
  // mutable new-session composer picks. Draft apply / picker writes still win.
  useEffect(() => {
    if (pickerTouchedRef.current) return;
    ensureModelForSession(props.session.id, props.session.model);
    const metaEffort = props.session.metadata.reasoningEffort;
    if (isIntelligenceEffort(metaEffort)) {
      ensureEffortForSession(props.session.id, metaEffort);
    }
    // Seed latency from durable session metadata until the composer draft
    // applies (draft wins). Avoids flashing the global leftover/standard mode.
    const metaLatency = props.session.metadata.latencyMode;
    if (metaLatency === "fast" || metaLatency === "priority" || metaLatency === "standard") {
      setLatencyMode(metaLatency);
    }
  }, [
    setLatencyMode,
    ensureEffortForSession,
    ensureModelForSession,
    props.session.id,
    props.session.metadata.latencyMode,
    props.session.metadata.reasoningEffort,
    props.session.model,
  ]);
  // Drop a stale non-Codex override so the picker selection matches send.
  useEffect(() => {
    if (model === requestedModel) return;
    setModelForSession(props.session.id, model);
  }, [model, requestedModel, props.session.id, setModelForSession]);
  // Catalog-backed effort legality: snap sticky effort when the selected model
  // cannot run it (e.g. after reconnect or catalog refresh).
  useEffect(() => {
    const row = findPickerRow(modelCatalog.rows, model);
    if (!row?.selectable) {
      return;
    }
    const coerced = coerceReasoningEffortForModel(row.catalog, reasoningEffort);
    if (coerced !== reasoningEffort) {
      setEffortForSession(props.session.id, coerced);
    }
  }, [model, modelCatalog.rows, props.session.id, reasoningEffort, setEffortForSession]);
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
  const applyComposerSettings = useCallback(
    (draft: ComposerDraft) => {
      // Initial hydrate only. A later draft reload (or a fetch that raced the
      // picker) must not undo an in-session model/effort change; autosave
      // persists the picker into the draft.
      if (pickerTouchedRef.current) {
        return;
      }
      setModelForSession(props.session.id, draft.model);
      setEffortForSession(props.session.id, draft.reasoningEffort);
      setLatencyMode(draft.latencyMode ?? "standard");
    },
    [setLatencyMode, props.session.id, setEffortForSession, setModelForSession],
  );
  const composer = useComposer(props.session.id, {
    events: props.events,
    sendExtras: () => {
      return {
        resources: attachments.readyResources,
        model,
        reasoningEffort,
        latencyMode,
      };
    },
    sendBlocked: () => attachments.hasUnresolved,
    effectiveControl: props.queue.effectiveControl ?? props.session.effectiveControl,
    onDraftApplied: applyComposerSettings,
    // Clear only files included in the accepted wire input. A file added while
    // sendMessage is in flight belongs to the next message and must survive.
    onSent: (_text, input) =>
      attachments.removeReadyFiles(
        (input.resources ?? []).flatMap((resource) =>
          resource.kind === "file" ? [resource.fileId] : [],
        ),
      ),
  });

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
          <MarkdownText text={text} streaming={item.streaming} />
        </div>
      );
    },
    [props.session.workspaceId],
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
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
              items={props.timeline}
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
              hasOlder={props.hasOlder}
              loadingOlder={props.loadingOlder}
              onLoadOlder={() => void props.onLoadOlder()}
              hasNewer={props.hasNewer}
              loadingNewer={props.loadingNewer}
              onLoadNewer={() => void props.onLoadNewer()}
              loadingOldest={props.loadingOldest}
              onJumpToStart={() => void props.onJumpToStart()}
              onJumpToLatest={() => void props.onJumpToLatest()}
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
                    icon={<MessagesSquareIcon className="size-4" />}
                    title="Waiting for the first step"
                    description="The agent's steps will appear here as it works."
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

      {/* Structured questions are tool output, not approvals: answer/skip
          resumes the exact frozen call. The authoritative hook reads pending
          rows and uses this shared event feed only as a refresh trigger.
          Parallel requests step one-at-a-time inside HumanInputSurface. */}
      {props.humanInput.requests.length > 0 && props.session.status === "requires_action" ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 sm:px-6 pb-2">
          <HumanInputSurface
            requests={props.humanInput.requests}
            respondingRequestId={props.humanInput.respondingRequestId}
            error={props.humanInput.mutationError?.message}
            onSubmit={(requestId, response) =>
              props.humanInput.respond(requestId, response).then(() => undefined)
            }
          />
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

      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <ConsoleComposer
            workspaceId={props.session.workspaceId}
            composer={composer}
            attachments={attachments}
            effectiveControl={props.queue.effectiveControl ?? props.session.effectiveControl}
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
              <ComposerMobilePlus
                disabled={terminal || composer.sending}
                fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
                servers={selectableSessionMcpServers}
                firstPartyTools={firstPartySessionToolOptions}
                selection={durableToolSelection}
                toolsDisabled={
                  composer.sending || terminal || durableToolsSaving || !durableToolsHydrated
                }
                onToolSelectionChange={(next) => void saveDurableToolPolicy(next)}
              />
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
                    ? "This session failed — send a message to revive it."
                    : "Send a follow-up…"
            }
            controls={
              <div className="flex min-w-0 items-center gap-1.5 max-sm:min-w-0 max-sm:flex-nowrap">
                <ModelPicker
                  rows={modelCatalog.rows}
                  model={model}
                  effort={reasoningEffort}
                  latencyMode={latencyMode}
                  disabled={composer.sending}
                  loading={modelCatalog.loading || composer.draftLoading}
                  error={modelCatalog.error}
                  sessionKey={props.session.id}
                  menuSide="top"
                  codexOnly={props.session.codexCompactionMode === "remote_v2"}
                  onModelChange={(value) => {
                    pickerTouchedRef.current = true;
                    context.setModelForSession(props.session.id, value);
                  }}
                  onEffortChange={(value) => {
                    pickerTouchedRef.current = true;
                    context.setEffortForSession(props.session.id, value);
                  }}
                  onLatencyModeChange={(value) => {
                    pickerTouchedRef.current = true;
                    context.setLatencyMode(value);
                  }}
                />
                <SessionToolPicker
                  menuSide="top"
                  servers={selectableSessionMcpServers}
                  firstPartyTools={firstPartySessionToolOptions}
                  selection={durableToolSelection}
                  triggerClassName="max-sm:hidden"
                  disabled={
                    composer.sending || terminal || durableToolsSaving || !durableToolsHydrated
                  }
                  saving={durableToolsSaving}
                  onChange={(next) => void saveDurableToolPolicy(next)}
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
    </section>
  );
}
