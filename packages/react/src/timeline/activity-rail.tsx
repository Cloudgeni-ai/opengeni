import { KnowledgeReceiptRow } from "./knowledge-receipt";
import { workerRowTitleParts } from "./platform-activity-presentation";
import { AgentRow, AgentRowSection } from "./agent-row";
import { useAgentIdentity } from "./agent-identity";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { GenieLoading } from "./genie-loading";
import { StartupDispatchDetails } from "./startup-dispatch-details";
import { useStartupDetails } from "./startup-preference";
import {
  ArrowRightIcon,
  BotIcon,
  BrainCircuitIcon,
  MessageSquareTextIcon,
  SendIcon,
} from "lucide-react";
import {
  Component,
  createContext,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { jsx as rowJsx, jsxs as rowJsxs } from "react/jsx-runtime";
import { Markdown } from "../components/markdown";
import { cn } from "../lib/cn";
import { truncate } from "../lib/format";
import { defaultToolRegistry } from "./tool-renderers";
import { useEntranceAnimation, useEntranceAnimationLive } from "./entrance";
import type { RetainedArtifactLoader, RetainedScreenshotLoader, ToolRegistry } from "./registry";
import { useSeenActivityIds } from "./seen-activity-ids";
import { BodyNote, PayloadBlock, ActivityDisclosure, ToolCallTruncationProvider } from "./shared";
import { toolDisplayName } from "./tool-display-name";
import type { ActivityItem, AgentMessageItem, MemoryItem, WorkerItem } from "./types";

const LazyFleetDecisionRow = lazy(() => import("./fleet-decision-row"));
const LazyPlatformActivityRow = lazy(() => import("./platform-activity-row"));

/* ----------------------------------------------------------------------------
   Activity rail

   Renders a run of clustered activity items (reasoning, tool calls, workers,
   sandbox ops) as the left-bordered column between chat messages. Tool calls
   resolve through the renderer registry; everything else has a first-class row.

   Shared by `MessageTimeline` and the component demo so both draw the exact
   same rail — no divergence.
   -------------------------------------------------------------------------- */

export type ActivityRailProps = {
  items: ActivityItem[];
  /** The owning turn remains active between individual phase receipts. */
  startupActive?: boolean;
  /** Renderer registry for tool calls. Defaults to {@link defaultToolRegistry}. */
  toolRegistry?: ToolRegistry | undefined;
  /** Drill into a spawned worker session. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /**
   * Deep-link a memory row to its record in the host's memory pane. Opt-in: the
   * library draws no "View in memory" affordance without a handler (the memory
   * row is then non-interactive rich content). See {@link MessageTimelineProps}.
   */
  onMemoryClick?: ((memoryId: string) => void) | undefined;
  loadRetainedScreenshot?: RetainedScreenshotLoader | undefined;
  /** Resolve permanent generated-image receipts through the authenticated host SDK. */
  loadRetainedArtifact?: RetainedArtifactLoader | undefined;
  /** Drop the left rule + indent (used inside a folded turn summary). */
  bare?: boolean | undefined;
  className?: string | undefined;
};

/**
 * The "family" a row belongs to, for light intra-rail grouping. Consecutive
 * rows of the same family sit tight; a family change gets a little extra top
 * margin so a long run reads as clusters rather than one undifferentiated wall.
 */
function familyOf(item: ActivityItem): string {
  if (item.kind === "tool-call") {
    return item.name === "exec_command" || item.name === "write_stdin" ? "terminal" : item.name;
  }
  return item.kind;
}

export function ActivityRail({
  items,
  startupActive,
  toolRegistry = defaultToolRegistry,
  onOpenSession,
  onMemoryClick,
  loadRetainedScreenshot,
  loadRetainedArtifact,
  bare,
  className,
}: ActivityRailProps) {
  const debug = useStartupDetails();
  const reducedMotion = useReducedMotion();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const phases = items.filter((item) => item.kind === "startup-phase");
  const dispatch = phases.find((item) => item.dispatchWait !== undefined);
  // Empty reasoning envelopes can arrive before any visible model output.
  const hasWork = items.some(
    (item) =>
      item.kind !== "startup-phase" && (item.kind !== "reasoning" || item.text.trim().length > 0),
  );
  const interrupted = phases.some(
    (item) => item.status === "failed" || item.status === "cancelled",
  );
  const providerResponded = phases.some(
    (item) => item.phase === "provider_first_byte" && item.status === "complete",
  );
  const responsePending = phases.some((item) => item.phase === "provider_first_byte");
  const loading =
    !hasWork &&
    !interrupted &&
    (startupActive ?? (!providerResponded && phases.some((item) => item.status === "running")));
  const visibleItems =
    debug || detailsOpen
      ? items
      : items.filter((item) =>
          item.kind === "startup-phase"
            ? item.status === "failed" || item.status === "cancelled"
            : item.kind !== "reasoning" || item.text.trim().length > 0,
        );
  const startedAt = phases.reduce((first, item) => {
    const start = item.loadingStartedAt ?? item.startedAt;
    return start < first ? start : first;
  }, phases[0]?.startedAt ?? "");
  const enterMounted = useEntranceAnimation();
  // Live gate: rails born during bulk capture enter=false forever; with a
  // seen-id map we still want later live appends to fade (ids gate remounts).
  const enterLive = useEntranceAnimationLive();
  const seenIds = useSeenActivityIds();
  const enter = seenIds ? enterLive : enterMounted;
  const previousIdsRef = useRef<Set<string> | null>(null);
  const enteringIds = new Set<string>();
  if (enter) {
    for (const item of items) {
      if (seenIds) {
        if (!seenIds.has(item.id)) {
          enteringIds.add(item.id);
        }
      } else if (previousIdsRef.current !== null && !previousIdsRef.current.has(item.id)) {
        // Standalone ActivityRail (tests / demo): append-only, no remount map.
        enteringIds.add(item.id);
      }
    }
  }
  useLayoutEffect(() => {
    previousIdsRef.current = new Set(items.map((item) => item.id));
    if (seenIds) {
      for (const item of items) {
        seenIds.add(item.id);
      }
    }
  });
  return (
    <div
      className={cn(
        // Rows sit TIGHT by default (gap-0.5) so a same-family run reads as one
        // calm cluster; a family change opens real breathing room (mt-3) below,
        // so a long rail reads as a few clusters, not a metronome of rows.
        "relative flex flex-col gap-0.5",
        !bare && "border-l-2 border-og-border pl-3 sm:pl-4",
        // Whole-rail enter: standalone rails only (no seen-id map). Inside
        // MessageTimeline, unknown ids take per-row enter — remounts stay quiet.
        !bare && enter && !seenIds && previousIdsRef.current === null && "animate-og-enter",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {loading && !debug ? (
          <motion.div
            key="startup"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{
              opacity: 0,
              height: 0,
              pointerEvents: "none",
            }}
            transition={{
              height: { duration: reducedMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: reducedMotion ? 0 : 0.16 },
            }}
            style={{ overflow: "hidden" }}
          >
            <GenieLoading
              startedAt={startedAt}
              notice={
                dispatch?.dispatchWait?.lastError
                  ? "Unable to start yet. Your messages are saved."
                  : undefined
              }
              phase={responsePending ? "waiting" : "preparing"}
              detailsOpen={detailsOpen}
              onShowDetails={() => setDetailsOpen((open) => !open)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {detailsOpen && !debug && !loading ? (
        <button
          type="button"
          className="og-genie-details self-start"
          onClick={() => setDetailsOpen(false)}
        >
          Hide startup details
        </button>
      ) : null}
      {dispatch && (detailsOpen || debug) ? (
        <StartupDispatchDetails wait={dispatch.dispatchWait ?? null} />
      ) : null}
      {visibleItems.map((item, index) => {
        const newFamily = index > 0 && familyOf(item) !== familyOf(visibleItems[index - 1]!);
        const row = renderActivity(
          item,
          toolRegistry,
          onOpenSession,
          onMemoryClick,
          loadRetainedScreenshot,
          loadRetainedArtifact,
        );
        return (
          <div
            key={item.id}
            data-og-timeline-row-anchor=""
            data-og-item={item.id}
            data-og-annotation-source-key={
              item.kind === "tool-call" ? item.annotationSource?.eventId : undefined
            }
            className={cn(newFamily && "mt-3", enteringIds.has(item.id) && "animate-og-row-enter")}
          >
            {row}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Host message renderer for progress notes inside a rail, so notes keep the
 * host's links and formatting. Without one, notes render the library Markdown.
 */
export const ActivityNoteTextContext = createContext<
  ((text: string, item: AgentMessageItem) => ReactNode) | null
>(null);

/**
 * Assistant commentary folded into the rail: the agent's own words about the
 * work, quieter than an answer and aligned with the step titles.
 */
function ActivityNoteRow({ item }: { item: AgentMessageItem }) {
  const renderText = useContext(ActivityNoteTextContext);
  if (!item.text.trim()) return null;
  return (
    <div className="flex items-start gap-2 px-1.5 py-1.5" data-og-activity-note="">
      <span className="size-3.5 shrink-0" aria-hidden />
      <MessageSquareTextIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-og-fg-subtle" />
      <div
        className="min-w-0 flex-1 text-og-sm text-og-fg-muted"
        data-og-search-item={item.id}
        data-og-annotation-source-key={item.annotationSource?.eventId}
      >
        {renderText ? (
          renderText(item.text, item)
        ) : (
          <Markdown softLineBreaks streaming={item.streaming}>
            {item.text}
          </Markdown>
        )}
      </div>
    </div>
  );
}

/** A never-reachable guard: adding an `ActivityItem` kind is now a compile error. */
function assertNever(item: never): never {
  throw new Error(`ActivityRail: unhandled activity item ${JSON.stringify(item)}`);
}

export function renderActivity(
  item: ActivityItem,
  toolRegistry: ToolRegistry,
  onOpenSession: ((sessionId: string) => void) | undefined,
  onMemoryClick: ((memoryId: string) => void) | undefined,
  loadRetainedScreenshot: RetainedScreenshotLoader | undefined,
  loadRetainedArtifact: RetainedArtifactLoader | undefined,
) {
  switch (item.kind) {
    case "reasoning":
    case "sandbox":
    case "startup-phase":
      return (
        <Suspense fallback={null}>
          <LazyPlatformActivityRow
            item={item}
            d={ActivityDisclosure}
            p={PayloadBlock}
            t={toolDisplayName}
            b={BotIcon}
            m={Markdown}
            j={rowJsx}
            s={rowJsxs}
          />
        </Suspense>
      );
    case "tool-call": {
      const Renderer = toolRegistry.resolve(item);
      return (
        <ToolRowBoundary name={toolDisplayName(item.name)} resetKeys={[item.status, Renderer]}>
          <ToolCallTruncationProvider value={item.truncation ?? null}>
            <Renderer
              item={item}
              loadRetainedScreenshot={loadRetainedScreenshot}
              loadRetainedArtifact={loadRetainedArtifact}
            />
          </ToolCallTruncationProvider>
        </ToolRowBoundary>
      );
    }
    case "worker":
      return <WorkerRow item={item} onOpenSession={onOpenSession} />;
    case "knowledge":
      return (
        <KnowledgeReceiptRow
          outcome={item.outcome}
          entryId={item.entryId}
          fileId={item.fileId}
          title={item.filename}
          source={Boolean(item.fileId)}
        />
      );
    case "memory":
      return <MemoryRow item={item} onMemoryClick={onMemoryClick} />;
    case "agent-message":
      return <ActivityNoteRow item={item} />;
    case "fleet-decision":
      return (
        <Suspense fallback={null}>
          <LazyFleetDecisionRow
            item={item}
            d={ActivityDisclosure}
            b={BodyNote}
            j={rowJsx}
            s={rowJsxs}
          />
        </Suspense>
      );
    default:
      return assertNever(item);
  }
}

/**
 * Human labels for the memory kinds, translated at the SDK boundary so a raw
 * enum slug never renders as UI. Kept local to the library (the app has its own
 * `KIND_LABEL`); an unknown kind simply omits the chip rather than showing a slug.
 */
const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: "Preference",
  semantic: "Fact",
  procedural: "Procedure",
  decision: "Decision",
  episodic: "History",
};

/**
 * A memory write the agent made mid-turn. A calm, NEUTRAL step (a successful save
 * is ordinary progress, never an exceptional state, so no accent/color): a brain-
 * circuit glyph, "Saved to memory" / "Updated memory", a human kind chip, and the
 * memory text. Expanding reveals the full text; a supersede shows the old text
 * struck through above the new one. When the host opts in with `onMemoryClick`,
 * a quiet "View in memory" affordance deep-links to the LIVE record.
 */
function MemoryRow({
  item,
  onMemoryClick,
}: {
  item: MemoryItem;
  onMemoryClick?: ((memoryId: string) => void) | undefined;
}) {
  const corrected = item.variant === "corrected";
  const kindLabel = MEMORY_KIND_LABEL[item.memoryKind];
  // A supersede carries both the old text (`preview`) and the new (`replacementPreview`);
  // an in-place update / archive carries only `preview`.
  const superseded = corrected && Boolean(item.replacementPreview);
  // Link to the LIVE record: a supersede's replacement when present, else the memory itself.
  const targetId = corrected ? (item.replacementMemoryId ?? item.memoryId) : item.memoryId;
  const deepLink = Boolean(onMemoryClick);
  return (
    <ActivityDisclosure
      icon={<BrainCircuitIcon className="size-3.5" />}
      iconTone="muted"
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="shrink-0">{corrected ? "Updated memory" : "Saved to memory"}</span>
          {kindLabel ? (
            <span className="shrink-0 rounded-og-xs bg-og-surface-2 px-1.5 py-px text-og-xs font-normal leading-tight text-og-fg-subtle">
              {kindLabel}
            </span>
          ) : null}
        </span>
      }
      preview={superseded ? item.replacementPreview : item.preview}
    >
      {superseded ? (
        // The correction as a before → after: the old memory struck through and
        // dimmed, the new text in the ordinary body weight below it.
        <div className="flex flex-col gap-1.5">
          <p className="whitespace-pre-wrap text-og-sm leading-6 text-og-fg-subtle line-through">
            {item.preview}
          </p>
          <p className="whitespace-pre-wrap text-og-base leading-6 text-og-fg-muted">
            {item.replacementPreview}
          </p>
        </div>
      ) : corrected && item.action === "updated" ? (
        // Edited in place, no replacement record: the memory is still live, so
        // show its current text — NOT the archived treatment.
        <>
          <p className="whitespace-pre-wrap text-og-base leading-6 text-og-fg-muted">
            {item.preview}
          </p>
          <BodyNote tone="muted">Updated in place.</BodyNote>
        </>
      ) : corrected ? (
        // A correction with no replacement (and not an in-place update) archived the record.
        <BodyNote tone="muted">Archived.</BodyNote>
      ) : (
        <p className="whitespace-pre-wrap text-og-base leading-6 text-og-fg-muted">
          {item.preview}
        </p>
      )}
      {item.deduped ? <BodyNote tone="muted">Merged into an existing memory.</BodyNote> : null}
      {deepLink ? (
        <button
          type="button"
          onClick={() => onMemoryClick?.(targetId)}
          className={cn(
            "group/memlink -mx-1 inline-flex w-fit items-center gap-1 rounded-og-sm px-1 py-0.5 text-left text-og-sm text-og-fg-subtle",
            "outline-hidden transition-colors duration-150 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent",
          )}
        >
          View in memory
          <ArrowRightIcon className="size-3.5 transition-transform duration-150 group-hover/memlink:translate-x-0.5" />
        </button>
      ) : null}
    </ActivityDisclosure>
  );
}

/**
 * Spawning or messaging another agent: a named rail step. The title names the
 * agent, one line previews the brief or message, expanding shows it in full,
 * and the trailing arrow opens the agent's session once its id is known. A
 * failed or interrupted call keeps its quiet chip; an interrupted one, or a
 * spawn that never produced a session, offers no link.
 */
function WorkerRow({
  item,
  onOpenSession,
}: {
  item: WorkerItem;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const identity = useAgentIdentity();
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const sessionId = item.workerSessionId;
  const name = identity.titleFor(sessionId) ?? (item.action === "spawn" ? item.title : null);
  const title = workerRowTitleParts(item, name);
  const prompt = item.prompt?.trim() ? item.prompt.trim() : null;
  const failure = failed ? item.failure : null;
  const hasBody = Boolean(prompt) || Boolean(failure);
  return (
    <AgentRow
      icon={item.action === "spawn" ? <BotIcon /> : <SendIcon />}
      title={title}
      preview={
        failure ? failure.message : prompt ? truncate(prompt.replace(/\s+/g, " "), 240) : null
      }
      sessionId={cancelled ? null : sessionId}
      onOpenSession={onOpenSession ?? identity.onOpenSession}
      running={running}
      failed={failed}
      cancelled={cancelled}
    >
      {hasBody ? (
        <>
          {prompt ? (
            <AgentRowSection label={item.action === "spawn" ? "Brief" : "Message"}>
              {prompt}
            </AgentRowSection>
          ) : null}
          {failure ? (
            <AgentRowSection label={failure.code} muted>
              {failure.message}
            </AgentRowSection>
          ) : null}
        </>
      ) : undefined}
    </AgentRow>
  );
}

/**
 * One tool row that fails to render shows a one-line note in its place, so the
 * rest of the work group (and the live preview) keeps reading normally.
 */
class ToolRowBoundary extends Component<
  { name: string; resetKeys: readonly unknown[]; children: ReactNode },
  { failed: boolean; resetKeys: readonly unknown[] }
> {
  state = { failed: false, resetKeys: this.props.resetKeys };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** A new status or renderer for the row gets a fresh attempt. */
  static getDerivedStateFromProps(
    props: { resetKeys: readonly unknown[] },
    state: { failed: boolean; resetKeys: readonly unknown[] },
  ): { failed: boolean; resetKeys: readonly unknown[] } | null {
    const same =
      props.resetKeys.length === state.resetKeys.length &&
      props.resetKeys.every((key, index) => Object.is(key, state.resetKeys[index]));
    return same ? null : { failed: false, resetKeys: props.resetKeys };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-testid="tool-row-render-error"
        role="status"
        className="px-1.5 py-1.5 text-og-menu text-og-fg-subtle"
      >
        {this.props.name} · couldn't be displayed
      </div>
    );
  }
}
