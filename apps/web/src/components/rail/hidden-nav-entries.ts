// Built-in rail entries a person (or the workspace default) hides
// (docs/sidebar-layout.md, `hiddenNavEntries`). The page you are on, and an
// entry with something waiting for you, still shows.
import { useSidebarLayout } from "@/components/sidebar-layout/use-sidebar-layout";
import { APPS_WORKSPACE_ITEM, navItemKey, type WorkspaceConfigTarget } from "./workspace-nav-data";

/** Each entry's rail key (`navItemKey`): Apps and Artifacts share a page. */
const ENTRY_TARGETS: Readonly<Record<string, WorkspaceConfigTarget | string>> = {
  capabilities: "/workspaces/$workspaceId/plugins",
  knowledge: "/workspaces/$workspaceId/state",
  automations: "/workspaces/$workspaceId/automations",
  agents: "/workspaces/$workspaceId/agents",
  meetings: "/workspaces/$workspaceId/meetings",
  artifacts: "/workspaces/$workspaceId/artifacts",
  apps: navItemKey(APPS_WORKSPACE_ITEM),
  get_started: "/workspaces/$workspaceId/get-started",
};

/** A rail destination's entry id (`navItemKey` to `inbox`, `agents`, ...), for ordering. */
export function navEntryKey(target: string): string {
  for (const [entry, key] of Object.entries(ENTRY_TARGETS)) if (key === target) return entry;
  return target.replace(/[^a-z]+/g, "_");
}

/**
 * The entries this person hides: the inbox, and the rail destinations by
 * `navItemKey`. Hiding Artifacts hides Apps too, its tab, so a rail trimmed
 * before Apps existed stays as it was.
 */
export function hiddenNavEntries(hidden: readonly string[]): {
  inbox: boolean;
  targets: ReadonlySet<string>;
} {
  const entries = hidden.includes("artifacts") ? [...hidden, "apps"] : hidden;
  return {
    inbox: hidden.includes("inbox"),
    targets: new Set(entries.flatMap((entry) => ENTRY_TARGETS[entry] ?? [])),
  };
}

export function useHiddenNavEntries(workspaceId: string) {
  // The last known choice draws at once on a reload (see useSidebarLayout).
  const { options } = useSidebarLayout(workspaceId);
  return hiddenNavEntries(options?.hiddenNavEntries ?? []);
}
