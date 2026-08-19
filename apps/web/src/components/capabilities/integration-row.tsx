import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  ContactIcon,
  FilesIcon,
  Loader2Icon,
  MailIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type ComponentType } from "react";

import type {
  IntegrationChip,
  IntegrationMark,
  IntegrationMarkIcon,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { cn } from "@/lib/utils";

const MARK_ICONS: Record<IntegrationMarkIcon, ComponentType<{ className?: string }>> = {
  mail: MailIcon,
  calendar: CalendarIcon,
  contacts: ContactIcon,
  files: FilesIcon,
  cloud: CloudIcon,
};

/**
 * Provider mark: the hosted logo when we have one, then the named product
 * glyph, and a monogram only as the last resort.
 */
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
  if ("icon" in mark) {
    const Icon = MARK_ICONS[mark.icon];
    return (
      <span className={cn(box, "text-fg-muted")} aria-hidden="true" title={name}>
        <Icon className={size === "md" ? "size-5" : "size-4"} />
      </span>
    );
  }
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
 * The compact circular connection-state indicator shared by every row/tile
 * across Integrations and Connectors. Tone `idle` ("Not connected") is the
 * only interactive one - the caller wires `onQuickConnect` for it - every
 * other tone renders as a decorative, non-interactive mark. `loading`
 * (undefined tone lookup) is handled by the caller passing `busy`.
 *
 * The glyph itself is always `aria-hidden`, so every non-interactive state
 * carries the chip label as visually hidden text: colour and shape are never
 * the only way to tell Connected from Needs attention (WCAG 1.1.1, 1.4.1).
 */
export function IntegrationStateIndicator({
  chip,
  busy = false,
  onQuickConnect,
}: {
  chip: IntegrationChip;
  /** Renders a spinner instead of the tone icon, e.g. while a mutation is in flight. */
  busy?: boolean;
  onQuickConnect?: () => void;
}) {
  const circle = "grid size-7 shrink-0 place-items-center rounded-full border";
  const label = <span className="sr-only">{busy ? "Working" : chip.label}</span>;
  if (busy) {
    return (
      <span className={cn(circle, "border-border bg-surface text-fg-subtle")}>
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
        {label}
      </span>
    );
  }
  if (chip.tone === "ok") {
    return (
      <span className={cn(circle, "border-status-idle/30 bg-status-idle/10 text-status-idle")}>
        <CheckIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    );
  }
  if (chip.tone === "warn") {
    return (
      <span
        className={cn(circle, "border-status-waiting/30 bg-status-waiting/10 text-status-waiting")}
      >
        <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    );
  }
  if (chip.tone === "idle" && onQuickConnect) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onQuickConnect();
        }}
        aria-label="Connect"
        title="Connect"
        className={cn(
          circle,
          "border-border text-fg-muted transition-colors hover:border-brand hover:text-brand",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        )}
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
      </button>
    );
  }
  // idle without a quick-connect action, or plain (admin-managed): the neutral
  // dot, never a plus that looks like the interactive one but does nothing.
  return (
    <span className={cn(circle, "border-border text-fg-subtle")}>
      <span className="size-1.5 rounded-full bg-fg-subtle/50" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The row body's accessible name. `aria-label` replaces the button's contents,
 * so the description line inside it is never announced: a caller with a fact
 * that must be heard (a Bundle's kind and provenance) supplies it as
 * `accessibleDetail` and it is spoken between the name and the state.
 */
function rowAccessibleName(model: {
  name: string;
  chip: IntegrationChip;
  accessibleDetail?: string;
}): string {
  const detail = model.accessibleDetail?.trim();
  return detail
    ? `${model.name}. ${detail}. ${model.chip.label}`
    : `${model.name}. ${model.chip.label}`;
}

/**
 * One identical row per integration: mark, name, one-line description, a
 * compact connection-state indicator, chevron. Two real sibling buttons, never
 * nested: the large body opens detail, the small trailing indicator is the
 * one-click/one-dialog quick-connect fast path when the caller provides one.
 */
export function IntegrationRow({
  model,
  onOpen,
  onQuickConnect,
  busy = false,
}: {
  model: Pick<
    IntegrationViewModel,
    "id" | "name" | "description" | "mark" | "chip" | "accessibleDetail"
  >;
  onOpen: () => void;
  /** Only passed when a fast one-click/one-dialog connect action exists for the current state. */
  onQuickConnect?: () => void;
  /** True while this integration has a real mutation in flight (its adapter says so). */
  busy?: boolean;
}) {
  return (
    <div
      data-integration-row={model.id}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3",
        "transition-colors hover:border-border-strong",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={rowAccessibleName(model)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left",
          "hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "pointer-coarse:min-h-11",
        )}
      >
        <IntegrationMarkView mark={model.mark} name={model.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{model.name}</span>
          <span className="mt-0.5 block truncate text-xs text-fg-muted">{model.description}</span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      </button>
      <span className="flex shrink-0 items-center">
        <IntegrationStateIndicator
          chip={model.chip}
          busy={busy || (model.chip.tone === "plain" && model.chip.label === "Loading")}
          {...(onQuickConnect ? { onQuickConnect } : {})}
        />
      </span>
    </div>
  );
}
