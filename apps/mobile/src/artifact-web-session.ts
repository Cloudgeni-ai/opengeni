import { readAccountToken } from "@/account-store";
import { webUrl } from "@/web-links";

/*
 * Sites and editable artifacts are shown by the deployment's own web pages.
 * Their web view is signed in from the app's device session, as the desktop
 * app signs its window in: the server sets its web sign-in cookie for the same
 * session, and the app's requests and its web views share one cookie store.
 */

const SIGNED_IN_FOR_MS = 20 * 60_000;
/*
 * One web sign-in cookie per server: each sign-in replaces the last, whichever
 * account made it. So the cache is per server and remembers who signed in
 * (account and token); another account, or a new token after signing in
 * again, signs in afresh.
 */
const signedIn = new Map<string, { at: number; who: string; request: Promise<boolean> }>();

/** Sign the account's web views in; false when this server can't (or the app is signed out). */
export async function signInWebViews(account: { id: string; baseUrl: string }): Promise<boolean> {
  const token = await readAccountToken(account.id).catch(() => null);
  if (!token) return false;
  const key = webUrl(account.baseUrl, "/");
  const who = `${account.id}\n${token}`;
  const known = signedIn.get(key);
  if (known && known.who === who && Date.now() - known.at < SIGNED_IN_FOR_MS) return known.request;
  const request = (async () => {
    const response = await fetch(webUrl(account.baseUrl, "/v1/native-app/web-session"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    });
    return response.ok;
  })().catch(() => false);
  const entry = { at: Date.now(), who, request };
  signedIn.set(key, entry);
  void request.then((ok) => {
    if (!ok && signedIn.get(key) === entry) signedIn.delete(key);
  });
  return request;
}
