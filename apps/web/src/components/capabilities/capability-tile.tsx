import { memo } from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { capabilityAuthHint, capabilityItemKindLabel } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

/** One compact catalog row. The whole row opens the same detail/settings sheet. */
export const CapabilityTile = memo(function CapabilityTile({
  item,
  logoSrc,
  onOpen,
}: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  onOpen: () => void;
}) {
  const authHint = capabilityAuthHint(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-capability-catalog-tile={item.id}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface/50 p-3 text-left",
        "transition-colors hover:border-border-strong hover:bg-surface",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      )}
    >
      <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-fg">{item.name}</h3>
          {item.enabled ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-status-idle">
              <span className="size-1.5 rounded-full bg-status-idle" />
              Enabled
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-fg-muted">
          {item.description ?? "No description provided."}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-2 text-2xs text-fg-subtle sm:flex">
        <span className="truncate">{capabilityItemKindLabel(item)}</span>
        {authHint ? (
          <>
            <span aria-hidden className="text-fg-subtle/50">
              ·
            </span>
            <span className="truncate">{authHint}</span>
          </>
        ) : null}
      </div>
    </button>
  );
});
