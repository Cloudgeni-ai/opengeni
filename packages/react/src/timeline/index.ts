/* ----------------------------------------------------------------------------
   @opengeni/react — timeline module

   The session timeline's data + rendering layer:
     - projection.ts   raw SessionEvents -> renderable TimelineItems (pure)
     - types.ts        the projected item shapes (the data contract)
     - registry.ts     the extensible, typed tool-renderer registry
     - tool-renderers  per-tool React renderers + the default registry
     - parsers.ts      pure provider-shape parsers (exec banner, V4A diff, …)
     - shared.tsx      the restraint primitives (ActivityDisclosure, TermBlock, …)
     - tool-diff.tsx   V4A GitFileDiff -> the real DiffView/PierreDiff stack
     - screenshot-lightbox.tsx  the app-level screenshot lightbox

   This barrel is the module's public surface. The components here are the
   single source of truth used by both the live app and the component demo.
   -------------------------------------------------------------------------- */

// projection
export { buildTimeline, extractSessionRef, groupTimeline, sessionStatusFromEvents, toolDisplayName } from "./projection";

// item types
export type {
  ActivityItem,
  AgentMessageItem,
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
} from "./types";

// renderer registry
export { createToolRegistry, rawTypeOf } from "./registry";
export type {
  CreateToolRegistryOptions,
  ToolRegistry,
  ToolRegistryEntry,
  ToolRenderer,
  ToolRendererProps,
} from "./registry";

// default renderers + registry
export { createDefaultToolRegistry, defaultToolRegistry } from "./tool-renderers";

// the activity rail (the clustered reasoning/tool/worker/sandbox column)
export { ActivityRail } from "./activity-rail";
export type { ActivityRailProps } from "./activity-rail";

// shared primitives (extension authors compose these)
export { ActivityDisclosure, BodyNote, MediaEmpty, MediaSkeleton, PayloadBlock, ScreenshotFigure, TermBlock, Thumbnail } from "./shared";
export type { ActivityDisclosureProps, DisclosureChip } from "./shared";

// screenshot lightbox
export { LightboxProvider, useLightbox, useLightboxOptional } from "./screenshot-lightbox";

// disclosure defaults (opt-in initial-open seed; for screenshot/test instrumentation)
export { DisclosureDefaultsProvider, useForcedDefaultOpen } from "./disclosure-context";

// turn-collapse summary chip
export { TurnSummary } from "./turn-summary";
export type { TurnOutcome, TurnSummaryProps } from "./turn-summary";

// parsers (pure, reusable by custom renderers)
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
} from "./parsers";
export type { ApplyPatchOperation } from "./parsers";
