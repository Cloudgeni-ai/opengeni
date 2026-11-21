import type { AccessGrant, AppPackageSync } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";

/**
 * How app packages carry syncs (automations that fill an app's data from a
 * connected tool). The package format owns only a `syncs` array of plain
 * definitions; the sync feature owns their shape and plugs in here:
 *
 * - `list` returns an app's sync definitions for its package (export).
 * - `createPaused` creates a package's syncs on a freshly installed app,
 *   each paused until the installer confirms the account it uses (install).
 *   It is called again with the same `installKey` when an install request is
 *   replayed, so it should not create a sync twice for one key.
 *
 * The default does nothing: packages export no syncs, and an install reports
 * any syncs a package carries as not installed.
 */
export type AppSyncHooks = {
  list(input: { deps: ApiRouteDeps; grant: AccessGrant; appId: string }): Promise<AppPackageSync[]>;
  createPaused(input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    appId: string;
    syncs: AppPackageSync[];
    installKey: string;
  }): Promise<{
    /** Names (or ids) of the syncs created, paused. */
    created: string[];
    notCreated: Array<{ name: string; reason: string }>;
  }>;
};

export function syncName(sync: AppPackageSync, index: number): string {
  const name = sync.name ?? sync.title ?? sync.id;
  return typeof name === "string" && name.length > 0 ? name.slice(0, 128) : `sync ${index + 1}`;
}

export const NO_APP_SYNCS: AppSyncHooks = {
  list: async () => [],
  createPaused: async ({ syncs }) => ({
    created: [],
    notCreated: syncs.map((sync, index) => ({
      name: syncName(sync, index),
      reason: "Syncs can't be installed on this deployment",
    })),
  }),
};

let hooks: AppSyncHooks = NO_APP_SYNCS;

/** Plug the sync feature into app packages (once, at startup). */
export function setAppSyncHooks(next: AppSyncHooks): void {
  hooks = next;
}

export function appSyncHooks(): AppSyncHooks {
  return hooks;
}
