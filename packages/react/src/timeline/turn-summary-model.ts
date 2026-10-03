// Pure turn-summary model shared by the web and native renderers: facet definitions,
// the summary context, status types and duration formatting. No DOM, no styling.
import type { ReactNode } from "react";
import {
  applyPatchOpsFromToolItem,
  isApplyPatch,
  mediaPreviewFact,
  retainedScreenshotMetadata,
  screenshotDataUrl,
} from "./parsers";
import { rawTypeOf } from "./registry";
import { mcpToolLeaf } from "./tool-display-name";
import type { ActivityItem, ToolCallItem, TurnOutcome } from "./types";

export const BUILT_IN_TURN_SUMMARY_FACET_IDS = [
  "steps",
  "files",
  "commands",
  "screenshots",
  "memories",
  "compacted",
  "duration",
] as const;

export type BuiltInTurnSummaryFacetId = (typeof BUILT_IN_TURN_SUMMARY_FACET_IDS)[number];

export type TurnSummaryContext = Readonly<{
  /** Every normalized activity item folded into this summary. */
  items: readonly ActivityItem[];
  /** Tool calls from `items`, retained in timeline order for convenient aggregation. */
  toolCalls: readonly ToolCallItem[];
  /** The settled turn verdict, or absent for a neutral/incomplete cluster. */
  outcome: TurnOutcome | undefined;
  /** The bounded failure reason rendered by the enclosing summary, when present. */
  failureText: string | undefined;
  /** Total turn duration when the enclosing group has both valid timestamps. */
  durationMs: number | undefined;
  /** False when any projected activity is still running or streaming. */
  settled: boolean;
  /**
   * Adjacent compaction landmarks next to this fold. Landmark remains the
   * primary UI; this is a secondary chip signal only.
   */
  contextCompactionCount: number;
}>;

export type TurnSummaryFacetResult = Readonly<{
  icon?: ReactNode;
  content: ReactNode;
  ariaLabel?: string;
  title?: string;
}>;

export type TurnSummaryFacet = Readonly<{
  /** Stable identity used for removal and deterministic de-duplication. */
  id: string;
  /** Return null when this facet has nothing useful to show. */
  summarize(context: TurnSummaryContext): TurnSummaryFacetResult | null;
}>;

type ModifyTurnSummaryFacets = Readonly<{
  /** Appended after the remaining built-ins, in supplied order. */
  add?: readonly TurnSummaryFacet[];
  /** Built-ins to omit before custom facets are appended. */
  remove?: readonly BuiltInTurnSummaryFacetId[];
  replace?: never;
}>;

type ReplaceTurnSummaryFacets = Readonly<{
  /** The complete ordered facet list. Mutually exclusive with add/remove. */
  replace: readonly TurnSummaryFacet[];
  add?: never;
  remove?: never;
}>;

export type TurnSummaryFacetConfiguration = ModifyTurnSummaryFacets | ReplaceTurnSummaryFacets;

export type TurnSummaryOptions = Readonly<{
  /**
   * Readable per-turn presentation. Assistant progress stays fully formatted;
   * each turn has its own Working / Worked row and rolling latest step.
   * Ordinary tip-follow and manual scrolling are unchanged.
   */
  rolling?: boolean;
  facets?: TurnSummaryFacetConfiguration;
}>;

/**
 * Exchange status shown in place of the plain facet line. `working` and
 * `waiting` run a live clock from `since`; `worked` shows the settled span.
 */
export type TurnSummaryStatus = Readonly<{
  kind: "working" | "waiting" | "worked";
  /** Replaces the default "Working" / "Waiting" wording. */
  label?: string | undefined;
  /** Live clock start for `working` and `waiting`. */
  since?: string | undefined;
  /** Settled span for `worked`. */
  durationMs?: number | undefined;
  /** Live step preview under the row while it is collapsed. */
  preview?: ReactNode;
}>;

/** Elapsed wall time with seconds below an hour: "14s", "2m 14s", "1h 05m". */
export function formatElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function createTurnSummaryContext(
  items: ActivityItem[],
  outcome: TurnOutcome | undefined,
  failureText: string | undefined,
  durationMs: number | undefined,
  contextCompactionCount: number,
): TurnSummaryContext {
  const itemSnapshot = Object.freeze([...items]);
  const toolCalls = Object.freeze(
    itemSnapshot.filter((item): item is ToolCallItem => item.kind === "tool-call"),
  );
  const settled = itemSnapshot.every((item) => {
    if (item.kind === "reasoning" || item.kind === "agent-message") {
      return !item.streaming;
    }
    if (
      item.kind === "tool-call" ||
      item.kind === "worker" ||
      item.kind === "sandbox" ||
      item.kind === "startup-phase"
    ) {
      return item.status !== "running";
    }
    return true;
  });
  return Object.freeze({
    items: itemSnapshot,
    toolCalls,
    outcome,
    failureText,
    durationMs,
    settled,
    contextCompactionCount: Math.max(0, Math.floor(contextCompactionCount)),
  });
}

export const BUILT_IN_TURN_SUMMARY_FACETS: readonly TurnSummaryFacet[] = Object.freeze([
  {
    id: "steps",
    summarize: ({ items }) => {
      // Progress notes narrate steps; they are not steps themselves.
      const count = items.filter(
        (item) => item.kind !== "startup-phase" && item.kind !== "agent-message",
      ).length;
      return count
        ? { content: `${count} ${count === 1 ? "step" : "steps"}` }
        : items.some((item) => item.kind === "startup-phase")
          ? { content: "Preparation" }
          : null;
    },
  },
  {
    id: "files",
    summarize: ({ toolCalls }) => {
      let files = 0;
      for (const item of toolCalls) {
        if (isApplyPatch(item)) {
          files += applyPatchOpsFromToolItem(item).length;
        }
      }
      return files ? { content: `${files} ${files === 1 ? "file" : "files"} edited` } : null;
    },
  },
  {
    id: "commands",
    summarize: ({ toolCalls }) => {
      const commands = toolCalls.filter((item) => item.name === "exec_command").length;
      return commands
        ? { content: `${commands} ${commands === 1 ? "command" : "commands"}` }
        : null;
    },
  },
  {
    id: "screenshots",
    summarize: ({ toolCalls }) => {
      let screenshots = 0;
      for (const item of toolCalls) {
        const leaf = mcpToolLeaf(item.name);
        if (
          (rawTypeOf(item) === "computer_call" ||
            item.name === "computer_call" ||
            item.name === "computer_screenshot" ||
            leaf === "browser_screenshot" ||
            leaf === "browser_observe" ||
            leaf === "browser_act") &&
          (retainedScreenshotMetadata(item.output) !== null ||
            screenshotDataUrl(item.output) !== null ||
            mediaPreviewFact(item.output) !== null)
        ) {
          screenshots += 1;
        }
      }
      return screenshots
        ? {
            content: `${screenshots} ${screenshots === 1 ? "screenshot" : "screenshots"}`,
          }
        : null;
    },
  },
  {
    id: "memories",
    summarize: ({ items }) => {
      let saved = 0;
      let updated = 0;
      for (const item of items) {
        if (item.kind !== "memory") {
          continue;
        }
        if (item.variant === "corrected") {
          updated += 1;
        } else {
          saved += 1;
        }
      }
      const parts: string[] = [];
      if (saved) {
        parts.push(`${saved} ${saved === 1 ? "memory" : "memories"} saved`);
      }
      if (updated) {
        parts.push(`${updated} ${updated === 1 ? "memory" : "memories"} updated`);
      }
      return parts.length > 0 ? { content: parts.join(" · ") } : null;
    },
  },
  {
    id: "compacted",
    summarize: ({ contextCompactionCount }) =>
      contextCompactionCount > 0
        ? {
            content:
              contextCompactionCount === 1 ? "compacted" : `${contextCompactionCount} compacts`,
            ariaLabel:
              contextCompactionCount === 1
                ? "Conversation history compacted"
                : `${contextCompactionCount} conversation history compactions`,
          }
        : null,
  },
  {
    id: "duration",
    summarize: ({ durationMs }) => {
      const duration = formatDurationFacet(durationMs);
      return duration ? { content: duration } : null;
    },
  },
]);

export function resolveTurnSummaryFacets(
  configuration: TurnSummaryFacetConfiguration | undefined,
): readonly TurnSummaryFacet[] {
  const requested: readonly TurnSummaryFacet[] = configuration?.replace ?? [
    ...BUILT_IN_TURN_SUMMARY_FACETS.filter(
      (facet) => !configuration?.remove?.includes(facet.id as BuiltInTurnSummaryFacetId),
    ),
    ...(configuration?.add ?? []),
  ];
  const seen = new Set<string>();
  return requested.filter((facet) => {
    if (!facet.id || seen.has(facet.id)) {
      return false;
    }
    seen.add(facet.id);
    return true;
  });
}

export function formatDurationFacet(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 1000) {
    return null;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}
