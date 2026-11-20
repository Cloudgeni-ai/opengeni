// The customizable sidebar's reads and changes (docs/sidebar-layout.md), shared
// by the HTTP route and the agent tools. The workspace default is set by
// workspace admins; each person's own changes sit on top. Every app item is
// resolved against the reader's own access, so the sidebar never shows an app
// they can't open, and deleted or archived apps drop out by themselves.
import {
  applyPersonalSidebarChanges,
  applyWorkspaceSidebarChanges,
  EMPTY_SIDEBAR_PERSONAL_CHANGES,
  mergeSidebarLayout,
  readStoredSidebarLayout,
  readStoredSidebarPersonalChanges,
  SIDEBAR_LIVE_LIST_DEFAULT_LIMIT,
  SIDEBAR_LIVE_LIST_LABELS,
  SIDEBAR_LIVE_LIST_MAX_LIMIT,
  SidebarLayoutChangeError,
  sidebarPersonalChangesCustomized,
  type AccessGrant,
  type MergedSidebarChild,
  type MergedSidebarItem,
  type NewSidebarItem,
  type ResolvedSidebarChild,
  type ResolvedSidebarItem,
  type SidebarAppLinkItem,
  type SidebarLayoutResponse,
  type SidebarLiveListKind,
  type UpdateSidebarLayoutRequest,
} from "@opengeni/contracts";
import {
  readSidebarApps,
  readSidebarLayouts,
  writeSidebarLayout,
  type Database,
  type SidebarAppSummary,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { siteViewerForGrant } from "../domain/site-audience";

type SidebarDeps = { db: Database };

/** Refused because the layout changed since it was read; read it again and retry. */
export const SIDEBAR_LAYOUT_CONFLICT_MESSAGE =
  "The sidebar changed meanwhile; read it again and retry.";
export const SIDEBAR_LAYOUT_ADMIN_MESSAGE =
  "Only workspace admins change the workspace's default sidebar.";
export const SIDEBAR_LAYOUT_PERSON_MESSAGE =
  "Only a person has a sidebar of their own; use scope workspace as an admin.";

function newItemSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function isAdmin(grant: AccessGrant): boolean {
  return hasPermission(grant.permissions, "workspace:admin");
}

function collectAppIds(items: readonly MergedSidebarItem[], into: Set<string>): void {
  for (const item of items) {
    if (item.type === "app") into.add(item.appId.toLowerCase());
    if (item.type === "group") collectAppIds(item.items, into);
  }
}

function listLimits(items: readonly MergedSidebarItem[], into: Map<SidebarLiveListKind, number>) {
  for (const item of items) {
    if (item.type === "live_list")
      into.set(
        item.list,
        Math.max(into.get(item.list) ?? 0, item.limit ?? SIDEBAR_LIVE_LIST_DEFAULT_LIMIT),
      );
    if (item.type === "group") listLimits(item.items, into);
  }
}

type AppView = {
  apps: Map<string, SidebarAppSummary>;
  lists: Record<SidebarLiveListKind, SidebarAppSummary[]>;
  appsReadable: boolean;
};

function resolveChild(item: MergedSidebarChild, view: AppView): ResolvedSidebarChild | null {
  switch (item.type) {
    case "app": {
      const app = view.apps.get(item.appId.toLowerCase());
      if (!app) return null;
      return {
        id: item.id,
        origin: item.origin,
        type: "app",
        appId: app.appId,
        path: item.path ?? null,
        label: item.label ?? app.title,
      };
    }
    case "link":
      return { id: item.id, origin: item.origin, type: "link", url: item.url, label: item.label };
    case "live_list": {
      if (!view.appsReadable) return null;
      const limit = item.limit ?? SIDEBAR_LIVE_LIST_DEFAULT_LIMIT;
      return {
        id: item.id,
        origin: item.origin,
        type: "live_list",
        list: item.list,
        label: item.label ?? SIDEBAR_LIVE_LIST_LABELS[item.list],
        limit,
        apps: view.lists[item.list].slice(0, limit),
      };
    }
    default:
      return null;
  }
}

function resolveItem(
  item: MergedSidebarItem,
  view: AppView,
  keepEmptyGroups: boolean,
): ResolvedSidebarItem | null {
  if (item.type !== "group") return resolveChild(item, view);
  const children = item.items
    .map((child) => resolveChild(child, view))
    .filter((child): child is ResolvedSidebarChild => child !== null);
  // A group whose every item this person can't open would be an empty
  // heading; an admin still sees it, to fill it.
  if (!children.length && item.items.length > 0 && !keepEmptyGroups) return null;
  return {
    id: item.id,
    origin: item.origin,
    type: "group",
    label: item.label,
    collapsed: item.collapsed ?? false,
    items: children,
  };
}

async function readAppView(
  deps: SidebarDeps,
  grant: AccessGrant,
  item: readonly MergedSidebarItem[],
): Promise<AppView> {
  const appsReadable = hasPermission(grant.permissions, "artifacts:read");
  const empty: AppView = {
    apps: new Map(),
    lists: { pinned_apps: [], recent_apps: [] },
    appsReadable,
  };
  if (!appsReadable) return empty;
  const appIds = new Set<string>();
  collectAppIds(item, appIds);
  const limits = new Map<SidebarLiveListKind, number>();
  listLimits(item, limits);
  if (!appIds.size && !limits.size) return empty;
  const viewer = await siteViewerForGrant(deps.db, grant);
  const read = await readSidebarApps(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    {
      viewer,
      appIds: [...appIds],
      pinnedLimit: Math.min(limits.get("pinned_apps") ?? 0, SIDEBAR_LIVE_LIST_MAX_LIMIT),
      recentLimit: Math.min(limits.get("recent_apps") ?? 0, SIDEBAR_LIVE_LIST_MAX_LIMIT),
    },
  );
  return {
    apps: read.apps,
    lists: { pinned_apps: read.pinned, recent_apps: read.recent },
    appsReadable,
  };
}

async function personSubject(deps: SidebarDeps, grant: AccessGrant): Promise<string | null> {
  return (await siteViewerForGrant(deps.db, grant)).subjectId;
}

/** The sidebar as this caller sees it, with what they may change. */
export async function readSidebarLayoutForGrant(
  deps: SidebarDeps,
  grant: AccessGrant,
): Promise<SidebarLayoutResponse> {
  const subjectId = await personSubject(deps, grant);
  const rows = await readSidebarLayouts(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    subjectId,
  );
  return await resolveSidebarLayout(deps, grant, subjectId, rows);
}

async function resolveSidebarLayout(
  deps: SidebarDeps,
  grant: AccessGrant,
  subjectId: string | null,
  rows: Awaited<ReturnType<typeof readSidebarLayouts>>,
): Promise<SidebarLayoutResponse> {
  const workspace = readStoredSidebarLayout(rows.workspace?.layout);
  const personal = readStoredSidebarPersonalChanges(rows.personal?.layout);
  const admin = isAdmin(grant);
  const merged = mergeSidebarLayout(
    workspace,
    subjectId === null ? EMPTY_SIDEBAR_PERSONAL_CHANGES : personal,
  );
  const defaults = admin ? mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES) : null;
  const view = await readAppView(deps, grant, [
    ...merged.items,
    ...merged.hidden.map((entry) => entry.item),
    ...(defaults?.items ?? []),
  ]);
  const resolveAll = (items: readonly MergedSidebarItem[], keepEmptyGroups: boolean) =>
    items
      .map((item) => resolveItem(item, view, keepEmptyGroups))
      .filter((item): item is ResolvedSidebarItem => item !== null);
  return {
    items: resolveAll(merged.items, admin),
    hidden: merged.hidden.flatMap((entry) => {
      const item = resolveItem(entry.item, view, true);
      return item ? [{ parentId: entry.parentId, item }] : [];
    }),
    personal: {
      available: subjectId !== null,
      revision: rows.personal?.revision ?? 0,
      customized: subjectId !== null && sidebarPersonalChangesCustomized(personal),
    },
    workspace: {
      revision: rows.workspace?.revision ?? 0,
      canEdit: admin,
      ...(defaults ? { items: resolveAll(defaults.items, true) } : {}),
    },
  };
}

function addedAppIds(request: UpdateSidebarLayoutRequest): string[] {
  const ids: string[] = [];
  const visit = (item: NewSidebarItem | Omit<SidebarAppLinkItem, "id">) => {
    if (item.type === "app") ids.push(item.appId.toLowerCase());
    if (item.type === "group") for (const child of item.items ?? []) visit(child);
  };
  for (const change of request.changes) if (change.op === "add") visit(change.item);
  return [...new Set(ids)];
}

/**
 * Change this caller's own sidebar (`personal`) or the workspace default
 * (`workspace`, admins only). Without `expectedRevision` a concurrent change
 * is re-read and the changes applied again once; with it, a newer revision is
 * refused (409) so nothing is overwritten.
 */
export async function updateSidebarLayoutForGrant(
  deps: SidebarDeps,
  grant: AccessGrant,
  request: UpdateSidebarLayoutRequest,
): Promise<SidebarLayoutResponse> {
  if (request.scope === "workspace" && !isAdmin(grant))
    throw new HTTPException(403, { message: SIDEBAR_LAYOUT_ADMIN_MESSAGE });
  const subjectId = await personSubject(deps, grant);
  if (request.scope === "personal" && subjectId === null)
    throw new HTTPException(403, { message: SIDEBAR_LAYOUT_PERSON_MESSAGE });
  // A new app link must be to an app this caller can open.
  const newApps = addedAppIds(request);
  if (newApps.length) {
    if (!hasPermission(grant.permissions, "artifacts:read"))
      throw new HTTPException(403, { message: "Adding an app needs access to apps." });
    const found = await readSidebarApps(
      deps.db,
      { accountId: grant.accountId, workspaceId: grant.workspaceId },
      { viewer: { subjectId }, appIds: newApps, pinnedLimit: 0, recentLimit: 0 },
    );
    const missing = newApps.find((id) => !found.apps.has(id));
    if (missing)
      throw new HTTPException(422, {
        message: `App ${missing} wasn't found or you can't open it.`,
      });
  }
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  for (let attempt = 0; ; attempt += 1) {
    const rows = await readSidebarLayouts(deps.db, scope, subjectId);
    const target = request.scope === "workspace" ? rows.workspace : rows.personal;
    const current = target?.revision ?? 0;
    if (request.expectedRevision !== undefined && request.expectedRevision !== current)
      throw new HTTPException(409, { message: SIDEBAR_LAYOUT_CONFLICT_MESSAGE });
    const workspace = readStoredSidebarLayout(rows.workspace?.layout);
    let layout: unknown;
    try {
      layout =
        request.scope === "workspace"
          ? applyWorkspaceSidebarChanges(workspace, request.changes, newItemSuffix)
          : applyPersonalSidebarChanges(
              workspace,
              readStoredSidebarPersonalChanges(rows.personal?.layout),
              request.changes,
              newItemSuffix,
            );
    } catch (error) {
      if (error instanceof SidebarLayoutChangeError)
        throw new HTTPException(422, { message: error.message });
      throw error;
    }
    const written = await writeSidebarLayout(deps.db, scope, {
      subjectId: request.scope === "workspace" ? null : subjectId,
      expectedRevision: current,
      layout,
      updatedBy: grant.subjectId,
    });
    if (written) {
      const next =
        request.scope === "workspace"
          ? { ...rows, workspace: written }
          : { ...rows, personal: written };
      return await resolveSidebarLayout(deps, grant, subjectId, next);
    }
    if (request.expectedRevision !== undefined || attempt >= 2)
      throw new HTTPException(409, { message: SIDEBAR_LAYOUT_CONFLICT_MESSAGE });
  }
}
