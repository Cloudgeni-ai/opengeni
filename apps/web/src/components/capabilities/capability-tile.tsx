import { memo } from "react";
import { BookOpenIcon } from "lucide-react";
import { CapabilityCatalogRow } from "@opengeni/react/connect";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { catalogStatusForChip } from "./integration-view-model";
import { capabilityStateChip, type ConnectionHealth } from "@/lib/capabilities";
import type { CapabilityCatalogItem } from "@/types";

/** One full-row action; adding a connection always begins with its setup dialog. */
export const CapabilityTile = memo(function CapabilityTile({
  item,
  logoSrc,
  health,
  onOpen,
}: {
  item: CapabilityCatalogItem;
  logoSrc: string | null;
  health?: ConnectionHealth | undefined;
  onOpen: () => void;
  /** @deprecated Kept for callers during migration; the entire row now opens setup. */
  onQuickConnect?: (() => void) | undefined;
}) {
  const chip = capabilityStateChip(item, health);
  return (
    <CapabilityCatalogRow
      data-capability-catalog-tile={item.id}
      name={item.name}
      description={item.description ?? undefined}
      icon={
        item.kind === "skill" ? (
          <BookOpenIcon aria-hidden="true" />
        ) : (
          <CapabilityLogo src={logoSrc} name={item.name} size="md" />
        )
      }
      status={catalogStatusForChip(chip)}
      statusLabel={chip.label}
      onOpen={onOpen}
    />
  );
});
