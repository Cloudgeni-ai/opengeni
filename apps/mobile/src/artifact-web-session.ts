import { readAccountToken } from "@/account-store";
import { webUrl } from "@/web-links";

/*
 * Sites and editable artifacts are shown by the deployment's own web pages.
 * Their web view is signed in from the app's device session, as the desktop
 * app signs its window in: the server sets its web sign-in cookie for the same
 * session, and the app's requests and its web views share one cookie store.
 */

const SIGNED_IN_FOR_MS = 20 * 60_000;
const signedIn = new Map<string, { at: number; request: Promise<boolean> }>();

/** Sign the account's web views in; false when this server can't (or the app is signed out). */
export function signInWebViews(account: { id: string; baseUrl: string }): Promise<boolean> {
  const key = `${account.id}:${account.baseUrl}`;
  const known = signedIn.get(key);
  if (known && Date.now() - known.at < SIGNED_IN_FOR_MS) return known.request;
  const request = (async () => {
    const token = await readAccountToken(account.id);
    if (!token) return false;
    const response = await fetch(webUrl(account.baseUrl, "/v1/native-app/web-session"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    });
    return response.ok;
  })().catch(() => false);
  signedIn.set(key, { at: Date.now(), request });
  void request.then((ok) => {
    if (!ok) signedIn.delete(key);
  });
  return request;
}
