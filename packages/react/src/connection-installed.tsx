import type { ReactNode } from "react";

export type ConnectionInstalledItem = {
  id: string;
  name: string;
  status: string;
  icon?: ReactNode;
  needsAttention?: boolean;
  onOpen: () => void;
};

/** Compact account/service shortcuts. The host supplies authoritative status. */
export function ConnectionInstalled({
  items,
  title = "Connected",
  className = "",
}: {
  items: ConnectionInstalledItem[];
  title?: string;
  className?: string;
}) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className={`og-connection-installed ${className}`}>
      <h2>
        {title} <span>{items.length}</span>
      </h2>
      <div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onOpen}
            title={item.status}
            aria-label={`${item.name} · ${item.status}`}
          >
            {item.icon}
            <span>{item.name}</span>
            {item.needsAttention ? <span aria-label="Needs attention">!</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
