import { useCallback, useMemo } from "react";
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
} from "@opengeni/react/session";
import { useNativeFileAttachments, type NativeFileAttachmentsResult } from "./attachments";
import { useOpenGeniReactNativeEnvironment } from "./environment";
import {
  useNativeReadAcknowledgement,
  type SessionAttentionClientLike,
} from "./read-acknowledgement";

export type OpenGeniNativeSessionClient = SessionClientLike &
  SessionReadClientLike &
  HumanInputSessionClientLike &
  SessionMcpApprovalPolicyClientLike &
  FileAttachmentClientLike &
  SessionAttentionClientLike &
  GoalClientLike &
  SessionLineageClientLike;

export interface OpenGeniNativeSessionController {
  sessionId: string;
  workspaceId: string;
  session: ReturnType<typeof useSession>;
  events: SessionEvent[];
  timeline: TimelineItem[];
  timelineGroups: TimelineGroup[];
  connectionState: ReturnType<typeof useSessionEvents>["connectionState"];
  sessionStatus: SessionStatus | null;
  initialLoading: boolean;
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
  lineage: ReturnType<typeof useSessionLineage>;
  active: boolean;
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

export function useOpenGeniNativeSession(input: {
  client: OpenGeniNativeSessionClient;
  workspaceId: string;
  sessionId: string;
  mcpApprovalPolicyServerId?: string;
}): OpenGeniNativeSessionController {
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
    // at once instead of flashing as a chat bubble before it is queued.
    sendDestination: () =>
      (session.session?.activeTurnId ?? null) !== null || queue.queue.length > 0 ? "queue" : "chat",
    sendExtras: () => ({ resources: attachments.readyResources }),
    sendBlocked: () => attachments.hasUnresolved,
    onSent: () => attachments.clear(),
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
  const timelineGroups = useMemo(() => groupTimeline(events.timeline), [events.timeline]);
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

  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    session,
    events: events.events,
    timeline: events.timeline,
    timelineGroups,
    connectionState: events.connectionState,
    sessionStatus: events.sessionStatus ?? session.session?.status ?? null,
    initialLoading: events.initialLoading || session.loading,
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
    runActive: sessionRunActive(events.sessionStatus ?? session.session?.status ?? null),
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
