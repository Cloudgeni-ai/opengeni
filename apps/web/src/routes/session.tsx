// The session view — live timeline plus one compact prompt queue above the
// composer. Enter queues and Cmd/Ctrl+Enter steers; failed sessions stay
// honest (reason + retry history) and revivable from the same composer.
import {
  creditExhaustedFromEvents,
  MessageTimeline,
  projectPendingApprovals,
  useComposer,
  useFileAttachments,
  useGoal,
  useSession,
  useSessionEvents,
  useSessionLineage,
  QueueSurface,
  useTurnQueue,
  type AgentMessageItem,
  type AuthNeededItem,
  type PendingApproval,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, Loader2Icon, MenuIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { isApiErrorStatus } from "@/api";
import { ConsoleComposer } from "@/components/Composer";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { MarkdownText } from "@/components/markdown";
import { EnabledMcpToolPicker, ModelPicker } from "@/components/pickers";
import {
  FailedSessionBanner,
  TerminalSessionArchive,
  TerminalSessionBanner,
  UserMessageBody,
} from "@/components/session/banners";
import { ComposerAgentsPill } from "@/components/session/composer-agents-pill";
import { useRail } from "@/components/rail/rail-context";
import { GoalSurface } from "@/components/session/goal-surface";
import { SessionInspector } from "@/components/session/inspector";
import { SessionWorkspace } from "@/components/session/sandbox-workspace";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import type { WorkspaceTab } from "@opengeni/react";
import { useAppContext } from "@/context";
import { useCodexModels } from "@/lib/use-codex-models";
import { normalizeProviderDomain } from "@/lib/capabilities";
import {
  isTerminalSessionStatus,
  projectSessionTimeline,
  summarizeSessionFailure,
} from "@/lib/events";
import { buildTools } from "@/lib/session-tools";
import type { ComposerDraft, LineageNode } from "@opengeni/sdk";
import type { ConnectionMetadata, Session, SessionEvent } from "@/types";

export function SessionRoute({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  const context = useAppContext();
  const rail = useRail();
  const navigate = useNavigate();

  // Session record + live event log via @opengeni/react. Fresh opens load a
  // bounded tail, then stream live events with resume-by-sequence.
  const { session: fetchedSession, loading, error: loadError } = useSession(sessionId);
  const {
    events,
    sessionStatus,
    connectionState,
    initialLoading,
    hasOlder,
    loadingOlder,
    loadOlder,
    error: streamError,
  } = useSessionEvents(sessionId);
  // Queue + goal share the timeline's event stream — one SSE connection total.
  const queue = useTurnQueue(sessionId, { events });
  const goal = useGoal(sessionId, { events });
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
  const { setSession: setContextSession, setConnectionState: setContextConnectionState } = context;
  useEffect(() => {
    setContextSession(session);
  }, [session, setContextSession]);
  useEffect(() => {
    setContextConnectionState(connectionState);
  }, [connectionState, setContextConnectionState]);
  useEffect(
    () => () => {
      setContextSession(null);
      setContextConnectionState("idle");
    },
    [setContextConnectionState, setContextSession],
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
  // returnPath to this session). The connection is refreshed server-side, so we
  // just acknowledge it and strip the params — the user retries their message.
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
      toast.success("Reconnected", {
        description: "Send your message again to continue.",
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

  // One lazy catalog fetch feeds two timeline resolvers: provider logos for any
  // inline reconnect card, and real capability names for the tool chips on user
  // messages. Both resolve only through the workspace catalog, so fetch it once —
  // when EITHER an auth-needed card OR a message carrying tool chips is in view —
  // and reuse the single response. Logos serve from our own catalog-assets route
  // via `catalogAssetUrl`, never an off-origin favicon (the CSP forbids it and it
  // would leak which providers are connected).
  const hasAuthNeeded = useMemo(
    () => timeline.some((item) => item.kind === "auth-needed"),
    [timeline],
  );
  const hasToolChips = useMemo(
    () => timeline.some((item) => item.kind === "user-message" && item.tools.length > 0),
    [timeline],
  );
  const [providerLogos, setProviderLogos] = useState<Map<string, string>>(() => new Map());
  // mcpServerId -> human capability name, so a chip reads "Linear" instead of a
  // best-effort parse of the raw server id.
  const [capabilityNames, setCapabilityNames] = useState<Map<string, string>>(() => new Map());
  const catalogRequestedRef = useRef(false);
  useEffect(() => {
    if ((!hasAuthNeeded && !hasToolChips) || catalogRequestedRef.current) {
      return;
    }
    catalogRequestedRef.current = true;
    let cancelled = false;
    void context.client
      .listCapabilities(workspaceId)
      .then((catalog) => {
        if (cancelled) {
          return;
        }
        const logos = new Map<string, string>();
        const names = new Map<string, string>();
        for (const cap of catalog.items) {
          const domain = cap.providerDomain ?? cap.connectionRef?.providerDomain ?? null;
          const url = context.client.catalogAssetUrl(cap.logoAssetPath);
          if (domain && url) {
            const key = normalizeProviderDomain(domain);
            if (!logos.has(key)) {
              logos.set(key, url);
            }
          }
          // A chip's tool.id IS the capability's runtime mcpServerId — map it to
          // the item's human name so the chip resolves to the real label.
          const mcpServerId = cap.runtime.mcpServerId;
          if (mcpServerId && cap.name && !names.has(mcpServerId)) {
            names.set(mcpServerId, cap.name);
          }
        }
        setProviderLogos(logos);
        setCapabilityNames(names);
      })
      .catch(() => {
        // Leave the card on its monogram fallback and the chips on their
        // best-effort labels, and allow a later retry.
        if (!cancelled) {
          catalogRequestedRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasAuthNeeded, hasToolChips, context.client, workspaceId]);
  const resolveProviderLogo = useCallback(
    (domain: string) => providerLogos.get(normalizeProviderDomain(domain)) ?? null,
    [providerLogos],
  );
  const resolveCapabilityName = useCallback(
    (mcpServerId: string) => capabilityNames.get(mcpServerId) ?? null,
    [capabilityNames],
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

  if (loading || !session) {
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
    return <LoadingPanel label="Opening session" />;
  }

  const chatPane = (
    <SessionChatPane
      session={session}
      events={events}
      timeline={timeline}
      initialLoading={initialLoading}
      approvals={approvals}
      failure={failure}
      creditExhausted={creditExhausted}
      goal={goal}
      queue={queue}
      agentNodes={agentNodes}
      hasOlder={hasOlder}
      loadingOlder={loadingOlder}
      onLoadOlder={loadOlder}
      onClearView={clearView}
      onOpenSession={(nextSessionId) =>
        void navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: nextSessionId },
        })
      }
      onMemoryClick={(memoryId) =>
        void navigate({
          to: "/workspaces/$workspaceId/documents",
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
      resolveCapabilityName={resolveCapabilityName}
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
  session: Session;
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
  const debugTab: WorkspaceTab = {
    id: "debug",
    label: "Debug",
    content: (
      <SessionInspector
        session={props.session}
        events={props.events}
        connectionState={props.connectionState}
      />
    ),
  };

  return (
    <SessionWorkspace
      workspaceId={props.workspaceId}
      sessionId={props.sessionId}
      events={props.events}
      primary={props.primary}
      trailingTabs={[debugTab]}
      collapsed={props.dockCollapsed}
      onCollapsedChange={props.onDockCollapsedChange}
      mobileLeadingControl={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open navigation"
          onClick={props.onOpenNavigation}
          className="pointer-coarse:size-10"
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
  approvals: PendingApproval[];
  failure: ReturnType<typeof summarizeSessionFailure> | null;
  /** The last turn ended budget_exhausted — the workspace is out of credits. */
  creditExhausted: boolean;
  goal: ReturnType<typeof useGoal>;
  queue: ReturnType<typeof useTurnQueue>;
  /** Spawned-worker lineage children — feeds the composer-anchored agents pill. */
  agentNodes: LineageNode[];
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<boolean>;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Deep-link a timeline memory step to its record in the Documents memory pane. */
  onMemoryClick: (memoryId: string) => void;
  onNewSession: () => void;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  onReconnect: (item: AuthNeededItem) => void | Promise<void>;
  resolveProviderLogo: (providerDomain: string) => string | null;
  /** Real capability name for a user-message tool chip, resolved from the catalog. */
  resolveCapabilityName: (mcpServerId: string) => string | null;
}) {
  const context = useAppContext();
  const codexModels = useCodexModels(props.session.workspaceId);
  const terminal = isTerminalSessionStatus(props.session.status);
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
  const { selectedCapabilityToolIds, reasoningEffort } = context;
  // The model is session-scoped: this session remembers its own pick (falling
  // back to the deployment default), so a switch here doesn't bleed into others.
  const model = context.modelForSession(props.session.id);
  const { setModelForSession, setReasoningEffort, setSelectedCapabilityToolIds } = context;
  const applyComposerSettings = useCallback(
    (draft: ComposerDraft) => {
      setModelForSession(props.session.id, draft.model);
      setReasoningEffort(draft.reasoningEffort);
      setSelectedCapabilityToolIds(new Set(draft.tools.map((tool) => tool.id)));
    },
    [props.session.id, setModelForSession, setReasoningEffort, setSelectedCapabilityToolIds],
  );
  const composer = useComposer(props.session.id, {
    events: props.events,
    // Evaluated at send time: attachments and tools picked while the draft was
    // being written ride along with the message.
    sendExtras: () => ({
      resources: attachments.readyResources,
      tools: buildTools(undefined, [...selectedCapabilityToolIds]),
      model,
      reasoningEffort,
    }),
    effectiveControl: props.queue.effectiveControl ?? props.session.effectiveControl,
    onDraftApplied: applyComposerSettings,
    onSent: () => attachments.clear(),
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
        return (
          <UserMessageBody
            workspaceId={props.session.workspaceId}
            item={item}
            resolveCapabilityName={props.resolveCapabilityName}
          />
        );
      }
      return (
        <div data-testid="assistant-markdown">
          <MarkdownText text={text} streaming={item.streaming} />
        </div>
      );
    },
    [props.session.workspaceId, props.resolveCapabilityName],
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
              renderMessageText={renderMessageText}
              onOpenSession={props.onOpenSession}
              onMemoryClick={props.onMemoryClick}
              onReconnect={props.onReconnect}
              resolveProviderLogo={props.resolveProviderLogo}
              hasOlder={props.hasOlder}
              loadingOlder={props.loadingOlder}
              onLoadOlder={() => void props.onLoadOlder()}
              emptyState={
                props.initialLoading ? (
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

      {/* The one compact control stack above the composer. Each surface hides
          when it has nothing to show, so the stack degrades to
          whichever one is present — or neither. */}
      {!terminal ? <QueueSurface queue={props.queue} composer={composer} /> : null}
      <GoalSurface session={props.session} goal={props.goal} />
      <ComposerAgentsPill workspaceId={props.session.workspaceId} nodes={props.agentNodes} />

      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <ConsoleComposer
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
              <div className="flex min-w-0 items-center gap-1.5">
                <ModelPicker
                  config={context.clientConfig}
                  model={model}
                  effort={context.reasoningEffort}
                  disabled={composer.sending}
                  extraModels={codexModels}
                  onModelChange={(value) => context.setModelForSession(props.session.id, value)}
                  onEffortChange={context.setReasoningEffort}
                />
                <EnabledMcpToolPicker
                  servers={context.toolMcpServers}
                  selectedIds={context.selectedCapabilityToolIds}
                  disabled={composer.sending || terminal}
                  onChange={context.setSelectedCapabilityToolIds}
                />
              </div>
            }
          />
        </div>
      </div>
    </section>
  );
}
