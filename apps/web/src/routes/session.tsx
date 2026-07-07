// The session view — the console's centerpiece. Live timeline on the left;
// the session rail (turn queue + goal, or debug inspector) on the right.
// The composer is queue-by-default with explicit steer; failed sessions stay
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
  useTurnQueue,
  type AgentMessageItem,
  type AuthNeededItem,
  type PendingApproval,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, Loader2Icon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { isApiErrorStatus } from "@/api";
import { ConsoleComposer } from "@/components/Composer";
import { LoadingPanel, ProblemPanel } from "@/components/common";
import { MarkdownText } from "@/components/markdown";
import {
  EnabledMcpToolPicker,
  ModelPicker,
} from "@/components/pickers";
import {
  FailedSessionBanner,
  TerminalSessionArchive,
  TerminalSessionBanner,
  UserMessageBody,
} from "@/components/session/banners";
import { GoalCard, GoalChip } from "@/components/session/goal-card";
import { SessionInspector } from "@/components/session/inspector";
import { QueueRail } from "@/components/session/queue-rail";
import { useSandboxWorkspaceTabs } from "@/components/session/sandbox-workspace";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WorkspaceDock, type WorkspaceTab } from "@opengeni/react";
import { useAppContext } from "@/context";
import { useCodexModels } from "@/lib/use-codex-models";
import { normalizeProviderDomain } from "@/lib/capabilities";
import { isTerminalSessionStatus, projectSessionTimeline, summarizeSessionFailure } from "@/lib/events";
import { buildTools } from "@/lib/session-tools";
import type { ConnectionMetadata, Session, SessionEvent } from "@/types";

export function SessionRoute({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();

  // Session record + live event log via @opengeni/react. Fresh opens load a
  // bounded tail, then stream live events with resume-by-sequence.
  const { session: fetchedSession, loading, error: loadError } = useSession(sessionId);
  const { events, sessionStatus, connectionState, initialLoading, hasOlder, loadingOlder, loadOlder, error: streamError } = useSessionEvents(sessionId);
  const session = useMemo(
    () => fetchedSession ? { ...fetchedSession, status: sessionStatus ?? fetchedSession.status } : null,
    [fetchedSession, sessionStatus],
  );
  // Queue + goal share the timeline's event stream — one SSE connection total.
  const queue = useTurnQueue(sessionId, { events });
  const goal = useGoal(sessionId, { events });
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
    () => viewClearedAfter !== null ? events.filter((event) => event.sequence > viewClearedAfter) : events,
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
    () => session && (session.status === "failed" || creditExhausted)
      ? summarizeSessionFailure(events, session.status)
      : null,
    [events, session?.status, creditExhausted],
  );

  // Keep the workspace header (title, status badge, connection pill) in sync.
  useEffect(() => {
    context.setSession(session);
  }, [session]);
  useEffect(() => {
    context.setConnectionState(connectionState);
  }, [connectionState]);
  useEffect(() => () => {
    context.setSession(null);
    context.setConnectionState("idle");
  }, []);
  useEffect(() => {
    if (streamError && !isApiErrorStatus(streamError, 404)) {
      toast.error("Event stream disconnected", { description: streamError.message });
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
      toast.success("Reconnected", { description: "Send your message again to continue." });
    } else {
      toast.error("Reconnect failed", { description: params.get("reason") ?? undefined });
    }
  }, []);

  // Start the recovery flow for a lapsed connection surfaced inline in the
  // timeline. OAuth connections reconnect in place (reuse the connectionId) and
  // return to this session; api-key ones can't OAuth, so hand off to credential
  // re-entry on the capabilities sheet for that provider. Throwing bubbles a
  // calm inline error on the reconnect card.
  const onReconnect = useCallback(async (item: AuthNeededItem) => {
    const connections = await context.client.listConnections(workspaceId).catch(() => [] as ConnectionMetadata[]);
    const connection = item.connectionId ? connections.find((candidate) => candidate.id === item.connectionId) ?? null : null;
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
  }, [context.client, workspaceId]);

  // Self-hosted provider logos for any inline reconnect card. A domain resolves
  // to a logo only through the workspace catalog (logoAssetPath), so fetch it
  // lazily — once an auth-needed card is actually in view — and serve the image
  // from our own catalog-assets route via `catalogAssetUrl`, never an off-origin
  // favicon (the CSP forbids it and it would leak which providers are connected).
  const hasAuthNeeded = useMemo(() => timeline.some((item) => item.kind === "auth-needed"), [timeline]);
  const [providerLogos, setProviderLogos] = useState<Map<string, string>>(() => new Map());
  const logosRequestedRef = useRef(false);
  useEffect(() => {
    if (!hasAuthNeeded || logosRequestedRef.current) {
      return;
    }
    logosRequestedRef.current = true;
    let cancelled = false;
    void context.client.listCapabilities(workspaceId)
      .then((catalog) => {
        if (cancelled) {
          return;
        }
        const map = new Map<string, string>();
        for (const cap of catalog.items) {
          const domain = cap.providerDomain ?? cap.connectionRef?.providerDomain ?? null;
          const url = context.client.catalogAssetUrl(cap.logoAssetPath);
          if (domain && url) {
            const key = normalizeProviderDomain(domain);
            if (!map.has(key)) {
              map.set(key, url);
            }
          }
        }
        setProviderLogos(map);
      })
      .catch(() => {
        // Leave the card on its monogram fallback and allow a later retry.
        if (!cancelled) {
          logosRequestedRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasAuthNeeded, context.client, workspaceId]);
  const resolveProviderLogo = useCallback(
    (domain: string) => providerLogos.get(normalizeProviderDomain(domain)) ?? null,
    [providerLogos],
  );

  if (loading || !session) {
    if (loadError) {
      return isApiErrorStatus(loadError, 404) ? (
        <ProblemPanel
          title="Session not found in this workspace"
          description="The session ID is not available under the workspace in the URL."
          action={<Button asChild type="button" variant="secondary"><Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }}>Back to sessions</Link></Button>}
        />
      ) : (
        <ProblemPanel
          title="Unable to open session"
          description={loadError instanceof Error ? loadError.message : String(loadError)}
          action={<Button asChild type="button" variant="secondary"><Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }}>Back to sessions</Link></Button>}
        />
      );
    }
    return <LoadingPanel label="Opening session" />;
  }

  const chatPane = (
    <SessionChatPane
      session={session}
      timeline={timeline}
      initialLoading={initialLoading}
      approvals={approvals}
      failure={failure}
      creditExhausted={creditExhausted}
      goal={goal}
      hasOlder={hasOlder}
      loadingOlder={loadingOlder}
      onLoadOlder={loadOlder}
      onClearView={clearView}
      onOpenSession={(nextSessionId) => void navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: nextSessionId } })}
      onNewSession={() => void navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId } })}
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
        queue={queue}
        goal={goal}
        connectionState={connectionState}
        primary={chatPane}
        dockCollapsed={!context.inspectorOpen}
        onDockCollapsedChange={(collapsed) => context.setInspectorOpen(!collapsed)}
      />
    </div>
  );

  async function approve(approvalId: string, decision: "approve" | "reject") {
    try {
      await context.client.sendApprovalDecision(workspaceId, sessionId, { approvalId, decision });
    } catch (error) {
      toast.error("Couldn't submit the decision", { description: error instanceof Error ? error.message : String(error) });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

/**
 * The resizable Workspace dock: chat on the left, a collapsible/maximizable dock
 * on the right with Run + the capability-gated sandbox surfaces (Files |
 * Terminal | Desktop) + Debug. Replaces the old fixed 390px aside.
 */
function SessionDock(props: {
  workspaceId: string;
  sessionId: string;
  session: Session;
  events: SessionEvent[];
  queue: ReturnType<typeof useTurnQueue>;
  goal: ReturnType<typeof useGoal>;
  connectionState: ReturnType<typeof useSessionEvents>["connectionState"];
  primary: React.ReactNode;
  dockCollapsed: boolean;
  onDockCollapsedChange: (collapsed: boolean) => void;
}) {
  // Track the dock's active tab so the Files surface can hold the box WARM only
  // while it's actually on screen (fast ~100ms Channel-A ops instead of a cold
  // ~5s resume per list/write). Default to the dock's first tab ("run").
  const [activeTab, setActiveTab] = useState<string>("run");
  const { tabs: sandboxTabs } = useSandboxWorkspaceTabs({
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    events: props.events,
    filesActive: !props.dockCollapsed && activeTab === "files",
  });

  const tabs: WorkspaceTab[] = [
    {
      id: "run",
      label: "Run",
      content: (
        <ScrollArea className="h-full min-w-0">
          <div className="min-w-0 space-y-5 p-3">
            <QueueRail queue={props.queue} sessionStatus={props.session.status} />
            <GoalCard goal={props.goal} events={props.events} />
          </div>
        </ScrollArea>
      ),
    },
    ...sandboxTabs,
    {
      id: "debug",
      label: "Debug",
      content: <SessionInspector session={props.session} events={props.events} connectionState={props.connectionState} />,
    },
  ];

  return (
    <WorkspaceDock
      primary={props.primary}
      tabs={tabs}
      autoSaveId="og.session.dock"
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
      collapsed={props.dockCollapsed}
      onCollapsedChange={props.onDockCollapsedChange}
    />
  );
}

function SessionChatPane(props: {
  session: Session;
  timeline: TimelineItem[];
  initialLoading: boolean;
  approvals: PendingApproval[];
  failure: ReturnType<typeof summarizeSessionFailure> | null;
  /** The last turn ended budget_exhausted — the workspace is out of credits. */
  creditExhausted: boolean;
  goal: ReturnType<typeof useGoal>;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<boolean>;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onApprove: (approvalId: string) => Promise<void>;
  onReject: (approvalId: string) => Promise<void>;
  onReconnect: (item: AuthNeededItem) => void | Promise<void>;
  resolveProviderLogo: (providerDomain: string) => string | null;
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
        setApprovalSettled((current) => ({ ...current, [approvalId]: decision }));
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
  const composer = useComposer(props.session.id, {
    // Evaluated at send time: attachments and tools picked while the draft was
    // being written ride along with the message.
    sendExtras: () => ({
      resources: attachments.readyResources,
      tools: buildTools(undefined, [...selectedCapabilityToolIds]),
      model,
      reasoningEffort,
    }),
    onSent: () => attachments.clear(),
  });

  // Slash-command palette context: the operator controls (/goal, /clear,
  // /compact, /help) act on THIS session. Permissions come from the workspace
  // grant so the palette hides commands the operator can't run.
  const workspacePermissions = useMemo(
    () => context.accessContext.workspaceGrants.find((grant) => grant.workspaceId === props.session.workspaceId)?.permissions ?? [],
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
    [context.client, props.session.workspaceId, props.session.id, props.session.status, workspacePermissions],
  );

  const renderMessageText = useCallback((text: string, item: AgentMessageItem | UserMessageItem) => {
    if (item.kind === "user-message") {
      return <UserMessageBody workspaceId={props.session.workspaceId} item={item} />;
    }
    return (
      <div data-testid="assistant-markdown">
        <MarkdownText text={text} streaming={item.streaming} />
      </div>
    );
  }, [props.session.workspaceId]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {props.goal.goal ? (
        <div className="mx-auto flex w-full max-w-3xl shrink-0 items-center px-4 pt-3 sm:px-6">
          <GoalChip goal={props.goal} />
        </div>
      ) : null}

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
          {props.failure && (props.session.status === "failed" || (props.creditExhausted && props.session.status === "idle")) ? (
            <FailedSessionBanner failure={props.failure} creditExhausted={props.creditExhausted} workspaceId={props.session.workspaceId} />
          ) : null}
          <div data-testid="session-timeline" className="min-h-0 min-w-0 flex-1">
            <MessageTimeline
              className="h-full"
              items={props.timeline}
              status={props.session.status}
              renderMessageText={renderMessageText}
              onOpenSession={props.onOpenSession}
              onReconnect={props.onReconnect}
              resolveProviderLogo={props.resolveProviderLogo}
              hasOlder={props.hasOlder}
              loadingOlder={props.loadingOlder}
              onLoadOlder={() => void props.onLoadOlder()}
              emptyState={props.initialLoading ? (
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
              )}
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
                    <Button size="sm" disabled={busy} onClick={() => void decideApproval(approval.id, "approve")}>
                      {pending === "approve" ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                      {settled === "approve" ? "Approved" : "Approve"}
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => void decideApproval(approval.id, "reject")}>
                      {pending === "reject" ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                      {settled === "reject" ? "Rejected" : "Reject"}
                    </Button>
                  </div>
                </Notice>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <ConsoleComposer
            composer={composer}
            attachments={attachments}
            status={props.session.status}
            disabled={terminal}
            showDeliveryMode
            commandContext={commandContext}
            onClearView={props.onClearView}
            fileUploadsEnabled={context.clientConfig.fileUploads.enabled === true}
            placeholder={props.session.status === "cancelled"
              ? "This session was cancelled."
              : props.creditExhausted && (props.session.status === "failed" || props.session.status === "idle")
                // "Send a message to revive" is a dead end without credits —
                // the reply turn dies the same budget death.
                ? "Out of OpenGeni credits — add credits to continue."
                : props.session.status === "failed"
                  ? "This session failed — send a message to revive it."
                  : "Send a follow-up…"}
            controls={(
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
            )}
          />
        </div>
      </div>
    </section>
  );
}
