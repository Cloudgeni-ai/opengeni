import {
  AppSyncDefinition,
  stableJson,
  type AccessGrant,
  type AppPackageSync,
} from "@opengeni/contracts";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import { syncName, type AppSyncHooks, type AppSyncUpgradePlan } from "../app-packages/syncs";
import {
  createAppSyncFromDefinition,
  listAppSyncDefinitions,
  listAppSyncs,
  updateAppSync,
} from "./service";

/**
 * A package's sync read as a definition. One that fills a Site SQL table may
 * leave out `collection`; it is the table's name.
 */
function readDefinition(raw: Record<string, unknown>) {
  const target = raw.target as { table?: unknown } | null | undefined;
  return AppSyncDefinition.safeParse(
    raw.collection === undefined && typeof target?.table === "string"
      ? { ...raw, collection: target.table }
      : raw,
  );
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "Unknown error";
}

const MANAGE_REASON = "Changing syncs needs permission to manage automations in this workspace";

function canManage(grant: AccessGrant): boolean {
  return hasPermission(grant.permissions, "scheduled_tasks:manage", grant.permissionMode);
}

/**
 * A sync's settings as plain JSON for comparing a package with an app: the
 * definition read with this deployment's defaults, without its name (how
 * syncs are matched) or event triggers (they name sources of one workspace,
 * and an upgrade keeps the app's own).
 */
function settingsOf(raw: AppPackageSync): Record<string, unknown> | null {
  const { events: _events, ...withoutEvents } = raw;
  const parsed = readDefinition(withoutEvents);
  if (!parsed.success) return null;
  const {
    name: _name,
    events: _parsedEvents,
    ...settings
  } = parsed.data as Record<string, unknown>;
  return settings;
}

/** The settings whose JSON differs: the patch that upgrades one sync. */
function changedSettings(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)]))
    if (key in next && stableJson(current[key]) !== stableJson(next[key])) patch[key] = next[key];
  return patch;
}

/** Settings whose change can make a removeMissing sync delete records. */
const REMOVAL_SENSITIVE = [
  "tool",
  "arguments",
  "recordsPath",
  "key",
  "collection",
  "target",
  "paging",
  "maxRecords",
] as const;

async function compare(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  syncs: AppPackageSync[],
) {
  const [definitions, views] = await Promise.all([
    listAppSyncDefinitions(deps, grant, appId),
    listAppSyncs(deps, grant, appId),
  ]);
  const current = new Map(
    definitions.map((definition) => [definition.name, settingsOf(definition as AppPackageSync)]),
  );
  const byName = new Map(views.map((view) => [view.name, view]));
  const plan: AppSyncUpgradePlan & {
    patches: Map<string, { id: string; patch: Record<string, unknown> }>;
    additions: Map<string, AppPackageSync>;
  } = {
    added: [],
    changed: [],
    unchanged: [],
    kept: [],
    problems: [],
    destructive: [],
    patches: new Map(),
    additions: new Map(),
  };
  const named = new Set<string>();
  for (const [index, raw] of syncs.entries()) {
    const name = syncName(raw, index);
    const next = settingsOf(raw);
    if (!next || typeof raw.name !== "string") {
      plan.problems.push({
        name,
        reason: "This sync isn't in a format this deployment knows",
      });
      continue;
    }
    const definitionName = String(AppSyncDefinition.shape.name.parse(raw.name));
    named.add(definitionName);
    const view = byName.get(definitionName);
    const existing = current.get(definitionName);
    if (!view || existing === undefined) {
      plan.added.push(definitionName);
      plan.additions.set(definitionName, raw);
      continue;
    }
    const patch = existing ? changedSettings(existing, next) : next;
    if (Object.keys(patch).length === 0) {
      plan.unchanged.push(definitionName);
      continue;
    }
    plan.changed.push(definitionName);
    // With removeMissing on, a changed source or key can make the next run
    // delete records it wrote earlier.
    if (next.removeMissing === true) {
      const narrowed = REMOVAL_SENSITIVE.filter((setting) => setting in patch);
      if (existing?.removeMissing !== true || narrowed.length > 0)
        plan.destructive!.push({
          name: definitionName,
          reason:
            existing?.removeMissing !== true
              ? "Turns on removing records the tool no longer returns"
              : `Changes ${narrowed.join(", ")} of a sync that removes records the tool no longer returns`,
        });
    }
    // Whoever saves a sync becomes its owner and its shared runs use their
    // connection, so an upgrade changes only syncs the upgrader owns.
    if (view.ownerSubjectId !== grant.subjectId)
      plan.problems.push({
        name: definitionName,
        reason:
          "Someone else owns this sync, so it stays as it is. Its owner can upgrade the app, or save the sync yourself to take it over.",
      });
    else plan.patches.set(definitionName, { id: view.id, patch });
  }
  for (const view of views) if (!named.has(view.name)) plan.kept.push(view.name);
  if (!canManage(grant))
    for (const name of [...plan.added, ...plan.patches.keys()])
      plan.problems.push({ name, reason: MANAGE_REASON });
  return plan;
}

/**
 * Syncs in app packages. Export lists the app's syncs as plain definitions.
 * Install creates each one paused on the new app, owned by the installer,
 * who confirms the account by turning it on. Event triggers name sources in
 * the exporting workspace, so an installed sync keeps only its schedule; it
 * can be given triggers after install. A replayed install skips syncs the
 * app already has by name, so it never creates one twice.
 *
 * An upgrade matches syncs by name: new ones are added paused like an
 * install, changed ones are saved with only the settings that differ (their
 * owner, status and event triggers stay, and the usual rule resets personal
 * opt-ins when the tool, arguments, collection or mode change), and the
 * app's other syncs stay. A retried upgrade finds them already done.
 */
export const APP_PACKAGE_SYNC_HOOKS: AppSyncHooks = {
  list: async ({ deps, grant, appId }) =>
    (await listAppSyncDefinitions(deps, grant, appId)) as AppPackageSync[],
  createPaused: async ({ deps, grant, appId, syncs }) => {
    const created: string[] = [];
    const notCreated: Array<{ name: string; reason: string }> = [];
    // Syncs are automations: adding them needs what managing syncs needs.
    if (!hasPermission(grant.permissions, "scheduled_tasks:manage", grant.permissionMode)) {
      for (const [index, raw] of syncs.entries())
        notCreated.push({
          name: syncName(raw, index),
          reason: "Adding syncs needs permission to manage automations in this workspace",
        });
      return { created, notCreated };
    }
    const existing = new Set(
      (await listAppSyncDefinitions(deps, grant, appId).catch(() => [])).map((sync) => sync.name),
    );
    for (const [index, raw] of syncs.entries()) {
      const name = syncName(raw, index);
      const { events: _events, ...withoutEvents } = raw;
      const parsed = readDefinition(withoutEvents);
      if (!parsed.success) {
        notCreated.push({ name, reason: "This sync isn't in a format this deployment knows" });
        continue;
      }
      if (existing.has(parsed.data.name)) {
        created.push(parsed.data.name);
        continue;
      }
      try {
        await createAppSyncFromDefinition(deps, grant, appId, parsed.data);
        existing.add(parsed.data.name);
        created.push(parsed.data.name);
      } catch (error) {
        notCreated.push({ name, reason: message(error) });
      }
    }
    return { created, notCreated };
  },
  planUpgrade: async ({ deps, grant, appId, syncs }) => {
    const {
      patches: _patches,
      additions: _additions,
      ...plan
    } = await compare(deps, grant, appId, syncs);
    return plan;
  },
  applyUpgrade: async ({ deps, grant, appId, syncs }) => {
    const plan = await compare(deps, grant, appId, syncs);
    const upgraded: string[] = [];
    const notUpgraded = [...plan.problems];
    if (!canManage(grant)) return { upgraded, notUpgraded };
    for (const [name, raw] of plan.additions) {
      const { events: _events, ...withoutEvents } = raw;
      const parsed = readDefinition(withoutEvents);
      if (!parsed.success) continue;
      try {
        await createAppSyncFromDefinition(deps, grant, appId, parsed.data);
        upgraded.push(name);
      } catch (error) {
        notUpgraded.push({ name, reason: message(error) });
      }
    }
    for (const [name, { id, patch }] of plan.patches) {
      try {
        await updateAppSync(deps, grant, appId, id, patch);
        upgraded.push(name);
      } catch (error) {
        notUpgraded.push({ name, reason: message(error) });
      }
    }
    return { upgraded, notUpgraded };
  },
};
