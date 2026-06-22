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
export { useFileAttachments } from "./hooks/use-file-attachments";
export type { FileAttachment, UseFileAttachmentsOptions, UseFileAttachmentsResult } from "./hooks/use-file-attachments";
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
export { useAvailableModels } from "./hooks/use-available-models";
export type { UseAvailableModelsOptions, UseAvailableModelsResult } from "./hooks/use-available-models";

// Sandbox surfacing (Phase 5): capability negotiation + terminal/files/diff/desktop
export { useSessionCapabilities } from "./hooks/use-session-capabilities";
export type {
  SessionCapabilitiesState,
  UseSessionCapabilitiesOptions,
  UseSessionCapabilitiesResult,
} from "./hooks/use-session-capabilities";
export { useDesktopStream } from "./hooks/use-desktop-stream";
export type { UseDesktopStreamOptions, UseDesktopStreamResult } from "./hooks/use-desktop-stream";
export { useSandboxTerminal } from "./hooks/use-sandbox-terminal";
export type {
  TerminalChunk,
  UseSandboxTerminalOptions,
  UseSandboxTerminalResult,
} from "./hooks/use-sandbox-terminal";
export { useSandboxFiles } from "./hooks/use-sandbox-files";
export type {
  FileTreeNode,
  FileTreeStatus,
  UseSandboxFilesOptions,
  UseSandboxFilesResult,
} from "./hooks/use-sandbox-files";
export { useSandboxGit } from "./hooks/use-sandbox-git";
export type { UseSandboxGitOptions, UseSandboxGitResult } from "./hooks/use-sandbox-git";

// Pending-approvals projection
export { approvalsFromRequiresAction, projectPendingApprovals } from "./approvals";
export type { PendingApproval } from "./approvals";

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

// Slash-command palette (registry + UI + hook)
export {
  argHint,
  defaultCommands,
  filterCommands,
  firstMissingRequiredArg,
  hasPermission,
  matchCommand,
  parseCommandLine,
} from "./commands/registry";
export type { ParsedCommandLine } from "./commands/registry";
export type {
  CommandContext,
  CommandResult,
  Notice,
  SlashArg,
  SlashCommand,
} from "./commands/types";
export { useSlashCommands } from "./hooks/use-slash-commands";
export type {
  ConfirmState,
  SlashCommandContext,
  SlashCommandHandlers,
  UseSlashCommandsOptions,
  UseSlashCommandsResult,
} from "./hooks/use-slash-commands";
export { CommandPalette } from "./components/command-palette";
export type { CommandPaletteProps } from "./components/command-palette";

// Components
export { ChatComposer } from "./components/chat-composer";
export type { ChatComposerProps } from "./components/chat-composer";
export { ModelPicker } from "./components/model-picker";
export type { ModelPickerProps } from "./components/model-picker";
export { MessageTimeline } from "./components/message-timeline";
export type { MessageTimelineProps } from "./components/message-timeline";
export { Markdown } from "./components/markdown";
export type { MarkdownProps } from "./components/markdown";
export { SessionStatus, StatusDot, SESSION_STATUS_META } from "./components/session-status";
export type { SessionStatusProps, StatusDotProps, SessionStatusMeta } from "./components/session-status";
export { FleetTile, sessionDisplayTitle } from "./components/fleet-tile";
export type { FleetTileProps } from "./components/fleet-tile";

// Sandbox surfacing components (Phase 5)
export { SandboxTerminal } from "./components/sandbox-terminal";
export type { SandboxTerminalProps, XtermTheme } from "./components/sandbox-terminal";
export { FileBrowser } from "./components/file-browser";
export type { FileBrowserProps } from "./components/file-browser";
export { DiffView } from "./components/diff-view";
export type { DiffViewProps, DiffTheme } from "./components/diff-view";
export { PierreDiff } from "./components/pierre-diff";
export type { PierreDiffProps } from "./components/pierre-diff";
export { SandboxFiles } from "./components/sandbox-files";
export type { SandboxFilesProps } from "./components/sandbox-files";
export { DesktopViewer } from "./components/desktop-viewer";
export type { DesktopViewerProps } from "./components/desktop-viewer";
export { WorkspaceDock } from "./components/workspace-dock";
export type { WorkspaceDockProps, WorkspaceTab } from "./components/workspace-dock";

// Sandbox helpers
export { gitFileDiffToPatch } from "./lib/git-patch";
export { xtermThemeFromTokens } from "./lib/xterm-theme";

// Utilities
export { cn } from "./lib/cn";
export { formatBytes, formatRelativeTime, stringifyPayload, truncate, tryParseJson } from "./lib/format";
