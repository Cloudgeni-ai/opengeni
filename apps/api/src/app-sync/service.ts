import {
  APP_SYNC_MAX_RECORDS,
  APP_SYNC_MAX_SUBSCRIBERS,
  AppSyncAction,
  AppSyncCreateRequest,
  AppSyncDefinition,
  AppSyncUpdateRequest,
  ScheduledTaskAgentConfig,
  type AccessGrant,
  type AppSync,
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
  appSyncActionOf,
  claimAppSyncRun,
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
  readSiteToolAccountInventory,
  routeSiteTool,
} from "../site-tool-routing";
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

export type AppSyncDeps = ApiRouteDeps;

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
const invalid = (message: string) => new SiteDataError("validation", message);

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
): AppSyncRecords {
  let list: unknown[];
  if (settings.recordsPath) {
    const found = readPath(value, settings.recordsPath);
    if (found === undefined)
      throw invalid(`The tool result has nothing at "${settings.recordsPath}".`);
    list = Array.isArray(found) ? found : [found];
  } else list = autoList(value);
  const truncated = list.length > APP_SYNC_MAX_RECORDS;
  const items = list.slice(0, APP_SYNC_MAX_RECORDS);
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

/**
 * The identity this person's call uses: the stored tool when it is theirs or
 * needs no account, else their own account of the same connector.
 */
async function toolForPerson(
  deps: AppSyncDeps,
  grant: AccessGrant,
  action: AppSyncAction,
): Promise<ToolGatewayIdentity> {
  const declared = action.declaredTools.length > 0 ? action.declaredTools : [action.tool];
  let inventory;
  try {
    inventory = await readSiteToolAccountInventory(deps, grant);
  } catch {
    return action.tool;
  }
  let route;
  try {
    route = routeSiteTool(inventory, declared, action.tool);
  } catch {
    return action.tool;
  }
  if (route.kind === "direct") return route.identity;
  if (route.kind === "connect")
    throw forbidden(`Connect ${route.connect.name} in Opengeni first, then the sync can use it.`);
  const own = route.accounts.find((account) => !account.shared) ?? route.accounts[0]!;
  return own.identity;
}

// --- writing ---------------------------------------------------------------------

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

/**
 * The access a sync run writes with: the Site as the person sees it (so a
 * lost audience or archived App stops the sync), the sync's own principal
 * and writer, and the run's automation chain depth on change events.
 */
async function syncAccess(
  deps: AppSyncDeps,
  grant: AccessGrant,
  task: ScheduledTask,
  action: AppSyncAction,
  chainDepth: number,
): Promise<SiteDataAccess> {
  const access = await resolveSiteDataAccess(deps, grant, action.siteId);
  const collection = await access.store.getCollection(
    { accountId: task.accountId, workspaceId: task.workspaceId, siteId: action.siteId },
    action.collection,
  );
  if (!collection)
    throw invalid(`The App has no collection named "${action.collection}" any more.`);
  if (action.mode === "shared") {
    if (access.caller.role !== "manager")
      throw forbidden(
        "The sync's owner can no longer manage this App's data. Someone who manages the App should save the sync again.",
      );
    if (collection.accessMode === "per_viewer")
      throw invalid(
        `"${action.collection}" keeps each person's records separately, so a shared sync can't fill it. Use a personal sync or a shared collection.`,
      );
  } else if (collection.accessMode !== "per_viewer")
    throw invalid(
      `A personal sync fills each person's own records, so "${action.collection}" must be a per_viewer collection.`,
    );
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
      chainDepth,
    },
  };
}

type PersonRun = { summary: AppSyncRunSummary; error: string | null };

async function runForPerson(
  deps: AppSyncDeps,
  callTool: AppSyncToolCaller,
  task: ScheduledTask,
  action: AppSyncAction,
  subjectId: string,
  chainDepth: number,
): Promise<PersonRun> {
  const empty: AppSyncRunSummary = {
    received: 0,
    written: 0,
    skipped: 0,
    truncated: false,
    people: null,
  };
  try {
    const grant = await personGrant(deps, task, subjectId);
    if (!grant)
      throw forbidden(
        action.mode === "shared"
          ? "The sync's owner is no longer in this workspace. Someone who manages the App should save the sync again."
          : "This person is no longer in the workspace.",
      );
    const access = await syncAccess(deps, grant, task, action, chainDepth);
    const identity = await toolForPerson(deps, grant, action);
    const result = await callTool({ deps, grant, identity, arguments: action.arguments });
    if ((result as { isError?: unknown }).isError === true) {
      let detail = "";
      const content = (result as { content?: unknown }).content;
      if (Array.isArray(content))
        for (const part of content)
          if (isObject(part) && part.type === "text" && typeof part.text === "string") {
            detail = part.text;
            break;
          }
      throw invalid(clip(`The tool returned an error${detail ? `: ${detail}` : "."}`, 1000));
    }
    const extracted = appSyncRecords(toolResultValue(result), action);
    const written = await writeRecords(deps, access, action.collection, extracted.records);
    return {
      summary: {
        received: extracted.received,
        written,
        skipped: extracted.skipped,
        truncated: extracted.truncated,
        people: null,
      },
      error: null,
    };
  } catch (error) {
    return { summary: empty, error: clip(errorText(error)) };
  }
}

/** Run one sync once. Shared: as the owner. Personal: once for each person who opted in. */
export async function executeAppSync(
  deps: AppSyncDeps,
  task: ScheduledTask,
  chainDepth: number,
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<{ status: "succeeded" | "failed"; error: string | null; summary: AppSyncRunSummary }> {
  const action = appSyncActionOf(task.action);
  if (!action)
    return {
      status: "failed",
      error: "This sync's settings can't be read. Save it again.",
      summary: { received: 0, written: 0, skipped: 0, truncated: false, people: null },
    };
  if (action.mode === "shared") {
    const run = await runForPerson(deps, callTool, task, action, action.ownerSubjectId, chainDepth);
    return { status: run.error ? "failed" : "succeeded", error: run.error, summary: run.summary };
  }
  const people = await listAppSyncSubscriptions(
    deps.db,
    task.workspaceId,
    task.id,
    APP_SYNC_MAX_SUBSCRIBERS,
  );
  const total: AppSyncRunSummary = {
    received: 0,
    written: 0,
    skipped: 0,
    truncated: false,
    people: { total: people.length, failed: 0 },
  };
  let firstError: string | null = null;
  for (const person of people) {
    const run = await runForPerson(deps, callTool, task, action, person.subjectId, chainDepth);
    total.received += run.summary.received;
    total.written += run.summary.written;
    total.skipped += run.summary.skipped;
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
}

/**
 * Execute one queued run, if this executor can claim it. A run of a sync
 * that is gone or paused settles skipped; another run of the same sync still
 * running makes this one skip too (overlap policy `skip`).
 */
export async function executeQueuedAppSyncRun(
  deps: AppSyncDeps,
  due: { workspaceId: string; runId: string },
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<AppSyncLastRun | null> {
  const claimed = await claimAppSyncRun(deps.db, due);
  if (!claimed) return null;
  const settle = async (
    status: "succeeded" | "failed" | "skipped",
    error: string | null,
    summary: AppSyncRunSummary | null,
  ): Promise<AppSyncLastRun> => {
    await finishAppSyncRun(deps.db, {
      workspaceId: claimed.workspaceId,
      runId: claimed.runId,
      status,
      error,
      summary,
    });
    return { runId: claimed.runId, status, at: new Date().toISOString(), error, summary };
  };
  if (claimed.attempts > RUN_ATTEMPTS)
    return await settle(
      "failed",
      "The sync run stopped before it finished. It will run again at its next time.",
      null,
    );
  const task = await getScheduledTask(deps.db, claimed.workspaceId, claimed.taskId);
  if (!task) return await settle("skipped", "The sync was deleted.", null);
  if (task.status !== "active" && claimed.triggerType !== "manual")
    return await settle("skipped", "The sync is paused.", null);
  const result = await executeAppSync(deps, task, claimed.chainDepth, callTool);
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
  if (!found) throw invalid(`The App has no collection named "${collection}". Define it first.`);
  if (mode === "personal" && found.accessMode !== "per_viewer")
    throw invalid(
      `A personal sync fills each person's own records, so "${collection}" must be a per_viewer collection (privateRecords keeps them from the App's managers too).`,
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
    collection: action.collection,
    tool: action.tool,
    arguments: action.arguments,
    recordsPath: action.recordsPath,
    key: action.key,
    fields: action.fields,
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

async function insertSync(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  request: ReturnType<typeof AppSyncCreateRequest.parse>,
  ownerSubjectId: string,
): Promise<ScheduledTask> {
  validateSchedule(request.schedule);
  const action: AppSyncAction = AppSyncAction.parse({
    kind: "app_sync",
    siteId,
    ownerSubjectId,
    collection: request.collection,
    mode: request.mode,
    tool: request.tool,
    declaredTools: await declaredToolsFor(deps, grant, request.tool),
    arguments: request.arguments,
    recordsPath: request.recordsPath,
    key: request.key,
    fields: request.fields,
  });
  const events =
    request.events && request.events.triggers.length > 0
      ? await validateScheduledTaskEvents({
          settings: deps.settings,
          db: deps.db,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          // Syncs have no owner column, so only workspace event sources fire them.
          ownerSubjectId: null,
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
  await requireCollectionFor(access, grant, siteId, request.collection, request.mode);
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
  const collection = patch.collection ?? action.collection;
  if (patch.mode !== undefined || patch.collection !== undefined)
    await requireCollectionFor(access, grant, siteId, collection, mode);
  const schedule = patch.schedule ?? task.schedule;
  if (patch.schedule) validateSchedule(schedule);
  const tool = patch.tool ?? action.tool;
  const nextAction = AppSyncAction.parse({
    ...action,
    ownerSubjectId: access.subjectId,
    collection,
    mode,
    tool,
    declaredTools:
      patch.tool || action.ownerSubjectId !== access.subjectId
        ? await declaredToolsFor(deps, grant, tool)
        : action.declaredTools,
    ...(patch.arguments !== undefined ? { arguments: patch.arguments } : {}),
    ...(patch.recordsPath !== undefined ? { recordsPath: patch.recordsPath } : {}),
    ...(patch.key !== undefined ? { key: patch.key } : {}),
    ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
  });
  const events = patch.events
    ? await validateScheduledTaskEvents({
        settings: deps.settings,
        db: deps.db,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        ownerSubjectId: null,
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
  await syncUpdatedScheduledTask({
    db: deps.db,
    workflowClient: deps.workflowClient,
    previous: { task },
    task: updated,
  });
  const [view] = await syncViews(deps, [updated]);
  return view!;
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

/** Run a sync now and wait for it. Works while it is paused too, to try it out. */
export async function runAppSyncNow(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  callTool: AppSyncToolCaller = callAppSyncToolThroughGateway,
): Promise<{ syncId: string; lastRun: AppSyncLastRun }> {
  await managerAccess(deps, grant, siteId);
  const { task } = await requireSyncTask(deps, grant, siteId, syncId);
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

/** Opt the person (or the person an agent acts for) in to a personal sync, or out. */
export async function setAppSyncOptIn(
  deps: AppSyncDeps,
  grant: AccessGrant,
  siteId: string,
  syncId: string,
  optedIn: boolean,
  surface: SiteDataSurface = {},
): Promise<{ syncId: string; optedIn: boolean }> {
  if (surface.frameSiteId !== undefined && surface.frameSiteId !== null)
    throw forbidden("Opt in to a sync from Opengeni, not from inside the App.");
  const access = await resolveSiteDataAccess(deps, grant, siteId);
  if (!access.subjectId) throw forbidden("Only a person can opt in to a personal sync.");
  const { task, action } = await requireSyncTask(deps, grant, siteId, syncId);
  if (action.mode !== "personal")
    throw invalid(
      "This sync fills shared data and runs for everyone; there is nothing to opt in to.",
    );
  await setAppSyncSubscription(deps.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    subjectId: access.subjectId,
    optedIn,
  });
  return { syncId, optedIn };
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
          collection: action.collection,
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
      collection: action.collection,
      mode: action.mode,
      tool: action.tool,
      arguments: action.arguments,
      recordsPath: action.recordsPath,
      key: action.key,
      fields: action.fields,
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
