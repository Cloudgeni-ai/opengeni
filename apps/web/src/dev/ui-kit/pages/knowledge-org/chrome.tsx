import { useId, type ReactNode } from "react";

import { Disclosure } from "@/components/ui/disclosure";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

import { useKitPane } from "../../kit";
import { kitHref } from "../../view";
import { alternativeLetter, getSection } from "../../sections/registry";
import { PICKED_KEYS, type PagePicks, type PickedKey } from "./picks";

/* ----------------------------------------------------------------------------
   Kit chrome around a page preview: the open product questions as small
   toggles (so both answers can be judged in context) and a line that says
   which of Bendik's picks the page is built from.
   -------------------------------------------------------------------------- */

export interface QuestionOption<V extends string> {
  value: V;
  label: string;
}

export interface QuestionToggleProps<V extends string> {
  /** "Q36". */
  id: string;
  /** The question in a few words: "Suspend keeps workspace access". */
  question: ReactNode;
  options: readonly [QuestionOption<V>, QuestionOption<V>, ...QuestionOption<V>[]];
  value: V;
  onChange: (value: V) => void;
  /** The option the brief recommends. */
  recommended: V;
  /** Replaces the line under the question; null hides it. */
  note?: ReactNode | null;
}

/** One open question: its number, the question and a 2-3 way switch between answers. */
export function QuestionToggle<V extends string>({
  id,
  question,
  options,
  value,
  onChange,
  recommended,
  note,
}: QuestionToggleProps<V>) {
  const labelId = useId();
  const recommendedLabel = options.find((option) => option.value === recommended)?.label;
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3 @[560px]/questions:flex-row @[560px]/questions:items-center @[560px]/questions:justify-between @[560px]/questions:gap-4">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-px inline-flex h-4.5 shrink-0 items-center rounded-full border border-border bg-surface-2 px-1.5 text-2xs font-medium text-fg-muted tabular-nums">
          {id}
        </span>
        <div className="min-w-0">
          <p id={labelId} className="text-sm leading-5 font-medium text-fg">
            {question}
          </p>
          {note === null ? null : (
            <p className="text-xs leading-4.5 text-fg-subtle">
              {note ??
                (value === recommended
                  ? "Showing the recommendation"
                  : `We recommend: ${recommendedLabel}`)}
            </p>
          )}
        </div>
      </div>
      <SegmentedControl
        size="sm"
        aria-labelledby={labelId}
        options={options}
        value={value}
        onValueChange={onChange}
        className="shrink-0 self-start @[560px]/questions:self-center"
      />
    </div>
  );
}

/**
 * The open questions for one page, in a disclosure (open by default on
 * desktop, closed in the phone frame so the page comes first), two columns
 * when there is room.
 */
export function QuestionBar({
  title = "Open questions",
  total,
  changed,
  description,
  children,
}: {
  title?: string;
  /** How many questions there are. */
  total: number;
  /** How many show the other answer right now. */
  changed: number;
  description?: ReactNode;
  children: ReactNode;
}) {
  const pane = useKitPane();
  const summary =
    changed === 0
      ? `${total} questions. The page shows the recommended answers.`
      : `${total} questions. ${changed} ${changed === 1 ? "shows" : "show"} the other answer.`;
  return (
    <Disclosure
      variant="row"
      title={`${title} (${total})`}
      summary={summary}
      defaultOpen={!pane.mobileFrame}
      className="@container/questions"
      contentClassName="pl-0"
    >
      {description ? <p className="text-xs leading-4.5 text-fg-muted">{description}</p> : null}
      <div className="mt-1 grid min-w-0 divide-y divide-border @[1040px]/questions:grid-cols-2 @[1040px]/questions:gap-x-10 @[1040px]/questions:divide-y-0 @[1040px]/questions:[&>*]:border-b @[1040px]/questions:[&>*]:border-border">
        {children}
      </div>
    </Disclosure>
  );
}

/** "Built from your picks: Page header B · Navigation A · ..." with links to each section. */
export function PicksLine({
  picks,
  keys = PICKED_KEYS,
  className,
}: {
  picks: PagePicks;
  keys?: readonly PickedKey[];
  className?: string;
}) {
  return (
    <p className={cn("text-xs leading-5 text-fg-subtle", className)}>
      <span className="font-medium text-fg-muted">Built from your picks: </span>
      {keys.map((key, index) => (
        <span key={key}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <a
            href={kitHref({ section: key })}
            className="rounded-[4px] underline-offset-2 hover:text-fg hover:underline"
          >
            {getSection(key).title} {alternativeLetter(picks.letters[key])}
          </a>
        </span>
      ))}
      . Pick a different version in any of these and the page follows.
    </p>
  );
}

/** "Preview with: Content | Nothing yet | Loading", for the page's data states. */
export function PreviewDataToggle<V extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly [QuestionOption<V>, QuestionOption<V>, ...QuestionOption<V>[]];
  value: V;
  onChange: (value: V) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span id={labelId} className="text-xs leading-4.5 font-medium text-fg-muted">
        Preview with
      </span>
      <SegmentedControl
        size="sm"
        aria-labelledby={labelId}
        options={options}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
}
