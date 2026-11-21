// Where an app sits in the sidebar (docs/sidebar-layout.md), carried in its
// package. Export reads the app's links in the workspace's default sidebar;
// install adds the same links to the new app, through the sidebar's own
// change path so its limits and checks apply.
import {
  APP_PACKAGE_SIDEBAR_MAX,
  type AccessGrant,
  readStoredSidebarLayout,
  type AppPackageProblem,
  type AppPackageSidebarItem,
  type ResolvedSidebarItem,
  type SidebarLayoutChange,
} from "@opengeni/contracts";
import {
  hasPermission,
  readSidebarLayoutForGrant,
  updateSidebarLayoutForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { readSidebarLayouts } from "@opengeni/db";

function message(error: unknown, context: string): string {
  const detail = error instanceof Error && error.message ? error.message.slice(0, 500) : "";
  return detail ? `Failed ${context}: ${detail}` : `Failed ${context}`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function placement(item: Record<string, unknown>, group?: string): AppPackageSidebarItem {
  const path = text(item.path);
  const label = text(item.label);
  return {
    ...(path ? { path } : {}),
    ...(label ? { label } : {}),
    ...(group ? { group } : {}),
  };
}

/**
 * The app's links in the workspace default sidebar (not anyone's own
 * changes): each link's page and label, and the label of the group it's in.
 */
export async function exportAppSidebar(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  notExported: AppPackageProblem[],
): Promise<AppPackageSidebarItem[]> {
  try {
    const rows = await readSidebarLayouts(
      deps.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      null,
    );
    const layout = readStoredSidebarLayout(rows.workspace?.layout);
    const id = appId.toLowerCase();
    const isApp = (item: Record<string, unknown>) =>
      item.type === "app" && typeof item.appId === "string" && item.appId.toLowerCase() === id;
    const found: AppPackageSidebarItem[] = [];
    for (const item of layout.items) {
      if (isApp(item)) found.push(placement(item));
      else if (item.type === "group" && Array.isArray(item.items)) {
        const group = text(item.label);
        for (const child of item.items)
          if (child && typeof child === "object" && isApp(child as Record<string, unknown>))
            found.push(placement(child as Record<string, unknown>, group));
      }
    }
    if (found.length > APP_PACKAGE_SIDEBAR_MAX)
      notExported.push({
        part: "sidebar",
        reason: `Only the first ${APP_PACKAGE_SIDEBAR_MAX} sidebar links were kept`,
      });
    return found.slice(0, APP_PACKAGE_SIDEBAR_MAX);
  } catch (error) {
    notExported.push({ part: "sidebar", reason: message(error, "reading the sidebar") });
    return [];
  }
}

function linksApp(items: readonly ResolvedSidebarItem[], appId: string): boolean {
  const id = appId.toLowerCase();
  return items.some((item) =>
    item.type === "group"
      ? item.items.some((child) => child.type === "app" && child.appId.toLowerCase() === id)
      : item.type === "app" && item.appId.toLowerCase() === id,
  );
}

/**
 * Add the package's sidebar links for the new app: to the workspace default
 * when the installer is a workspace admin, otherwise to their own sidebar. A
 * link goes into a group with the same name when there is one, else into a
 * new group. Nothing is added when the app already has a link (a replayed
 * install). Returns how many links were added; failures are reported.
 */
export async function installAppSidebar(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  items: readonly AppPackageSidebarItem[],
  notInstalled: AppPackageProblem[],
): Promise<number> {
  if (items.length === 0) return 0;
  const scope = hasPermission(grant.permissions, "workspace:admin") ? "workspace" : "personal";
  try {
    const current = await readSidebarLayoutForGrant(deps, grant);
    if (scope === "personal" && !current.personal.available) {
      notInstalled.push({
        part: "sidebar",
        reason: "Only a person or a workspace admin can add sidebar links",
      });
      return 0;
    }
    const level =
      scope === "workspace" ? (current.workspace.items ?? current.items) : current.items;
    if (linksApp(level, appId)) return 0;
    const groups = new Map<string, string>();
    for (const item of level)
      if (item.type === "group") groups.set(item.label.trim().toLowerCase(), item.id);
    const changes: SidebarLayoutChange[] = [];
    const newGroups = new Map<string, { label: string; links: AppPackageSidebarItem[] }>();
    const link = (item: AppPackageSidebarItem) => ({
      type: "app" as const,
      appId,
      ...(item.path ? { path: item.path } : {}),
      ...(item.label ? { label: item.label } : {}),
    });
    for (const item of items) {
      const key = item.group?.trim().toLowerCase();
      const groupId = key ? groups.get(key) : undefined;
      if (!key || !item.group) changes.push({ op: "add", item: link(item) });
      else if (groupId) changes.push({ op: "add", item: link(item), groupId });
      else {
        const entry = newGroups.get(key) ?? { label: item.group, links: [] };
        entry.links.push(item);
        newGroups.set(key, entry);
      }
    }
    for (const entry of newGroups.values())
      changes.push({
        op: "add",
        item: { type: "group", label: entry.label, items: entry.links.map(link) },
      });
    await updateSidebarLayoutForGrant(deps, grant, { scope, changes });
    return items.length;
  } catch (error) {
    notInstalled.push({ part: "sidebar", reason: message(error, "adding sidebar links") });
    return 0;
  }
}
