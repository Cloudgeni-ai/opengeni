import type { ReactNode } from "react";
import type { CapabilityCatalogStatus } from "@opengeni/react/connect";
import {
  catalogStatusForChip,
  type IntegrationChip,
} from "@opengeni/react/app/components/capabilities/integration-view-model";
import {
  connectionAttentionLabel,
  connectionRepair,
  connectionRepairLabel,
  type ConnectionHealth,
} from "@opengeni/react/app/lib/capabilities";
import type { CapabilityCatalogItem } from "@opengeni/react/app/types";
import { Button } from "@opengeni/react/ui/button";
import { capabilityTitle } from "./capability-copy";

/**
 * A connector row's status from the same health as its page: an item that
 * needs attention names the reason and offers that page's one repair.
 * `repairable` is false when the viewer can't act on the connection here.
 */
export function connectorRowHealth({
  item,
  health,
  chip,
  repairable,
  busy,
  onRepair,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  chip: IntegrationChip;
  repairable: boolean;
  busy: boolean;
  onRepair: () => void;
}): { status: string; state: CapabilityCatalogStatus; action?: ReactNode } {
  const repair = repairable ? connectionRepair(health) : null;
  if (!repair || health.state !== "attention")
    return { status: chip.label, state: catalogStatusForChip(chip) };
  return {
    status: connectionAttentionLabel(health.reason),
    state: "attention",
    action: (
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRepair}>
        {connectionRepairLabel(repair, capabilityTitle(item))}
      </Button>
    ),
  };
}
