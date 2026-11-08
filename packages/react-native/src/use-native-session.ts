import type { ChatClient, OpenGeniClient } from "@opengeni/sdk";
import { useCallback, useMemo } from "react";
import { useOpenGeniText } from "@opengeni/react/messages";
import type { SessionEvent, SessionStatus } from "@opengeni/sdk";
import {
  groupTimeline,
  projectPendingApprovals,
  useComposer,
  useGoal,
  useHumanInputRequests,
  useSession,
  useSessionControl,
  useSessionEvents,
  useSessionLineage,
  useSessionMcpApprovalPolicy,
  useTurnQueue,
  type ComposerBusySend,
  type FileAttachmentClientLike,
  type GoalClientLike,
  type HumanInputSessionClientLike,
  type PendingApproval,
  type SessionClientLike,
  type SessionMcpApprovalPolicyClientLike,
  type SessionLineageClientLike,
  type SessionReadClientLike,
  type TimelineGroup,
  type TimelineItem,
  type UseSessionResult,
  type UseSessionLineageResult,
} from "@opengeni/react/session";
import {
  promptSendDestination,
  sessionAdmissionBlocked,
  sessionArchived,
  type SessionDisplayStatus,
} from "@opengeni/react/timeline-model";
import {
  nativeComposerAttachmentCallbacks,
  useNativeFileAttachments,
  type NativeFileAttachmentsResult,
} from "./attachments";
import { useOpenGeniReactNativeEnvironment } from "./environment";
import {
  useNativeReadAcknowledgement,
  type SessionAttentionClientLike,
} from "./read-acknowledgement";

export type OpenGeniNativeSessionClient<Client extends ChatClient = OpenGeniClient> =
  SessionClientLike<Client> &
    SessionReadClientLike<Client> &
    HumanInputSessionClientLike<Client> &
    SessionMcpApprovalPolicyClientLike<Client> &
    FileAttachmentClientLike<Client> &
    SessionAttentionClientLike &
    GoalClientLike<Client> &
    SessionLineageClientLike<Client>;

export interface OpenGeniNativeSessionController<Client extends ChatClient = OpenGeniClient> {
  sessionId: string;
  workspaceId: string;
  /**
   * The client this controller reads and writes through. Surfaces drawn from
   * the controller pass it to shared hooks explicitly: the native screens do
   * not require an `OpenGeniProvider` above them.
   */
  client: OpenGeniNativeSessionClient<Client>;
  session: UseSessionResult<Awaited<ReturnType<Client["getSession"]>>>;
  events: SessionEvent[];
  timeline: TimelineItem[];
  timelineGroups: TimelineGroup[];
  connectionState: ReturnType<typeof useSessionEvents>["connectionState"];
  sessionStatus: SessionStatus | null;
  initialLoading: boolean;
  initialHistoryReady?: boolean | undefined;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<boolean>;
  queue: ReturnType<typeof useTurnQueue>;
  composer: ReturnType<typeof useComposer>;
  attachments: NativeFileAttachmentsResult;
  approvals: PendingApproval[];
  control: ReturnType<typeof useSessionControl>;
  humanInput: ReturnType<typeof useHumanInputRequests>;
  mcpApprovalPolicy: ReturnType<typeof useSessionMcpApprovalPolicy>;
  /** The session goal and its pause/resume control (web session chrome). */
  goal: ReturnType<typeof useGoal>;
  /** Spawned sub-agent sessions, refreshed by spawn and completion events. */
  lineage: UseSessionLineageResult<Awaited<ReturnType<Client["getSessionLineage"]>>>;
  active: boolean;
  /**
   * The runtime refused to start the next turn (an admission block). Nothing
   * is asked of the person; Resume rechecks and starts the kept work again.
   */
  admissionBlocked: boolean;
  /**
   * `sessionStatus` as a person should read it: `blocked` instead of "Waiting
   * on you", and `archived` for an archived chat (never its `cancelled` status).
   */
  displayStatus: SessionDisplayStatus | null;
  /** The chat is archived: read-only, continuable in a new chat. */
  archived: boolean;
  runActive: boolean;
  error: Error | null;
  refresh(): Promise<void>;
}

function sessionRunActive(status: SessionStatus | null): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "recovering" ||
    status === "waiting_capacity" ||
    status === "requires_action"
  );
}

/** The newest loaded status change, and whether the runtime blocked admission there. */
function latestStatusChange(
  events: readonly SessionEvent[],
): { sequence: number; blocked: boolean } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "session.status.changed") continue;
    return {
      sequence: event.sequence,
      blocked: (event.payload as { code?: unknown } | undefined)?.code === "admission_blocked",
    };
  }
  return null;
}

type NativeSessionOptions<Client extends ChatClient = OpenGeniClient> = {
  client: OpenGeniNativeSessionClient<Client>;
  workspaceId: string;
  sessionId: string;
  mcpApprovalPolicyServerId?: string;
  /**
   * What an ordinary Send does while the agent is working: `queue` (default)
   * runs it after the current turn; `steer` has the agent read it within
   * seconds (a reply still being written stops; running tools are not cut off).
   *
   * Under `steer` the screen has one Send and nothing to learn: no Queue
   * choice beside it and no Queue or Steer words. Set `offerQueue` to also
   * offer Queue beside Send.
   */
  busySend?: ComposerBusySend;
  /** Under `busySend: "steer"`, also offer Queue beside Send while the agent works. */
  offerQueue?: boolean;
};

export function useOpenGeniNativeSession(
  input: NativeSessionOptions,
): OpenGeniNativeSessionController;
export function useOpenGeniNativeSession(
  input: NativeSessionOptions<ChatClient>,
): OpenGeniNativeSessionController<ChatClient>;
export function useOpenGeniNativeSession(
  input: NativeSessionOptions<ChatClient>,
): OpenGeniNativeSessionController<ChatClient> {
  const environment = useOpenGeniReactNativeEnvironment();
  const events = useSessionEvents(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
  });
  const session = useSession(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
    events: events.events,
  });
  const queue = useTurnQueue(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
    events: events.events,
  });
  const attachments = useNativeFileAttachments({
    client: input.client,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    files: environment.adapters.files,
    crypto: environment.adapters.crypto,
  });
  const composer = useComposer(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    events: events.events,
    effectiveControl: queue.effectiveControl,
    // As on web: while a turn runs or prompts wait, a Send shows in the queue
    // at once instead of flashing as a chat bubble before it is queued. A turn
    // parked on a usage limit is replaced by the Send, which starts at once.
    sendDestination: () =>
      promptSendDestination({
        status: session.session?.status,
        activeTurnId: session.session?.activeTurnId,
        queuedPrompts: queue.queue.length,
        admissionBlock: session.session?.admissionBlock,
      }),
    busySend: input.busySend,
    offerQueue: input.offerQueue,
    sendExtras: () => ({ resources: attachments.readyResources }),
    sendBlocked: () => attachments.hasUnresolved,
    ...nativeComposerAttachmentCallbacks(attachments),
  });
  const control = useSessionControl(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
  });
  const humanInput = useHumanInputRequests(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
    events: events.events,
  });
  const goal = useGoal(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
    events: events.events,
  });
  // As on web: events refresh on spawn and completion; the poll catches a
  // child's own status changes, which emit nothing on this feed.
  const lineage = useSessionLineage(input.sessionId, {
    client: input.client,
    workspaceId: input.workspaceId,
    enabled: environment.active,
    events: events.events,
    pollIntervalMs: 30_000,
  });
  const approvals = useMemo(() => projectPendingApprovals(events.events), [events.events]);
  const t = useOpenGeniText();
  const timelineGroups = useMemo(() => groupTimeline(t, events.timeline), [t, events.timeline]);
  useNativeReadAcknowledgement({
    client: input.client,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    session: session.session ?? null,
    events: events.events,
    active: environment.active,
  });
  const mcpApprovalPolicy = useSessionMcpApprovalPolicy(
    input.sessionId,
    input.mcpApprovalPolicyServerId,
    {
      client: input.client,
      workspaceId: input.workspaceId,
      events: events.events,
      enabled: environment.active && Boolean(input.mcpApprovalPolicyServerId),
    },
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      session.refresh(),
      queue.refresh(),
      humanInput.refresh(),
      events.jumpToLatest(),
      mcpApprovalPolicy.refresh(),
    ]);
  }, [events, humanInput, mcpApprovalPolicy, queue, session]);

  const detail = session.session ?? null;
  const latestChange = latestStatusChange(events.events);
  // A recheck (Resume) clears an admission block and restores the earlier
  // status without a status event, so once the detail read is as fresh as the
  // block event it is the truth. Until it lands, the block event is.
  const detailCurrent =
    detail !== null &&
    latestChange?.blocked === true &&
    detail.lastSequence >= latestChange.sequence;
  const sessionStatus = detailCurrent
    ? detail.status
    : (events.sessionStatus ?? detail?.status ?? null);
  const admissionBlocked = detailCurrent
    ? sessionAdmissionBlocked(detail)
    : sessionStatus === "requires_action" &&
      (latestChange?.blocked === true || (detail !== null && sessionAdmissionBlocked(detail)));
  const archived = detail !== null && sessionArchived(detail);

  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    client: input.client,
    session,
    events: events.events,
    timeline: events.timeline,
    timelineGroups,
    connectionState: events.connectionState,
    sessionStatus,
    admissionBlocked,
    archived,
    displayStatus: archived ? "archived" : admissionBlocked ? "blocked" : sessionStatus,
    initialLoading: events.initialLoading || session.loading,
    initialHistoryReady: events.initialHistoryReady,
    hasOlder: events.hasOlder,
    loadingOlder: events.loadingOlder,
    loadOlder: events.loadOlder,
    queue,
    composer,
    attachments,
    approvals,
    control,
    humanInput,
    mcpApprovalPolicy,
    goal,
    lineage,
    active: environment.active,
    // A blocked session runs nothing: the composer offers Send, not Stop.
    runActive: !admissionBlocked && sessionRunActive(sessionStatus),
    error:
      events.error ??
      session.error ??
      queue.error ??
      queue.mutationError ??
      composer.error ??
      composer.draftConflict ??
      control.error ??
      humanInput.error ??
      humanInput.mutationError ??
      mcpApprovalPolicy.error,
    refresh,
  };
}
