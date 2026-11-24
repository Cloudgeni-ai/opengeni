import type { ReactNode } from "react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { useOpenGeniText } from "./messages/runtime";

export type ConnectionInstalledItem = {
  id: string;
  name: string;
  /** The status line: what it is and whose, such as "Installed · Workspace". */
  status: string;
  /**
   * "description" shows the status line as plain muted text, for hosts whose
   * rows describe each item rather than report a connection state.
   */
  statusTone?: "state" | "description" | undefined;
  /** @deprecated The status line always shows. */
  showStatus?: boolean;
  icon?: ReactNode;
  needsAttention?: boolean;
  disabled?: boolean;
  onOpen: () => void;
};

/**
 * What you already have, first on each setup page: the same rows as the
 * catalog below it (logo, name, one status line), two columns where there is
 * room. The host supplies the authoritative status line, such as
 * "Installed · Workspace". A null `title` leaves the heading to the host's
 * page; `aria-label` then names the list.
 */
export function ConnectionInstalled({
  items,
  title: titleProp,
  "aria-label": ariaLabel,
  className = "",
}: {
  items: ConnectionInstalledItem[];
  title?: string | null;
  "aria-label"?: string;
  className?: string;
}) {
  const t = useOpenGeniText();
  const title = titleProp === undefined ? t("connectionInstalled.connected") : titleProp;
  if (!items.length) return null;
  return (
    <section
      aria-label={ariaLabel ?? title ?? undefined}
      className={`og-connection-installed ${className}`}
    >
      {title !== null ? (
        <h2>
          {title} <span>{items.length}</span>
        </h2>
      ) : null}
      <div className="og-connection-catalog" data-columns="2">
        {items.map((item) => (
          <CapabilityCatalogRow
            key={item.id}
            name={item.name}
            icon={item.icon}
            status={item.needsAttention ? "attention" : "added"}
            statusLabel={item.needsAttention ? t("connectionInstalled.needsAttention") : undefined}
            statusLine={item.status}
            onOpen={item.onOpen}
            disabled={item.disabled}
            title={item.status}
            data-status-tone={item.statusTone === "description" ? "description" : undefined}
          />
        ))}
      </div>
    </section>
  );
}
