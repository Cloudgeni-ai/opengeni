import { chordKeys, chordLabel, type Chord, type ChordPlatform } from "../../lib/actions/chords";
import { cn } from "../../lib/utils";

/**
 * A chord as small keycaps: ⌘ ⇧ O on Mac, Ctrl Shift O elsewhere. Screen
 * readers hear the whole chord once ("⌘⇧O") instead of each cap.
 */
export function Keycaps(props: {
  chord: Chord;
  platform: ChordPlatform;
  /** Shows this on the last cap instead of the chord's key, e.g. "1–9" for a range. */
  keyLabel?: string | undefined;
  /** What screen readers hear instead of the chord's own label. */
  ariaLabel?: string | undefined;
  className?: string | undefined;
}) {
  const keys = chordKeys(props.chord, props.platform);
  if (props.keyLabel) keys[keys.length - 1] = props.keyLabel;
  return (
    // role="img" makes the label count: browsers and screen readers ignore
    // aria-label on a plain span, and the caps themselves are hidden.
    <span
      role="img"
      className={cn("inline-flex shrink-0 items-center gap-0.5", props.className)}
      aria-label={props.ariaLabel ?? chordLabel(props.chord, props.platform)}
    >
      {keys.map((key) => (
        <kbd
          key={key}
          aria-hidden="true"
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-surface-2 px-1 font-sans text-[11px] leading-none font-medium text-fg-muted",
            // Mac symbols read better a touch larger than letters.
            key.length === 1 && /[⌘⇧⌥⌃↩⇥⌫↑↓←→]/.test(key) ? "text-[12px]" : null,
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** A tooltip's text with its key after it, quieter: "Search sessions  ⌘K". */
export function TooltipWithKeys(props: {
  label: string;
  shortcut: { label: string } | null | undefined;
}) {
  if (!props.shortcut) return <>{props.label}</>;
  return (
    <span className="inline-flex items-center gap-2">
      {props.label}
      <span className="opacity-60">{props.shortcut.label}</span>
    </span>
  );
}
