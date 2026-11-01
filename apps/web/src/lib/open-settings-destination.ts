import type { useNavigate } from "@tanstack/react-router";

import type { AvailableHereDestination } from "@/components/settings/available-here";
import type { SharedOverviewDestination } from "@/components/settings/shared-overview";

/**
 * Opens a row of Workspace settings › Available here or Organization settings
 * › Shared: the thing's own page in the workspace the page is anchored on (a
 * vault that works only elsewhere opens in that workspace), or the
 * organization's Models or Developer page.
 */
export function openSettingsDestination(
  navigate: ReturnType<typeof useNavigate>,
  workspaceId: string,
  destination: AvailableHereDestination | SharedOverviewDestination,
) {
  switch (destination.page) {
    case "models":
      void navigate({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId },
        search: { section: "models", workspace: workspaceId },
      });
      return;
    case "developer":
      void navigate({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId },
        search: { section: "developer" },
      });
      return;
    case "plugins":
      void navigate({
        to: "/workspaces/$workspaceId/plugins",
        params: { workspaceId },
        search: destination.section ? { section: destination.section } : {},
      });
      return;
    case "machines":
      void navigate({ to: "/workspaces/$workspaceId/machines", params: { workspaceId } });
      return;
    case "rig":
      void navigate({
        to: "/workspaces/$workspaceId/rigs/$rigId",
        params: { workspaceId, rigId: destination.rigId },
      });
      return;
    case "vault":
      void navigate({
        to: "/workspaces/$workspaceId/secrets/$vaultId",
        params: {
          workspaceId: destination.workspaceId ?? workspaceId,
          vaultId: destination.vaultId,
        },
      });
      return;
    case "knowledge":
      void navigate({
        to: "/workspaces/$workspaceId/state",
        params: { workspaceId },
        search: destination.scope ? { scope: destination.scope } : {},
      });
  }
}
