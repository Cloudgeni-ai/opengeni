import { CameraIcon, CameraOffIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Collapsible } from "radix-ui";
import { cn } from "../lib/cn";
import { stringifyPayload } from "../lib/format";
import { useForcedDefaultOpen } from "./disclosure-context";
import { useLightboxOptional } from "./screenshot-lightbox";

/* ----------------------------------------------------------------------------
   Shared timeline primitives

   The restraint layer. One disclosure shape every tool renderer reuses, so the
   rail reads as a calm, aligned column: a chevron, a tinted icon, a title, an
   optional muted preview, and — at most — ONE quiet right-aligned signal
   (a settle chip). Compact by default; the body only mounts when expanded.

   CHIP DOCTRINE (closed set — do not extend):
   The right gutter carries at most ONE terse status token per row, and COLOR is
   spent only on the exception. Success is the default, so it never earns a hue:
   a settled-ok chip is bare muted text (or nothing). The colored dot is reserved
   for failure alone. In-flight state is NOT a gutter chip — the shimmering title
   carries it, so a running row has a clean right edge (no detached pulse badge).
   There is no bordered/filled pill. Anything narrative (a session id, "approval
   rejected", "malformed V4A") belongs in the muted preview line, never the gutter.

     ok       a settled success      quiet muted text ("0", "done") — no dot
     bad      a settled failure      red dot + red text ("exit 6") — the one hue
     muted    quiet metadata         subtle text ("session 3")
   -------------------------------------------------------------------------- */

/**
 * A subtle settle signal — see the CHIP DOCTRINE above. The closed tone set.
 * `"interrupted"` is a calm neutral tone for cancelled items — no dot, same
 * quiet weight as `"muted"`, but semantically distinct from metadata.
 */
export type DisclosureChip = {
  tone: "ok" | "bad" | "muted" | "interrupted";
  text: string;
};

export type ActivityDisclosureProps = {
  icon: ReactNode;
  /** Icon tint. Defaults to the muted foreground; renderers pass accent/failed. */
  iconTone?: "accent" | "failed" | "running" | "muted" | undefined;
  title: ReactNode;
  /** Render the title in the mono face (commands, paths). */
  titleMono?: boolean | undefined;
  /** Shimmer the title while the tool is in-flight. */
  running?: boolean | undefined;
  /**
   * Quiet single-line secondary text (truncated). It is detail-on-demand: hidden
   * when a media preview is set, AND hidden once the row is expanded (the body
   * then owns the detail), so a stat/path never appears twice at once.
   */
  preview?: ReactNode | undefined;
  /** A small inline media preview (a screenshot thumbnail) shown in place of `preview`. */
  media?: ReactNode | undefined;
  /** At most one quiet settle chip, right-aligned to the gutter. */
  chip?: DisclosureChip | undefined;
  /**
   * When true the row carries the standard failure affordance: the icon is tinted
   * red and a "failed" bad-chip appears in the right gutter (unless an explicit
   * `chip` is already supplied — the caller's chip wins). Output is still visible
   * on expand; this is a quiet status signal, not a blocking banner.
   *
   * Renderers should pass `failed={item.status === "failed"}` on their settled
   * (non-running) paths so any tool with a failed status shows a consistent
   * affordance without each renderer having to duplicate the logic.
   */
  failed?: boolean | undefined;
  /**
   * When true the row carries a calm "interrupted" affordance: the icon stays
   * muted (no red) and a quiet "interrupted" chip appears in the right gutter
   * (unless an explicit `chip` is already supplied — the caller's chip wins).
   * This is the cancelled-status analogue of `failed`, but deliberately calm
   * and neutral — it is NOT an error; the user chose to stop.
   *
   * Renderers should pass `cancelled={item.status === "cancelled"}` so any
   * in-flight item that was interrupted on turn.cancelled reads consistently.
   * `cancelled` is ignored when `failed` is also true (failure takes precedence).
   */
  cancelled?: boolean | undefined;
  /** When false the row is a static line (no expand affordance). */
  expandable?: boolean | undefined;
  children?: ReactNode | undefined;
};

const ICON_TONE: Record<NonNullable<ActivityDisclosureProps["iconTone"]>, string> = {
  accent: "text-og-accent",
  failed: "text-og-status-failed",
  running: "text-og-status-running",
  muted: "text-og-fg-subtle",
};

/**
 * The one disclosure row shape every activity row reuses (tool calls, reasoning,
 * sandbox ops): a chevron, a tinted icon, a title, an optional muted preview or
 * inline media, and at most one right-gutter settle chip. Compact by default;
 * the body mounts only when expanded.
 */
export function ActivityDisclosure({
  icon,
  iconTone: iconToneProp = "muted",
  title,
  titleMono,
  running,
  preview,
  media,
  chip: chipProp,
  failed,
  cancelled,
  expandable = true,
  children,
}: ActivityDisclosureProps) {
  // `failed` takes precedence over `cancelled` when both are set (shouldn't happen, but be safe).
  // When `failed` is set the icon goes red and a "failed" chip appears in the
  // gutter — unless the caller already supplied an explicit chip (their chip wins,
  // e.g. an exit-code chip that is more informative than a bare "failed" label).
  // When `cancelled` is set (and not failed) the icon stays muted and a calm
  // "interrupted" chip appears — no red, just a quiet neutral signal.
  const iconTone = failed && iconToneProp === "muted" ? "failed" : iconToneProp;
  const chip =
    chipProp ??
    (failed
      ? ({ tone: "bad", text: "failed" } satisfies DisclosureChip)
      : cancelled
        ? ({ tone: "interrupted", text: "interrupted" } satisfies DisclosureChip)
        : undefined);
  // An ancestor may seed the initial open state (screenshot instrumentation);
  // absent in normal app usage, where the row starts collapsed.
  const forcedDefaultOpen = useForcedDefaultOpen();
  const [open, setOpen] = useState(forcedDefaultOpen ?? false);
  const hasBody = expandable && children != null;

  // The preview is detail-on-demand: it is suppressed once the row is open so a
  // path/stat shown in the body never also sits in the collapsed row.
  const previewVisible = preview != null && !open;

  // ONE full-row layout for EVERY tool — media or not — so the hit target always
  // equals the visible row. The chevron → icon → title lead; a flex spacer (or
  // the preview) fills the middle; the right gutter (ml-auto) carries the chip OR
  // the media thumbnail. There is no media-vs-non-media fork: the screenshot card
  // toggles from anywhere on the row, exactly like every other row.
  //
  // The row is the single Collapsible.Trigger (via `asChild` onto a div), so it
  // is the toggle surface. A div — not a native <button> — so the interactive
  // media thumbnail (itself a <button>) is valid nested DOM; that thumbnail calls
  // stopPropagation so activating it never toggles the row.
  //
  // Radix forwards aria-expanded / aria-controls / data-state and a click handler
  // onto the asChild child, but it does NOT synthesize the button role, tab stop,
  // or Enter/Space activation for a non-button element. We add those ourselves
  // (role/tabIndex/onKeyDown) so the row is a fully keyboard-operable button to
  // AT and the keyboard, matching its native-<button> siblings (TurnSummary).
  const rowClass = cn(
    "group/disclosure flex w-full min-w-0 items-center gap-2 rounded-og-sm px-1.5 py-1.5 text-left text-og-base",
    "text-og-fg-muted transition-colors duration-150",
    // A tool row is a touch target on coarse pointers: grow its padding so the
    // hit area clears the 40px minimum without loosening the dense desktop rail.
    "pointer-coarse:py-2.5",
  );
  // The chevron rotates to point down when open; it tracks `data-state` on this
  // same row (the Trigger), so the affordance never freezes.
  const inner = (
    <>
      {hasBody ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-og-fg-subtle transition-transform duration-150 ease-og-in-out group-data-[state=open]/disclosure:rotate-90" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className={cn("shrink-0", ICON_TONE[iconTone])}>{icon}</span>
      <span
        className={cn(
          "min-w-0 shrink truncate text-og-base font-medium",
          titleMono && "font-og-mono text-og-sm font-normal",
          running && "og-shimmer-text",
        )}
      >
        {title}
      </span>
      {previewVisible && !media ? (
        <span className="min-w-0 flex-1 truncate text-og-sm text-og-fg-subtle">{preview}</span>
      ) : (
        <span className="flex-1" />
      )}
      {/* The right gutter carries at most ONE signal: the media thumbnail, else a
          terse settle chip (hidden once expanded — the body owns the detail). */}
      {media ? (
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">{media}</span>
      ) : chip && !open ? (
        <span className="ml-auto shrink-0 pl-2">
          <Chip chip={chip} />
        </span>
      ) : null}
    </>
  );

  // A `data-status` attribute on the root lets tests (and AT) detect the item's
  // settled state regardless of whether the chip slot is occupied by media.
  const dataStatus = cancelled ? "cancelled" : failed ? "failed" : undefined;

  if (!hasBody) {
    return <div className={cn(rowClass, "cursor-default")} data-status={dataStatus}>{inner}</div>;
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <div
          role="button"
          tabIndex={0}
          // Space/Enter activate a native button; Radix doesn't add this for a
          // non-button asChild child, so we toggle here. preventDefault on Space
          // stops the page from scrolling.
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((prev) => !prev);
            }
          }}
          data-status={dataStatus}
          className={cn(
            rowClass,
            "cursor-pointer outline-none hover:bg-og-surface-1 hover:text-og-fg",
            "focus-visible:ring-2 focus-visible:ring-og-accent focus-visible:ring-offset-0",
          )}
        >
          {inner}
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-og-collapse data-[state=open]:animate-og-expand">
        <div className="mb-2 ml-7 mt-1.5 flex flex-col gap-2">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * The right-gutter settle chip. Color is spent only on the exception: a failure
 * is a red dot + red text (the one colored token in a healthy run); success and
 * metadata are bare muted text with no dot. No box, no fill (see the CHIP
 * DOCTRINE above). A `bad` chip with empty text is a lone dot (no trailing void).
 */
function Chip({ chip }: { chip: DisclosureChip }) {
  const base = "inline-flex items-center font-og-mono text-og-xs leading-none";
  const withText = chip.text ? "gap-1.5" : "gap-0";
  if (chip.tone === "bad") {
    return (
      <span className={cn(base, withText, "text-og-status-failed")}>
        <span className="size-1.5 rounded-full bg-og-status-failed" />
        {chip.text}
      </span>
    );
  }
  // "interrupted" is a calm cancelled signal: same quiet weight as muted, no
  // dot, no red — just a slightly more prominent subtle text so "interrupted"
  // reads at a glance without demanding attention the way a failure does.
  if (chip.tone === "interrupted") {
    return <span className={cn(base, "text-og-fg-subtle og-cancelled-chip")}>{chip.text}</span>;
  }
  // ok and muted are the same quiet weight — success never earns a hue.
  return <span className={cn(base, "text-og-fg-subtle")}>{chip.text}</span>;
}

/* --- terminal output block (exec / write_stdin) ---------------------------- */

export function TermBlock({
  command,
  workdir,
  output,
  live,
  tailLines = 12,
  failed,
}: {
  /**
   * The command shown in the prompt header. Pass `null` when the row title
   * already carries it (e.g. an exec row titled `$ cmd`): the header then drops
   * the command — and the whole prompt line if there is no workdir either — so
   * the command never reads twice, stacked, above the output.
   */
  command: string | null;
  workdir?: string | null | undefined;
  /** The FULL output. TermBlock owns the tail/full slicing internally. */
  output: string;
  live?: boolean | undefined;
  /** A non-zero exit / failed call — tints the left accent red (the one hue). */
  failed?: boolean | undefined;
  /**
   * When the output exceeds the tail window, only the last `tailLines` are shown
   * with a "show full output" toggle. The component holds the full text, so the
   * toggle reveals the rest (never a dead affordance). Defaults to 12.
   */
  tailLines?: number | undefined;
}) {
  const [full, setFull] = useState(false);
  const empty = output.trim() === "";
  const lines = output.split("\n");
  const big = lines.length > tailLines + 4;
  const shown = full || !big ? output : lines.slice(-tailLines).join("\n");
  const showMore = big && !full;
  const showHeader = command != null || workdir != null;

  // No frame, no fill: a quiet monospace run flush on the page, marked only by a
  // 2px left accent so it reads as terminal output at a glance without becoming
  // yet another nested box. Color is spent only on the exception — a settled run
  // gets a calm neutral rule, a live one the running hue, a failed one the red.
  return (
    <div
      className={cn(
        "min-w-0 border-l-2 pl-3",
        failed ? "border-og-status-failed/50" : live ? "border-og-status-running/50" : "border-og-border",
      )}
    >
      {showHeader ? (
        <div className="flex items-center gap-2 pb-1">
          <span className="select-none text-og-status-idle">$</span>
          {command != null ? (
            <span className="min-w-0 flex-1 truncate font-og-mono text-og-sm text-og-fg-muted">{command}</span>
          ) : (
            <span className="flex-1" />
          )}
          {workdir ? <span className="shrink-0 font-og-mono text-og-xs text-og-fg-subtle">{workdir}</span> : null}
        </div>
      ) : null}
      {empty ? (
        <p className="font-og-mono text-og-xs italic text-og-fg-subtle">(no output)</p>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-og-mono text-og-xs leading-5 text-og-fg-muted">
          {shown}
          {live ? <span className="ml-px inline-block h-[1em] w-[2px] translate-y-[2px] animate-og-blink bg-og-accent align-middle" /> : null}
        </pre>
      )}
      {showMore ? (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-1 text-left text-og-xs text-og-fg-subtle transition-colors hover:text-og-fg"
        >
          show full output ({lines.length} lines)
        </button>
      ) : null}
    </div>
  );
}

/* --- generic payload block -------------------------------------------------- */

export function PayloadBlock({ label, value, failed }: { label: string; value: unknown; failed?: boolean | undefined }) {
  const text = typeof value === "string" ? value : stringifyPayload(value);
  if (!text || text.trim() === "") {
    return null;
  }
  // Flush on the page, no frame — a labelled monospace run marked only by a 2px
  // left accent (red when the call failed, otherwise a calm neutral rule), so a
  // payload reads as detail hanging off the row, never a nested card.
  return (
    <div className={cn("min-w-0 border-l-2 pl-3", failed ? "border-og-status-failed/50" : "border-og-border")}>
      <p className="mb-1 text-og-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle">{label}</p>
      <pre
        className={cn(
          "max-h-64 overflow-auto whitespace-pre-wrap break-all font-og-mono text-og-xs leading-5",
          failed ? "text-og-status-failed" : "text-og-fg-muted",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

/** A quiet inline note inside an expanded body (lost output, empty frame, …). */
export function BodyNote({ children, tone }: { children: ReactNode; tone?: "error" | "muted" | undefined }) {
  if (tone === "error") {
    // A quiet error run marked by a 2px red accent — the same flush, frameless
    // language as the payload/output blocks, not a filled callout box.
    return (
      <div className="border-l-2 border-og-status-failed/50 pl-3 font-og-mono text-og-xs leading-5 text-og-status-failed">
        {children}
      </div>
    );
  }
  return <p className="px-0.5 text-og-sm italic leading-5 text-og-fg-subtle">{children}</p>;
}

/* --- screenshot thumbnail + media states ------------------------------------ */

/**
 * The shared inline-media footprint, so thumb / skeleton / empty align. Sized to
 * the row's line height (~28px) so a media row never out-weighs a text row and
 * the single-column rhythm holds.
 */
const MEDIA_BOX = "h-7 w-[52px] shrink-0 rounded-og-xs border border-og-border";

/**
 * A loading screenshot placeholder. A faint camera glyph over a shimmering box,
 * so a still frame of the running state reads unambiguously as "capturing" — not
 * a broken thumbnail.
 */
export function MediaSkeleton() {
  return (
    <span className={cn(MEDIA_BOX, "relative inline-flex items-center justify-center overflow-hidden bg-og-surface-2")}>
      <span className="absolute inset-0 animate-og-pulse bg-og-surface-3/50" />
      <CameraIcon className="relative size-3.5 text-og-fg-subtle" />
    </span>
  );
}

/** A standardized "tool ran, produced no image" placeholder in the media slot. */
export function MediaEmpty() {
  return (
    <span className={cn(MEDIA_BOX, "inline-flex items-center justify-center bg-og-bg")}>
      <CameraOffIcon className="size-3.5 text-og-fg-subtle" />
    </span>
  );
}

/**
 * A small inline screenshot thumbnail that opens the app lightbox on click.
 *
 * Requires a `LightboxProvider` ancestor for the click-to-expand affordance.
 * Outside one it degrades to a plain, non-interactive image — never a dead
 * "Expand" button that announces an action it cannot perform.
 */
export function Thumbnail({ src, caption, alt = "screenshot" }: { src: string; caption?: string | undefined; alt?: string }) {
  const lightbox = useLightboxOptional();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <MediaEmpty />;
  }
  // A plain <img> (not a framework Image): this is a framework-agnostic SDK, so
  // the host's image component is unavailable and unwanted here.
  const img = (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="h-full w-full object-cover transition-opacity group-hover/thumb:opacity-80"
    />
  );
  if (!lightbox) {
    return <span className={cn(MEDIA_BOX, "inline-flex overflow-hidden bg-og-bg")}>{img}</span>;
  }
  // The thumbnail is a real, independently-focusable button nested inside the
  // row's disclosure trigger. It stops both pointer AND keyboard activation from
  // bubbling, so opening the lightbox never also toggles the row.
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        lightbox.open(src, caption);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
        }
      }}
      className={cn(
        MEDIA_BOX,
        "group/thumb relative inline-flex overflow-hidden bg-og-bg outline-none",
        "focus-visible:ring-2 focus-visible:ring-og-accent",
      )}
      aria-label="Expand screenshot"
    >
      {img}
    </button>
  );
}

/**
 * The expanded screenshot inside a tool body: a contained, clickable preview
 * (opens the lightbox) with a quiet caption. Constrained height + object-contain
 * so it never breaks the row layout. Like {@link Thumbnail}, it degrades to a
 * plain image outside a `LightboxProvider`.
 */
export function ScreenshotFigure({ src, caption, alt = "screenshot" }: { src: string; caption?: string | undefined; alt?: string }) {
  const lightbox = useLightboxOptional();
  const [failed, setFailed] = useState(false);
  const surface = "block w-full overflow-hidden rounded-og-md border border-og-border bg-og-bg";
  // A plain <img>, like {@link Thumbnail} — a framework-agnostic SDK has no host
  // Image component to defer to.
  const img = <img src={src} alt={alt} onError={() => setFailed(true)} className="max-h-80 w-full object-contain" />;
  return (
    <figure className="m-0 min-w-0">
      {failed ? (
        <div className="rounded-og-md border border-og-border bg-og-bg px-3 py-6 text-center font-og-mono text-og-xs text-og-fg-subtle">
          image unavailable
        </div>
      ) : lightbox ? (
        <button type="button" onClick={() => lightbox.open(src, caption)} className={surface} aria-label="Expand screenshot">
          {img}
        </button>
      ) : (
        <div className={surface}>{img}</div>
      )}
      {caption ? <figcaption className="mt-1.5 font-og-mono text-og-xs text-og-fg-subtle">{caption}</figcaption> : null}
    </figure>
  );
}
