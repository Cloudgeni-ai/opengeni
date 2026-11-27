// The web app's session shell: the shared shell from @opengeni/react with the
// app's own sections in its slots (workspace switcher, inbox and workspace
// shortcuts, account footer, workspace and open-in-app banners).
import { useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useDesktopWorkspace } from "@/components/desktop/desktop-rail";
import { OpenInAppBanner } from "@/components/rail/open-in-app-banner";
import { PrimaryNavExtras, WorkspaceShortcutLinks } from "@/components/rail/primary-nav";
import { RailFooter } from "@/components/rail/rail-footer";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { WorkspacePausedBanner } from "@/components/rail/workspace-paused-banner";
import {
  appsArchivedFromSidebar,
  SidebarLayoutSection,
} from "@/components/sidebar-layout/sidebar-layout-section";
import { appsPlacementChange } from "@/components/sidebar-layout/apps-placement-change";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { toast } from "sonner";
import type { SidebarAppsPlacement } from "@opengeni/sdk";
import { AppPages } from "@opengeni/react/app/routes/app-page";
import { PromotionReviewBanner } from "@/components/rail/promotion-review-banner";
import { workspaceSectionForPath } from "@/components/rail/workspace-nav-data";
import { DesktopUpdateButton } from "@opengeni/react/app/components/desktop/app-update";
import { DesktopThisComputerOffer } from "@opengeni/react/app/components/desktop/this-computer";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import {
  RailBody as SharedRailBody,
  SessionShell,
  SessionShellSlotsProvider,
  type SessionShellSlots,
} from "@opengeni/react/app/components/rail/session-shell";

/**
 * The person's sidebar (docs/sidebar-layout.md) as the Sessions list uses it:
 * whether apps are rows of their own there (null until known, so the list
 * draws the right rows first), and "Add to sidebar" in an app row's menu.
 */
function useSessionsSidebarOptions(workspaceId: string) {
  const { layout, options, update } = useSidebarLayout(workspaceId);
  const sessionsShowApps = options ? options.sessionsShowApps : null;
  const appsPlacement = options ? options.appsPlacement : null;
  const personalAvailable = layout?.personal.available === true;
  const onAppsPlacementChange = useMemo(
    () =>
      personalAvailable
        ? (placement: SidebarAppsPlacement) =>
            void update({
              scope: "personal",
              changes: [appsPlacementChange(placement)],
            }).catch((error: unknown) =>
              toast.error("Couldn't change the sidebar", { description: userErrorText(error) }),
            )
        : undefined,
    [personalAvailable, update],
  );
  const sidebarApps = useMemo(() => {
    if (!layout?.personal.available) return undefined;
    const linked = new Set<string>();
    for (const item of layout.items) {
      if (item.type === "app") linked.add(item.appId.toLowerCase());
      if (item.type === "group")
        for (const child of item.items)
          if (child.type === "app") linked.add(child.appId.toLowerCase());
    }
    // A link shown again means the app was restored: it no longer needs the
    // stand-in, so unpinning it later returns it to the Apps section.
    for (const appId of linked) appsArchivedFromSidebar.delete(appId);
    return {
      has: (appId: string) =>
        linked.has(appId.toLowerCase()) || appsArchivedFromSidebar.has(appId.toLowerCase()),
      add: (appId: string) =>
        void update({
          scope: "personal",
          changes: [{ op: "add", item: { type: "app", appId } }],
        }).catch((error: unknown) =>
          toast.error("Couldn't change the sidebar", { description: userErrorText(error) }),
        ),
    };
  }, [layout, update]);
  return { sessionsShowApps, appsPlacement, onAppsPlacementChange, sidebarApps };
}

function useWebShellSlots(): SessionShellSlots {
  const { collapsed, workspaceId } = useRail();
  const navigate = useNavigate();
  const { sessionsShowApps, appsPlacement, onAppsPlacementChange, sidebarApps } =
    useSessionsSidebarOptions(workspaceId);
  return useMemo(
    () => ({
      switcher: <SwitcherBlock />,
      primaryNav: <PrimaryNavExtras />,
      primaryNavPlacesNewSession: true,
      layout: <SidebarLayoutSection />,
      mobileWorkspacePanel: (
        <>
          <WorkspaceShortcutLinks className="px-2" />
          <div className="my-2 border-t border-border" />
        </>
      ),
      railFooter: (
        <>
          {!collapsed ? <DesktopThisComputerOffer className="mx-2 mt-2" /> : null}
          <DesktopUpdateButton collapsed={collapsed} />
          <RailFooter />
        </>
      ),
      canvasBanners: (
        <>
          <PromotionReviewBanner workspaceId={workspaceId} />
          <WorkspacePausedBanner workspaceId={workspaceId} />
          <OpenInAppBanner />
        </>
      ),
      windowBarSection: (pathname: string) => {
        const section = workspaceSectionForPath(pathname, workspaceId);
        return section
          ? { label: section.label, onClick: () => void navigate({ to: section.path }) }
          : null;
      },
      sessionsShowApps,
      appsPlacement,
      onAppsPlacementChange,
      sidebarApps,
    }),
    [
      collapsed,
      navigate,
      workspaceId,
      sessionsShowApps,
      appsPlacement,
      onAppsPlacementChange,
      sidebarApps,
    ],
  );
}

/** The rail body alone, with the web app's sections (desktop previews render it). */
export function RailBody() {
  return (
    <SessionShellSlotsProvider slots={useWebShellSlots()}>
      <SharedRailBody />
    </SessionShellSlotsProvider>
  );
}

export function RailShell({ children }: { children: ReactNode }) {
  const rail = useRail();
  useDesktopWorkspace(rail.workspaceId);
  return (
    <SessionShell slots={useWebShellSlots()}>
      <AppPages>{children}</AppPages>
    </SessionShell>
  );
}
