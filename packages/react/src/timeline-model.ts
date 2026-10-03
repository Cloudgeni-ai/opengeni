// @opengeni/react/timeline-model: the pure presentation model behind the web timeline,
// shared with non-DOM renderers (React Native). No DOM, no CSS, no styled components:
// renderers that consume it make the same decisions the web MessageTimeline makes.
export {
  BUILT_IN_TURN_SUMMARY_FACET_IDS,
  BUILT_IN_TURN_SUMMARY_FACETS,
  createTurnSummaryContext,
  formatDurationFacet,
  formatElapsed,
  resolveTurnSummaryFacets,
} from "./timeline/turn-summary-model";
export type {
  BuiltInTurnSummaryFacetId,
  TurnSummaryContext,
  TurnSummaryFacet,
  TurnSummaryFacetConfiguration,
  TurnSummaryFacetResult,
  TurnSummaryOptions,
  TurnSummaryStatus,
} from "./timeline/turn-summary-model";
export {
  clusterIsSettled,
  compactedLandmarkCount,
  durationBetween,
  flattenActivityItems,
  isPreparingWork,
  readableWorkDefaultOpen,
  readableWorkShowsPreview,
  readableWorkStatus,
  rollingActivityItem,
} from "./timeline/work-presentation";
export type { ActivityGroup, ReadableWorkOptions, TurnGroup } from "./timeline/work-presentation";
export { timelineGroupContainsPresentedImage } from "./timeline/presented-image";
export { mcpToolLeaf, toolDisplayName } from "./timeline/tool-display-name";
export { rawTypeOf } from "./timeline/registry";
export {
  applyPatchOpsFromToolItem,
  isApplyPatch,
  parseToolArgs,
  sandboxCommandExitCode,
  stripExecBanner,
  tailPeek,
  unwrapMcpOutput,
} from "./timeline/parsers";
export { formatClockTime } from "./lib/format";
export {
  applyPatchPresentation,
  askPresentation,
  execPresentation,
  genericToolIconKind,
  genericToolPresentation,
  pathBasename,
  pathDirname,
  presentedToolKind,
  runOnPresentation,
  toolRowPresentation,
  truncatePreview,
  webSearchPresentation,
  withComputePreview,
  writeStdinPresentation,
} from "./timeline/tool-presentation";
export type {
  PresentedToolKind,
  ToolBody,
  ToolChip,
  ToolIconKind,
  ToolIconTone,
  ToolPatchFile,
  ToolPresentationContext,
  ToolPreview,
  ToolRowPresentation,
  WebSearchResult,
} from "./timeline/tool-presentation";

export {
  sandboxRowTitle,
  startupDuration,
  startupPhaseTitle,
  STARTUP_WAIT_TITLES,
  workerRowTitle,
} from "./timeline/platform-activity-presentation";
export { formatBytes, stringifyPayload, tryParseJson } from "./lib/format";
export { selectTurnSummaryFacets } from "./timeline/turn-summary-model";
export { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "./timeline/genie-copy";
export {
  answersFromDrafts,
  defaultHumanInputFormMessages,
  emptyDraft,
  formatDeadline,
  humanInputHeading,
  initialDrafts,
} from "./human-input-model";
export type { HumanInputAnswerDraft, HumanInputFormMessages } from "./human-input-model";
export { isActionableHumanInputRequest } from "./human-input";
export { SESSION_STATUS_PRESENTATION } from "./session-status-model";
export type { SessionStatusTone } from "./session-status-model";
export { formatRelativeTime } from "./lib/format";
export { noticeDisplayText, noticeTone } from "./timeline/notice-presentation";
