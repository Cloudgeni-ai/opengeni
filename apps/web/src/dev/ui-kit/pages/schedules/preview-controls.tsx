/**
 * Kit chrome above a page preview: switch the preview's state, and answer the
 * pending product questions both ways. Not part of the product.
 */
import { useId, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

export interface PreviewToggleOption<Value extends string> {
  value: Value;
  label: string;
}

/** One labelled toggle. The first option is the recommendation. */
export function PreviewToggle<Value extends string>({
  tag,
  label,
  value,
  options,
  onChange,
}: {
  /** "Q25", or omit for a state toggle. */
  tag?: string;
  label: string;
  value: Value;
  options: readonly PreviewToggleOption<Value>[];
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p
        id={labelId}
        className="flex min-w-0 items-baseline gap-1.5 text-xs leading-4.5 text-fg-muted"
      >
        {tag ? <span className="shrink-0 font-medium text-fg">{tag}</span> : null}
        <span className="min-w-0">{label}</span>
      </p>
      <SegmentedControl<Value>
        aria-labelledby={labelId}
        size="sm"
        value={value}
        onValueChange={onChange}
        options={options}
        className="max-w-full self-start"
      />
    </div>
  );
}

export function PreviewControls({
  state,
  questions,
  onReset,
}: {
  /** Toggles for the preview's data and situation. */
  state?: ReactNode;
  /** Toggles for pending product questions. */
  questions?: ReactNode;
  onReset?: () => void;
}) {
  return (
    <div className="@container/controls mb-4 min-w-0 rounded-[14px] border border-border bg-surface px-4 py-3.5">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <p className="min-w-0 text-xs leading-4.5 text-fg-muted">
          Preview only. Flip the questions you haven't answered yet to see both answers. The first
          option is the recommendation.
        </p>
        {onReset ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onReset}
            className="-my-1 shrink-0 text-fg-muted hover:text-fg pointer-coarse:h-11"
          >
            <RotateCcwIcon aria-hidden="true" />
            Reset preview
          </Button>
        ) : null}
      </div>
      {state ? (
        <div className="mt-3 grid min-w-0 gap-x-6 gap-y-3 @2xl/controls:grid-cols-2 @5xl/controls:grid-cols-3">
          {state}
        </div>
      ) : null}
      {questions ? (
        <div className="mt-3 grid min-w-0 gap-x-6 gap-y-3 border-t border-border pt-3 @2xl/controls:grid-cols-2 @5xl/controls:grid-cols-3">
          {questions}
        </div>
      ) : null}
    </div>
  );
}
