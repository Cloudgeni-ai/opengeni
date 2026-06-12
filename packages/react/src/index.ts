// @opengeni/react — hooks + styled components on @opengeni/sdk.
//
// Import the styles once in your Tailwind entry CSS:
//   @import "@opengeni/react/styles.css";
//   @source "../node_modules/@opengeni/react/src";

export type { SessionClientLike } from "./client";
export { OpenGeniProvider, useOpenGeni, useOpenGeniClient } from "./provider";
export type { ClientOverride, OpenGeniContextValue, OpenGeniProviderProps } from "./provider";

// Hooks
export { useSession } from "./hooks/use-session";
export type { UseSessionOptions, UseSessionResult } from "./hooks/use-session";
export { useSessionEvents } from "./hooks/use-session-events";
export type { SessionEventsConnectionState, UseSessionEventsOptions, UseSessionEventsResult } from "./hooks/use-session-events";
export { useComposer, composeSendInput, shouldSubmitOnKey } from "./hooks/use-composer";
export type { ComposerMode, ComposerSendExtras, ComposerState, UseComposerOptions } from "./hooks/use-composer";
export {
  useTurnQueue,
  isTurnQueueEvent,
  queueFromTurns,
  activeTurnFromTurns,
  applyTurnEdit,
  applyTurnReorder,
  applyTurnRemoval,
} from "./hooks/use-turn-queue";
export type { UseTurnQueueOptions, UseTurnQueueResult } from "./hooks/use-turn-queue";
export { useGoal, isGoalEvent } from "./hooks/use-goal";
export type { UseGoalOptions, UseGoalResult } from "./hooks/use-goal";
export { useSessionControl } from "./hooks/use-session-control";
export type { UseSessionControlOptions, UseSessionControlResult } from "./hooks/use-session-control";
export { useScheduledTasks } from "./hooks/use-scheduled-tasks";
export type { UseScheduledTasksOptions, UseScheduledTasksResult } from "./hooks/use-scheduled-tasks";
export { useWorkspaceSessions } from "./hooks/use-workspace-sessions";
export type { UseWorkspaceSessionsOptions, UseWorkspaceSessionsResult } from "./hooks/use-workspace-sessions";
export { useEnvironments } from "./hooks/use-environments";
export type { UseEnvironmentsOptions, UseEnvironmentsResult } from "./hooks/use-environments";
export { usePacks } from "./hooks/use-packs";
export type { UsePacksOptions, UsePacksResult } from "./hooks/use-packs";
export { useWorkspaces } from "./hooks/use-workspaces";
export type { UseWorkspacesOptions, UseWorkspacesResult } from "./hooks/use-workspaces";
export { useBillingUsage } from "./hooks/use-billing-usage";
export type { UseBillingUsageOptions, UseBillingUsageResult } from "./hooks/use-billing-usage";

// Timeline projection
export {
  buildTimeline,
  compactPayloadPreview,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  toolDisplayName,
} from "./timeline";
export type {
  AgentMessageItem,
  GoalItem,
  NoticeItem,
  ReasoningItem,
  SandboxItem,
  SessionStatusItem,
  TimelineGroup,
  TimelineItem,
  ToolCallItem,
  UserMessageItem,
  WorkerItem,
} from "./timeline";

// Components
export { ChatComposer } from "./components/chat-composer";
export type { ChatComposerProps } from "./components/chat-composer";
export { MessageTimeline } from "./components/message-timeline";
export type { MessageTimelineProps } from "./components/message-timeline";
export { SessionStatus, StatusDot, SESSION_STATUS_META } from "./components/session-status";
export type { SessionStatusProps, StatusDotProps, SessionStatusMeta } from "./components/session-status";
export { FleetTile, sessionDisplayTitle } from "./components/fleet-tile";
export type { FleetTileProps } from "./components/fleet-tile";

// Utilities
export { cn } from "./lib/cn";
export { formatRelativeTime, stringifyPayload, truncate, tryParseJson } from "./lib/format";
