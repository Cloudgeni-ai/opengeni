import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, Loader2Icon, PlusIcon } from "lucide-react";

export type CapabilityCatalogStatus =
  | "available"
  | "added"
  | "attention"
  | "unavailable"
  | "loading";

export type CapabilityCatalogRowProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "onClick" | "name"
> & {
  name: string;
  description?: string | undefined;
  icon?: ReactNode;
  status?: CapabilityCatalogStatus;
  statusLabel?: string | undefined;
  /** Preserve opaque host status text when adopting this row without typed health. */
  showStatusLabel?: boolean;
  onOpen: () => void;
};

const labels: Record<CapabilityCatalogStatus, string> = {
  available: "Available to add",
  added: "Added",
  attention: "Needs attention",
  unavailable: "Unavailable",
  loading: "Working",
};

/** A display-only state. The entire catalog row is the action, never this glyph. */
export function CapabilityCatalogIndicator({
  status = "available",
  label,
  showLabel = false,
}: {
  status?: CapabilityCatalogStatus;
  label?: string | undefined;
  showLabel?: boolean;
}) {
  const Icon =
    status === "added"
      ? CheckIcon
      : status === "attention" || status === "unavailable"
        ? AlertTriangleIcon
        : status === "loading"
          ? Loader2Icon
          : PlusIcon;
  return (
    <span className="og-capability-catalog-indicator" data-status={status}>
      <Icon aria-hidden="true" />
      <span
        className={
          showLabel || status === "attention" || status === "unavailable"
            ? "og-capability-catalog-notice"
            : "og-capability-catalog-sr-only"
        }
      >
        {label ?? labels[status]}
      </span>
    </span>
  );
}

/** Shared by connections, skills, and plugins: one row, one focus target, one action. */
export function CapabilityCatalogRow({
  name,
  description,
  icon,
  status = "available",
  statusLabel,
  showStatusLabel = false,
  onOpen,
  className = "",
  ...props
}: CapabilityCatalogRowProps) {
  return (
    <button
      {...props}
      type="button"
      className={`og-capability-catalog-row ${className}`}
      onClick={onOpen}
    >
      {icon ? <span className="og-capability-catalog-icon">{icon}</span> : null}
      <span className="og-capability-catalog-copy">
        <strong>{name}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <CapabilityCatalogIndicator status={status} label={statusLabel} showLabel={showStatusLabel} />
    </button>
  );
}
