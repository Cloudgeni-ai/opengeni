/**
 * "Add AI agents to my product" continues past organization setup to the
 * developer setup step (key + prompt, or "Let Opengeni implement it"). That
 * step lives in the browser only, and a person who already has a workspace
 * never sees onboarding again, so a reload, a closed tab or a second device
 * used to drop it. The organization panel remembers the step here; the app
 * shell shows it again until the person picks an option or skips.
 */
const STORAGE_KEY = "opengeni.pendingDeveloperSetup.v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingDeveloperSetup = {
  /** The signed-in account it belongs to (email), so another account never inherits it. */
  account: string;
  organizationId: string;
  organizationName?: string | undefined;
  at: number;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function rememberPendingDeveloperSetup(
  setup: Omit<PendingDeveloperSetup, "at">,
  now = Date.now(),
): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...setup, at: now }));
  } catch {
    /* Private mode or a full store: the step still shows this once. */
  }
}

export function pendingDeveloperSetupFor(
  account: string | null | undefined,
  now = Date.now(),
): PendingDeveloperSetup | null {
  if (!account) return null;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingDeveloperSetup>;
    if (
      typeof value.account !== "string" ||
      typeof value.organizationId !== "string" ||
      typeof value.at !== "number" ||
      value.account.toLowerCase() !== account.toLowerCase() ||
      now - value.at > MAX_AGE_MS
    ) {
      return null;
    }
    return {
      account: value.account,
      organizationId: value.organizationId,
      ...(typeof value.organizationName === "string"
        ? { organizationName: value.organizationName }
        : {}),
      at: value.at,
    };
  } catch {
    return null;
  }
}

export function clearPendingDeveloperSetup(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to clear. */
  }
}
