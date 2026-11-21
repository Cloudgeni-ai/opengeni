import {
  APP_SYNC_DEFAULT_PAGES,
  APP_SYNC_MAX_RECORDS,
  APP_SYNC_MAX_RUN_RECORDS,
  APP_SYNC_MAX_SUBSCRIBERS,
  AppSyncAction,
  AppSyncOptInRequest,
  AppSyncCreateRequest,
  AppSyncDefinition,
  AppSyncUpdateRequest,
  ScheduledTaskAgentConfig,
  type AccessGrant,
  type AppSync,
  type AppSyncAccountChoice,
  type AppSyncOptInReview,
  type AppSyncTableTarget,
  type SiteSqlValue,
  type AppSyncDefinitionInput,
  type AppSyncLastRun,
  type AppSyncRunSummary,
  type AppSyncStatus,
  type ScheduledTask,
  type ScheduledTaskScheduleSpec,
  type ToolGatewayIdentity,
  type ToolGatewayResult,
} from "@opengeni/contracts";
import {
  deleteScheduledTaskLifecycle,
  scheduledTaskTemporalScheduleId,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validateScheduledTaskEvents,
  withScheduledTaskEvents,
  writeScheduledTaskEvents,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  APP_SYNC_SHARED_KEYS,
  appSyncActionOf,
  appSyncRunEventSources,
  claimAppSyncRun,
  clearAppSyncKeys,
  deleteAppSyncKeys,
  eventSourceVisibleTo,
  getEventSource,
  listMissingAppSyncKeys,
  recordAppSyncKeys,
  clearAppSyncSubscriptions,
  EVENT_AUTOMATION_MAX_CHAIN_DEPTH,
  getAppAutomationCause,
  renewAppSyncLease,
  countAppSyncSubscriptions,
  createScheduledTask,
  createScheduledTaskRun,
  enqueueAppSyncRun,
  finishAppSyncRun,
  getAppSyncSubscriptionsForSubject,
  getScheduledTask,
  getWorkspaceGrant,
  latestAppSyncRuns,
  listAppSyncSubscriptions,
  listAppSyncTaskIds,
  listDueAppSyncRuns,
  recordAppSyncSubscriptionRun,
  setAppSyncSubscription,
  SiteDataError,
  subjectHasLiveWorkspaceAuthorityInScope,
  updateScheduledTask,
  withWorkspaceSubjectRls,
  type SiteDataWriteOp,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { writeSiteDataWithAccess } from "../site-data/operations";
import {
  resolveSiteDataAccess,
  type SiteDataAccess,
  type SiteDataAuthority,
  type SiteDataSurface,
} from "../site-data/service";
import {
  declareSiteToolsForEveryViewer,
  connectorToolIdentity,
  readSiteToolAccountInventory,
  type SiteToolAccountInventory,
} from "../site-tool-routing";
import {
  deleteSiteSqlRowsForSync,
  requireSiteSqlForSync,
  SiteSqlError,
  upsertSiteSqlRowsForSync,
} from "../site-sql/service";
import { processTemporalScheduleCleanupClaims } from "../temporal-schedule-cleanup";
import {
  callWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
} from "../workspace-tool-gateway";

/**
 * App data sync (docs/app-sync.md). A sync is an ordinary automation
 * (scheduled task) whose action is `app_sync`: its schedule and event
 * triggers start runs like any automation, and the worker hands each run to
 * this executor instead of starting a chat. The executor calls one connected
 * tool with fixed arguments and upserts the kept fields of each returned
 * record by key into one collection of the App's data. No model runs.
 *
 * A shared sync calls the tool as its owner (the person who last saved it),
 * on the owner's connection, and writes shared records. A personal sync runs
 * once for each person who opted in, as that person, on their own account of
 * the same connector, and writes only their own records of a `per_viewer`
 * collection. Ordinary tool approvals apply: a tool that asks first cannot be
 * approved by nobody, so the run fails with a readable error; blocked tools
 * stay blocked.
 */

export type AppSyncDeps = ApiRouteDeps & {
  /** The person's connector accounts; tests replace it. */
  appSyncToolInventory?: (
    deps: ApiRouteDeps,
    grant: AccessGrant,
  ) => Promise<SiteToolAccountInventory>;
};

/** Calls one connected tool as a person. Tests replace it. */
export type AppSyncToolCaller = (input: {
  deps: AppSyncDeps;
  grant: AccessGrant;
  identity: ToolGatewayIdentity;
  arguments: Record<string, unknown>;
}) => Promise<ToolGatewayResult>;

const WRITE_BATCH = 100;
const MIN_INTERVAL_SECONDS = 300;
const RUN_ATTEMPTS = 3;

const forbidden = (message: string) => new SiteDataError("forbidden", message);
const invalid = (message: string, details?: Record<string, unknown>) =>
  new SiteDataError("validation", message, details);

function errorText(error: unknown): string {
  if (error instanceof SiteDataError) return error.message;
  if (error instanceof HTTPException) {
    const message = error.message;
    if (message === "tool_gateway_approval_required")
      return "This tool asks for approval before it runs, and nobody can approve a sync run. Allow the tool without asking for this connection, or choose another tool.";
    if (message === "tool_blocked" || message === "tool_gateway_blocked")
      return "This tool is blocked in this workspace, so the sync can't call it.";
    if (error.status === 404) return "The tool is no longer available on this connection.";
    return message || `The tool call failed (HTTP ${error.status}).`;
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function clip(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// --- reading records out of a tool result -------------------------------------

function pathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);

export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of pathSegments(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object" || UNSAFE.has(segment)) return undefined;
    current = Object.prototype.hasOwnProperty.call(current, segment)
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = pathSegments(path).filter((segment) => !UNSAFE.has(segment));
  if (segments.length === 0) return;
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

const LIST_KEYS = [
  "items",
  "results",
  "records",
  "data",
  "rows",
  "entries",
  "values",
  "value",
  "nodes",
  "list",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The tool result as JSON: structured content, or else the first text part that parses. */
export function toolResultValue(result: ToolGatewayResult): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined && structured !== null) return structured;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content))
    for (const part of content) {
      if (isObject(part) && part.type === "text" && typeof part.text === "string") {
        try {
          return JSON.parse(part.text);
        } catch {
          continue;
        }
      }
    }
  throw invalid("The tool didn't return JSON data the sync can read.");
}

function autoList(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of LIST_KEYS) if (Array.isArray(value[key])) return value[key] as unknown[];
  const lists = Object.values(value).filter(Array.isArray);
  if (lists.length === 1) return lists[0] as unknown[];
  if (depth < 2)
    for (const key of LIST_KEYS)
      if (isObject(value[key])) {
        const nested = autoList(value[key], depth + 1);
        if (nested.length > 0) return nested;
      }
  return [value];
}

export type AppSyncRecords = {
  records: Array<{ key: string; data: Record<string, unknown> }>;
  received: number;
  skipped: number;
  truncated: boolean;
};

/** The records a sync writes from one tool result. */
export function appSyncRecords(
  value: unknown,
  settings: Pick<AppSyncAction, "recordsPath" | "key" | "fields">,
  /** At most this many records (default and ceiling APP_SYNC_MAX_RECORDS). */
  options: { maxRecords?: number } = {},
): AppSyncRecords {
  let list: unknown[];
  if (settings.recordsPath) {
    const found = readPath(value, settings.recordsPath);
    if (found === undefined)
      throw invalid(`The tool result has nothing at "${settings.recordsPath}".`);
    list = Array.isArray(found) ? found : [found];
  } else list = autoList(value);
  const cap = Math.max(
    0,
    Math.min(APP_SYNC_MAX_RECORDS, Math.trunc(options.maxRecords ?? APP_SYNC_MAX_RECORDS)),
  );
  const truncated = list.length > cap;
  const items = list.slice(0, cap);
  const records = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const item of items) {
    const rawKey = isObject(item) ? readPath(item, settings.key) : undefined;
    const key =
      typeof rawKey === "string"
        ? rawKey.trim()
        : typeof rawKey === "number" && Number.isFinite(rawKey)
          ? String(rawKey)
          : "";
    if (!isObject(item) || key.length === 0 || key.length > 256) {
      skipped += 1;
      continue;
    }
    let data: Record<string, unknown>;
    if (settings.fields && settings.fields.length > 0) {
      data = {};
      for (const field of settings.fields) {
        const fieldValue = readPath(item, field);
        if (fieldValue !== undefined) writePath(data, field, fieldValue);
      }
    } else data = item;
    // The last record with a key wins, as a put of each in order would.
    records.set(key, data);
  }
  return {
    records: [...records].map(([key, data]) => ({ key, data })),
    received: items.length,
    skipped,
    truncated,
  };
}

// --- calling the tool ------------------------------------------------------------

/** The ordinary workspace tool gateway, as the person: their catalog, approvals and blocks. */
export const callAppSyncToolThroughGateway: AppSyncToolCaller = async ({
  deps,
  grant,
  identity,
  arguments: args,
}) => {
  const prepared = await prepareWorkspaceToolGatewayForGrant(deps, grant, [identity]);
  try {
    const response = await callWorkspaceToolGateway(
      prepared,
      grant,
      { catalogDigest: prepared.toolGatewayCatalog.digest, identity, arguments: args },
      deps.db,
    );
    return response.result;
  } finally {
    await prepared.close().catch(() => undefined);
  }
};

/** A person's own live workspace grant, as when they use Opengeni themselves; null when gone. */
async function personGrant(
  deps: AppSyncDeps,
  scope: { accountId: string; workspaceId: string },
  subjectId: string,
): Promise<AccessGrant | null> {
  return await withWorkspaceSubjectRls(deps.db, scope.workspaceId, subjectId, async (tx) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, { ...scope, subjectId }))) return null;
    return await getWorkspaceGrant(tx, subjectId, scope.workspaceId, {
      principalKind: "human_session",
    });
  });
}

async function readInventory(
  deps: AppSyncDeps,
  grant: AccessGrant,
): Promise<SiteToolAccountInventory> {
  return await (deps.appSyncToolInventory ?? readSiteToolAccountInventory)(deps, grant);
}

/**
 * The connector-level identity of a sync's tool: stored on syncs saved since
 * it existed, else the one other identity `declaredTools` pairs with the same
 * tool name, else the tool itself.
 */
export function connectorToolOf(
  action: Pick<AppSyncAction, "tool" | "declaredTools" | "connectorTool">,
): ToolGatewayIdentity {
  if (action.connectorTool) return action.connectorTool;
  const paired = action.declaredTools.filter(
    (item) => item.toolName === action.tool.toolName && item.serverId !== action.tool.serverId,
  );
  return paired.length === 1 ? paired[0]! : action.tool;
}

function uniqueTools(items: readonly ToolGatewayIdentity[]): ToolGatewayIdentity[] {
  const result: ToolGatewayIdentity[] = [];
  for (const item of items)
    if (!result.some((existing) => sameTool(existing, item))) result.push(item);
  return result;
}

export type AppSyncToolRoute =
  /** Call exactly this identity. */
  | { kind: "route"; identity: ToolGatewayIdentity }
  /** The person has no account of the connector. */
  | { kind: "connect"; connector: string }
  /** A personal sync, and the person has only the workspace's shared account. */
  | { kind: "no_own_account"; connector: string };

/**
 * Which identity one person's run calls. The saved route when it is that
 * person's own account; otherwise that person's own account of the same
 * connector (a shared sync may also use a workspace-shared account); a tool
 * without accounts runs as itself. Never another person's account.
 */
export function resolveAppSyncTool(
  inventory: SiteToolAccountInventory,
  action: Pick<AppSyncAction, "tool" | "declaredTools" | "connectorTool">,
  mode: "shared" | "personal",
): AppSyncToolRoute {
  const { tool } = action;
  const personal = mode === "personal";
  const own = inventory.accounts.find((account) => account.serverId === tool.serverId);
  if (own && !(personal && own.shared === true)) return { kind: "route", identity: tool };
  const connectorTool = connectorToolIdentity(
    inventory,
    uniqueTools([connectorToolOf(action), ...action.declaredTools]),
    own ? tool : connectorToolOf(action),
  );
  const canonicalId = inventory.canonical.has(connectorTool.serverId)
    ? connectorTool.serverId
    : null;
  // No connector with accounts behind it: the tool runs as itself.
  if (!canonicalId) return { kind: "route", identity: tool };
  const accounts = inventory.accounts.filter(
    (account) => account.canonicalServerId === canonicalId,
  );
  const mine = accounts.filter((account) => account.shared !== true);
  const pick = mine[0] ?? (personal ? undefined : accounts[0]);
  if (pick)
    return { kind: "route", identity: { serverId: pick.serverId, toolName: tool.toolName } };
  const connector = inventory.canonical.get(canonicalId)?.name ?? "the tool's connector";
  return accounts.length > 0
    ? { kind: "no_own_account", connector }
    : { kind: "connect", connector };
}

/**
 * The accounts of a sync's connector one person can choose from: their own
 * (and, for a shared sync, the workspace's shared ones). Empty for a tool
 * without accounts.
 */
export function appSyncAccountChoices(
  inventory: SiteToolAccountInventory,
  action: Pick<AppSyncAction, "tool" | "declaredTools" | "connectorTool">,
  mode: "shared" | "personal",
): { connector: string | null; accounts: AppSyncAccountChoice[] } {
  const own = inventory.accounts.find((account) => account.serverId === action.tool.serverId);
  const connectorTool = connectorToolIdentity(
    inventory,
    uniqueTools([connectorToolOf(action), ...action.declaredTools]),
    own ? action.tool : connectorToolOf(action),
  );
  const canonicalId = inventory.canonical.has(connectorTool.serverId)
    ? connectorTool.serverId
    : (own?.canonicalServerId ?? null);
  if (!canonicalId) return { connector: null, accounts: [] };
  const accounts = inventory.accounts
    .filter(
      (account) =>
        account.canonicalServerId === canonicalId && (mode === "shared" || account.shared !== true),
    )
    .map((account) => ({
      id: account.serverId,
      label: account.account,
      connector: account.connector,
      shared: account.shared === true,
    }));
  return { connector: inventory.canonical.get(canonicalId)?.name ?? own?.connector ?? null, accounts };
}

/** A readable list of accounts to choose from, for an error. */
function choiceList(accounts: readonly AppSyncAccountChoice[]): string {
  return accounts.map((account) => `${account.label} (${account.id})`).join(", ");
}

/**
 * The identity this person's call uses. With an account they chose, exactly
 * that account while it is still theirs, else a readable failure; without
 * one, see `resolveAppSyncTool`.
 */
async function toolForPerson(
  deps: AppSyncDeps,
  grant: AccessGrant,
  action: AppSyncAction,
  chosen: string | null,
): Promise<ToolGatewayIdentity> {
  let inventory: SiteToolAccountInventory;
  try {
    inventory = await readInventory(deps, grant);
  } catch {
    // Without the inventory the gateway still decides what a shared sync's
    // call may use: only the person's own routes resolve. A personal sync
    // must run on the person's own account, which can't be confirmed, so
    // their run fails instead.
    if (action.mode === "shared") return chosen ? { ...action.tool, serverId: chosen } : action.tool;
    throw forbidden(
      "Couldn't check your connected accounts for this sync. It will try again next run.",
    );
  }
  if (chosen) {
    const { accounts } = appSyncAccountChoices(inventory, action, action.mode);
    if (accounts.some((account) => account.id === chosen))
      return { serverId: chosen, toolName: action.tool.toolName };
    throw forbidden(
      action.mode === "shared"
        ? "The account chosen for this sync is no longer connected for its owner. Someone who manages the app should save the sync again and pick an account."
        : "The account you chose for this sync is no longer connected for you. Opt in again and pick one of your accounts.",
    );
  }
  const route = resolveAppSyncTool(inventory, action, action.mode);
  if (route.kind === "route") return route.identity;
  if (route.kind === "connect")
    throw forbidden(`Connect ${route.connector} in Opengeni first, then the sync can use it.`);
  throw forbidden(
    `This personal sync runs on each person's own ${route.connector} account, and only the workspace's shared one is connected for you. Connect your own account in Opengeni.`,
  );
}

// --- writing ---------------------------------------------------------------------

/** Thrown once a run no longer holds its lease: it stops and leaves the run to the holder. */
export class AppSyncLeaseLost extends Error {
  constructor() {
    super("The sync run lost its lease to another executor");
    this.name = "AppSyncLeaseLost";
  }
}

/**
 * Renew the run's lease, or stop: a renewal that fails (another executor
 * claimed the run, it settled, or the renewal itself failed) ends this
 * execution before any further tool call or write.
 */
async function holdLease(context: AppSyncRunContext): Promise<void> {
  if (!context.renew) return;
  let held: boolean | void;
  try {
    held = await context.renew();
  } catch {
    held = false;
  }
  if (held === false) throw new AppSyncLeaseLost();
}

/** Where one person's run writes: a collection or a Site SQL table. */
type SyncWriter = {
  write(records: AppSyncRecords["records"]): Promise<number>;
  /** Remove records by key; keys already gone count as removed. */
  remove(keys: readonly string[]): Promise<number>;
};

async function writeRecords(
  deps: AppSyncDeps,
  access: SiteDataAccess,
  collection: string,
  records: AppSyncRecords["records"],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < records.length; start += WRITE_BATCH) {
    const operations = records.slice(start, start + WRITE_BATCH).map(
      (record): SiteDataWriteOp => ({
        op: "put",
        collection,
        key: record.key,
        data: record.data,
      }),
    );
    const result = await writeSiteDataWithAccess(deps, access, operations);
    written += result.results.length;
  }
  return written;
}

/** Delete records by key; a record that is already gone is skipped. */
async function deleteRecords(
  deps: AppSyncDeps,
  access: SiteDataAccess,
  collection: string,
  keys: readonly string[],
): Promise<number> {
  let removed = 0;
  for (let start = 0; start < keys.length; start += WRITE_BATCH) {
    let batch = keys.slice(start, start + WRITE_BATCH);
    while (batch.length > 0) {
      try {
        const result = await writeSiteDataWithAccess(
          deps,
          access,
          batch.map((key): SiteDataWriteOp => ({ op: "delete", collection, key })),
        );
        removed += result.results.length;
        break;
      } catch (error) {
        const index = (error as SiteDataError).details?.index;
        if (
          !(error instanceof SiteDataError) ||
          error.code !== "not_found" ||
          typeof index !== "number"
        )
          throw error;
        // Already removed (by a person or another run): drop it and go on.
        batch = batch.filter((_, position) => position !== index);
      }
    }
  }
  return removed;
}

/** A record value as one SQLite value: objects and lists as JSON text. */
function sqlValue(value: unknown): SiteSqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value) ?? null;
}

function tableWriter(
  deps: AppSyncDeps,
  access: SiteDataAccess,
  siteId: string,
  target: AppSyncTableTarget,
): SyncWriter {
  const others = Object.keys(target.columns).filter((column) => column !== target.keyColumn);
  return {
    // Counts records, not the database's row writes (an index write counts there too).
    write: async (records) => {
      await upsertSiteSqlRowsForSync(deps, access, siteId, {
        table: target.table,
        keyColumn: target.keyColumn,
        columns: [target.keyColumn, ...others],
        rows: records.map((record) => [
          record.key,
          ...others.map((column) => sqlValue(readPath(record.data, target.columns[column]!))),
        ]),
      });
      return records.length;
    },
    remove: async (keys) => {
      await deleteSiteSqlRowsForSync(deps, access, siteId, {
        table: target.table,
        keyColumn: target.keyColumn,
        keys,
      });
      return keys.length;
    },
  };
}

/** What one execution of a sync knows about the run it serves. */
export type AppSyncRunContext = {
  /** The run's automation chain depth; the sync's writes carry it. */
  chainDepth: number;
  /** The run, so the App's change events name the run that made them. */
  runId?: string | null;
  /** How the run started (`event` runs of a personal sync may be for one person only). */
  triggerType?: string | null;
  /**
   * Keeps the run's queue lease alive; called after every tool call, between
   * people and before removals. Resolving `false` (or failing) means the run
   * lost its lease: no further tool call or write happens.
   */
  renew?: () => Promise<boolean | void>;
};

/**
 * The access a sync run writes with: the App as the person sees it (so a
 * lost audience stops the sync), the sync's own principal and writer, and
 * the run's automation chain depth and ids on change events. An archived App
 * stops its syncs.
 */
async function syncAccess(
  deps: AppSyncDeps,
  grant: AccessGrant,
  task: ScheduledTask,
  action: AppSyncAction,
  context: AppSyncRunContext,
): Promise<SiteDataAccess> {
  const access = await resolveSiteDataAccess(deps, grant, action.siteId);
  if (access.site.status !== "active")
    throw forbidden("The app is archived, so its syncs don't run. Restore the app to sync again.");
  if (action.mode === "shared" && access.caller.role !== "manager")
    throw forbidden(
      "The sync's owner can no longer manage this app's data. Someone who manages the app should save the sync again.",
    );
  if (action.collection) {
    const collection = await access.store.getCollection(
      { accountId: task.accountId, workspaceId: task.workspaceId, siteId: action.siteId },
      action.collection,
    );
    if (!collection)
      throw invalid(`The app has no collection named "${action.collection}" any more.`);
    if (action.mode === "shared" && collection.accessMode === "per_viewer")
      throw invalid(
        `"${action.collection}" keeps each person's records separately, so a shared sync can't fill it. Use a personal sync or a shared collection.`,
      );
    if (action.mode === "personal" && collection.accessMode !== "per_viewer")
      throw invalid(
        `A personal sync fills each person's own records, so "${action.collection}" must be a per_viewer collection.`,
      );
  } else if (!action.target || action.mode !== "shared")
    throw invalid("This sync has nowhere to write. Save it again with a collection or a table.");
  const principal = action.mode === "shared" ? `schedule:${task.id}` : access.caller.principal;
  return {
    ...access,
    // Sync writes are the server's own trusted writes: they count in the
    // App's manager window, and a personal one stays in the person's records.
    caller: {
      ...access.caller,
      role: "manager",
      principal,
      actor: `schedule:${task.id}`,
      framed: false,
      // The run's depth carries on to change events so a loop stops at the
      // chain limit. The run itself stays off them: a sync runs no model, so
      // its writes aren't Opengeni's own and triggers hear them by default.
      chainDepth: context.chainDepth,
    },
  };
}

async function syncWriter(
  deps: AppSyncDeps,
  grant: AccessGrant,
  task: ScheduledTask,
  action: AppSyncAction,
  context: AppSyncRunContext,
): Promise<SyncWriter> {
  const access = await syncAccess(deps, grant, task, action, context);
  if (action.collection) {
    const collection = action.collection;
    return {
      write: (records) => writeRecords(deps, access, collection, records),
      remove: (keys) => deleteRecords(deps, access, collection, keys),
    };
  }
  await requireSiteSqlForSync(deps, access, action.siteId);
  return tableWriter(deps, access, action.siteId, action.target!);
}

/** The tool's error text, when the result is an error. */
function toolErrorOf(result: ToolGatewayResult): string | null {
  if ((result as { isError?: unknown }).isError !== true) return null;
  let detail = "";
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content))
    for (const part of content)
      if (isObject(part) && part.type === "text" && typeof part.text === "string") {
        detail = part.text;
        break;
      }
  return clip(`The tool returned an error${detail ? `: ${detail}` : "."}`, 1000);
}

/** The fixed arguments with one (dot path) argument set, for the next page. */
function argumentsWith(
  base: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const next = structuredClone(base);
  writePath(next, path, value);
  return next;
}

type PersonRun = { summary: AppSyncRunSummary; error: string | null };

const emptySummary = (): AppSyncRunSummary => ({
  received: 0,
  written: 0,
  skipped: 0,
  truncated: false,
  pages: 0,
  removed: 0,
  people: null,
});

/**
 * One person's run: call the tool page by page, write each page, and, after
 * a complete run, remove what this sync wrote before that the tool no longer
 * returns. Throws `AppSyncLeaseLost` when the run lost its lease.
 */
async function runForPerson(
  deps: AppSyncDeps,
  callTool: AppSyncToolCaller,
  task: ScheduledTask,
  action: AppSyncAction,
  subjectId: string,
  context: AppSyncRunContext,
  chosenAccount: string | null,
): Promise<PersonRun> {
  const summary = emptySummary();
  try {
    const grant = await personGrant(deps, task, subjectId);
    if (!grant)
      throw forbidden(
        action.mode === "shared"
          ? "The sync's owner is no longer in this workspace. Someone who manages the app should save the sync again."
          : "This person is no longer in the workspace.",
      );
    const writer = await syncWriter(deps, grant, task, action, context);
    const identity = await toolForPerson(deps, grant, action, chosenAccount);
    const limit = Math.min(action.maxRecords ?? APP_SYNC_MAX_RECORDS, APP_SYNC_MAX_RUN_RECORDS);
    const paging = action.paging ?? null;
    const maxPages = paging ? (paging.maxPages ?? APP_SYNC_DEFAULT_PAGES) : 1;
    const ledger = action.mode === "shared" ? APP_SYNC_SHARED_KEYS : subjectId;
    // Marks the keys this execution saw; another execution of the same run
    // (after a lost lease) gets its own.
    const pass = crypto.randomUUID();
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let page = paging?.mode === "page" ? (paging.firstPage ?? 1) : 0;
    let args =
      paging?.mode === "page"
        ? argumentsWith(action.arguments, paging.pageArgument, page)
        : action.arguments;
    let ended = false;
    while (!ended) {
      if (summary.pages >= maxPages || summary.received >= limit) {
        summary.truncated = true;
        break;
      }
      const result = await callTool({ deps, grant, identity, arguments: args });
      summary.pages += 1;
      // The lease renews per call; a lost lease stops before anything is written.
      await holdLease(context);
      const toolError = toolErrorOf(result);
      if (toolError) throw invalid(toolError);
      const value = toolResultValue(result);
      const extracted = appSyncRecords(value, action, { maxRecords: limit - summary.received });
      summary.received += extracted.received;
      summary.skipped += extracted.skipped;
      let fresh = 0;
      for (const record of extracted.records)
        if (!seen.has(record.key)) {
          seen.add(record.key);
          fresh += 1;
        }
      summary.written += await writer.write(extracted.records);
      if (action.removeMissing)
        await recordAppSyncKeys(deps.db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          taskId: task.id,
          subjectId: ledger,
          pass,
          keys: extracted.records.map((record) => record.key),
        });
      if (extracted.truncated) {
        summary.truncated = true;
        break;
      }
      if (!paging) ended = true;
      else if (paging.mode === "cursor") {
        const cursor = readPath(value, paging.cursorPath);
        if (cursor === undefined || cursor === null || cursor === "" || cursor === false)
          ended = true;
        else {
          const marker = stableJson(cursor);
          // A cursor that comes back again would read the same pages forever.
          if (cursors.has(marker)) {
            summary.truncated = true;
            break;
          }
          cursors.add(marker);
          args = argumentsWith(action.arguments, paging.cursorArgument, cursor);
        }
      } else if (fresh === 0) ended = true;
      else {
        page += 1;
        args = argumentsWith(action.arguments, paging.pageArgument, page);
      }
    }
    // Only a complete run (every page read, nothing cut off, no failure)
    // shows what the tool no longer returns.
    if (action.removeMissing && ended && !summary.truncated)
      for (let round = 0; round < 20; round += 1) {
        await holdLease(context);
        const missing = await listMissingAppSyncKeys(deps.db, {
          workspaceId: task.workspaceId,
          taskId: task.id,
          subjectId: ledger,
          pass,
          limit: 1_000,
        });
        if (missing.length === 0) break;
        summary.removed += await writer.remove(missing);
        await deleteAppSyncKeys(deps.db, {
          workspaceId: task.workspaceId,
          taskId: task.id,
          subjectId: ledger,
          keys: missing,
        });
      }
    return { summary, error: null };
  } catch (error) {
    if (error instanceof AppSyncLeaseLost) throw error;
    return { summary, error: clip(errorText(error)) };
  }
}

type AppSyncExecution =
  | { status: "succeeded" | "failed"; error: string | null; summary: AppSyncRunSummary }
  /** The run lost its lease part way; whoever holds it now settles it. */
  | { status: "lease_lost" };

/**
 * Who a personal sync's event run is for: everyone opted in, unless only
 * people's own (private) event sources fired it; then only those people.
 */
async function eventRunPeople(
  deps: AppSyncDeps,
  task: ScheduledTask,
  context: AppSyncRunContext,
): Promise<Set<string> | null> {
  if (context.triggerType !== "event" || !context.runId) return null;
  const sources = await appSyncRunEventSources(deps.db, task.workspaceId, context.runId);
  if (!sources || sources.workspaceWide) return null;
  return new Set(sources.owners);
}

/** Run one sync once. Shared: as the owner. Personal: once for each person who opted in. */
export async function executeAppSync(
  deps: AppSyncDeps,
  task: ScheduledTask,
  context: AppSyncRunContext,
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<AppSyncExecution> {
  const action = appSyncActionOf(task.action);
  if (!action)
    return {
      status: "failed",
      error: "This sync's settings can't be read. Save it again.",
      summary: emptySummary(),
    };
  try {
    if (action.mode === "shared") {
      const run = await runForPerson(
        deps,
        callTool,
        task,
        action,
        action.ownerSubjectId,
        context,
        action.ownerAccount ?? null,
      );
      return { status: run.error ? "failed" : "succeeded", error: run.error, summary: run.summary };
    }
    const only = await eventRunPeople(deps, task, context);
    const people = (
      await listAppSyncSubscriptions(deps.db, task.workspaceId, task.id, APP_SYNC_MAX_SUBSCRIBERS)
    ).filter((person) => !only || only.has(person.subjectId));
    const total: AppSyncRunSummary = {
      ...emptySummary(),
      people: { total: people.length, failed: 0 },
    };
    let firstError: string | null = null;
    for (const person of people) {
      const run = await runForPerson(
        deps,
        callTool,
        task,
        action,
        person.subjectId,
        context,
        person.account,
      );
      total.received += run.summary.received;
      total.written += run.summary.written;
      total.skipped += run.summary.skipped;
      total.pages += run.summary.pages;
      total.removed += run.summary.removed;
      total.truncated ||= run.summary.truncated;
      if (run.error) {
        total.people!.failed += 1;
        firstError ??= run.error;
      }
      await recordAppSyncSubscriptionRun(deps.db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        subjectId: person.subjectId,
        status: run.error ? "failed" : "succeeded",
        error: run.error,
        summary: run.summary,
      }).catch(() => undefined);
      await holdLease(context);
    }
    const failed = total.people!.failed;
    return {
      status: failed > 0 ? "failed" : "succeeded",
      error:
        failed > 0
          ? clip(
              `${failed} of ${people.length} ${people.length === 1 ? "person" : "people"} failed. First error: ${firstError}`,
            )
          : null,
      summary: total,
    };
  } catch (error) {
    if (error instanceof AppSyncLeaseLost) return { status: "lease_lost" };
    throw error;
  }
}

/**
 * Execute one queued run, if this executor can claim it. A run of a sync
 * that is gone or paused settles skipped, and so does one whose sync has
 * another run in progress (overlap policy `skip`). The run renews its lease
 * with its claim's token as it goes, so a long personal sync is not claimed
 * a second time; once a renewal fails it stops calling and writing, and
 * leaves the run to the executor that holds it now (null).
 */
export async function executeQueuedAppSyncRun(
  deps: AppSyncDeps,
  due: { workspaceId: string; runId: string },
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<AppSyncLastRun | null> {
  const claimed = await claimAppSyncRun(deps.db, due);
  if (!claimed) return null;
  const lease = { leaseToken: claimed.leaseToken, attempts: claimed.attempts };
  const settle = async (
    status: "succeeded" | "failed" | "skipped",
    error: string | null,
    summary: AppSyncRunSummary | null,
  ): Promise<AppSyncLastRun | null> => {
    const settled = await finishAppSyncRun(deps.db, {
      workspaceId: claimed.workspaceId,
      runId: claimed.runId,
      status,
      error,
      summary,
      lease,
    });
    if (!settled) return null;
    return { runId: claimed.runId, status, at: new Date().toISOString(), error, summary };
  };
  if (claimed.attempts > RUN_ATTEMPTS)
    return await settle(
      "failed",
      "The sync run stopped before it finished. It will run again at its next time.",
      null,
    );
  if (claimed.overlapping)
    return await settle("skipped", "Another run of this sync was still in progress.", null);
  const task = await getScheduledTask(deps.db, claimed.workspaceId, claimed.taskId);
  if (!task) return await settle("skipped", "The sync was deleted.", null);
  if (task.status !== "active" && claimed.triggerType !== "manual")
    return await settle("skipped", "The sync is paused.", null);
  const result = await executeAppSync(
    deps,
    task,
    {
      chainDepth: claimed.chainDepth,
      runId: claimed.runId,
      triggerType: claimed.triggerType,
      renew: async () =>
        await renewAppSyncLease(deps.db, {
          workspaceId: claimed.workspaceId,
          runId: claimed.runId,
          lease,
        }),
    },
    callTool,
  );
  if (result.status === "lease_lost") return null;
  return await settle(result.status, result.error, result.summary);
}

/** One executor pass: claim and run due sync runs, one at a time. */
export async function drainAppSyncRuns(
  deps: AppSyncDeps,
  options: { limit?: number; callTool?: AppSyncToolCaller } = {},
): Promise<{ claimed: number }> {
  const due = await listDueAppSyncRuns(deps.db, options.limit ?? 8);
  let claimed = 0;
  for (const run of due) {
    try {
      const result = await executeQueuedAppSyncRun(deps, run, options.callTool);
      if (result) claimed += 1;
    } catch (error) {
      deps.observability?.warn?.("App data sync run failed to settle", {
        runId: run.runId,
        error: errorText(error),
      });
    }
  }
  return { claimed };
}

/** One non-overlapping executor loop per API replica; queue leases coordinate replicas. */
export function startAppSyncPump(
  deps: AppSyncDeps,
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(250, options.intervalMs ?? 5_000);
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = drainAppSyncRuns(deps)
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.observability?.warn?.("App data sync pass failed", { error: errorText(error) });
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

// --- managing syncs ----------------------------------------------------------------

function validateSchedule(schedule: ScheduledTaskScheduleSpec): void {
  if (schedule.type === "interval" && schedule.everySeconds < MIN_INTERVAL_SECONDS)
    throw invalid(`A sync runs at most every ${MIN_INTERVAL_SECONDS / 60} minutes.`);
  if (
    schedule.type === "interval" &&
    schedule.startAt &&
    schedule.endAt &&
    new Date(schedule.startAt).getTime() >= new Date(schedule.endAt).getTime()
  )
    throw invalid("The schedule's end must be after its start.");
}

function parseOrInvalid<T>(
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalid(
    parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
      .join("; "),
  );
}

async function managerAccess(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
): Promise<SiteDataAccess & { subjectId: string }> {
  const access = await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  if (!access.subjectId)
    throw forbidden(
      "A sync runs on a person's connection, so a person (or their agent) must set it up.",
    );
  return access as SiteDataAccess & { subjectId: string };
}

/**
 * Where a sync writes, checked when it is saved: exactly one collection
 * (shared or per_viewer to match the mode) or, for a shared sync, one Site
 * SQL table of a Site whose SQL is on.
 */
async function requireTargetFor(
  deps: AppSyncDeps,
  access: SiteDataAccess,
  grant: AccessGrant,
  siteId: string,
  where: { collection: string | null; target: AppSyncTableTarget | null },
  mode: "shared" | "personal",
): Promise<void> {
  if (where.target) {
    if (where.collection)
      throw invalid("A sync fills either a collection or a table (target), not both.");
    if (mode !== "shared")
      throw invalid(
        "A personal sync fills each person's own records, so it needs a per_viewer collection. Only a shared sync can fill a table.",
      );
    if (!Object.keys(where.target.columns).some((column) => column !== where.target!.keyColumn))
      throw invalid("Map at least one column besides the key column in target.columns.");
    try {
      await requireSiteSqlForSync(deps, access, siteId);
    } catch (error) {
      // Saving a sync answers in Site Data terms: what is missing, readably.
      if (error instanceof SiteSqlError) throw invalid(error.message);
      throw error;
    }
    return;
  }
  if (!where.collection)
    throw invalid("Give the collection the sync fills, or a Site SQL table as target.");
  await requireCollectionFor(access, grant, siteId, where.collection, mode);
}

async function requireCollectionFor(
  access: SiteDataAccess,
  grant: AccessGrant,
  siteId: string,
  collection: string,
  mode: "shared" | "personal",
): Promise<void> {
  const found = await access.store.getCollection(
    { accountId: grant.accountId, workspaceId: grant.workspaceId, siteId },
    collection,
  );
  if (!found) throw invalid(`The app has no collection named "${collection}". Define it first.`);
  if (mode === "personal" && found.accessMode !== "per_viewer")
    throw invalid(
      `A personal sync fills each person's own records, so "${collection}" must be a per_viewer collection (privateRecords keeps them from the app's managers too).`,
    );
  if (mode === "shared" && found.accessMode === "per_viewer")
    throw invalid(
      `"${collection}" keeps each person's records separately. Use a shared or shared_read collection for a shared sync, or make it a personal sync.`,
    );
}

async function declaredToolsFor(
  deps: AppSyncDeps,
  grant: AccessGrant,
  tool: ToolGatewayIdentity,
): Promise<ToolGatewayIdentity[]> {
  try {
    return (await declareSiteToolsForEveryViewer(deps, grant, [tool])).slice(0, 8);
  } catch {
    // Without the pairing the sync still runs for its owner.
    return [tool];
  }
}

const sameTool = (left: ToolGatewayIdentity, right: ToolGatewayIdentity) =>
  left.serverId === right.serverId && left.toolName === right.toolName;

type RoutedTool = Pick<AppSyncAction, "tool" | "declaredTools" | "connectorTool">;

/**
 * The tool a sync stores when someone saves it. `requested` may be the
 * saver's (or their agent's) account route, a connector, or a tool without
 * accounts. The connector-level identity is kept for exports and for other
 * people's runs; a shared sync is pinned to the new owner's own account of
 * that connector, never the previous owner's.
 */
async function routeToolForOwner(
  deps: AppSyncDeps,
  grant: AccessGrant,
  ownerSubjectId: string,
  requested: ToolGatewayIdentity,
  mode: "shared" | "personal",
  previous?: RoutedTool,
  account?: string,
): Promise<RoutedTool & { ownerAccount: string | null }> {
  const declared = await declaredToolsFor(deps, grant, requested);
  const inherited = previous ? [...previous.declaredTools, connectorToolOf(previous)] : [];
  let connector = connectorToolOf({
    tool: requested,
    declaredTools: declared,
    connectorTool: null,
  });
  let inventory: SiteToolAccountInventory | null = null;
  try {
    const owner = await personGrant(deps, grant, ownerSubjectId);
    inventory = owner ? await readInventory(deps, owner) : null;
  } catch {
    inventory = null;
  }
  // The saver's own route maps through their accounts; another person's (an
  // edit by a new owner) through the connector it was saved with.
  if (inventory)
    connector = connectorToolIdentity(
      inventory,
      uniqueTools([...declared, ...inherited]),
      requested,
    );
  let tool = requested;
  let ownerAccount: string | null = null;
  if (mode === "shared") {
    if (!inventory) {
      if (account)
        throw forbidden("Couldn't check your connected accounts. Try saving the sync again shortly.");
    } else {
      const routed = {
        tool: requested,
        declaredTools: [...declared, ...inherited],
        connectorTool: connector,
      };
      const { connector: connectorName, accounts } = appSyncAccountChoices(
        inventory,
        routed,
        "shared",
      );
      const ownRoute = accounts.find((choice) => choice.id === requested.serverId);
      // The owner picks the account a shared sync runs on: given, or the
      // account route they saved it with, or their only account.
      const picked = account
        ? accounts.find((choice) => choice.id === account)
        : (ownRoute ?? (accounts.length === 1 ? accounts[0] : undefined));
      if (account && !picked)
        throw invalid(
          accounts.length > 0
            ? `That account isn't one of yours for ${connectorName ?? "this tool"}. Pick one of: ${choiceList(accounts)}.`
            : `You have no ${connectorName ?? "account for this tool"} connected. Connect it in Opengeni first.`,
          { accounts },
        );
      if (!picked && accounts.length > 1)
        throw invalid(
          `You have several ${connectorName ? `${connectorName} accounts` : "accounts for this tool"}. Choose the one this sync runs on with account: ${choiceList(accounts)}.`,
          { accounts },
        );
      if (picked) {
        tool = { serverId: picked.id, toolName: requested.toolName };
        ownerAccount = picked.id;
      } else {
        const route = resolveAppSyncTool(inventory, routed, "shared");
        if (route.kind === "route") tool = route.identity;
      }
    }
  }
  const declaredTools = uniqueTools([tool, connector, ...declared]).slice(0, 8);
  return { tool, declaredTools, connectorTool: connector, ownerAccount };
}

async function requireSyncTask(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
): Promise<{ task: ScheduledTask; action: AppSyncAction }> {
  const task = await getScheduledTask(deps.db, grant.workspaceId, syncId).catch(() => null);
  const action = task ? appSyncActionOf(task.action) : null;
  if (!task || !action || action.siteId !== siteId)
    throw new SiteDataError("not_found", "Sync not found");
  return { task, action };
}

/** The collection a sync fills, or the table of a Site SQL target. */
function syncTargetName(action: Pick<AppSyncAction, "collection" | "target">): string {
  return action.collection ?? action.target?.table ?? "";
}

function viewOf(
  task: ScheduledTask,
  action: AppSyncAction,
  lastRun: AppSyncLastRun | null,
  subscribers: number | null,
): AppSync {
  return {
    id: task.id,
    siteId: action.siteId,
    name: task.name,
    status: task.status,
    mode: action.mode,
    collection: syncTargetName(action),
    tool: action.tool,
    arguments: action.arguments,
    recordsPath: action.recordsPath,
    key: action.key,
    fields: action.fields,
    target: action.target ?? null,
    paging: action.paging ?? null,
    maxRecords: action.maxRecords ?? null,
    removeMissing: action.removeMissing === true,
    account: action.ownerAccount ?? null,
    schedule: task.schedule,
    events: task.events ?? null,
    ownerSubjectId: action.ownerSubjectId,
    subscribers,
    lastRun,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function syncViews(deps: AppSyncDeps, tasks: ScheduledTask[]): Promise<AppSync[]> {
  if (tasks.length === 0) return [];
  const workspaceId = tasks[0]!.workspaceId;
  const ids = tasks.map((task) => task.id);
  const [runs, counts, withEvents] = await Promise.all([
    latestAppSyncRuns(deps.db, workspaceId, ids),
    countAppSyncSubscriptions(deps.db, workspaceId, ids),
    withScheduledTaskEvents(deps.db, tasks),
  ]);
  return withEvents.flatMap((task) => {
    const action = appSyncActionOf(task.action);
    if (!action) return [];
    return [
      viewOf(
        task,
        action,
        runs.get(task.id) ?? null,
        action.mode === "personal" ? (counts.get(task.id) ?? 0) : null,
      ),
    ];
  });
}

async function siteSyncTasks(
  deps: AppSyncDeps,
  scope: { accountId: string; workspaceId: string },
  siteId: string,
): Promise<ScheduledTask[]> {
  const ids = await listAppSyncTaskIds(deps.db, scope, siteId);
  const tasks = await Promise.all(
    ids.map((id) => getScheduledTask(deps.db, scope.workspaceId, id).catch(() => null)),
  );
  return tasks.filter((task): task is ScheduledTask => task !== null);
}

/** A Site's syncs, for its managers. */
export async function listAppSyncs(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
): Promise<AppSync[]> {
  await managerAccess(deps, grant, siteId);
  return await syncViews(deps, await siteSyncTasks(deps, grant, siteId));
}

type CreateOptions = {
  /** Installed syncs start paused until someone confirms the account. */
  status?: "active" | "paused";
};

/** The optional settings an action stores only when they are used. */
function syncOptions(settings: {
  target?: AppSyncTableTarget | null | undefined;
  paging?: AppSyncAction["paging"] | undefined;
  maxRecords?: number | null | undefined;
  removeMissing?: boolean | undefined;
}): {
  target?: AppSyncTableTarget;
  paging?: NonNullable<AppSyncAction["paging"]>;
  maxRecords?: number;
  removeMissing?: true;
} {
  return {
    ...(settings.target ? { target: settings.target } : {}),
    ...(settings.paging ? { paging: settings.paging } : {}),
    ...(settings.maxRecords ? { maxRecords: settings.maxRecords } : {}),
    ...(settings.removeMissing ? { removeMissing: true } : {}),
  };
}

async function insertSync(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  request: ReturnType<typeof AppSyncCreateRequest.parse>,
  ownerSubjectId: string,
): Promise<ScheduledTask> {
  validateSchedule(request.schedule);
  const routed = await routeToolForOwner(
    deps,
    grant,
    ownerSubjectId,
    request.tool,
    request.mode,
    undefined,
    request.account,
  );
  const action: AppSyncAction = AppSyncAction.parse({
    kind: "app_sync",
    siteId,
    ownerSubjectId,
    collection: request.target ? null : (request.collection ?? null),
    mode: request.mode,
    ...routed,
    arguments: request.arguments,
    recordsPath: request.recordsPath,
    key: request.key,
    fields: request.fields,
    ...syncOptions(request),
  });
  const events =
    request.events && request.events.triggers.length > 0
      ? await validateScheduledTaskEvents({
          settings: deps.settings,
          db: deps.db,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          // The owner's own event sources fire their syncs too (the event
          // matcher reads the owner from the sync's action).
          ownerSubjectId,
          actorSubjectId: ownerSubjectId,
          schedule: request.schedule,
          action,
          events: request.events,
        })
      : null;
  const id = crypto.randomUUID();
  const task = await deps.db.transaction(async (tx) => {
    const created = await createScheduledTask(tx, {
      id,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: request.name.trim(),
      status: request.status,
      visibility: "workspace_shared",
      schedule: request.schedule,
      temporalScheduleId: scheduledTaskTemporalScheduleId(id),
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      action,
      agentConfig: ScheduledTaskAgentConfig.parse({ prompt: `App data sync: ${request.name}` }),
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      metadata: { appSync: { siteId } },
    });
    if (events && events.triggers.length > 0) await writeScheduledTaskEvents(tx, created, events);
    return created;
  });
  await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
  return task;
}

/** Create a sync for a Site. The person saving it owns it: a shared sync runs on their connection. */
export async function createAppSync(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  input: unknown,
  options: CreateOptions = {},
): Promise<AppSync> {
  const access = await managerAccess(deps, grant, siteId);
  const request = parseOrInvalid(AppSyncCreateRequest, input);
  if (options.status) request.status = options.status;
  await requireTargetFor(
    deps,
    access,
    grant,
    siteId,
    { collection: request.collection ?? null, target: request.target ?? null },
    request.mode,
  );
  const task = await insertSync(deps, grant, siteId, request, access.subjectId);
  const [view] = await syncViews(deps, [task]);
  return view!;
}

/** Change a sync. Whoever saves it becomes its owner. */
export async function updateAppSync(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  input: unknown,
): Promise<AppSync> {
  const access = await managerAccess(deps, grant, siteId);
  const patch = parseOrInvalid(AppSyncUpdateRequest, input);
  const { task, action } = await requireSyncTask(deps, grant, siteId, syncId);
  const mode = patch.mode ?? action.mode;
  // A collection replaces a table target and the other way round.
  const target =
    patch.target !== undefined
      ? patch.target
      : patch.collection !== undefined
        ? null
        : (action.target ?? null);
  const collection = target ? null : (patch.collection ?? action.collection);
  if (patch.mode !== undefined || patch.collection !== undefined || patch.target !== undefined)
    await requireTargetFor(deps, access, grant, siteId, { collection, target }, mode);
  const schedule = patch.schedule ?? task.schedule;
  if (patch.schedule) validateSchedule(schedule);
  const ownerChanged = action.ownerSubjectId !== access.subjectId;
  const reroute =
    patch.tool !== undefined ||
    patch.account !== undefined ||
    ownerChanged ||
    mode !== action.mode;
  const routed: RoutedTool & { ownerAccount: string | null } = reroute
    ? await routeToolForOwner(
        deps,
        grant,
        access.subjectId,
        // A new account choice starts from the connector, not the old route.
        patch.tool ?? (patch.account !== undefined ? connectorToolOf(action) : action.tool),
        mode,
        patch.tool ? undefined : action,
        patch.account,
      )
    : {
        tool: action.tool,
        declaredTools: action.declaredTools,
        connectorTool: connectorToolOf(action),
        ownerAccount: action.ownerAccount ?? null,
      };
  // The triggers of a sync whose owner changes must still be ones the new
  // owner may use: another person's own event source would stop firing.
  if (ownerChanged && !patch.events) await requireTriggersUsableBy(deps, task, access.subjectId);
  const {
    target: _target,
    paging: _paging,
    maxRecords: _maxRecords,
    removeMissing: _removeMissing,
    ownerAccount: _ownerAccount,
    ...kept
  } = action;
  const nextAction = AppSyncAction.parse({
    ...kept,
    ownerSubjectId: access.subjectId,
    collection,
    mode,
    ...routed,
    ...(patch.arguments !== undefined ? { arguments: patch.arguments } : {}),
    ...(patch.recordsPath !== undefined ? { recordsPath: patch.recordsPath } : {}),
    ...(patch.key !== undefined ? { key: patch.key } : {}),
    ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
    ...syncOptions({
      target,
      paging: patch.paging !== undefined ? patch.paging : action.paging,
      maxRecords: patch.maxRecords !== undefined ? patch.maxRecords : action.maxRecords,
      removeMissing: patch.removeMissing ?? action.removeMissing,
    }),
  });
  const events = patch.events
    ? await validateScheduledTaskEvents({
        settings: deps.settings,
        db: deps.db,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        ownerSubjectId: access.subjectId,
        actorSubjectId: access.subjectId,
        taskId: task.id,
        schedule,
        action: nextAction,
        events: patch.events,
      })
    : null;
  const updated = await deps.db.transaction(async (tx) => {
    const next = await updateScheduledTask(tx, grant.workspaceId, task.id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      action: nextAction,
    });
    if (events) await writeScheduledTaskEvents(tx, next, events);
    return next;
  });
  // People opted in to run one tool with one set of arguments into one
  // collection; anything else needs their consent again.
  if (
    !sameTool(connectorToolOf(action), connectorToolOf(nextAction)) ||
    stableJson(action.arguments) !== stableJson(nextAction.arguments) ||
    action.collection !== nextAction.collection ||
    action.mode !== nextAction.mode
  )
    await clearAppSyncSubscriptions(deps.db, grant.workspaceId, task.id);
  // Keys this sync wrote name records in one place; written elsewhere they
  // mean nothing, so removeMissing starts over.
  if (
    syncTargetName(action) !== syncTargetName(nextAction) ||
    stableJson(action.target ?? null) !== stableJson(nextAction.target ?? null) ||
    action.key !== nextAction.key ||
    action.mode !== nextAction.mode
  )
    await clearAppSyncKeys(deps.db, grant.workspaceId, task.id);
  await syncUpdatedScheduledTask({
    db: deps.db,
    workflowClient: deps.workflowClient,
    previous: { task },
    task: updated,
  });
  const [view] = await syncViews(deps, [updated]);
  return view!;
}

async function requireTriggersUsableBy(
  deps: AppSyncDeps,
  task: ScheduledTask,
  subjectId: string,
): Promise<void> {
  const [withEvents] = await withScheduledTaskEvents(deps.db, [task]);
  for (const trigger of withEvents?.events?.triggers ?? []) {
    const source = await getEventSource(deps.db, task.workspaceId, trigger.sourceId).catch(
      () => null,
    );
    if (source && !eventSourceVisibleTo(source, subjectId))
      throw invalid(
        "This sync is started by its owner's own event source, which you can't use. Save it with new triggers (events) to take it over.",
      );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Delete a sync. Records it already wrote stay. */
export async function deleteAppSync(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
): Promise<{ deleted: string }> {
  const access = await managerAccess(deps, grant, siteId);
  await requireSyncTask(deps, grant, siteId, syncId);
  await deleteScheduledTaskLifecycle({
    db: deps.db,
    workspaceId: grant.workspaceId,
    taskId: syncId,
    subjectId: access.subjectId,
    processCleanupClaims: async (claims) => {
      await processTemporalScheduleCleanupClaims(
        {
          db: deps.db,
          deleteSchedule: async (temporalScheduleId) =>
            await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId }),
        },
        claims,
      );
    },
  });
  return { deleted: syncId };
}

/**
 * The chain depth of a manual run. A person's run starts a chain (1). An
 * agent's run continues the chain of the automation behind its turn (that
 * run's depth plus one), so an automation woken by the App's changes can't
 * loop through `app_sync_run`: past the chain limit it is refused, as the
 * event dispatcher refuses deeper event runs.
 */
async function manualRunChainDepth(deps: AppSyncDeps, grant: AccessGrant): Promise<number> {
  if (grant.principalKind !== "agent_attempt" && grant.metadata?.delegated !== true) return 1;
  const sessionId = grant.metadata?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return 1;
  const turnId = grant.metadata?.turnId;
  const cause = await getAppAutomationCause(
    deps.db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    { sessionId, turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null },
  );
  if (!cause) return 1;
  const limit = deps.settings.automationMaxChainDepth ?? EVENT_AUTOMATION_MAX_CHAIN_DEPTH;
  if (cause.chainDepth >= limit)
    throw new SiteDataError(
      "forbidden",
      `This automation was started by other automations ${cause.chainDepth} levels deep, so it can't run a sync: that could make automations wake each other in a loop. Run the sync from Opengeni or let its schedule run it.`,
      { reason: "automation_chain_limit", maxChainDepth: limit },
    );
  return cause.chainDepth + 1;
}

/** Run a sync now and wait for it. Works while it is paused too, to try it out. */
export async function runAppSyncNow(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<{ syncId: string; lastRun: AppSyncLastRun }> {
  await resolveSiteDataAccess(deps, grant, siteId, { management: true });
  const { task } = await requireSyncTask(deps, grant, siteId, syncId);
  const chainDepth = await manualRunChainDepth(deps, grant);
  const run = await createScheduledTaskRun(deps.db, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    triggerType: "manual",
    producerKey: `app-sync-manual:${crypto.randomUUID()}`,
  });
  await enqueueAppSyncRun(deps.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    runId: run.id,
    chainDepth,
  });
  const result = await executeQueuedAppSyncRun(
    deps,
    { workspaceId: task.workspaceId, runId: run.id },
    callTool,
  );
  return {
    syncId,
    lastRun: result ?? {
      runId: run.id,
      status: "queued",
      at: run.firedAt,
      error: null,
      summary: null,
    },
  };
}

/** The person's accounts for a personal sync; null when they can't be read. */
async function ownAccountChoices(
  deps: AppSyncDeps,
  grant: AccessGrant,
  action: AppSyncAction,
): Promise<{ connector: string | null; accounts: AppSyncAccountChoice[] } | null> {
  try {
    return appSyncAccountChoices(await readInventory(deps, grant), action, "personal");
  } catch {
    return null;
  }
}

/**
 * Opt the person (or the person an agent acts for) in to a personal sync,
 * or out. With several accounts of the sync's connector they pick one
 * (`account`); with one it is chosen for them. The choice is kept and every
 * run checks it is still theirs. Refused from inside an App's frame: an App
 * asks the platform host, which confirms with the person first.
 */
export async function setAppSyncOptIn(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  optedIn: boolean,
  surface: SiteDataSurface = {},
  input: unknown = {},
): Promise<{ syncId: string; optedIn: boolean; account: string | null }> {
  if (surface.frameSiteId !== undefined && surface.frameSiteId !== null)
    throw forbidden("Opt in to a sync from Opengeni, not from inside the app.");
  const request = parseOrInvalid(AppSyncOptInRequest, input ?? {});
  const access = await resolveSiteDataAccess(deps, grant, siteId);
  if (!access.subjectId) throw forbidden("Only a person can opt in to a personal sync.");
  const { task, action } = await requireSyncTask(deps, grant, siteId, syncId);
  if (action.mode !== "personal")
    throw invalid(
      "This sync fills shared data and runs for everyone; there is nothing to opt in to.",
    );
  let account: string | null = null;
  if (optedIn) {
    const choices = await ownAccountChoices(deps, grant, action);
    if (!choices) {
      if (request.account)
        throw forbidden("Couldn't check your connected accounts. Try again shortly.");
    } else if (request.account) {
      if (!choices.accounts.some((choice) => choice.id === request.account))
        throw invalid(
          `That account isn't one of yours for ${choices.connector ?? "this tool"}.${
            choices.accounts.length > 0 ? ` Pick one of: ${choiceList(choices.accounts)}.` : ""
          }`,
          { accounts: choices.accounts },
        );
      account = request.account;
    } else if (choices.accounts.length > 1)
      throw invalid(
        `You have several ${choices.connector ? `${choices.connector} accounts` : "accounts for this tool"}. Choose the one this sync runs on with account: ${choiceList(choices.accounts)}.`,
        { accounts: choices.accounts },
      );
    else account = choices.accounts[0]?.id ?? null;
  }
  await setAppSyncSubscription(deps.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    subjectId: access.subjectId,
    optedIn,
    ...(optedIn ? { account } : {}),
  });
  // Opted out: the keys this sync wrote for them no longer matter.
  if (!optedIn)
    await clearAppSyncKeys(deps.db, task.workspaceId, task.id, access.subjectId).catch(
      () => undefined,
    );
  return { syncId, optedIn, account };
}

/**
 * What the platform's opt-in confirmation shows for a personal sync: its
 * name, the tool it calls, where it writes and the person's own accounts of
 * the connector. Read by the host (the console, or a published App's shell),
 * never by the App's page.
 */
export async function appSyncOptInReview(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  surface: SiteDataSurface = {},
): Promise<AppSyncOptInReview> {
  if (surface.frameSiteId !== undefined && surface.frameSiteId !== null)
    throw forbidden("Opt in to a sync from Opengeni, not from inside the app.");
  const access = await resolveSiteDataAccess(deps, grant, siteId);
  if (!access.subjectId) throw forbidden("Only a person can opt in to a personal sync.");
  const { task, action } = await requireSyncTask(deps, grant, siteId, syncId);
  const own = await getAppSyncSubscriptionsForSubject(
    deps.db,
    task.workspaceId,
    [task.id],
    access.subjectId,
  );
  const subscription = own.get(task.id);
  const choices =
    action.mode === "personal" ? await ownAccountChoices(deps, grant, action) : null;
  const connector = choices?.connector ?? null;
  const accounts = choices?.accounts ?? [];
  const blocked =
    action.mode !== "personal"
      ? "This sync fills shared data and runs for everyone; there is nothing to opt in to."
      : task.status !== "active"
        ? "This sync is paused."
        : connector && accounts.length === 0
          ? `Connect your own ${connector} account in Opengeni first.`
          : null;
  return {
    syncId: task.id,
    name: task.name,
    mode: action.mode,
    collection: syncTargetName(action),
    tool: { toolName: action.tool.toolName, connector },
    accounts,
    account: subscription?.account ?? null,
    optedIn: subscription !== undefined,
    blocked,
  };
}

/**
 * What the App's own page may know about its syncs: when each last ran and
 * whether it failed. Anyone who can see the App reads it; a personal sync's
 * last run and opt-in are the viewer's own.
 */
export async function appSyncStatusForSite(
  deps: AppSyncDeps,
  authority: SiteDataAuthority,
  siteId: string,
  surface: SiteDataSurface = {},
): Promise<{ syncs: AppSyncStatus[] }> {
  const access = await resolveSiteDataAccess(deps, authority, siteId, surface);
  const scope = { accountId: access.caller.accountId, workspaceId: access.caller.workspaceId };
  const tasks = await siteSyncTasks(deps, scope, siteId);
  if (tasks.length === 0) return { syncs: [] };
  const ids = tasks.map((task) => task.id);
  const [runs, own] = await Promise.all([
    latestAppSyncRuns(deps.db, scope.workspaceId, ids),
    access.subjectId
      ? getAppSyncSubscriptionsForSubject(deps.db, scope.workspaceId, ids, access.subjectId)
      : Promise.resolve(new Map()),
  ]);
  return {
    syncs: tasks.flatMap((task) => {
      const action = appSyncActionOf(task.action);
      if (!action) return [];
      const personal = action.mode === "personal";
      const subscription = own.get(task.id);
      return [
        {
          id: task.id,
          name: task.name,
          collection: syncTargetName(action),
          ...(action.target ? { table: action.target.table } : {}),
          mode: action.mode,
          active: task.status === "active",
          lastRun: personal ? (subscription?.lastRun ?? null) : (runs.get(task.id) ?? null),
          optedIn: personal ? subscription !== undefined : null,
        },
      ];
    }),
  };
}

// --- export and install ------------------------------------------------------------

/** A Site's syncs as plain, portable definitions (no ids, owners or accounts). */
export async function listAppSyncDefinitions(
  deps: AppSyncDeps,
  scope: { accountId: string; workspaceId: string },
  siteId: string,
): Promise<AppSyncDefinition[]> {
  const tasks = await withScheduledTaskEvents(deps.db, await siteSyncTasks(deps, scope, siteId));
  return tasks.flatMap((task) => {
    const action = appSyncActionOf(task.action);
    if (!action) return [];
    const definition: AppSyncDefinitionInput = {
      name: task.name,
      ...(action.collection ? { collection: action.collection } : {}),
      mode: action.mode,
      // The connector, not one person's account: each installer's sync runs
      // on their own account of it.
      tool: connectorToolOf(action),
      arguments: action.arguments,
      recordsPath: action.recordsPath,
      key: action.key,
      fields: action.fields,
      // Only what the sync uses, so a definition without them stays the same JSON.
      ...syncOptions(action),
      schedule: task.schedule,
      ...(task.events && task.events.triggers.length > 0
        ? {
            events: {
              // A source id names a source in this workspace; install maps
              // or drops sources the target workspace doesn't have.
              triggers: task.events.triggers.map((trigger) => ({
                sourceId: trigger.sourceId,
                eventTypes: trigger.eventTypes,
                conditions: trigger.conditions,
                includeOwnEvents: trigger.includeOwnEvents,
                ...(trigger.arguments ? { arguments: trigger.arguments } : {}),
              })),
              maxRunsPerHour: task.events.maxRunsPerHour,
              once: task.events.once,
            },
          }
        : {}),
    };
    const parsed = AppSyncDefinition.safeParse(definition);
    if (parsed.success) return [parsed.data];
    // Keep the sync even when its triggers can't be described portably.
    const { events: _events, ...withoutEvents } = definition;
    const plain = AppSyncDefinition.safeParse(withoutEvents);
    return plain.success ? [plain.data] : [];
  });
}

/**
 * Create a sync from a definition, for App install. It starts paused: the
 * installer confirms the account it runs on by resuming it (saving it with
 * `status: "active"`), which makes them its owner.
 */
export async function createAppSyncFromDefinition(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  definition: AppSyncDefinitionInput,
): Promise<AppSync> {
  return await createAppSync(deps, grant, siteId, definition, { status: "paused" });
}
