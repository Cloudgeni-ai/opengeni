// @opengeni/react/session-ui — styled surfaces used by the session route.
// Keep these separate from the hook-only session entry and the broad root barrel
// so session hosts do not pay for unrelated React surfaces.
export { HumanInputForm } from "./components/human-input-form";
export type {
  HumanInputAnswerDraft,
  HumanInputFormMessages,
  HumanInputFormProps,
} from "./components/human-input-form";
export { HumanInputSurface } from "./components/human-input-surface";
export { ApprovalSurface } from "./components/approval-surface";
export type { ApprovalSurfaceProps, ApprovalSurfaceMessages } from "./components/approval-surface";
export type { HumanInputSurfaceProps } from "./components/human-input-surface";
export { MessageTimeline, TimelineRow } from "./components/message-timeline";
export type { MessageTimelineProps } from "./components/message-timeline";
export { createOlderHistoryLoadReceipt } from "./older-history";
export type { OlderHistoryLoader, OlderHistoryLoadReceipt } from "./older-history";
export { UserMessageBody, userMessageLikelyNeedsDisclosure } from "./components/user-message-body";
export type { UserMessageBodyProps } from "./components/user-message-body";
export { BUILT_IN_TURN_SUMMARY_FACET_IDS } from "./timeline/turn-summary";
export type {
  BuiltInTurnSummaryFacetId,
  TurnSummaryContext,
  TurnSummaryFacet,
  TurnSummaryFacetConfiguration,
  TurnSummaryFacetResult,
  TurnSummaryOptions,
} from "./timeline/turn-summary";
export { QueueSurface } from "./components/queue-surface";
export { SessionConversation } from "./components/session-conversation";
export type { SessionConversationProps } from "./components/session-conversation";
export type { QueueSurfaceProps } from "./components/queue-surface";
export {
  SessionChrome,
  sessionChromeGoalPillExplanation,
  sessionChromeGoalPillLabel,
  sessionChromeGoalPillState,
} from "./components/session-chrome";
export type {
  SessionChromeAgentsSignal,
  SessionChromeProps,
  SessionChromeSignalId,
  SessionChromeSignalTone,
} from "./components/session-chrome";
export { SessionCommandsPanel } from "./components/session-commands-panel";

export { KnowledgeActivityProvider } from "./timeline/knowledge-receipt";
export type { KnowledgeActivityActions } from "./timeline/knowledge-receipt";
export { StartupTimings } from "./timeline/startup-timings";
export { useStartupDetails, setStartupDetails } from "./timeline/startup-preference";
export type { GenieLoadingOptions } from "./timeline/genie-loading";
