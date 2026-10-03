import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  MailIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { SEMANTIC_TONE_META, StatusDot, type SemanticTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   StatusBadge (design brief 7.12) - the one status vocabulary.

   Always a dot (or an icon) plus a sentence-case label, never color alone.
   Tones: green is fine, purple needs you, amber is working, red failed, grey
   is paused or off. Plans, scopes, types and counts are MetaChips, not
   statuses; "Primary" is a role, so it is a MetaChip too.

   Three looks, one vocabulary:
   - "dot"      A. Dot and label, no pill. The quietest; for rows.
   - "outline"  B. 22px bordered pill. The Capabilities chip; headers, sheets.
   - "tinted"   C. Soft status fill. Louder; for alerts.
   -------------------------------------------------------------------------- */

export type StatusBadgeVariant = "dot" | "outline" | "tinted";

interface ProductStatusMeta {
  label: string;
  tone: SemanticTone;
  /** The icon used when `icon="auto"`. Falls back to the tone's icon. */
  icon?: LucideIcon;
  /** Live states pulse their dot (reduced-motion safe). */
  live?: boolean;
}

/**
 * Every status the product shows, with its one label and one tone. Add a
 * status here rather than inventing a label at the call site.
 */
export const PRODUCT_STATUSES = {
  // Green: fine.
  connected: { label: "Connected", tone: "success" },
  active: { label: "Active", tone: "success" },
  succeeded: { label: "Succeeded", tone: "success" },
  installed: { label: "Installed", tone: "success" },
  ready: { label: "Ready", tone: "success" },
  // Purple: needs you.
  needs_you: { label: "Needs you", tone: "attention" },
  needs_reconnect: { label: "Needs reconnect", tone: "attention" },
  pending_review: { label: "Pending review", tone: "attention" },
  near_limit: { label: "Near limit", tone: "attention" },
  // Amber: working.
  running: { label: "Running", tone: "progress", live: true },
  syncing: { label: "Syncing", tone: "progress", live: true },
  // Red: failed.
  failed: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "danger", icon: ClockIcon },
  invite_failed: { label: "Invitation failed", tone: "danger", icon: MailIcon },
  out_of_usage: { label: "Out of usage", tone: "danger" },
  limit_reached: { label: "Limit reached", tone: "danger" },
  // Grey: paused or off.
  paused: { label: "Paused", tone: "neutral", icon: CirclePauseIcon },
  queued: { label: "Queued", tone: "neutral", icon: CircleDashedIcon },
  invited: { label: "Invited", tone: "neutral", icon: MailIcon },
  not_connected: { label: "Not connected", tone: "neutral" },
  unavailable: { label: "Unavailable", tone: "neutral", icon: CircleSlashIcon },
  suspended: { label: "Suspended", tone: "neutral", icon: BanIcon },
  revoked: { label: "Revoked", tone: "neutral", icon: BanIcon },
  never_run: { label: "Never run", tone: "neutral", icon: CircleDashedIcon },
  off: { label: "Off", tone: "neutral" },
} as const satisfies Record<string, ProductStatusMeta>;

export type ProductStatus = keyof typeof PRODUCT_STATUSES;

export const PRODUCT_STATUS_KEYS = Object.keys(PRODUCT_STATUSES) as ProductStatus[];

const TONE_ICON: Record<SemanticTone, LucideIcon> = {
  success: CircleCheckIcon,
  attention: CircleAlertIcon,
  progress: LoaderCircleIcon,
  danger: CircleXIcon,
  neutral: CircleMinusIcon,
};

const VARIANT_CLASS: Record<StatusBadgeVariant, string> = {
  dot: "gap-1.5 text-xs leading-4 font-medium text-fg-muted",
  outline:
    "h-5.5 gap-1.5 rounded-full border border-border bg-surface px-2 text-2xs font-medium text-fg",
  tinted: "h-5.5 gap-1.5 rounded-full border px-2 text-2xs font-medium",
};

/** Resolves the label and tone for a status key or an explicit tone. */
export function resolveStatus(
  status: ProductStatus | undefined,
  tone: SemanticTone | undefined,
): { label: string | null; tone: SemanticTone; meta: ProductStatusMeta | null } {
  const meta: ProductStatusMeta | null = status ? PRODUCT_STATUSES[status] : null;
  return { label: meta?.label ?? null, tone: tone ?? meta?.tone ?? "neutral", meta };
}

export interface StatusBadgeProps {
  /** A known product status. Gives the label, tone and icon. */
  status?: ProductStatus;
  /** Overrides the status tone, or sets it for a custom label. */
  tone?: SemanticTone;
  /** Overrides the label, for example "Invited · expires in 5 days". */
  children?: ReactNode;
  /** A (dot), B (outline, the default) or C (tinted). */
  variant?: StatusBadgeVariant;
  /** "auto" uses the status icon instead of the dot; pass a node for a custom one. */
  icon?: "auto" | ReactNode;
  /** Pulse the dot. Defaults to on for live statuses (Running, Syncing). */
  pulse?: boolean;
  /**
   * Why this status, and who can fix it. Shown in a touch-safe tooltip and
   * read by screen readers; the badge becomes focusable.
   */
  reason?: ReactNode;
  className?: string;
}

export function StatusBadge({
  status,
  tone: toneProp,
  children,
  variant = "outline",
  icon,
  pulse,
  reason,
  className,
}: StatusBadgeProps) {
  const { label, tone, meta } = resolveStatus(status, toneProp);
  const toneMeta = SEMANTIC_TONE_META[tone];
  const text = children ?? label;
  const live = pulse ?? meta?.live ?? false;

  let marker: ReactNode;
  if (icon === "auto") {
    const Icon = meta?.icon ?? TONE_ICON[tone];
    marker = (
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0",
          toneMeta.text,
          tone === "neutral" && "text-fg-subtle",
          Icon === LoaderCircleIcon && "motion-safe:animate-spin",
        )}
      />
    );
  } else if (icon) {
    marker = (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 [&>svg]:size-3",
          toneMeta.text,
          tone === "neutral" && "text-fg-subtle",
        )}
      >
        {icon}
      </span>
    );
  } else {
    marker = <StatusDot tone={tone} size="sm" pulse={live} />;
  }

  const badge = (
    <span
      data-slot="status-badge"
      data-tone={tone}
      data-variant={variant}
      tabIndex={reason ? 0 : undefined}
      // The reason is already in the badge's text for screen readers; an
      // explicit undefined stops the tooltip from describing it a second time.
      aria-describedby={undefined}
      className={cn(
        "inline-flex max-w-full min-w-0 shrink-0 items-center align-middle whitespace-nowrap",
        VARIANT_CLASS[variant],
        variant === "tinted" && toneMeta.soft,
        variant === "tinted" && (tone === "neutral" ? "text-fg-muted" : toneMeta.text),
        // A tooltip trigger: a 44px tall tap area on touch, without changing the layout.
        reason &&
          "relative cursor-help rounded-full pointer-coarse:after:absolute pointer-coarse:after:inset-x-0",
        reason &&
          (variant === "dot"
            ? "pointer-coarse:after:-inset-y-3.5"
            : "pointer-coarse:after:-inset-y-3"),
        className,
      )}
    >
      {marker}
      <span className="min-w-0 truncate">{text}</span>
      {reason ? <span className="sr-only">. {reason}</span> : null}
    </span>
  );

  return reason ? <ReasonTooltip reason={reason}>{badge}</ReasonTooltip> : badge;
}

/** A placeholder while a status is loading. Same footprint as the badge. */
export function StatusBadgeSkeleton({
  variant = "outline",
  className,
}: {
  variant?: StatusBadgeVariant;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label="Loading status"
      data-slot="status-badge-skeleton"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 align-middle",
        variant === "dot" ? "h-4" : "h-5.5 rounded-full border border-border bg-surface px-2",
        className,
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-surface-3" />
      <span className="h-2 w-14 rounded-full bg-surface-3 motion-safe:animate-pulse" />
    </span>
  );
}
