// One short notice that survives the full-page load the app uses to leave a
// destination the signed-in person can't use: another account signed in on
// this browser, or a workspace link they have no access to. The page that
// lands shows it once.

export type RouteRecoveryNotice = "account_changed" | "workspace_unavailable";

const STORAGE_KEY = "opengeni.routeRecoveryNotice";

const NOTICE_TEXT: Readonly<Record<RouteRecoveryNotice, string>> = {
  account_changed: "You're signed in with another account now, so we opened its workspace.",
  workspace_unavailable: "You don't have access to that workspace, so we opened yours.",
};

export function routeRecoveryNoticeText(notice: RouteRecoveryNotice): string {
  return NOTICE_TEXT[notice];
}

function isRouteRecoveryNotice(value: unknown): value is RouteRecoveryNotice {
  return value === "account_changed" || value === "workspace_unavailable";
}

/** Keep a notice for the next page this tab loads. */
export function rememberRouteRecoveryNotice(notice: RouteRecoveryNotice): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, notice);
  } catch {
    // Storage blocked: the destination still opens, without the notice.
  }
}

let pageNotice: { value: RouteRecoveryNotice | null } | null = null;

/**
 * The notice the previous page kept, read once per page load and removed so
 * it shows once. A notice this page keeps later belongs to the next page.
 */
export function takeRouteRecoveryNotice(): RouteRecoveryNotice | null {
  if (pageNotice) return pageNotice.value;
  pageNotice = { value: readAndClear() };
  return pageNotice.value;
}

function readAndClear(): RouteRecoveryNotice | null {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    if (value === null) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    return isRouteRecoveryNotice(value) ? value : null;
  } catch {
    return null;
  }
}

/** Tests: forget this page's read. */
export function resetRouteRecoveryNoticeForTests(): void {
  pageNotice = null;
}
