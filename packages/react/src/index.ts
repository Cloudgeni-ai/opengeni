// oxlint-disable-next-line typescript/triple-slash-reference -- package consumers must load the ambient type for this optional untyped peer without emitting a runtime import.
/// <reference path="./types/external.d.ts" />

// @opengeni/react — hooks + styled components on @opengeni/sdk.
//
// Import the styles once in your Tailwind entry CSS:
//   @import "@opengeni/react/styles.css";
//   @source "../node_modules/@opengeni/react/src";

export type { SessionClientLike } from "./client";
export { OpenGeniProvider, useOpenGeni, useOpenGeniClient } from "./provider";
export type { ClientOverride, OpenGeniContextValue, OpenGeniProviderProps } from "./provider";

// Hooks
export { useSession, isTitleEvent } from "./hooks/use-session";
export type { UseSessionOptions, UseSessionResult } from "./hooks/use-session";
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
export { useFileAttachments } from "./hooks/use-file-attachments";
export type {
  FileAttachment,
  UseFileAttachmentsOptions,
  UseFileAttachmentsResult,
} from "./hooks/use-file-attachments";
export { useTurnQueue, isTurnQueueEvent } from "./hooks/use-turn-queue";
export type {
  QueueMutationKind,
  UseTurnQueueOptions,
  UseTurnQueueResult,
} from "./hooks/use-turn-queue";
export { QueueSurface } from "./components/queue-surface";
export type { QueueSurfaceProps } from "./components/queue-surface";
export { OPEN_WORKSTREAM_CONTROL_EVENT } from "./components/chat-composer";
export { useGoal, isGoalEvent } from "./hooks/use-goal";
export type { UseGoalOptions, UseGoalResult } from "./hooks/use-goal";
export { useSessionControl } from "./hooks/use-session-control";
export type {
  UseSessionControlOptions,
  UseSessionControlResult,
} from "./hooks/use-session-control";
export { useScheduledTasks } from "./hooks/use-scheduled-tasks";
export type {
  UseScheduledTasksOptions,
  UseScheduledTasksResult,
} from "./hooks/use-scheduled-tasks";
export { useWorkspaceSessions } from "./hooks/use-workspace-sessions";
export type {
  UseWorkspaceSessionsOptions,
  UseWorkspaceSessionsResult,
} from "./hooks/use-workspace-sessions";
export { useSessionLineage, isLineageRefreshEvent } from "./hooks/use-session-lineage";
export type {
  UseSessionLineageOptions,
  UseSessionLineageResult,
} from "./hooks/use-session-lineage";
export { useVariableSets, useEnvironments } from "./hooks/use-environments";
export type {
  UseVariableSetsOptions,
  UseVariableSetsResult,
  UseEnvironmentsOptions,
  UseEnvironmentsResult,
} from "./hooks/use-environments";
export { useRigs, useRig, useRigVersions, useRigChanges } from "./hooks/use-rigs";
export type {
  UseRigsOptions,
  UseRigsResult,
  UseRigOptions,
  UseRigResult,
  UseRigVersionsOptions,
  UseRigVersionsResult,
  UseRigChangesOptions,
  UseRigChangesResult,
} from "./hooks/use-rigs";
export { usePacks } from "./hooks/use-packs";
export type { UsePacksOptions, UsePacksResult } from "./hooks/use-packs";
export { useWorkspaces } from "./hooks/use-workspaces";
export type { UseWorkspacesOptions, UseWorkspacesResult } from "./hooks/use-workspaces";
export { useBillingUsage } from "./hooks/use-billing-usage";
export type { UseBillingUsageOptions, UseBillingUsageResult } from "./hooks/use-billing-usage";
export { useAvailableModels } from "./hooks/use-available-models";
export type {
  UseAvailableModelsOptions,
  UseAvailableModelsResult,
} from "./hooks/use-available-models";

// Sandbox surfacing (Phase 5): capability negotiation + terminal/files/diff/desktop
export { useSessionCapabilities } from "./hooks/use-session-capabilities";
export type {
  SessionCapabilitiesState,
  UseSessionCapabilitiesOptions,
  UseSessionCapabilitiesResult,
} from "./hooks/use-session-capabilities";
export { useDesktopStream } from "./hooks/use-desktop-stream";
export type { UseDesktopStreamOptions, UseDesktopStreamResult } from "./hooks/use-desktop-stream";
export { useRelayFrameStream } from "./hooks/use-relay-frame-stream";
export type {
  DesktopWebSocketFactory,
  DesktopWebSocketLike,
  UseRelayFrameStreamOptions,
  UseRelayFrameStreamResult,
} from "./hooks/use-relay-frame-stream";
export { useTerminalStream } from "./hooks/use-terminal-stream";
export type {
  TerminalStreamStatus,
  UseTerminalStreamOptions,
  UseTerminalStreamResult,
} from "./hooks/use-terminal-stream";
export { useSandboxTerminal } from "./hooks/use-sandbox-terminal";
export type {
  TerminalChunk,
  UseSandboxTerminalOptions,
  UseSandboxTerminalResult,
} from "./hooks/use-sandbox-terminal";
export {
  CapturedFileUnavailableError,
  FileWriteConflictError,
  useSandboxFiles,
} from "./hooks/use-sandbox-files";
export type {
  CapturedFileUnavailableReason,
  FileTreeNode,
  FileTreeStatus,
  SandboxWriteFileOptions,
  UseSandboxFilesOptions,
  UseSandboxFilesResult,
} from "./hooks/use-sandbox-files";
export { useSandboxGit } from "./hooks/use-sandbox-git";
export type {
  SandboxGitFileDiff,
  UseSandboxGitOptions,
  UseSandboxGitResult,
} from "./hooks/use-sandbox-git";

// Workbench v2 turn-end capture (the cold-paint data layer)
export { useWorkspaceCapture } from "./hooks/use-workspace-capture";
export type {
  UseWorkspaceCaptureOptions,
  UseWorkspaceCaptureResult,
} from "./hooks/use-workspace-capture";
export { useWorkspaceEdit } from "./hooks/use-workspace-edit";
export type {
  UseWorkspaceEditOptions,
  UseWorkspaceEditResult,
  WorkspaceEditConflict,
  WorkspaceEditState,
} from "./hooks/use-workspace-edit";
export { deriveMachineChip, formatAsOf, useMachineChip } from "./hooks/use-machine-chip";
export type {
  DeriveMachineChipInput,
  MachineChip,
  MachineChipState,
  UseMachineChipOptions,
} from "./hooks/use-machine-chip";

// Pending-approvals projection
export { approvalsFromRequiresAction, projectPendingApprovals } from "./approvals";
export type { PendingApproval } from "./approvals";

// Timeline projection
export {
  buildTimeline,
  creditExhaustedFromEvents,
  extractSessionRef,
  groupTimeline,
  sessionStatusFromEvents,
  toolDisplayName,
} from "./timeline";
export type {
  ActivityItem,
  AgentMessageItem,
  AuthNeededItem,
  GoalItem,
  NoticeItem,
  ReasoningItem,
  SandboxItem,
  SessionStatusItem,
  TimelineGroup,
  TimelineItem,
  TurnEndItem,
  ToolCallItem,
  UserMessageItem,
  WorkerItem,
} from "./timeline";

// Tool-renderer registry + the per-tool renderers (the timeline's extension API)
export {
  createDefaultToolRegistry,
  createToolRegistry,
  defaultToolRegistry,
  rawTypeOf,
} from "./timeline";
export type {
  CreateToolRegistryOptions,
  ToolRegistry,
  ToolRegistryEntry,
  ToolRenderer,
  ToolRendererProps,
} from "./timeline";

// Timeline rendering primitives + the screenshot lightbox (compose custom renderers)
export {
  ActivityDisclosure,
  ActivityRail,
  BodyNote,
  DisclosureDefaultsProvider,
  LightboxProvider,
  MediaEmpty,
  MediaSkeleton,
  PayloadBlock,
  ScreenshotFigure,
  TermBlock,
  Thumbnail,
  TurnSummary,
  useLightbox,
  useLightboxOptional,
} from "./timeline";
export type {
  ActivityDisclosureProps,
  ActivityRailProps,
  DisclosureChip,
  TurnOutcome,
  TurnSummaryProps,
} from "./timeline";

// Pure provider-shape parsers (exec banner, V4A diff, secret redaction, …)
export {
  applyPatchOps,
  controlCaret,
  execTruncated,
  isApplyPatch,
  isExecSessionLostBanner,
  looksBinary,
  parseExecBannerSessionId,
  parseToolArgs,
  redactSecrets,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
  v4aToGitFileDiff,
} from "./timeline";
export type { ApplyPatchOperation } from "./timeline";

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
export { defaultChatComposerMessages } from "./components/composer";
export type { ChatComposerMessages } from "./components/composer";
export { ModelPicker } from "./components/model-picker";
export type { ModelPickerProps } from "./components/model-picker";
export { MessageTimeline, TimelineRow } from "./components/message-timeline";
export type { MessageTimelineProps } from "./components/message-timeline";
export { Markdown } from "./components/markdown";
export type { MarkdownProps } from "./components/markdown";
export { SessionStatus, StatusDot, SESSION_STATUS_META } from "./components/session-status";
export type {
  SessionStatusProps,
  StatusDotProps,
  SessionStatusMeta,
} from "./components/session-status";
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
export { PierreFile } from "./components/pierre-file";
export type { PierreFileProps } from "./components/pierre-file";
export { CodeEditor, languageForPath } from "./components/code-editor";
export type { CodeEditorProps } from "./components/code-editor";
export { SandboxFiles } from "./components/sandbox-files";
export type { SandboxFilesProps } from "./components/sandbox-files";
export { DesktopViewer } from "./components/desktop-viewer";
export type { DesktopViewerProps } from "./components/desktop-viewer";
export { WorkspaceDock } from "./components/workspace-dock";
export type { WorkspaceDockProps, WorkspaceTab } from "./components/workspace-dock";

// The embeddable dock "brain" (Workbench v2, M4): the whole session workspace as
// one component + the tab-building hook + the pre-paint default-tab helper.
export {
  SandboxWorkspace,
  useSandboxWorkspaceTabs,
  initialWorkspaceTab,
  WORKBENCH_TAB_CHANGES,
  WORKBENCH_TAB_FILES,
} from "./components/sandbox-workspace";
export type {
  SandboxWorkspaceProps,
  UseSandboxWorkspaceTabsOptions,
  UseSandboxWorkspaceTabsResult,
  WorkspaceMachine,
  WorkspaceNotification,
} from "./components/sandbox-workspace";

// Connected-machine UI moved to the "@opengeni/react/machines" subpath; re-exported
// here for back-compat (#144).
export * from "./machines";
// Multi-account Codex (P1): accounts list + active-switch hook.
export { useCodexAccounts, isCodexAccountEvent } from "./hooks/use-codex-accounts";
export type {
  CodexAccountsClientLike,
  UseCodexAccountsOptions,
  UseCodexAccountsResult,
} from "./hooks/use-codex-accounts";

// Sandbox helpers
export { gitFileDiffToPatch } from "./lib/git-patch";
export { xtermThemeFromTokens } from "./lib/xterm-theme";

// Utilities
export { cn } from "./lib/cn";
export {
  CREDIT_EXHAUSTION_MESSAGE,
  formatBytes,
  formatRelativeTime,
  humanizeFailureReason,
  isCreditExhaustion,
  stringifyPayload,
  truncate,
  tryParseJson,
} from "./lib/format";
