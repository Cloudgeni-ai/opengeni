import type { ReactNode } from "react";
import { CapabilityCatalogRow } from "./capability-catalog-row";
import { useOpenGeniText } from "./messages/runtime";

export type ConnectionInstalledItem = {
  id: string;
  name: string;
  /** The status line: what it is and whose, such as "Installed · Workspace". */
  status: string;
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
 * "Installed · Workspace".
 */
export function ConnectionInstalled({
  items,
  title: titleProp,
  className = "",
}: {
  items: ConnectionInstalledItem[];
  title?: string;
  className?: string;
}) {
  const t = useOpenGeniText();
  const title = titleProp === undefined ? t("connectionInstalled.connected") : titleProp;
  if (!items.length) return null;
  return (
    <section aria-label={title} className={`og-connection-installed ${className}`}>
      <h2>
        {title} <span>{items.length}</span>
      </h2>
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
            aria-label={`${item.name} · ${item.status}`}
          />
        ))}
      </div>
    </section>
  );
}
