import { AppSyncDefinition, type AppPackageSync } from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";
import { syncName, type AppSyncHooks } from "../app-packages/syncs";
import { createAppSyncFromDefinition, listAppSyncDefinitions } from "./service";

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : "Unknown error";
}

/**
 * Syncs in app packages. Export lists the app's syncs as plain definitions.
 * Install creates each one paused on the new app, owned by the installer,
 * who confirms the account by turning it on. Event triggers name sources in
 * the exporting workspace, so an installed sync keeps only its schedule; it
 * can be given triggers after install. A replayed install skips syncs the
 * app already has by name, so it never creates one twice.
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
      const parsed = AppSyncDefinition.safeParse(withoutEvents);
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
};
