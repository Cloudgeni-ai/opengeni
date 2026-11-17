import type { ReactNode } from "react";
import type { CapabilityCatalogStatus } from "@opengeni/react/connect";
import {
  catalogStatusForChip,
  type IntegrationChip,
} from "@opengeni/react/app/components/capabilities/integration-view-model";
import type { ConnectAction } from "@opengeni/react/app/components/capabilities/capability-detail-sheet";
import {
  capabilityReconnectPlan,
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

/**
 * The one repair a list row runs for an item that needs attention, or null to
 * open the item's page instead. Turning an own account on here is management
 * of an existing account, so it stays available when new setup is blocked; an
 * OAuth sign-in runs from the row only when setup is available; anything that
 * needs a form (an API key) opens the page, which offers the same repair.
 */
export function connectorRowRepairAction(
  item: CapabilityCatalogItem,
  health: ConnectionHealth,
  options: { setupUnavailable: boolean },
): ConnectAction | null {
  const repair = connectionRepair(health);
  if (!repair || health.state !== "attention") return null;
  if (repair === "turn_on_here")
    return health.connection ? { type: "turn_on_here", item, connection: health.connection } : null;
  const plan = capabilityReconnectPlan(item, health);
  if (plan?.kind !== "oauth" || options.setupUnavailable) return null;
  return {
    type: "reconnect_oauth",
    item,
    connectionId: plan.connectionId,
    ownership: plan.ownership,
    ...(plan.connectionWorkspaceId ? { connectionWorkspaceId: plan.connectionWorkspaceId } : {}),
  };
}
