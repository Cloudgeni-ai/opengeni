import {
  Children,
  Component,
  createContext,
  useContext,
  useId,
  useMemo,
  type ReactNode,
} from "react";
import { CheckIcon, HammerIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { setNote, setPick, useExplicitPick, useNote } from "./picks";
import {
  alternativeLetter,
  alternativeMeta,
  getSection,
  type AlternativeId,
  type SectionKey,
} from "./sections/registry";
import type { ResolvedTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Pane context: where a section is being rendered.
   -------------------------------------------------------------------------- */

export interface KitPane {
  /** The theme forced on this pane. */
  theme: ResolvedTheme;
  /** 0 for the first (or only) pane; side by side renders a second pane. */
  index: number;
  /** 1, or 2 when side by side. */
  count: number;
  /** True inside the 390px mobile frame. */
  mobileFrame: boolean;
  /** True when the shell already shows the section header above the panes. */
  headerInShell: boolean;
  /** False when the shell shows the notes field once below the panes. */
  notesInPane: boolean;
}

const DEFAULT_PANE: KitPane = {
  theme: "light",
  index: 0,
  count: 1,
  mobileFrame: false,
  headerInShell: false,
  notesInPane: true,
};

export const KitPaneContext = createContext<KitPane>(DEFAULT_PANE);

/** Which pane this render belongs to. Content renders twice when side by side. */
export function useKitPane(): KitPane {
  return useContext(KitPaneContext);
}

const KitSectionContext = createContext<SectionKey | null>(null);

/** The key of the enclosing `KitSection`, or null outside one. */
export function useKitSectionKey(): SectionKey | null {
  return useContext(KitSectionContext);
}

/* ----------------------------------------------------------------------------
   Small shared pieces (kit chrome only, token classes only).
   -------------------------------------------------------------------------- */

function LetterBadge({ id, picked }: { id: AlternativeId; picked?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-xs font-semibold",
        picked
          ? "bg-brand-strong text-brand-fg"
          : "border border-border bg-surface-2 text-fg-muted",
      )}
    >
      {alternativeLetter(id)}
    </span>
  );
}

export function RecommendedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border border-brand/30 bg-brand/5 px-2 text-2xs font-medium text-brand",
        className,
      )}
    >
      Recommended
    </span>
  );
}

/* ----------------------------------------------------------------------------
   Error boundary: a broken section never takes the page down.
   -------------------------------------------------------------------------- */

interface KitErrorBoundaryProps {
  children: ReactNode;
  /** Headline in the fallback. */
  title?: string;
  /** Smaller fallback, for a single alternative or state. */
  compact?: boolean;
  /** Changing this value clears a caught error. */
  resetKey?: unknown;
  onReset?: () => void;
}

interface KitErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

export class KitErrorBoundary extends Component<KitErrorBoundaryProps, KitErrorBoundaryState> {
  override state: KitErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<KitErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: KitErrorBoundaryProps,
    state: KitErrorBoundaryState,
  ): Partial<KitErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { compact, title = "This section is being built" } = this.props;
    return (
      <div
        role="status"
        className={cn(
          "flex min-w-0 flex-col items-start gap-3 rounded-[14px] border border-border bg-surface",
          compact ? "p-4" : "p-6",
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-border bg-surface-2 text-fg-muted">
            <HammerIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{title}</p>
            <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">
              Someone is working on it right now. The rest of the kit keeps working.
            </p>
          </div>
        </div>
        <p className="line-clamp-3 max-w-full font-mono text-xs leading-4.5 break-words text-fg-subtle">
          {error.message}
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-2"
        >
          <RotateCcwIcon className="size-3.5" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
}

/* ----------------------------------------------------------------------------
   KitSection and KitBlock: the body of one component page.
   -------------------------------------------------------------------------- */

/** The section header (group, title, purpose, where it is used), from the registry. */
export function KitSectionHeader({ sectionKey }: { sectionKey: SectionKey }) {
  const section = getSection(sectionKey);
  return (
    <header className="min-w-0 border-b border-border pb-4">
      <p className="text-xs font-medium text-fg-subtle">{section.group}</p>
      <h1 className="mt-1 text-xl font-semibold tracking-[-0.5px] text-fg">{section.title}</h1>
      <p className="mt-1 text-sm text-fg-muted">{section.purpose}</p>
      {section.usedOn ? (
        <p className="mt-2 text-xs leading-4.5 text-fg-subtle">
          <span className="font-medium text-fg-muted">Used on </span>
          {section.usedOn}
        </p>
      ) : null}
    </header>
  );
}

/**
 * Wraps one section's content. Children are blocks (`Fork`, `StatesGrid`,
 * `UsageNotes`, `KitBlock`); each gets 32px of space and a hairline between.
 */
export function KitSection({
  sectionKey,
  children,
}: {
  sectionKey: SectionKey;
  children: ReactNode;
}) {
  const pane = useKitPane();
  return (
    <KitSectionContext.Provider value={sectionKey}>
      <div data-kit-section={sectionKey} className="@container/kit-section min-w-0">
        {pane.headerInShell ? null : (
          <div className="mb-8">
            <KitSectionHeader sectionKey={sectionKey} />
          </div>
        )}
        <div className="flex min-w-0 flex-col divide-y divide-border [&>*]:py-8 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          {children}
        </div>
      </div>
    </KitSectionContext.Provider>
  );
}

/** A titled block inside a section, for anything the other helpers don't cover. */
export function KitBlock({
  title,
  description,
  aside,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Right-aligned next to the title, for example a count or a status. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)}>
      <div className="mb-3 min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-4">
          <h2 id={headingId} className="min-w-0 text-sm font-semibold text-fg">
            {title}
          </h2>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
        {description ? (
          <p className="mt-1 text-xs leading-4.5 text-fg-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A bordered preview canvas, for demos that don't fit a Fork or StatesGrid. */
export function KitCanvas({
  canvas = "bg",
  padding = true,
  className,
  children,
}: {
  /** "bg" is the page canvas; "surface" is the inside of a dialog or sheet. */
  canvas?: "bg" | "surface";
  padding?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[14px] border border-border",
        canvas === "bg" ? "bg-bg" : "bg-surface",
        padding && "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Fork and Alternative: the side-by-side versions with a Pick button.
   -------------------------------------------------------------------------- */

interface ForkContextValue {
  sectionKey: SectionKey;
  recommended: AlternativeId | null;
  pick: AlternativeId | null;
}

const ForkContext = createContext<ForkContextValue | null>(null);

function useRequiredSectionKey(explicit: SectionKey | undefined, component: string): SectionKey {
  const inherited = useKitSectionKey();
  const key = explicit ?? inherited;
  if (!key) throw new Error(`${component} needs a pickKey or an enclosing <KitSection>.`);
  return key;
}

/**
 * Alternatives A/B/C side by side on identical fixtures, each with a Pick
 * button. Names, rationales and the recommended default come from the
 * registry; pass `name`/`rationale` on an `Alternative` only to override.
 */
export function Fork({
  pickKey,
  title = "Pick a version",
  description,
  layout = "columns",
  showNote = true,
  children,
}: {
  /** Defaults to the enclosing KitSection's key. */
  pickKey?: SectionKey;
  title?: string;
  /** Defaults to "We recommend B: <why>" from the registry. */
  description?: ReactNode;
  /** "columns" puts versions side by side when there is room; "stack" always stacks them. */
  layout?: "columns" | "stack";
  /** The optional notes field below the versions (the shell shows it once when side by side). */
  showNote?: boolean;
  children: ReactNode;
}) {
  const sectionKey = useRequiredSectionKey(pickKey, "Fork");
  const section = getSection(sectionKey);
  const pick = useExplicitPick(sectionKey);
  const pane = useKitPane();
  const recommended = section.recommended ?? null;
  const forkValue = useMemo(
    () => ({ sectionKey, recommended, pick }),
    [pick, recommended, sectionKey],
  );
  const count = Children.count(children);
  const recommendedLine =
    description ??
    (recommended ? (
      <>
        We recommend {alternativeLetter(recommended)}
        {section.whyRecommended ? `: ${section.whyRecommended}` : "."}
      </>
    ) : null);

  return (
    <ForkContext.Provider value={forkValue}>
      <KitBlock
        title={title}
        description={recommendedLine}
        aside={
          <span className="text-xs font-medium text-fg-subtle">
            {pick ? (
              <span className="inline-flex items-center gap-1 text-brand">
                <CheckIcon className="size-3.5" aria-hidden="true" />
                You picked {alternativeLetter(pick)}
              </span>
            ) : (
              "Not picked yet"
            )}
          </span>
        }
      >
        <div
          className={cn(
            "grid min-w-0 gap-4",
            layout === "columns" && count === 2 && "@2xl/kit-section:grid-cols-2",
            layout === "columns" && count >= 3 && "@4xl/kit-section:grid-cols-3",
          )}
        >
          {children}
        </div>
        {showNote && pane.notesInPane ? (
          <div className="mt-4">
            <KitNote sectionKey={sectionKey} />
          </div>
        ) : null}
      </KitBlock>
    </ForkContext.Provider>
  );
}

/** One version inside a `Fork`. Render the real primitive as children. */
export function Alternative({
  id,
  name,
  rationale,
  canvas = "bg",
  padding = true,
  align = "stretch",
  className,
  children,
}: {
  id: AlternativeId;
  /** Defaults to the registry name. */
  name?: string;
  /** Defaults to the registry rationale. */
  rationale?: ReactNode;
  /** "bg" is the page canvas; "surface" is the inside of a dialog or sheet. */
  canvas?: "bg" | "surface";
  /** Set false for edge-to-edge previews (lists, page frames). */
  padding?: boolean;
  /** "stretch" fills the width, top-aligned; "center" centres small controls. */
  align?: "stretch" | "center";
  className?: string;
  children: ReactNode;
}) {
  const fork = useContext(ForkContext);
  if (!fork) throw new Error("<Alternative> must be inside a <Fork>.");
  const meta = alternativeMeta(fork.sectionKey, id);
  const title = name ?? meta?.name ?? `Version ${alternativeLetter(id)}`;
  const line = rationale ?? meta?.rationale;
  const picked = fork.pick === id;
  const isRecommended = fork.recommended === id;
  const letter = alternativeLetter(id);
  const headingId = useId();

  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-[14px] border bg-surface transition-[border-color,box-shadow] duration-[120ms]",
        picked ? "border-brand ring-2 ring-brand/15" : "border-border",
        className,
      )}
    >
      <header className={cn("px-4 pt-3.5 pb-3 transition-colors", picked && "bg-brand/5")}>
        <div className="flex min-w-0 items-center gap-2">
          <LetterBadge id={id} picked={picked} />
          <h3 id={headingId} className="min-w-0 truncate text-sm font-medium text-fg" title={title}>
            <span className="sr-only">Version {letter}: </span>
            {title}
          </h3>
          {isRecommended ? <RecommendedTag className="ml-auto" /> : null}
        </div>
        {line ? <p className="mt-1.5 text-xs leading-4.5 text-fg-muted">{line}</p> : null}
      </header>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col border-t border-border",
          canvas === "bg" ? "bg-bg" : "bg-surface",
          padding && "p-5",
          align === "center" && "items-center justify-center",
        )}
      >
        <KitErrorBoundary compact title="This version is being built">
          {children}
        </KitErrorBoundary>
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <button
          type="button"
          aria-pressed={picked}
          aria-label={`Pick ${letter}`}
          onClick={() => setPick(fork.sectionKey, picked ? null : id)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-3 text-sm font-medium transition-colors duration-[120ms] pointer-coarse:h-11",
            picked
              ? "border-brand/40 bg-brand/10 text-brand hover:bg-brand/15"
              : "border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-2",
          )}
        >
          {picked ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
          {picked ? "Picked" : `Pick ${letter}`}
        </button>
        {picked ? <span className="text-xs text-fg-subtle">Click again to clear</span> : null}
      </footer>
    </article>
  );
}

/** The optional note for a section, saved in this browser with the picks. */
export function KitNote({ sectionKey, label }: { sectionKey?: SectionKey; label?: string }) {
  const key = useRequiredSectionKey(sectionKey, "KitNote");
  const note = useNote(key);
  const fieldId = useId();
  const hintId = useId();
  return (
    <div className="max-w-[640px] min-w-0">
      <label htmlFor={fieldId} className="text-sm font-medium text-fg">
        {label ?? "Notes"}
        <span className="ml-1.5 text-xs font-normal text-fg-subtle">Optional</span>
      </label>
      <textarea
        id={fieldId}
        aria-describedby={hintId}
        value={note}
        onChange={(event) => setNote(key, event.target.value)}
        rows={2}
        placeholder={
          getSection(key).recommended
            ? "Anything you'd change? For example: B, but with a smaller title."
            : "Anything you'd change here?"
        }
        className="mt-1.5 block w-full resize-y rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong"
      />
      <p id={hintId} className="mt-1 text-xs leading-4.5 text-fg-subtle">
        Saved in this browser and included when you copy your picks.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   StatesGrid and StateCell.
   -------------------------------------------------------------------------- */

/** Every state of the recommended version, in a responsive grid. */
export function StatesGrid({
  title = "States",
  description,
  columns = 3,
  children,
}: {
  title?: string;
  description?: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  children: ReactNode;
}) {
  return (
    <KitBlock title={title} description={description}>
      <div
        className={cn(
          "grid min-w-0 gap-x-4 gap-y-6",
          columns >= 2 && "@xl/kit-section:grid-cols-2",
          columns === 3 && "@4xl/kit-section:grid-cols-3",
          columns === 4 && "@4xl/kit-section:grid-cols-4",
        )}
      >
        {children}
      </div>
    </KitBlock>
  );
}

/** One labelled state. */
export function StateCell({
  label,
  note,
  span,
  canvas = "bg",
  align = "center",
  width = "auto",
  padding = true,
  className,
  children,
}: {
  label: string;
  /** One line under the canvas, for example the disabled reason. */
  note?: ReactNode;
  /** Take 2 columns, or the full row. */
  span?: 2 | "full";
  /** "bg" is the page canvas; "surface" is the inside of a dialog or sheet. */
  canvas?: "bg" | "surface";
  /** "center" for small controls; "stretch" for rows and lists that fill the width. */
  align?: "center" | "stretch";
  /**
   * "mobile" caps the content at 390px. Viewport breakpoints don't change;
   * use the Mobile 390 toggle for a real phone-width render.
   */
  width?: "auto" | "mobile";
  padding?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure
      className={cn(
        "m-0 flex min-w-0 flex-col gap-2",
        span === "full" && "col-span-full",
        span === 2 && "@xl/kit-section:col-span-2",
        className,
      )}
    >
      <figcaption className="text-xs font-medium text-fg-muted">{label}</figcaption>
      <div
        className={cn(
          "flex min-h-24 min-w-0 flex-1 flex-col justify-center rounded-[14px] border border-border",
          canvas === "bg" ? "bg-bg" : "bg-surface",
          padding && "p-5",
          align === "center" && "items-center",
        )}
      >
        <KitErrorBoundary compact title="This state is being built">
          {width === "mobile" ? (
            <div className="mx-auto w-full max-w-[390px] min-w-0">{children}</div>
          ) : (
            children
          )}
        </KitErrorBoundary>
      </div>
      {note ? <p className="text-xs leading-4.5 text-fg-subtle">{note}</p> : null}
    </figure>
  );
}

/* ----------------------------------------------------------------------------
   UsageNotes.
   -------------------------------------------------------------------------- */

const NO_ITEMS: ReactNode[] = [];

/** When to use the component and when not to, from the "which control when" table. */
export function UsageNotes({
  title = "When to use",
  use,
  avoid = NO_ITEMS,
  children,
}: {
  title?: string;
  use: ReactNode[];
  avoid?: ReactNode[];
  /** Extra guidance under the lists, for example related components. */
  children?: ReactNode;
}) {
  return (
    <KitBlock title={title}>
      <div className="grid min-w-0 gap-6 @xl/kit-section:grid-cols-2">
        <UsageList label="Use it for" items={use} tone="use" />
        {avoid.length > 0 ? (
          <UsageList label="Don't use it for" items={avoid} tone="avoid" />
        ) : null}
      </div>
      {children ? <div className="mt-4 text-sm text-fg-muted">{children}</div> : null}
    </KitBlock>
  );
}

function UsageList({
  label,
  items,
  tone,
}: {
  label: string;
  items: ReactNode[];
  tone: "use" | "avoid";
}) {
  const Icon = tone === "use" ? CheckIcon : XIcon;
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-fg-subtle">{label}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- static copy, never reordered
          <li key={index} className="flex min-w-0 items-start gap-2 text-sm text-fg">
            <Icon
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0",
                tone === "use" ? "text-status-idle" : "text-fg-subtle",
              )}
            />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Placeholders and page frames.
   -------------------------------------------------------------------------- */

/** Placeholder body for a section that hasn't been built yet. */
export function ComingUp({ note }: { note?: ReactNode }) {
  const sectionKey = useRequiredSectionKey(undefined, "ComingUp");
  const section = getSection(sectionKey);
  return (
    <KitBlock
      title="Coming up"
      description={
        note ??
        (section.alternatives
          ? "These versions are being built from the real components, on the same content."
          : "Coming soon, built from the real components and the shared fixtures.")
      }
    >
      {section.alternatives ? (
        <ol className="flex min-w-0 flex-col divide-y divide-border rounded-[14px] border border-border bg-surface">
          {section.alternatives.map((alternative) => (
            <li key={alternative.id} className="flex min-w-0 items-start gap-3 px-4 py-3">
              <LetterBadge id={alternative.id} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-fg">{alternative.name}</p>
                  {section.recommended === alternative.id ? <RecommendedTag /> : null}
                </div>
                <p className="mt-0.5 text-xs leading-4.5 text-fg-muted">{alternative.rationale}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <KitCanvas canvas="surface">
          <p className="text-sm text-fg-muted">
            Nothing to pick here. Leave a note below if something should change.
          </p>
        </KitCanvas>
      )}
    </KitBlock>
  );
}

/**
 * A frame for a full page composition (the Pages group). The canvas is the
 * app's page background; give it a height to scroll inside the frame.
 */
export function PagePreview({
  label,
  height,
  className,
  children,
}: {
  /** Accessible name, for example "General settings". */
  label?: string;
  /** Fixed frame height in px; content scrolls inside. */
  height?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        "relative min-w-0 overflow-hidden rounded-[16px] border border-border bg-bg",
        className,
      )}
      style={height ? { height } : undefined}
    >
      <div className={cn("min-w-0", height && "h-full overflow-auto")}>{children}</div>
    </div>
  );
}
