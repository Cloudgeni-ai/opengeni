import type { ReactNode } from "react";
import { CapabilityCatalogIndicator, CapabilityCatalogRow } from "@opengeni/react/connect";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import {
  catalogStatusForChip,
  type IntegrationChip,
  type IntegrationMark,
  type IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { cn } from "@/lib/utils";

/** The same provider logo used by the catalog and details. */
export function IntegrationMarkView({
  mark,
  name,
  size = "md",
}: {
  mark: IntegrationMark;
  name: string;
  size?: "sm" | "md";
}) {
  return (
    <CapabilityLogo
      src={"logoSrc" in mark ? mark.logoSrc : null}
      name={name}
      size={size}
      fallback={mark.monogram}
    />
  );
}

const CHIP_TONE: Record<IntegrationChip["tone"], { text: string; dot: string | null }> = {
  ok: { text: "text-status-idle border-status-idle/30", dot: "bg-status-idle" },
  warn: { text: "text-status-waiting border-status-waiting/30", dot: "bg-status-waiting" },
  idle: { text: "text-fg-muted border-border", dot: "bg-fg-subtle/50" },
  plain: { text: "text-fg-muted border-border", dot: null },
};

/** Detailed status remains available inside management surfaces. */
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

export function IntegrationStateIndicator({
  chip,
  busy = false,
}: {
  chip: IntegrationChip;
  busy?: boolean;
  /** @deprecated Catalog rows now have one action, on their whole body. */
  onQuickConnect?: () => void;
}) {
  return (
    <CapabilityCatalogIndicator
      status={busy ? "loading" : catalogStatusForChip(chip)}
      label={busy ? "Working" : chip.label}
    />
  );
}

/** One full-row action for every integration and bundle. The plus is decorative. */
export function IntegrationRow({
  model,
  onOpen,
  busy = false,
  icon,
}: {
  model: Pick<
    IntegrationViewModel,
    "id" | "name" | "description" | "mark" | "chip" | "accessibleDetail"
  >;
  onOpen: () => void;
  /** @deprecated The row opens its setup/details; no separate quick-connect action. */
  onQuickConnect?: () => void;
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <CapabilityCatalogRow
      data-integration-row={model.id}
      name={model.name}
      description={model.description}
      icon={icon ?? <IntegrationMarkView mark={model.mark} name={model.name} />}
      status={busy ? "loading" : catalogStatusForChip(model.chip)}
      statusLabel={busy ? "Working" : model.chip.label}
      aria-label={[model.name, model.accessibleDetail?.trim(), model.chip.label]
        .filter(Boolean)
        .join(". ")}
      onOpen={onOpen}
    />
  );
}
