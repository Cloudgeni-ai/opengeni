// The web app's session shell: the shared shell from @opengeni/react with the
// app's own sections in its slots (workspace switcher, inbox and workspace
// shortcuts, account footer, workspace and open-in-app banners).
import { useMemo, type ReactNode } from "react";

import { useDesktopWorkspace } from "@/components/desktop/desktop-rail";
import { OpenInAppBanner } from "@/components/rail/open-in-app-banner";
import { PrimaryNavExtras, WorkspaceShortcutLinks } from "@/components/rail/primary-nav";
import { RailFooter } from "@/components/rail/rail-footer";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { WorkspacePausedBanner } from "@/components/rail/workspace-paused-banner";
import { PromotionReviewBanner } from "@/components/rail/promotion-review-banner";
import { DesktopUpdateButton } from "@opengeni/react/app/components/desktop/app-update";
import { DesktopThisComputerOffer } from "@opengeni/react/app/components/desktop/this-computer";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import {
  RailBody as SharedRailBody,
  SessionShell,
  SessionShellSlotsProvider,
  type SessionShellSlots,
} from "@opengeni/react/app/components/rail/session-shell";

function useWebShellSlots(): SessionShellSlots {
  const { collapsed, workspaceId } = useRail();
  return useMemo(
    () => ({
      switcher: <SwitcherBlock />,
      primaryNav: <PrimaryNavExtras />,
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
    }),
    [collapsed, workspaceId],
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
  return <SessionShell slots={useWebShellSlots()}>{children}</SessionShell>;
}
