import { memo } from "react";

import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { IntegrationStateIndicator } from "@/components/capabilities/integration-row";
import {
  capabilityAuthHint,
  capabilityCuration,
  capabilityItemKindLabel,
  capabilityStateChip,
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
  onOpen,
  onQuickConnect,
}: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  onOpen: () => void;
  onQuickConnect?: () => void;
}) {
  const authHint = capabilityAuthHint(item);
  const curation = capabilityCuration(item);
  const chip = capabilityStateChip(item);
  return (
    <div
      data-capability-catalog-tile={item.id}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface/50 p-3",
        "transition-colors hover:border-border-strong",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.name} details`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium text-fg">{item.name}</h3>
            {curation.official ? (
              <span
                data-capability-official
                className="inline-flex shrink-0 items-center rounded-full border border-brand/40 bg-brand/10 px-1.5 text-2xs font-medium uppercase tracking-wide text-brand"
                title="Published by the provider on its own domain"
              >
                Official
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
      <span className="flex shrink-0 items-center">
        <IntegrationStateIndicator chip={chip} onQuickConnect={onQuickConnect} />
      </span>
    </div>
  );
});
