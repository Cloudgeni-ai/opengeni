/**
 * The web's handoff to the phone app. On a phone browser, session and
 * workspace pages offer "Open in app", which hands the page's own URL to the
 * app (`opengeni://open?url=…`); the app opens the same session or workspace
 * on the account that matches this server.
 */

const APP_SCHEME = "opengeni";
const DISMISSED_KEY = "opengeni.openInApp.bannerDismissed";

/** The app link that opens `webUrl` in the phone app. */
export function openInAppUrl(webUrl: string): string {
  return `${APP_SCHEME}://open?url=${encodeURIComponent(webUrl)}`;
}

/**
 * iPhone, iPad and Android browsers, where the phone app can be installed.
 * iPadOS reports a desktop Mac user agent, so a Mac with a touch screen
 * counts as an iPad.
 */
export function isPhoneAppPlatform(userAgent: string | undefined, maxTouchPoints = 0): boolean {
  if (!userAgent) return false;
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Pages the app opens itself: a workspace, its sessions list, or one session. */
export function isAppOpenablePath(pathname: string): boolean {
  return (
    /^\/workspaces\/[^/]+\/?$/.test(pathname) ||
    /^\/workspaces\/[^/]+\/sessions(\/[^/]+)?\/?$/.test(pathname) ||
    /^\/sessions\/[^/]+\/?$/.test(pathname)
  );
}

export function currentPhoneAppPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return isPhoneAppPlatform(navigator.userAgent, navigator.maxTouchPoints);
}

export function openInAppBannerDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOpenInAppBanner(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Private browsing can refuse storage; the banner then hides for this page only.
  }
}
