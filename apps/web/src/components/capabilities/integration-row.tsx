import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type {
  IntegrationChip,
  IntegrationMark,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { cn } from "@/lib/utils";

/** Provider mark: the hosted logo when we have one, otherwise a monogram. */
export function IntegrationMarkView({
  mark,
  name,
  size = "md",
}: {
  mark: IntegrationMark;
  name: string;
  size?: "sm" | "md";
}) {
  const [failed, setFailed] = useState(false);
  const box = cn(
    "grid shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-bg",
    size === "md" ? "size-10" : "size-8",
  );
  if ("logoSrc" in mark && !failed) {
    return (
      <span className={box} aria-hidden="true">
        <img
          src={mark.logoSrc}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className={cn("object-contain", size === "md" ? "size-6" : "size-5")}
        />
      </span>
    );
  }
  return (
    <span
      className={cn(box, "text-fg-muted", size === "md" ? "text-sm font-semibold" : "text-xs")}
      aria-hidden="true"
      title={name}
    >
      {mark.monogram}
    </span>
  );
}

const CHIP_TONE: Record<IntegrationChip["tone"], { text: string; dot: string | null }> = {
  ok: { text: "text-status-idle border-status-idle/30", dot: "bg-status-idle" },
  warn: { text: "text-status-waiting border-status-waiting/30", dot: "bg-status-waiting" },
  idle: { text: "text-fg-muted border-border", dot: "bg-fg-subtle/50" },
  plain: { text: "text-fg-muted border-border", dot: null },
};

export function IntegrationChipView({ chip }: { chip: IntegrationChip }) {
  const tone = CHIP_TONE[chip.tone];
  return (
    <span
      data-integration-chip={chip.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface px-2 py-0.5 text-2xs font-medium",
        tone.text,
      )}
    >
      {tone.dot ? <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden /> : null}
      {chip.label}
    </span>
  );
}

/**
 * One identical row per integration: mark, name, one-line description, one
 * state chip, chevron. The whole row is a button that opens the detail sheet.
 */
export function IntegrationRow({
  model,
  onOpen,
}: {
  model: Pick<IntegrationViewModel, "id" | "name" | "description" | "mark" | "chip">;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-integration-row={model.id}
      aria-label={`${model.name}. ${model.chip.label}`}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left",
        "transition-colors hover:border-border-strong hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "pointer-coarse:min-h-11",
      )}
    >
      <IntegrationMarkView mark={model.mark} name={model.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{model.name}</span>
        <span className="mt-0.5 block truncate text-xs text-fg-muted">{model.description}</span>
      </span>
      <IntegrationChipView chip={model.chip} />
      <ChevronRightIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
    </button>
  );
}
