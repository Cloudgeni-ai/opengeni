import { forgetAllComposerOperations } from "./hooks/use-composer";
import { forgetAllHumanInputDrafts } from "./human-input-draft-store";

/**
 * Session-storage entries that hold nobody's content and must outlive a
 * sign-out: reload-loop guards, the desktop restore guard, the short-lived
 * "signed in as" notice, and the invitation a person is switching accounts to
 * accept.
 */
const KEPT_ACROSS_SIGN_OUT = [
  "opengeni.reloadForApiContract:",
  "opengeni.reloadForRevision:",
  "opengeni.desktop.webSessionRestoredAt",
  "opengeni:vite-preload-recovery-build",
  "opengeni:sign-in-change-feedback",
  "opengeni:organization-invitation-continuation:v1",
];

function opengeniKey(key: string): boolean {
  return key.startsWith("opengeni.") || key.startsWith("opengeni:");
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Forget what this tab kept for the person who just signed out (CASA 6.6.1):
 * unsent answers and messages, in memory and in session storage, and every
 * other Opengeni session-storage entry except the few that hold nobody's
 * content. Never throws.
 */
export function forgetSignedOutBrowserData(storage: Storage | null = sessionStore()): void {
  forgetAllHumanInputDrafts();
  forgetAllComposerOperations();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key !== null &&
        opengeniKey(key) &&
        !KEPT_ACROSS_SIGN_OUT.some((kept) => key === kept || key.startsWith(kept))
      )
        keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // A blocked store holds nothing to forget.
  }
}
