// @opengeni/react/session — session state and pure timeline projection.
//
// This entry deliberately excludes styled components, workbench surfaces, CSS,
// and their optional peers. Hosts keep OpenGeni's session semantics while
// rendering their own product UI.

export type { EmbeddedSessionClientLike as SessionClientLike } from "./client";
export type { EmbeddedSessionClientOverride as ClientOverride } from "./provider";

export { useSessionEvents } from "./hooks/use-session-events";
export type {
  SessionEventsConnectionState,
  UseSessionEventsOptions,
  UseSessionEventsResult,
} from "./hooks/use-session-events";
export {
  useComposer,
  composeSendInput,
  shouldSteerOnKey,
  shouldSubmitOnKey,
  FILE_ONLY_MESSAGE_TEXT,
} from "./hooks/use-composer";
export type { ComposerSendExtras, ComposerState, UseComposerOptions } from "./hooks/use-composer";
export { useTurnQueue, isTurnQueueEvent } from "./hooks/use-turn-queue";
export type {
  QueueMutationKind,
  UseTurnQueueOptions,
  UseTurnQueueResult,
} from "./hooks/use-turn-queue";
export { useSessionControl } from "./hooks/use-session-control";
export type {
  UseSessionControlOptions,
  UseSessionControlResult,
} from "./hooks/use-session-control";

export { approvalsFromRequiresAction, projectPendingApprovals } from "./approvals";
export type { PendingApproval } from "./approvals";

export {
  buildTimeline,
  creditExhaustedFromEvents,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  toolDisplayName,
} from "./timeline/projection";
export type {
  ActivityItem,
  AgentMessageItem,
  AuthNeededItem,
  GoalItem,
  MemoryItem,
  NoticeItem,
  ReasoningItem,
  SandboxItem,
  SessionStatusItem,
  TimelineGroup,
  TimelineItem,
  TurnOutcome,
  ToolCallItem,
  TurnEndItem,
  UserMessageItem,
  WorkerCompletionItem,
  WorkerItem,
} from "./timeline/types";
