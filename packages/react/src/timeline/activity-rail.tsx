import {
  ArrowRightIcon,
  BotIcon,
  BrainCircuitIcon,
  BrainIcon,
  GaugeIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { truncate } from "../lib/format";
import { defaultToolRegistry } from "./tool-renderers";
import { useEntranceAnimation } from "./entrance";
import type { ToolRegistry } from "./registry";
import { BodyNote, PayloadBlock, ActivityDisclosure } from "./shared";
import { toolDisplayName } from "./projection";
import type {
  ActivityItem,
  FleetDecisionItem,
  MemoryItem,
  ReasoningItem,
  SandboxItem,
  WorkerItem,
} from "./types";

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
  toolRegistry = defaultToolRegistry,
  onOpenSession,
  onMemoryClick,
  bare,
  className,
}: ActivityRailProps) {
  const enter = useEntranceAnimation();
  return (
    <div
      className={cn(
        // Rows sit TIGHT by default (gap-0.5) so a same-family run reads as one
        // calm cluster; a family change opens real breathing room (mt-3) below,
        // so a long rail reads as a few clusters, not a metronome of rows.
        "flex flex-col gap-0.5",
        !bare && "border-l-2 border-og-border pl-3 sm:pl-4",
        !bare && enter && "animate-og-enter",
        className,
      )}
    >
      {items.map((item, index) => {
        const newFamily = index > 0 && familyOf(item) !== familyOf(items[index - 1]!);
        const row = renderActivity(item, toolRegistry, onOpenSession, onMemoryClick);
        return (
          <div key={item.id} className={cn(newFamily && "mt-3")}>
            {row}
          </div>
        );
      })}
    </div>
  );
}

/** A never-reachable guard: adding an `ActivityItem` kind is now a compile error. */
function assertNever(item: never): never {
  throw new Error(`ActivityRail: unhandled activity item ${JSON.stringify(item)}`);
}

function renderActivity(
  item: ActivityItem,
  toolRegistry: ToolRegistry,
  onOpenSession: ((sessionId: string) => void) | undefined,
  onMemoryClick: ((memoryId: string) => void) | undefined,
) {
  switch (item.kind) {
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "tool-call": {
      const Renderer = toolRegistry.resolve(item);
      return <Renderer item={item} />;
    }
    case "worker":
      return <WorkerRow item={item} onOpenSession={onOpenSession} />;
    case "sandbox":
      return <SandboxRow item={item} />;
    case "memory":
      return <MemoryRow item={item} onMemoryClick={onMemoryClick} />;
    case "fleet-decision":
      return <FleetDecisionRow item={item} />;
    default:
      return assertNever(item);
  }
}

function ReasoningRow({ item }: { item: ReasoningItem }) {
  // Reasoning recedes: a dimmer, lighter-weight title so action rows lead and
  // thought rows sit a half-step back in the hierarchy.
  return (
    <ActivityDisclosure
      icon={<BrainIcon className="size-3.5" />}
      iconTone="muted"
      title={
        item.streaming ? (
          "Thinking"
        ) : (
          <span className="font-normal italic text-og-fg-subtle">Thought</span>
        )
      }
      running={item.streaming}
      preview={truncate(item.text, 110)}
    >
      <p className="whitespace-pre-wrap text-og-base leading-6 text-og-fg-muted">{item.text}</p>
    </ActivityDisclosure>
  );
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
            "outline-none transition-colors duration-150 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent",
          )}
        >
          View in memory
          <ArrowRightIcon className="size-3.5 transition-transform duration-150 group-hover/memlink:translate-x-0.5" />
        </button>
      ) : null}
    </ActivityDisclosure>
  );
}

const FLEET_ACTUAL_REASON_LABEL: Record<FleetDecisionItem["actualReason"], string> = {
  lease_reused: "Reused the fenced lease",
  pin: "Kept the session pin",
  rotation: "Rotated for capacity",
  active: "Used the active subscription",
  all_capped: "All observed subscriptions were capped",
  none: "No production candidate was selected",
};

const FLEET_SHADOW_REASON_LABEL: Record<FleetDecisionItem["shadowReason"], string> = {
  fenced_in_flight: "Kept the fenced in-flight assignment",
  fenced_candidate_missing: "The fenced assignment was missing from the snapshot",
  admission_paced: "Admission would have been paced",
  no_eligible_candidate: "No candidate passed the policy checks",
  overlay_isolated_empty: "Explicit isolation left no eligible candidate",
  best_score: "Selected the lowest-pressure candidate",
  affinity_best: "Session affinity was already best",
  hysteresis_hold: "Hysteresis avoided a low-value switch",
};

const FLEET_COMPARISON_LABEL: Record<FleetDecisionItem["comparison"], string> = {
  match: "Production and shadow matched",
  different_candidate: "Shadow preferred another candidate",
  different_outcome: "Production and shadow outcomes differed",
  not_comparable_truncated: "Comparison limited by bounded candidate data",
};

const FLEET_ADMISSION_REASON_LABEL: Record<FleetDecisionItem["admissionReason"], string> = {
  fenced_in_flight: "In-flight assignment was fenced",
  pacing_disabled: "Admission pacing was disabled",
  capacity_unknown: "Capacity was unknown, so work remained admissible",
  capacity_available: "Observed capacity was available",
  work_conserving_borrow: "Idle capacity was borrowed for standard work",
  manager_priority: "Manager-priority work was admitted",
  standard_starvation_bound: "The standard-work starvation bound was reached",
  capacity_saturated: "Observed dynamic capacity was saturated",
  emergency_fuse: "The emergency fuse blocked new work",
};

const FLEET_REJECTION_LABEL: Record<
  Exclude<FleetDecisionItem["scores"][number]["rejectionReason"], null>,
  string
> = {
  allocator_disabled: "Allocator disabled",
  unavailable: "Unavailable",
  cooling: "Cooling down",
  quota_ceiling: "Quota ceiling reached",
  overlay_isolation: "Outside explicit isolation",
};

const FLEET_CONFIDENCE_LABEL: Record<FleetDecisionItem["confidence"], string> = {
  unknown: "Unknown confidence",
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

function FleetDecisionRow({ item }: { item: FleetDecisionItem }) {
  const scoreRowsHidden = item.scoreRowsTruncatedCount > 0;
  return (
    <ActivityDisclosure
      icon={<GaugeIcon className="size-3.5" />}
      iconTone="muted"
      title="Fleet policy shadow"
      preview={FLEET_COMPARISON_LABEL[item.comparison]}
      chip={{
        tone: "muted",
        text:
          item.comparison === "match"
            ? "matched"
            : item.comparison === "not_comparable_truncated"
              ? "limited"
              : "different",
      }}
    >
      <section aria-label="Fleet policy shadow details" className="flex min-w-0 flex-col gap-3">
        <BodyNote tone="muted">
          Shadow observation only — it did not change the subscription serving this turn.
        </BodyNote>
        <dl className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
          <FleetDetail
            term="Production"
            value={fleetOutcomeLabel(item.actualOutcome, item.actualCandidateKey)}
            note={FLEET_ACTUAL_REASON_LABEL[item.actualReason]}
          />
          <FleetDetail
            term="Shadow policy"
            value={fleetOutcomeLabel(item.shadowOutcome, item.shadowCandidateKey)}
            note={FLEET_SHADOW_REASON_LABEL[item.shadowReason]}
          />
          <FleetDetail term="Comparison" value={FLEET_COMPARISON_LABEL[item.comparison]} />
          <FleetDetail term="Decision confidence" value={FLEET_CONFIDENCE_LABEL[item.confidence]} />
          <FleetDetail
            term="Admission"
            value={
              item.admissionOutcome === "admit" ? "Would admit new work" : "Would pace new work"
            }
            note={FLEET_ADMISSION_REASON_LABEL[item.admissionReason]}
          />
          <FleetDetail
            term="Observed candidates"
            value={`${item.candidateCount} in the bounded replay`}
          />
          <FleetDetail
            term="Idle-capacity borrowing"
            value={item.borrowedIdleCapacity ? "Borrowed for standard work" : "Not borrowed"}
          />
          <FleetDetail
            term="Named-policy borrowing"
            value={
              item.borrowedOverlayCapacity ? "Borrowed outside the preferred group" : "Not borrowed"
            }
          />
          <FleetDetail
            term="Stranded capacity"
            value={
              item.strandedEligibleCount === 0
                ? "None"
                : `${item.strandedEligibleCount} eligible ${item.strandedEligibleCount === 1 ? "candidate" : "candidates"}`
            }
            note={
              item.strandedEligibleCount > 0
                ? "Capacity excluded by explicit isolation; existing fenced turns are unchanged."
                : undefined
            }
          />
        </dl>

        {item.scores.length > 0 ? (
          <div className="min-w-0">
            <h4 className="text-og-sm font-medium text-og-fg">Bounded candidate scores</h4>
            <p className="mt-0.5 text-og-xs leading-5 text-og-fg-subtle">
              Lower scores rank first. Candidate aliases are temporary and local to this event.
            </p>
            <ul className="mt-2 flex min-w-0 flex-col gap-1.5" aria-label="Candidate scores">
              {item.scores.map((score) => (
                <li
                  key={score.candidateKey}
                  className="flex min-w-0 flex-col gap-1 rounded-og-sm bg-og-surface-1 px-2.5 py-2 text-og-sm sm:flex-row sm:items-center sm:gap-3"
                >
                  <span className="font-og-mono text-og-fg">{score.candidateKey}</span>
                  <span className="min-w-0 text-og-fg-muted sm:flex-1">
                    {score.eligible
                      ? "Eligible"
                      : score.rejectionReason
                        ? FLEET_REJECTION_LABEL[score.rejectionReason]
                        : "Unavailable"}
                  </span>
                  <span className="font-og-mono text-og-fg-subtle">
                    score {formatFleetScore(score.total)} ·{" "}
                    {FLEET_CONFIDENCE_LABEL[score.confidence]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {item.truncatedCandidateCount > 0 ? (
          <BodyNote tone="muted">
            {item.truncatedCandidateCount} additional{" "}
            {item.truncatedCandidateCount === 1 ? "candidate was" : "candidates were"} excluded from
            this bounded replay record.
          </BodyNote>
        ) : null}
        {scoreRowsHidden ? (
          <BodyNote tone="muted">
            {item.scoreRowsTruncatedCount} additional{" "}
            {item.scoreRowsTruncatedCount === 1 ? "score row was" : "score rows were"} hidden by
            this view’s safety limit.
          </BodyNote>
        ) : null}
      </section>
    </ActivityDisclosure>
  );
}

function FleetDetail({
  term,
  value,
  note,
}: {
  term: string;
  value: string;
  note?: string | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-og-xs font-medium uppercase tracking-wide text-og-fg-subtle">{term}</dt>
      <dd className="mt-0.5 break-words text-og-sm text-og-fg-muted">
        <span className="text-og-fg">{value}</span>
        {note ? <span className="mt-0.5 block leading-5">{note}</span> : null}
      </dd>
    </div>
  );
}

function fleetOutcomeLabel(
  outcome: FleetDecisionItem["actualOutcome"] | FleetDecisionItem["shadowOutcome"],
  candidateKey: string | null,
): string {
  if (outcome === "selected" && candidateKey) return `Selected ${candidateKey}`;
  if (outcome === "waiting") return "Waiting for capacity";
  if (outcome === "paced") return "Paced before placement";
  return "No candidate selected";
}

function formatFleetScore(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/**
 * A human title for a sandbox operation row. Named platform operations (the lazy
 * `sandbox.provision` first-establish that now runs mid-turn) read as calm,
 * status-aware English instead of a raw op id — the box coming up should look
 * like "Starting sandbox", never an unexplained long-running command. Unnamed /
 * unknown ops fall back to the generic id-to-words {@link toolDisplayName}.
 */
function sandboxRowTitle(item: SandboxItem): string {
  if (item.name === "sandbox.provision") {
    if (item.status === "failed") return "Sandbox didn’t start";
    if (item.status === "running") return "Starting sandbox";
    if (item.origin === "resumed") return "Sandbox reattached";
    if (item.origin === "restored") return "Sandbox restored";
    if (item.origin === "created") return "Sandbox created";
    return "Sandbox ready";
  }
  return toolDisplayName(item.name);
}

function SandboxRow({ item }: { item: SandboxItem }) {
  return (
    <ActivityDisclosure
      icon={<SquareTerminalIcon className="size-3.5" />}
      iconTone={
        item.status === "failed" ? "failed" : item.status === "running" ? "running" : "muted"
      }
      title={sandboxRowTitle(item)}
      running={item.status === "running"}
      failed={item.status === "failed"}
      cancelled={item.status === "cancelled"}
      preview={item.command ?? undefined}
    >
      {item.command ? <PayloadBlock label="Command" value={item.command} /> : null}
      {item.output ? <PayloadBlock label="Output" value={item.output} /> : null}
    </ActivityDisclosure>
  );
}

/** Spawned/messaged worker sessions get a first-class card, not a tool row. */
function WorkerRow({
  item,
  onOpenSession,
}: {
  item: WorkerItem;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  const title =
    item.action === "spawn"
      ? running
        ? "Spawning worker"
        : failed
          ? "Worker spawn failed"
          : cancelled
            ? "Worker interrupted"
            : "Worker spawned"
      : running
        ? "Messaging worker"
        : failed
          ? "Worker message failed"
          : cancelled
            ? "Worker interrupted"
            : "Worker messaged";
  // A worker is a first-class actor but still a STEP on the rail — a borderless
  // row (no card), aligned to its sibling tool rows: the chevron column is an
  // empty spacer (a worker doesn't expand), then the bot glyph, then the title
  // with a quiet prompt beneath, and one right-gutter affordance.
  //
  // Once the worker's session id is known, the WHOLE row is a clean, clickable
  // deep-link into that child session (a trailing arrow brightens on hover) —
  // the spawn moment itself is the affordance, not a small side button. A
  // still-in-flight spawn (no id yet) or a failed/cancelled worker is inert, so
  // there is never a dead click target. The gutter mirrors the worker-completion
  // card's calm language: red chip on failure, "interrupted" on cancel.
  const sessionId = item.workerSessionId;
  const deepLink = Boolean(sessionId) && Boolean(onOpenSession) && !failed && !cancelled;
  const inner = (
    <>
      <span className="size-3.5 shrink-0" aria-hidden />
      <span className={cn("mt-px shrink-0", failed ? "text-og-status-failed" : "text-og-accent")}>
        <BotIcon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* In-flight state is carried ONLY by the shimmering title (no detached
            pulse badge), matching every other running row in the rail. */}
        <span
          className={cn(
            "text-og-base font-medium",
            running ? "og-shimmer-text" : failed ? "text-og-status-failed" : "text-og-fg",
          )}
        >
          {title}
        </span>
        {item.prompt ? (
          <p className="mt-0.5 truncate text-og-sm text-og-fg-muted">
            {truncate(item.prompt, 140)}
          </p>
        ) : null}
      </div>
      {failed ? (
        <span className="inline-flex shrink-0 self-center items-center gap-1.5 font-og-mono text-og-xs leading-none text-og-status-failed">
          <span className="size-1.5 rounded-full bg-og-status-failed" />
          failed
        </span>
      ) : cancelled ? (
        <span className="og-cancelled-chip shrink-0 self-center font-og-mono text-og-xs leading-none text-og-fg-subtle">
          interrupted
        </span>
      ) : deepLink ? (
        <ArrowRightIcon
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-og-fg-subtle transition-[transform,color] duration-150 group-hover/worker:translate-x-0.5 group-hover/worker:text-og-fg"
        />
      ) : null}
    </>
  );

  if (deepLink && sessionId && onOpenSession) {
    return (
      <button
        type="button"
        onClick={() => onOpenSession(sessionId)}
        className={cn(
          "group/worker -mx-1.5 flex w-full items-start gap-2 rounded-og-sm px-1.5 py-1.5 text-left",
          "outline-none transition-colors duration-150 hover:bg-og-surface-1 focus-visible:ring-2 focus-visible:ring-og-accent",
          "pointer-coarse:py-2.5",
        )}
      >
        {inner}
      </button>
    );
  }
  return <div className="flex items-start gap-2 px-1.5 py-1.5">{inner}</div>;
}
