import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useOpenGeniText, type OpenGeniText } from "./messages/runtime";

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
  /**
   * Something you already have shows one status line ("Installed · Workspace")
   * in place of its description, and no glyph unless it needs attention: the
   * row itself opens it.
   */
  statusLine?: string | undefined;
  onOpen: () => void;
};

const labels = (t: OpenGeniText): Record<CapabilityCatalogStatus, string> => ({
  available: t("capabilityCatalogRow.availableToAdd"),
  added: t("capabilityCatalogRow.added"),
  attention: t("capabilityCatalogRow.needsAttention"),
  unavailable: t("capabilityCatalogRow.unavailable"),
  loading: t("capabilityCatalogRow.working"),
});

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
  const t = useOpenGeniText();
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
        {label ?? labels(t)[status]}
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
  statusLine,
  onOpen,
  className = "",
  ...props
}: CapabilityCatalogRowProps) {
  const quiet = statusLine !== undefined && (status === "added" || status === "available");
  return (
    <button
      {...props}
      type="button"
      className={`og-capability-catalog-row ${className}`}
      data-row-status={status}
      // A quiet row has no indicator, so the row itself carries the status.
      {...(quiet ? { "data-status": status } : {})}
      onClick={onOpen}
    >
      {icon ? <span className="og-capability-catalog-icon">{icon}</span> : null}
      <span className="og-capability-catalog-copy">
        <strong>{name}</strong>
        {statusLine !== undefined ? (
          <span className="og-capability-catalog-status-line">{statusLine}</span>
        ) : description ? (
          <span>{description}</span>
        ) : null}
      </span>
      {quiet ? null : (
        <CapabilityCatalogIndicator
          status={status}
          label={statusLabel}
          showLabel={showStatusLabel && statusLine === undefined}
        />
      )}
    </button>
  );
}
