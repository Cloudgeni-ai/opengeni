// Built-in rail entries a person (or the workspace default) hides
// (docs/sidebar-layout.md, `hiddenNavEntries`). The page you are on, and an
// entry with something waiting for you, still shows.
import { readResolvedSidebarOptions } from "@opengeni/contracts/sidebar-layout";
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import type { WorkspaceConfigTarget } from "./workspace-nav-data";

const ENTRY_TARGETS: Readonly<Record<string, WorkspaceConfigTarget>> = {
  capabilities: "/workspaces/$workspaceId/plugins",
  knowledge: "/workspaces/$workspaceId/state",
  automations: "/workspaces/$workspaceId/automations",
  agents: "/workspaces/$workspaceId/agents",
  meetings: "/workspaces/$workspaceId/meetings",
  artifacts: "/workspaces/$workspaceId/artifacts",
};

/** The entries this person hides: the inbox, and the rail destinations by route. */
export function hiddenNavEntries(hidden: readonly string[]): {
  inbox: boolean;
  targets: ReadonlySet<string>;
} {
  return {
    inbox: hidden.includes("inbox"),
    targets: new Set(hidden.flatMap((entry) => ENTRY_TARGETS[entry] ?? [])),
  };
}

export function useHiddenNavEntries(workspaceId: string) {
  const { layout } = useSidebarLayout(workspaceId);
  return hiddenNavEntries(readResolvedSidebarOptions(layout?.options).hiddenNavEntries);
}
