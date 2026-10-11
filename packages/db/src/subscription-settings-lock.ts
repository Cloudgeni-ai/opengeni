import { isSubscriptionSettingKey, type SubscriptionSettingKey } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";

import { rawRows, type Database } from "./database";

/**
 * Settings transactions run at READ COMMITTED whatever the connection
 * default: 0724's guard and lock writer refuse a widening write or a lock
 * change under an older snapshot, which could miss a concurrent lock.
 */
export const SUBSCRIPTION_SETTINGS_TRANSACTION = { isolationLevel: "read committed" } as const;

/** The detail prefix migration 0724's guard raises (SQLSTATE 42501) for a locked setting. */
const LOCK_DETAIL = "subscription_setting_locked:";

/** The write would override settings the organization locked. */
export class SubscriptionSettingsLockedError extends Error {
  constructor(readonly settings: readonly SubscriptionSettingKey[]) {
    super(`locked by the organization: ${settings.join(", ")}`);
    this.name = "SubscriptionSettingsLockedError";
  }
}

/**
 * The settings named by a lock refusal from the 0724 guard, found in the
 * error or its causes; null when the error is not a lock refusal. Every
 * writer of `subscription_settings` meets the guard, so callers that treat
 * 42501 as "not visible" must check this first.
 */
export function subscriptionSettingLockRefusal(error: unknown): SubscriptionSettingKey[] | null {
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 16; index += 1) {
    const current = queue[index] as { detail?: unknown; cause?: unknown } | null;
    if (!current || typeof current !== "object") continue;
    if (current instanceof SubscriptionSettingsLockedError) return [...current.settings];
    if (typeof current.detail === "string" && current.detail.startsWith(LOCK_DETAIL)) {
      const key = current.detail.slice(LOCK_DETAIL.length);
      return isSubscriptionSettingKey(key) ? [key] : [];
    }
    if (current.cause !== undefined) queue.push(current.cause);
  }
  return null;
}

/** Rethrows a lock refusal as `SubscriptionSettingsLockedError`; returns otherwise. */
export function throwIfSubscriptionSettingLocked(error: unknown): void {
  const locked = subscriptionSettingLockRefusal(error);
  if (locked === null) return;
  if (error instanceof SubscriptionSettingsLockedError) throw error;
  throw new SubscriptionSettingsLockedError(locked);
}

/**
 * Take the organization's settings lock: the transaction advisory lock 0724's
 * guard (shared) and lock writer (exclusive) use. The repository's workspace
 * writers take it shared before any row lock, and a lock change queues for it
 * exclusively before any row lock, so later widening writes queue behind the
 * change instead of starving it. Holding it exclusively, a lock change never
 * waits for a workspace row (0724 locks them NOWAIT): a writer outside the
 * repository (an older release during a rolling upgrade, a raw or migration
 * writer) may hold a row while it waits for this lock.
 */
export async function lockSubscriptionSettings(
  tx: Database,
  accountId: string,
  mode: "shared" | "exclusive",
): Promise<void> {
  const key = sql`pg_catalog.hashtextextended('subscription-settings-locks:' || ${accountId}::uuid::text, 0)`;
  await rawRows(
    tx,
    mode === "shared"
      ? sql`select pg_catalog.pg_advisory_xact_lock_shared(${key}) is null as locked`
      : sql`select pg_catalog.pg_advisory_xact_lock(${key}) is null as locked`,
  );
}

/** The detail 0724's lock writer raises (SQLSTATE 55P03) while a workspace write is in flight. */
const BUSY_DETAIL = "subscription_settings_lock_busy";

/**
 * A lock change kept yielding to in-flight workspace writes; nothing was
 * written and the change can be retried.
 */
export class SubscriptionSettingsBusyError extends Error {
  constructor() {
    super("workspace settings writes are in flight; retry the lock change");
    this.name = "SubscriptionSettingsBusyError";
  }
}

/** Whether the error, or one of its causes, is 0724's lock-writer yield. */
export function isSubscriptionSettingsLockBusy(error: unknown): boolean {
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 16; index += 1) {
    const current = queue[index] as { code?: unknown; detail?: unknown; cause?: unknown } | null;
    if (!current || typeof current !== "object") continue;
    if (current.code === "55P03" && current.detail === BUSY_DETAIL) return true;
    if (current.cause !== undefined) queue.push(current.cause);
  }
  return false;
}
