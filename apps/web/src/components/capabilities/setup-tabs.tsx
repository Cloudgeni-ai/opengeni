import { Link } from "@tanstack/react-router";

import { LineTabsLink, LineTabsNav } from "@opengeni/react/ui/line-tabs";
import type { CapabilitiesSection } from "./capabilities-section";

/**
 * The Capabilities page's tabs: connections, skills, and ready-made agents,
 * apps, skills and plugins to add. Each tab is its own address, so links,
 * Back and phones work.
 */
const TAB_LABEL: Record<CapabilitiesSection, string> = {
  connections: "Connections",
  skills: "Skills",
  "ready-made": "Ready-made",
};

const TAB_ORDER: readonly CapabilitiesSection[] = ["connections", "skills", "ready-made"];

export function setupTabLabel(tab: CapabilitiesSection): string {
  return TAB_LABEL[tab];
}

export function SetupTabs({
  workspaceId,
  active,
}: {
  workspaceId: string;
  active: CapabilitiesSection;
}) {
  return (
    <LineTabsNav aria-label="Capabilities">
      {TAB_ORDER.map((tab) => (
        <LineTabsLink key={tab} asChild active={tab === active}>
          <Link
            to="/workspaces/$workspaceId/plugins"
            params={{ workspaceId }}
            search={tab === "connections" ? {} : { section: tab }}
          >
            {TAB_LABEL[tab]}
          </Link>
        </LineTabsLink>
      ))}
    </LineTabsNav>
  );
}
