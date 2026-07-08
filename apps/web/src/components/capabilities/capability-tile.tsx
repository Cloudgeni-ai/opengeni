import { memo } from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { capabilityAuthHint, capabilityKindLabel } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

/**
 * One catalog tile in the Browse grid. The whole tile is the click target
 * (opens the detail sheet) — no per-tile enable button crowding the grid.
 */
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
      className={cn(
        "group flex h-full flex-col gap-3 rounded-xl border border-border bg-surface/50 p-4 text-left",
        "transition-all hover:-translate-y-px hover:border-border-strong hover:bg-surface hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <CapabilityLogo src={logoSrc} name={item.name} />
        <div className="flex items-center gap-1.5">
          {item.enabled ? (
            <span className="inline-flex items-center gap-1 text-2xs font-medium text-status-idle">
              <span className="size-1.5 rounded-full bg-status-idle" />
              Enabled
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-fg">{item.name}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">
          {item.description ?? "No description provided."}
        </p>
      </div>

      <div className="flex items-center gap-2 text-2xs text-fg-subtle">
        <span className="truncate">{capabilityKindLabel(item.kind)}</span>
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
