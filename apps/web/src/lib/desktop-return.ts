/**
 * The browser page a sign-in started in the desktop app lands on once the
 * provider is done (`/desktop-return?url=…`): it hands the person back to the
 * app, which already shows the finished connection.
 */
import { openInAppUrl } from "@opengeni/react/app/lib/open-in-app";
import {
  mcpOAuthCallbackFailureMessage,
  oauthCallbackFailureMessage,
} from "@opengeni/react/app/lib/oauth-callback-messages";

/**
 * The console page the flow meant to return to, or null when the link is
 * missing it or names another site. The destination is a full console URL or
 * a console path. A provider may add its own outcome parameters to the
 * hand-back link; they are carried onto that page.
 */
export function desktopReturnTarget(search: string, origin: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("url");
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin) return null;
  for (const [key, value] of params) {
    if (key !== "url") target.searchParams.append(key, value);
  }
  return target.toString();
}

/** The link that opens `target` in the desktop app. */
export function desktopReturnAppLink(target: string): string {
  return openInAppUrl(target);
}

/**
 * What the browser can say about the sign-in it just finished. Most flows add
 * their outcome to the return link; a Connect flow that returns to its exact
 * page adds none, and the app (which watches the connection itself) shows the
 * result. Either way the browser's part is over.
 */
export type DesktopReturnOutcome =
  | { kind: "connected" }
  | { kind: "failed"; message: string }
  | { kind: "done" };

export function desktopReturnOutcome(target: string | null): DesktopReturnOutcome {
  if (!target) return { kind: "done" };
  let params: URLSearchParams;
  try {
    params = new URL(target).searchParams;
  } catch {
    return { kind: "done" };
  }
  const reason = params.get("reason");
  const integration = params.get("integration_oauth");
  if (integration === "success") return { kind: "connected" };
  if (integration === "error")
    return { kind: "failed", message: mcpOAuthCallbackFailureMessage(params.get("stage"), reason) };
  for (const key of ["social_oauth", "github_personal_oauth", "fiken"]) {
    const value = params.get(key);
    if (value === "success" || value === "connected") return { kind: "connected" };
    if (value === "error" || value === "failed")
      return { kind: "failed", message: oauthCallbackFailureMessage(reason) };
  }
  if (params.get("google_drive") === "error")
    return { kind: "failed", message: oauthCallbackFailureMessage(reason) };
  return { kind: "done" };
}
