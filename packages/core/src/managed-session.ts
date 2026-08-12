import type { Context } from "hono";
import type { ManagedAuth } from "./managed-auth-type";
import type { Database } from "@opengeni/db";
import { validateCanonicalHumanSession } from "@opengeni/db/canonical-human-identities";

/**
 * Read a Better Auth session without bypassing its sliding-cookie renewal.
 *
 * Better Auth can refresh the durable session while resolving `getSession`.
 * Programmatic callers must explicitly request and forward the returned cookie
 * headers; the HTTP handler does this automatically, but direct API calls do not.
 */
export async function getManagedSession(
  c: Context,
  auth: ManagedAuth,
  options?: { db?: Database; allowIdentityRecovery?: boolean },
) {
  const result = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });

  for (const cookie of setCookieHeaders(result.headers)) {
    c.header("set-cookie", cookie, { append: true });
  }

  const session = result.response;
  if (!session?.user || !options?.db) return session;
  const authSessionId = session.session?.id;
  if (typeof authSessionId !== "string") return null;
  const valid = await validateCanonicalHumanSession(options.db, {
    authSessionId,
    authUserId: session.user.id,
    ...(options.allowIdentityRecovery === undefined
      ? {}
      : { allowRecovery: options.allowIdentityRecovery }),
  });
  return valid ? session : null;
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}
