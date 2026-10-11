import { isSubscriptionSettingKey, type SubscriptionSettingKey } from "@opengeni/subscriptions";

/** The detail prefix migration 0716's guard raises (SQLSTATE 42501) for a locked setting. */
const LOCK_DETAIL = "subscription_setting_locked:";

/** The write would override settings the organization locked. */
export class SubscriptionSettingsLockedError extends Error {
  constructor(readonly settings: readonly SubscriptionSettingKey[]) {
    super(`locked by the organization: ${settings.join(", ")}`);
    this.name = "SubscriptionSettingsLockedError";
  }
}

/**
 * The settings named by a lock refusal from the 0716 guard, found in the
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
