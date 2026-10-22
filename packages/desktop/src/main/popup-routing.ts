/**
 * How the shell treats windows a web app opens.
 *
 * Sign-in and connect flows reserve a blank window during the person's click
 * (`window.open("about:blank", …)`), then point it at the provider once the
 * server has answered, and keep polling the server until the connection is
 * done. Provider sign-in belongs in the person's own browser: that is where
 * they are already signed in, and providers such as Google refuse sign-in in
 * embedded app windows. So the shell accepts the blank window as a hidden
 * placeholder and routes its first real destination: the account's own pages
 * show as an app window, anything else opens in the browser and the
 * placeholder closes. The flow's server-side completion is unaffected.
 */

/** What to do with a page's request for a new window. */
export type NewWindowRoute =
  /** A blank window the page fills in by script: keep it, hidden, until it navigates. */
  | "placeholder"
  /** A destination already known: open it in the browser. */
  | "browser";

/** What to do when a placeholder (or an app window it became) navigates. */
export type PopupNavigationRoute =
  /** The account's own page: show it in the app window. */
  | "app"
  /** Somewhere else: open it in the browser instead. */
  | "browser"
  /** Still blank: nothing to decide yet. */
  | "blank";

function isBlank(url: string): boolean {
  return url === "" || url === "about:blank";
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** Only an account's web app may hold placeholders; the local pages never need them. */
export function routeNewWindow(url: string, baseUrl: string | null): NewWindowRoute {
  return baseUrl && isBlank(url) ? "placeholder" : "browser";
}

export function routePopupNavigation(url: string, baseUrl: string): PopupNavigationRoute {
  if (isBlank(url)) return "blank";
  return sameOrigin(url, baseUrl) ? "app" : "browser";
}
