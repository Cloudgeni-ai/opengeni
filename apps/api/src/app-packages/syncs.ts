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
 * - `planUpgrade` compares a package's syncs with an app's, by name
 *   (upgrade dry run and plan), and `applyUpgrade` adds the new ones paused
 *   and changes the changed ones in place, keeping each one's owner and
 *   status. Both treat definitions as plain JSON. A deployment without them
 *   reports every package sync as not upgraded.
 *
 * The default does nothing: packages export no syncs, and an install reports
 * any syncs a package carries as not installed.
 */
export type AppSyncUpgradePlan = {
  added: string[];
  changed: string[];
  unchanged: string[];
  /** The app's syncs the package doesn't have: they stay. */
  kept: string[];
  /** Syncs that won't upgrade as planned, and why. */
  problems: Array<{ name: string; reason: string }>;
  /** Changes that can make a sync delete records it wrote (removeMissing). */
  destructive?: Array<{ name: string; reason: string }>;
};

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
  planUpgrade?(input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    appId: string;
    syncs: AppPackageSync[];
  }): Promise<AppSyncUpgradePlan>;
  applyUpgrade?(input: {
    deps: ApiRouteDeps;
    grant: AccessGrant;
    appId: string;
    syncs: AppPackageSync[];
    upgradeKey: string;
  }): Promise<{
    /** Names of the syncs added (paused) or changed. */
    upgraded: string[];
    notUpgraded: Array<{ name: string; reason: string }>;
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
