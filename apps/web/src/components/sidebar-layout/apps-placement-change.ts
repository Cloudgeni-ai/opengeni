import type { SidebarAppsPlacement, SidebarLayoutChange } from "@opengeni/sdk";

/**
 * The change that sets where apps show. In Sessions and Hidden are written as
 * sessionsShowApps, which every server version takes (the server keeps
 * appsPlacement in step); only Own section needs the newer field.
 */
export function appsPlacementChange(placement: SidebarAppsPlacement): SidebarLayoutChange {
  return placement === "section"
    ? { op: "options", appsPlacement: placement }
    : { op: "options", sessionsShowApps: placement === "sessions" };
}
