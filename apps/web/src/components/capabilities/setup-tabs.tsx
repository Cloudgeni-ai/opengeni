import { Link } from "@tanstack/react-router";

import { LineTabsLink, LineTabsNav } from "@opengeni/react/ui/line-tabs";
import { useKnowledgeReviewIndicator } from "@/components/rail/use-knowledge-review-indicator";
import type { SetupTab } from "./capabilities-section";

/**
 * The Capabilities page's tabs: what agents can use (connections, skills,
 * plugins), what they know (Knowledge), and ready-made content to add
 * (Gallery). Each tab is its own address, so links, Back and phones work.
 */
const TAB_LABEL: Record<SetupTab, string> = {
  connections: "Connections",
  skills: "Skills",
  plugins: "Plugins",
  knowledge: "Knowledge",
  gallery: "Gallery",
};

const TAB_ORDER: readonly SetupTab[] = ["connections", "skills", "plugins", "knowledge", "gallery"];

export function setupTabLabel(tab: SetupTab): string {
  return TAB_LABEL[tab];
}

export function SetupTabs({ workspaceId, active }: { workspaceId: string; active: SetupTab }) {
  const pendingKnowledge = useKnowledgeReviewIndicator(workspaceId);
  return (
    <LineTabsNav aria-label="Capabilities">
      {TAB_ORDER.map((tab) => (
        <LineTabsLink
          key={tab}
          asChild
          active={tab === active}
          {...(tab === "knowledge" && pendingKnowledge
            ? { count: "•", countTone: "attention" as const, countLabel: "Waiting for review" }
            : {})}
        >
          {tab === "knowledge" ? (
            <Link to="/workspaces/$workspaceId/state" params={{ workspaceId }}>
              {TAB_LABEL[tab]}
            </Link>
          ) : (
            <Link
              to="/workspaces/$workspaceId/plugins"
              params={{ workspaceId }}
              search={tab === "connections" ? {} : { section: tab }}
            >
              {TAB_LABEL[tab]}
            </Link>
          )}
        </LineTabsLink>
      ))}
    </LineTabsNav>
  );
}
