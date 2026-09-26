import { useId, useState, type ReactNode } from "react";
import { ChevronDownIcon, RotateCcwIcon } from "lucide-react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

import { usePickState } from "../../picks";
import {
  alternativeLetter,
  alternativeMeta,
  getSection,
  type SectionKey,
} from "../../sections/registry";
import { kitHref, useKitNavigate, useKitView } from "../../view";
import {
  resetAnswers,
  setAnswer,
  useRecommendedAnswers,
  useStoredAnswers,
  useAnswers,
  type AnswerKey,
  type VariableSetAnswers,
} from "./answers";

/* ----------------------------------------------------------------------------
   Kit chrome for the Variable sets page previews: the open-question toggles,
   a chip row for preview state, and the picks the page is built from. None
   of this ships; the page inside the preview frame does.
   -------------------------------------------------------------------------- */

interface Question<Key extends AnswerKey> {
  key: Key;
  number: string;
  title: string;
  options: { value: VariableSetAnswers[Key]; label: string }[];
}

type AnyQuestion = { [Key in AnswerKey]: Question<Key> }[AnswerKey];

const QUESTIONS: AnyQuestion[] = [
  {
    key: "opens",
    number: "Q19",
    title: "Where a set opens",
    options: [
      { value: "page", label: "Its own page" },
      { value: "sheet", label: "Right sheet" },
      { value: "inline", label: "In place" },
    ],
  },
  {
    key: "inUse",
    number: "Q21",
    title: "Delete a set in use",
    options: [
      { value: "explain", label: "Explain in a dialog" },
      { value: "disable", label: "Disable it" },
    ],
  },
  {
    key: "reveal",
    number: "Q17",
    title: "Reveal secrets in the UI",
    options: [
      { value: "no", label: "No, write-only" },
      { value: "yes", label: "Yes, audited" },
    ],
  },
  {
    key: "plain",
    number: "Q17 next",
    title: "Show plain config values",
    options: [
      { value: "hidden", label: "Not yet" },
      { value: "shown", label: "Shipped" },
    ],
  },
  {
    key: "versions",
    number: "Q18",
    title: "Version numbers and dots",
    options: [
      { value: "removed", label: "Removed" },
      { value: "kept", label: "Kept" },
    ],
  },
  {
    key: "verbs",
    number: "Q16",
    title: "Delete or Revoke",
    options: [
      { value: "delete", label: "Delete, Replace value" },
      { value: "revoke", label: "Revoke, Rotate" },
    ],
  },
];

function QuestionControl({ question }: { question: AnyQuestion }) {
  const answers = useAnswers();
  const recommended = useRecommendedAnswers();
  const labelId = useId();
  const value = answers[question.key];
  const recommendedLabel = question.options.find(
    (option) => option.value === recommended[question.key],
  )?.label;
  const differs = value !== recommended[question.key];
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <p id={labelId} className="min-w-0 text-sm leading-5 font-medium text-fg">
          <span className="mr-1.5 text-xs font-medium text-fg-subtle tabular-nums">
            {question.number}
          </span>
          {question.title}
        </p>
        <span
          className={cn(
            "shrink-0 text-xs leading-4.5",
            differs ? "font-medium text-status-waiting" : "text-fg-subtle",
          )}
        >
          {differs ? "Not the recommendation" : "Recommended"}
        </span>
      </div>
      <SegmentedControl
        aria-labelledby={labelId}
        size="sm"
        className="self-start"
        value={value}
        onValueChange={(next) =>
          setAnswer(question.key, next as VariableSetAnswers[typeof question.key])
        }
        options={question.options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />
      {differs && recommendedLabel ? (
        <p className="text-xs leading-4.5 text-fg-subtle">We recommend: {recommendedLabel}</p>
      ) : null}
    </div>
  );
}

/** The open questions that change these pages, with one toggle each. */
export function QuestionToggles({
  keys,
  collapsible = false,
}: {
  keys?: AnswerKey[];
  /** Start closed behind a Show button (side by side, where room is short). */
  collapsible?: boolean;
}) {
  const stored = useStoredAnswers();
  const answers = useAnswers();
  const recommended = useRecommendedAnswers();
  const [open, setOpen] = useState(!collapsible);
  const bodyId = useId();
  const changed = Object.keys(stored).length > 0;
  const shown = keys ? QUESTIONS.filter((question) => keys.includes(question.key)) : QUESTIONS;
  const differing = shown.filter((question) => answers[question.key] !== recommended[question.key]);
  return (
    <div
      className={cn(
        "@container/questions min-w-0 rounded-[14px] border border-border bg-surface px-4 pt-3",
        open ? "pb-1" : "pb-3",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm leading-5 font-semibold text-fg">Open questions</p>
          <p className="text-xs leading-4.5 text-fg-muted">
            {open
              ? "Not answered yet. Flip one to see the page with the other answer; both page previews follow."
              : differing.length
                ? `${differing.length} not on the recommendation: ${differing.map((question) => question.number).join(", ")}.`
                : `${shown.length} questions, all on the recommendation.`}
          </p>
        </div>
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[10px] px-2 text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:h-11"
          >
            {open ? "Hide" : "Show"}
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-4 transition-transform duration-[120ms]", open && "rotate-180")}
            />
          </button>
        ) : null}
        {changed && open ? (
          <button
            type="button"
            onClick={resetAnswers}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-sm font-medium text-brand transition-colors duration-[120ms] hover:bg-surface-2 pointer-coarse:h-11"
          >
            <RotateCcwIcon aria-hidden="true" className="size-3.5" />
            Back to recommended
          </button>
        ) : null}
      </div>
      <div
        id={bodyId}
        hidden={!open}
        className="mt-1 grid min-w-0 divide-y divide-border @2xl/questions:grid-cols-2 @2xl/questions:gap-x-8 @2xl/questions:divide-y-0 @4xl/questions:grid-cols-3"
      >
        {shown.map((question) => (
          <QuestionControl key={question.key} question={question} />
        ))}
      </div>
    </div>
  );
}

/** A small chip group for preview state (kit chrome, not a product control). */
export function ChipGroup<Value extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: { value: Value; label: ReactNode }[];
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-fg-subtle">{label}</span>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors duration-[120ms] pointer-coarse:h-9",
              active
                ? "border-brand/40 bg-brand/10 text-brand"
                : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const PAGE_PICKS: SectionKey[] = [
  "navigation",
  "page-header",
  "list-row",
  "section",
  "detail-sheet",
  "empty-state",
  "form-dialog",
  "destructive-confirm",
  "secret-values",
  "segmented-control",
  "status-badge",
  "disclosure",
  "tabs-toolbar",
];

/** The picks this page is built from, each a link to its component. */
export function PicksUsed() {
  const state = usePickState();
  const view = useKitView();
  const navigate = useKitNavigate(view);
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5">
      {PAGE_PICKS.map((key) => {
        const section = getSection(key);
        const picked = state.picks[key];
        const id = picked ?? section.recommended ?? "a";
        const name = alternativeMeta(key, id)?.name;
        return (
          <li key={key} className="min-w-0">
            <a
              href={kitHref({ section: key, theme: view.theme, width: view.width })}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                navigate({ section: key });
              }}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-xs text-fg-muted transition-colors duration-[120ms] hover:border-border-strong hover:text-fg pointer-coarse:h-9"
            >
              <span className="font-medium text-fg">{section.title}</span>
              <span className="truncate">
                {alternativeLetter(id)}
                {name ? ` · ${name}` : ""}
              </span>
              {picked ? null : <span className="text-fg-subtle">(default)</span>}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
