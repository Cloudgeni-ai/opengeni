import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { HelpTip } from "@/components/ui/inline-help";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectMenuProps } from "@/components/ui/select-menu";
import { useSettingRowField } from "@/components/ui/setting-row";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Preview controls: the open product questions and the preview state, shown
   above a page preview. Kit chrome, built from the real segmented control.
   -------------------------------------------------------------------------- */

export interface PreviewToggle<V extends string = string> {
  /** "Q4", or null for a preview state. */
  tag?: string;
  label: string;
  /** The full question and the recommendation, in a help tooltip. */
  help?: ReactNode;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
}

function ToggleItem<V extends string>({ toggle }: { toggle: PreviewToggle<V> }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4.5 font-medium text-fg-muted">
        {toggle.tag ? <span className="text-fg-subtle tabular-nums">{toggle.tag}</span> : null}
        <span className="min-w-0">{toggle.label}</span>
        {toggle.help ? <HelpTip label={`About ${toggle.label}`}>{toggle.help}</HelpTip> : null}
      </span>
      <SegmentedControl
        size="sm"
        aria-label={toggle.tag ? `${toggle.tag} ${toggle.label}` : toggle.label}
        value={toggle.value}
        onValueChange={toggle.onChange}
        options={toggle.options}
      />
    </div>
  );
}

function ToggleRow({
  title,
  toggles,
  aside,
}: {
  title: string;
  toggles: PreviewToggle<string>[];
  aside?: ReactNode;
}) {
  if (toggles.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-2 px-4 py-3 @3xl/kit-section:grid-cols-[112px_minmax(0,1fr)]">
      <p className="pt-1.5 text-xs leading-4.5 font-medium text-fg">{title}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
        {toggles.map((toggle) => (
          <ToggleItem key={`${toggle.tag ?? ""}${toggle.label}`} toggle={toggle} />
        ))}
        {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
      </div>
    </div>
  );
}

/**
 * Two rows: "Open questions" (each defaults to the recommended answer, flip
 * it to see the other answer) and "Preview as" (who is looking, what data).
 */
export function PreviewControls({
  questions,
  states,
  aside,
  className,
}: {
  questions: PreviewToggle<string>[];
  states: PreviewToggle<string>[];
  /** Trailing kit action on the preview row, for example "Start over". */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 divide-y divide-border rounded-[14px] border border-border bg-surface",
        className,
      )}
    >
      <ToggleRow title="Open questions" toggles={questions} />
      <ToggleRow title="Preview" toggles={states} aside={aside} />
    </div>
  );
}

/** Narrows a typed toggle for the `PreviewControls` list. */
export function asToggle<V extends string>(spec: PreviewToggle<V>): PreviewToggle<string> {
  return spec as unknown as PreviewToggle<string>;
}

export const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

export type YesNo = "yes" | "no";

/* ----------------------------------------------------------------------------
   Layout helpers.
   -------------------------------------------------------------------------- */

/**
 * The element's width, measured before paint and kept current. The page
 * frame lays itself out from its own width, so it behaves the same in the
 * kit column, a side-by-side pane and the 390px phone frame.
 */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * A SelectMenu inside a SettingRow, named by the row's label and described by
 * its description. SelectMenu only reads Field context, so this wires the row.
 */
export function RowSelect<V extends string>(props: SelectMenuProps<V>) {
  const field = useSettingRowField();
  return (
    <SelectMenu
      size="sm"
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      {...props}
    />
  );
}
