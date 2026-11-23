import type { AccessGrant, ToolGatewayIdentity } from "@opengeni/contracts";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import {
  getWorkspaceGrant,
  listSiteToolDataSources,
  markSiteToolData,
  resetSiteToolData,
  SITE_TOOL_DATA_RESET_GRACE_MS,
  SiteDataError,
  siteToolDataTarget,
  subjectHasLiveWorkspaceAuthorityInScope,
  withWorkspaceSubjectRls,
  type SiteToolDataSource,
} from "@opengeni/db";
import { readSiteToolAccountInventory, type SiteToolAccountInventory } from "./site-tool-routing";

/**
 * Stored tool data (docs/app-server-code.md): data an app stored from a
 * workspace-shared account (a shared sync, or server code with tools or
 * secrets) is shown only to signed-in members of the app's workspace who may
 * use that connector themselves, whatever the collection or sharing settings
 * say. Targets are marked server-side before the data is stored; live shared
 * syncs count from their definitions too.
 */

type Deps = Pick<ApiRouteDeps, "db" | "settings"> & {
  /** Test seams (shared with app server code and app syncs). */
  appServerToolInventory?: (
    deps: ApiRouteDeps,
    grant: AccessGrant,
  ) => Promise<SiteToolAccountInventory>;
  appSyncToolInventory?: (
    deps: ApiRouteDeps,
    grant: AccessGrant,
  ) => Promise<SiteToolAccountInventory>;
};
type Scope = { accountId: string; workspaceId: string };

export { siteToolDataTarget, type SiteToolDataSource };

/** A person's own live grant in the workspace as a member; null when they aren't one. */
export async function liveMemberGrant(
  deps: Pick<ApiRouteDeps, "db">,
  scope: Scope,
  subjectId: string,
): Promise<AccessGrant | null> {
  return await withWorkspaceSubjectRls(deps.db, scope.workspaceId, subjectId, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, { ...scope, subjectId }))) return null;
    return await getWorkspaceGrant(tx, subjectId, scope.workspaceId, {
      principalKind: "human_session",
    });
  });
}

const INVENTORY_TTL_MS = 30_000;
const inventories = new Map<
  string,
  { expiresAt: number; inventory: Promise<SiteToolAccountInventory> }
>();

/** A member's own tool inventory, kept briefly per process (reads are frequent). */
export function memberToolInventory(
  deps: Deps,
  grant: AccessGrant,
): Promise<SiteToolAccountInventory> {
  const seam = deps.appServerToolInventory ?? deps.appSyncToolInventory;
  if (seam) return seam(deps as ApiRouteDeps, grant);
  const key = `${grant.workspaceId}:${grant.subjectId}`;
  const now = Date.now();
  const cached = inventories.get(key);
  if (cached && cached.expiresAt > now) return cached.inventory;
  if (inventories.size >= 1_000) inventories.clear();
  const inventory = readSiteToolAccountInventory(deps as ApiRouteDeps, grant);
  inventories.set(key, { expiresAt: now + INVENTORY_TTL_MS, inventory });
  inventory.catch(() => inventories.delete(key));
  return inventory;
}

/** The connector-level identity of a sync's tool (as app-sync's connectorToolOf). */
function syncConnectorOf(action: {
  tool: ToolGatewayIdentity;
  declaredTools?: ToolGatewayIdentity[];
  connectorTool?: ToolGatewayIdentity | null;
}): string {
  if (action.connectorTool) return action.connectorTool.serverId;
  const paired = (action.declaredTools ?? []).filter(
    (item) => item.toolName === action.tool.toolName && item.serverId !== action.tool.serverId,
  );
  return paired.length === 1 ? paired[0]!.serverId : action.tool.serverId;
}

export function sourceOfSyncAction(raw: unknown): SiteToolDataSource | null {
  if (!raw || typeof raw !== "object") return null;
  const action = raw as {
    collection?: unknown;
    target?: unknown;
    tool?: { serverId?: unknown; toolName?: unknown };
    declaredTools?: ToolGatewayIdentity[];
    connectorTool?: ToolGatewayIdentity | null;
    ownerAccount?: unknown;
  };
  if (typeof action.tool?.serverId !== "string" || typeof action.tool.toolName !== "string")
    return null;
  if (!action.target && typeof action.collection !== "string") return null;
  const tool = { serverId: action.tool.serverId, toolName: action.tool.toolName };
  return {
    target: action.target
      ? siteToolDataTarget("sql")
      : siteToolDataTarget("collection", action.collection as string),
    connector: syncConnectorOf({ ...action, tool }),
    route: typeof action.ownerAccount === "string" ? action.ownerAccount : tool.serverId,
    shared: false,
  };
}

/** Everything that fed the app's targets with shared-account tool data. */
export async function siteToolDataSources(
  deps: Pick<ApiRouteDeps, "db">,
  scope: Scope,
  siteId: string,
): Promise<SiteToolDataSource[]> {
  const { marks, sharedSyncActions, resets } = await listSiteToolDataSources(
    deps.db,
    scope,
    siteId,
  );
  return [
    ...marks,
    ...sharedSyncActions.flatMap(({ action, deletedAt }) => {
      const source = sourceOfSyncAction(action);
      if (!source) return [];
      // A deleted sync's data is gone once its target was reset after it.
      const reset = resets.get(source.target);
      if (
        deletedAt &&
        reset &&
        reset.getTime() - SITE_TOOL_DATA_RESET_GRACE_MS >= deletedAt.getTime()
      )
        return [];
      return [source];
    }),
  ];
}

/**
 * A manager reset a target's data (a collection reset or removed, or the
 * SQL database reset): its earlier marks stop counting. Live shared syncs
 * that fill it still count.
 */
export async function resetToolData(
  deps: Pick<ApiRouteDeps, "db">,
  scope: Scope,
  siteId: string,
  target: string,
): Promise<void> {
  await resetSiteToolData(deps.db, scope, siteId, target);
}

/**
 * Keep a shared sync's target marked when the sync is changed or deleted, so
 * data it stored stays restricted after it switches mode or target.
 */
export async function keepSyncToolDataMarked(
  deps: Pick<ApiRouteDeps, "db">,
  scope: Scope,
  siteId: string,
  action: unknown,
): Promise<void> {
  if (!action || typeof action !== "object" || (action as { mode?: unknown }).mode !== "shared")
    return;
  const source = sourceOfSyncAction(action);
  if (source) await markSiteToolData(deps.db, scope, siteId, [source]);
}

/** Mark targets before shared-account tool data is stored in them. */
export async function markToolData(
  deps: Pick<ApiRouteDeps, "db">,
  scope: Scope,
  siteId: string,
  sources: readonly SiteToolDataSource[],
): Promise<void> {
  await markSiteToolData(deps.db, scope, siteId, sources);
}

/**
 * Whether a member may use the connector a source came from: the same
 * shared account route when the data came from one; otherwise any working
 * account of that connector of theirs (or the account-less server configured
 * for them); `secrets:use` for vault-backed data.
 */
export function memberMayUseSource(
  grant: AccessGrant,
  inventory: SiteToolAccountInventory,
  source: SiteToolDataSource,
): boolean {
  if (source.connector === "vault")
    return hasPermission(grant.permissions, "secrets:use", grant.permissionMode);
  if (source.shared)
    return inventory.accounts.some(
      (account) => account.serverId === source.route && account.shared === true,
    );
  const canonical = inventory.canonical.has(source.connector)
    ? source.connector
    : (inventory.accounts.find((account) => account.serverId === source.connector)
        ?.canonicalServerId ?? source.connector);
  if (
    inventory.accounts.some(
      (account) => account.canonicalServerId === canonical || account.serverId === source.route,
    )
  )
    return true;
  return inventory.plain.has(canonical) && !inventory.canonical.has(canonical);
}

export const RESTRICTED_TOOL_DATA = "restricted_tool_data";

function connectorName(source: SiteToolDataSource, inventory?: SiteToolAccountInventory) {
  if (source.connector === "vault") return "vault-backed";
  return inventory?.canonical.get(source.connector)?.name ?? source.connector;
}

/**
 * Refuse a read of `target` unless the reader may see every connector that
 * fed it. `system` readers are the app's own automation (a sync's schedule
 * principal); server code passes its run's verified viewer.
 */
export async function requireToolDataReader(
  deps: Deps,
  input: {
    scope: Scope;
    siteId: string;
    target: string;
    reader: { subjectId: string | null } | "system";
  },
): Promise<void> {
  if (input.reader === "system") return;
  const sources = (await siteToolDataSources(deps, input.scope, input.siteId)).filter(
    (source) => source.target === input.target,
  );
  if (sources.length === 0) return;
  const name = input.target === "sql" ? "This app's database" : input.target.slice(11);
  const refuse = (source: SiteToolDataSource, inventory?: SiteToolAccountInventory) =>
    new SiteDataError(
      "forbidden",
      `${name} holds ${connectorName(source, inventory)} data from a connected account, so only workspace members who can use ${connectorName(source, inventory)} may see it.`,
      { code: RESTRICTED_TOOL_DATA },
    );
  const grant = input.reader.subjectId
    ? await liveMemberGrant(deps, input.scope, input.reader.subjectId)
    : null;
  if (!grant) throw refuse(sources[0]!);
  const inventory = await memberToolInventory(deps, grant).catch(() => {
    throw new SiteDataError(
      "forbidden",
      "Your connections can't be checked right now. Try again shortly.",
      {
        code: RESTRICTED_TOOL_DATA,
      },
    );
  });
  for (const source of sources)
    if (!memberMayUseSource(grant, inventory, source)) throw refuse(source, inventory);
}

/**
 * Accesses the app's own automation built server-side (its syncs, webhook
 * deliveries, and server code, which checks its run's viewer itself). Held
 * by identity, so no caller can claim it through a principal name.
 */
const automationAccesses = new WeakSet<object>();

/** Mark an access the API built for the app's own automation. */
export function asAppAutomation<T extends object>(access: T): T {
  automationAccesses.add(access);
  return access;
}

/** The reader of a Site Data access: the app's own automation, or the person (null for a guest). */
export function toolDataReaderOf(access: {
  subjectId: string | null;
}): { subjectId: string | null } | "system" {
  if (automationAccesses.has(access)) return "system";
  return { subjectId: access.subjectId };
}
