import { memo } from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { IntegrationStateIndicator } from "@/components/capabilities/integration-row";
import {
  capabilityAuthHint,
  capabilityCuration,
  capabilityItemKindLabel,
  capabilityStateChip,
  type ConnectionHealth,
} from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

/**
 * One compact catalog row. Two sibling buttons: the body opens the detail
 * sheet, the trailing state indicator is the quick-connect fast path when the
 * caller supplies one (only ever for a not-yet-connected item with a
 * dialog-free or one-dialog connect action).
 */
export const CapabilityTile = memo(function CapabilityTile({
  item,
  logoSrc,
  health,
  onOpen,
  onQuickConnect,
}: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  /** Connection health, so an enabled-but-broken connector never renders as a green check. */
  health?: ConnectionHealth;
  onOpen: () => void;
  onQuickConnect?: () => void;
}) {
  const authHint = capabilityAuthHint(item);
  const curation = capabilityCuration(item);
  const chip = capabilityStateChip(item, health);
  return (
    <div
      data-capability-catalog-tile={item.id}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface/50 p-3",
        "transition-[border-color,background-color,box-shadow] duration-150",
        "hover:border-brand/40 hover:bg-accent hover:shadow-sm",
        "focus-within:border-brand/60 focus-within:ring-1 focus-within:ring-brand/30",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.name}. ${chip.label}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none"
      >
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <div className="min-w-0 flex-1">
          <h3
            data-capability-name
            className="truncate text-sm font-medium text-fg"
            title={item.name}
          >
            {item.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-fg-muted">
            {item.description ?? "No description provided."}
          </p>
          <div
            data-capability-metadata
            className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-fg-subtle"
          >
            {curation.official ? (
              <span
                data-capability-official
                className="inline-flex shrink-0 items-center rounded-full border border-brand/40 bg-brand/10 px-1.5 text-2xs font-medium uppercase tracking-wide text-brand"
                title="Published by the provider on its own domain"
              >
                Official
              </span>
            ) : null}
            <span data-capability-kind className="min-w-0 truncate">
              {capabilityItemKindLabel(item)}
              {authHint ? ` · ${authHint}` : ""}
            </span>
          </div>
        </div>
      </button>
      <span className="flex shrink-0 items-center">
        <IntegrationStateIndicator chip={chip} {...(onQuickConnect ? { onQuickConnect } : {})} />
      </span>
    </div>
  );
});
