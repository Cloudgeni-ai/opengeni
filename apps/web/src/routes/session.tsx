// The session view — the console's centerpiece. Live timeline on the left;
// the session rail (turn queue + goal, or debug inspector) on the right.
// The composer is queue-by-default with explicit steer; failed sessions stay
// honest (reason + re-dispatch history) and revivable from the same composer.
import {
  MessageTimeline,
  projectPendingApprovals,
  useComposer,
  useFileAttachments,
  useGoal,
  useSession,
  useSessionEvents,
  useTurnQueue,
  type AgentMessageItem,
  type PendingApproval,
  type TimelineItem,
  type UserMessageItem,
} from "@opengeni/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import { isTerminalSessionStatus, projectSessionTimeline, summarizeSessionFailure } from "@/lib/events";
import { isMidTurn } from "@/lib/queue";
import { buildTools } from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

export function SessionRoute({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();

  // Session record + live event log via @opengeni/react. The stream replays
  // the full durable log (after=0), reconnects with resume-by-sequence, and
  // carries the live session status.
  const { session: fetchedSession, loading, error: loadError } = useSession(sessionId);
  const { events, sessionStatus, connectionState, error: streamError } = useSessionEvents(sessionId);
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
    const projected = projectSessionTimeline(session, visibleEvents);
    // projectSessionTimeline falls back to the session's initial message when
    // the projection is empty; after a clear-view that fallback would resurrect
    // the very first message, so suppress it once the view has been cleared.
    return viewClearedAfter !== null && visibleEvents.length === 0 ? [] : projected;
  }, [session, visibleEvents, viewClearedAfter]);
  // Only approvals still awaiting a decision: the durable log replays every
  // historical `session.requiresAction`, so subtract decisions and finished
  // turns instead of rendering decided approvals as live buttons forever.
  const approvals = useMemo(() => projectPendingApprovals(events), [events]);
  const failure = useMemo(
    () => session?.status === "failed" ? summarizeSessionFailure(events, session.status) : null,
    [events, session?.status],
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

  return (
    <div className={cn("grid min-h-0 w-full min-w-0 flex-1 grid-cols-1 overflow-hidden", context.inspectorOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(0,390px)]")}>
      <SessionChatPane
        session={session}
        timeline={timeline}
        approvals={approvals}
        failure={failure}
        goal={goal}
        onClearView={clearView}
        onOpenSession={(nextSessionId) => void navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: nextSessionId } })}
        onNewSession={() => void navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId } })}
        onApprove={(approvalId) => void approve(approvalId, "approve")}
        onReject={(approvalId) => void approve(approvalId, "reject")}
      />

      {context.inspectorOpen ? (
        <aside className="min-h-0 w-full min-w-0 overflow-hidden border-t border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 lg:border-t-0 lg:border-l">
          <Tabs defaultValue="run" className="flex h-full min-h-0 min-w-0 flex-col gap-0 overflow-hidden">
            <div className="min-w-0 border-b border-[color:var(--color-border)] px-2 py-2">
              <TabsList className="grid h-8 w-full min-w-0 grid-cols-2 rounded-md bg-[color:var(--color-bg)] p-1">
                <TabsTrigger value="run" className="h-6 min-w-0 rounded px-1 text-[11px]">Run</TabsTrigger>
                <TabsTrigger value="debug" className="h-6 min-w-0 rounded px-1 text-[11px]">Debug</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="run" className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full min-w-0">
                <div className="min-w-0 space-y-5 p-3">
                  <QueueRail queue={queue} sessionStatus={session.status} />
                  <GoalCard goal={goal} events={events} />
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="debug" className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <SessionInspector session={session} events={events} connectionState={connectionState} />
            </TabsContent>
          </Tabs>
        </aside>
      ) : null}
    </div>
  );

  async function approve(approvalId: string, decision: "approve" | "reject") {
    try {
      await context.client.sendApprovalDecision(workspaceId, sessionId, { approvalId, decision });
    } catch (error) {
      toast.error("Failed to submit the approval decision", { description: error instanceof Error ? error.message : String(error) });
    }
  }
}

function SessionChatPane(props: {
  session: Session;
  timeline: TimelineItem[];
  approvals: PendingApproval[];
  failure: ReturnType<typeof summarizeSessionFailure> | null;
  goal: ReturnType<typeof useGoal>;
  /** Reset the local timeline view (the /clear-view command target). */
  onClearView: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  const context = useAppContext();
  const terminal = isTerminalSessionStatus(props.session.status);
  // Workspace-scoped: the provider (mounted on the workspace route) supplies
  // the workspaceId, so the hook needs no positional argument.
  const attachments = useFileAttachments();
  const { selectedCapabilityToolIds, model, reasoningEffort } = context;
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

  // Steering needs something to interrupt: when the turn ends, fall back to
  // the queue default so a stale steer toggle cannot surprise a later send.
  useEffect(() => {
    if (!isMidTurn(props.session.status) && composer.mode !== "queue") {
      composer.setMode("queue");
    }
  }, [props.session.status, composer.mode, composer.setMode]);

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
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
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
          {props.session.status === "failed" && props.failure ? <FailedSessionBanner failure={props.failure} /> : null}
          <div data-testid="session-timeline" className="min-h-0 min-w-0 flex-1">
            <MessageTimeline
              className="h-full"
              items={props.timeline}
              status={props.session.status}
              renderMessageText={renderMessageText}
              onOpenSession={props.onOpenSession}
              emptyState={(
                <div className="grid min-h-[24rem] place-items-center rounded-lg border border-dashed border-[color:var(--color-border)] text-sm text-[color:var(--color-fg-subtle)]">
                  Waiting for session activity
                </div>
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
            {props.approvals.map((approval) => (
              <div key={approval.id} className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="text-sm font-medium">{approval.name}</div>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-[color:var(--color-bg)] p-3 text-xs text-[color:var(--color-fg-muted)]">
                  {JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2)}
                </pre>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" onClick={() => props.onApprove(approval.id)}>
                    <CheckIcon className="size-3.5" />
                    Approve
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => props.onReject(approval.id)}>
                    <XIcon className="size-3.5" />
                    Reject
                  </Button>
                </div>
              </div>
            ))}
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
            placeholder={terminal
              ? `Session is ${props.session.status}.`
              : props.session.status === "failed"
                ? "Send a message to revive this session..."
                : "Send a follow-up..."}
            controls={(
              <div className="flex min-w-0 items-center gap-1.5">
                <ModelPicker
                  config={context.clientConfig}
                  model={context.model}
                  effort={context.reasoningEffort}
                  disabled={composer.sending}
                  onModelChange={context.setModel}
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
