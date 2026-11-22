// The customizable sidebar's reads and changes (docs/sidebar-layout.md), shared
// by the HTTP route and the agent tools. The workspace default is set by
// workspace admins; each person's own changes sit on top. Every app and agent
// item is resolved against the reader's own access, so the sidebar never shows
// an app they can't open or an agent they can't see, and deleted or archived
// ones drop out by themselves.
import {
  agentInitialsAvatar,
  applyPersonalSidebarChanges,
  knownSidebarOptions,
  mergeSidebarOptions,
  applyWorkspaceSidebarChanges,
  EMPTY_SIDEBAR_PERSONAL_CHANGES,
  isSidebarExternalUrl,
  mergeSidebarLayout,
  readWorkspaceSidebarLayout,
  readStoredSidebarPersonalChanges,
  sidebarLinkedAgentIds,
  sidebarLinkedAppIds,
  withoutGoneSidebarAgents,
  withoutGoneSidebarApps,
  SessionAvatar,
  SIDEBAR_LIVE_LIST_DEFAULT_LIMIT,
  SIDEBAR_LIVE_LIST_LABELS,
  SIDEBAR_LIVE_LIST_MAX_LIMIT,
  SidebarLayoutChangeError,
  SidebarLayoutLimitError,
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
  readSidebarAgents,
  readSidebarLinkedApps,
  readSidebarApps,
  readSidebarLayouts,
  writeSidebarLayout,
  type Database,
  type SidebarAgentSummary,
  type SidebarAppSummary,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { agentVisibleTo } from "../domain/agents";
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

function collectAgentIds(items: readonly MergedSidebarItem[], into: Set<string>): void {
  for (const item of items) {
    if (item.type === "agent") into.add(item.agentId.toLowerCase());
    if (item.type === "group") collectAgentIds(item.items, into);
  }
}

/** Seeing agents takes what reading chats takes, as on the agents pages. */
function agentsReadable(grant: AccessGrant): boolean {
  return hasPermission(grant.permissions, "sessions:read");
}

/** The agents among `ids` this person may see: shared ones and their own Only me ones. */
async function readVisibleAgents(
  deps: SidebarDeps,
  grant: AccessGrant,
  subjectId: string | null,
  ids: readonly string[],
): Promise<Map<string, SidebarAgentSummary>> {
  if (!ids.length || !agentsReadable(grant)) return new Map();
  const found = await readSidebarAgents(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    ids,
  );
  const viewer = { subjectId, admin: false, contributor: false };
  return new Map([...found].filter(([, agent]) => agentVisibleTo(viewer, agent)));
}

function agentAvatar(agent: SidebarAgentSummary): SessionAvatar {
  const parsed = SessionAvatar.safeParse(agent.avatar);
  return parsed.success ? parsed.data : agentInitialsAvatar(agent.name, agent.agentId);
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
  /** The linked agents this person may see. */
  agents: Map<string, SidebarAgentSummary>;
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
        ...(item.icon ? { icon: item.icon } : {}),
      };
    }
    case "link":
      return {
        id: item.id,
        origin: item.origin,
        type: "link",
        url: item.url,
        label: item.label,
        ...(item.icon ? { icon: item.icon } : {}),
      };
    case "agent": {
      const agent = view.agents.get(item.agentId.toLowerCase());
      if (!agent) return null;
      return {
        id: item.id,
        origin: item.origin,
        type: "agent",
        agentId: agent.agentId,
        label: item.label ?? agent.name,
        avatar: agentAvatar(agent),
      };
    }
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
    ...(item.icon ? { icon: item.icon } : {}),
    items: children,
  };
}

async function readAppView(
  deps: SidebarDeps,
  grant: AccessGrant,
  subjectId: string | null,
  item: readonly MergedSidebarItem[],
): Promise<AppView> {
  const agentIds = new Set<string>();
  collectAgentIds(item, agentIds);
  const agents = await readVisibleAgents(deps, grant, subjectId, [...agentIds]);
  const appsReadable = hasPermission(grant.permissions, "artifacts:read");
  const empty: AppView = {
    apps: new Map(),
    agents,
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
    agents,
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
  const workspace = readWorkspaceSidebarLayout(rows.workspace);
  const personal = readStoredSidebarPersonalChanges(rows.personal?.layout);
  const admin = isAdmin(grant);
  const merged = mergeSidebarLayout(
    workspace,
    subjectId === null ? EMPTY_SIDEBAR_PERSONAL_CHANGES : personal,
  );
  const defaults = admin ? mergeSidebarLayout(workspace, EMPTY_SIDEBAR_PERSONAL_CHANGES) : null;
  const view = await readAppView(deps, grant, subjectId, [
    ...merged.items,
    ...merged.hidden.map((entry) => entry.item),
    ...(defaults?.items ?? []),
  ]);
  const ownOptions = subjectId === null ? undefined : knownSidebarOptions(personal.options);
  const defaultOptions = knownSidebarOptions(workspace.options);
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
      ...(ownOptions ? { options: ownOptions } : {}),
    },
    workspace: {
      revision: rows.workspace?.revision ?? 0,
      canEdit: admin,
      ...(defaults ? { items: resolveAll(defaults.items, true) } : {}),
      ...(admin && defaultOptions ? { options: defaultOptions } : {}),
    },
    options: mergeSidebarOptions(defaultOptions, ownOptions),
  };
}

function addedIds(request: UpdateSidebarLayoutRequest, type: "app" | "agent"): string[] {
  const ids: string[] = [];
  const visit = (item: NewSidebarItem | Omit<SidebarAppLinkItem, "id">) => {
    if (item.type === "app" && type === "app") ids.push(item.appId.toLowerCase());
    if (item.type === "agent" && type === "agent") ids.push(item.agentId.toLowerCase());
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
  const newApps = addedIds(request, "app");
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
  // A new agent link must be to an agent this caller can see.
  const newAgents = addedIds(request, "agent");
  if (newAgents.length) {
    if (!agentsReadable(grant))
      throw new HTTPException(403, { message: "Adding an agent needs access to agents." });
    const visible = await readVisibleAgents(deps, grant, subjectId, newAgents);
    const missing = newAgents.find((id) => !visible.has(id));
    if (missing)
      throw new HTTPException(422, {
        message: `Agent ${missing} wasn't found or you can't see it.`,
      });
  }
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  for (let attempt = 0; ; attempt += 1) {
    const rows = await readSidebarLayouts(deps.db, scope, subjectId);
    const target = request.scope === "workspace" ? rows.workspace : rows.personal;
    const current = target?.revision ?? 0;
    if (request.expectedRevision !== undefined && request.expectedRevision !== current)
      throw new HTTPException(409, { message: SIDEBAR_LAYOUT_CONFLICT_MESSAGE });
    const stored = readWorkspaceSidebarLayout(rows.workspace);
    const storedPersonal = readStoredSidebarPersonalChanges(rows.personal?.layout);
    // Links to agents that no longer exist are dropped on the next write to
    // the scope that holds them, and a person's own links to an agent that
    // became someone else's Only me, like apps below (agents aren't archived).
    const agentLevel =
      request.scope === "workspace"
        ? stored.items
        : storedPersonal.added.map((entry) => entry.item);
    const linkedAgents = sidebarLinkedAgentIds(agentLevel);
    // Without access to agents a person can't tell which are theirs to see:
    // their links stay as they are.
    const liveAgents = !linkedAgents.length
      ? null
      : request.scope === "workspace"
        ? new Set((await readSidebarAgents(deps.db, scope, linkedAgents)).keys())
        : agentsReadable(grant)
          ? new Set((await readVisibleAgents(deps, grant, subjectId, linkedAgents)).keys())
          : null;
    const workspace =
      liveAgents && request.scope === "workspace"
        ? { ...stored, items: withoutGoneSidebarAgents(stored.items, liveAgents) }
        : stored;
    const personal =
      liveAgents && request.scope === "personal"
        ? {
            ...storedPersonal,
            added: storedPersonal.added.flatMap((entry) => {
              const [item] = withoutGoneSidebarAgents([entry.item], liveAgents);
              return item ? [{ ...entry, item }] : [];
            }),
          }
        : storedPersonal;
    // Links to apps that no longer exist are dropped on the next write to
    // the scope that holds them: nobody can see them to remove them, and
    // they shouldn't count toward the limits. A person's own links to an app
    // that became someone else's Only me go too, since they can't open it.
    // Links to archived apps are kept (hidden, back when it's restored),
    // unless the change would go over a limit: then they make room.
    const linked = sidebarLinkedAppIds(
      request.scope === "workspace" ? workspace.items : personal.added.map((entry) => entry.item),
    );
    const apps = linked.length
      ? await readSidebarLinkedApps(
          deps.db,
          scope,
          linked,
          request.scope === "personal" ? { subjectId } : undefined,
        )
      : null;
    const apply = (keep: ReadonlySet<string> | null) => {
      if (request.scope === "workspace")
        return applyWorkspaceSidebarChanges(
          keep ? { ...workspace, items: withoutGoneSidebarApps(workspace.items, keep) } : workspace,
          request.changes,
          newItemSuffix,
        );
      const own = keep
        ? {
            ...personal,
            added: personal.added.flatMap((entry) => {
              const [item] = withoutGoneSidebarApps([entry.item], keep);
              return item ? [{ ...entry, item }] : [];
            }),
          }
        : personal;
      return applyPersonalSidebarChanges(workspace, own, request.changes, newItemSuffix);
    };
    let layout: unknown;
    try {
      try {
        layout = apply(apps?.kept ?? null);
      } catch (error) {
        if (!(error instanceof SidebarLayoutLimitError) || !apps?.archived.size) throw error;
        const active = new Set([...apps.kept].filter((id) => !apps.archived.has(id)));
        layout = apply(active);
      }
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

/**
 * The sites (origins) of the outside links in this caller's sidebar: the
 * default's and their own, hidden ones included. Their icons are fetched for
 * them, and only theirs.
 */
export async function sidebarLinkOriginsForGrant(
  deps: SidebarDeps,
  grant: AccessGrant,
): Promise<Set<string>> {
  const subjectId = await personSubject(deps, grant);
  const rows = await readSidebarLayouts(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    subjectId,
  );
  const workspace = readWorkspaceSidebarLayout(rows.workspace);
  const personal = readStoredSidebarPersonalChanges(rows.personal?.layout);
  const origins = new Set<string>();
  const visit = (item: { type: string; url?: unknown; items?: unknown }) => {
    if (item.type === "link" && typeof item.url === "string" && isSidebarExternalUrl(item.url))
      origins.add(new URL(item.url).origin);
    if (item.type === "group" && Array.isArray(item.items))
      for (const child of item.items as { type: string }[]) visit(child);
  };
  for (const item of workspace.items) visit(item);
  if (subjectId !== null) for (const entry of personal.added) visit(entry.item);
  return origins;
}
