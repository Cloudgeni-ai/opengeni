import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiRouteDeps } from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import {
  CONSOLE_SIGN_IN_API_PATH,
  CONSOLE_SIGN_IN_APP_PATH,
  CONSOLE_SIGN_IN_DEFAULT_RETURN,
  CONSOLE_SIGN_IN_OUTCOME_PARAM,
  CONSOLE_SIGN_IN_RETURN_MAX_LENGTH,
  consoleSignInReturnPath,
  type ConsoleSignInOutcome,
} from "@opengeni/contracts/console-sign-in";
import { recordConsoleSignInHandoff } from "@opengeni/db";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runManagedAuthProvider } from "../auth/managed-auth-attempt-context";
import { managedAuthConsoleOrigins, managedAuthRequestBaseUrl } from "../auth/managed-auth";
import { managedAuthSessionCookieHeaders } from "../auth/managed-auth-session-adapter";
import { managedAuthRefusal } from "../auth/managed-passkeys";
import { ApiHttpError } from "../http/api-error";
import { parseRequestBody } from "../http/request-body";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";

/* ----------------------------------------------------------------------------
   Opengeni Console sign-in handoff.

   Console runs on its own host with its own host-only session cookie. A person
   signed out there signs in with the app host's sign-in instead:

   1. `GET  start` (Console host): keeps a random verifier in a host-only,
      HttpOnly cookie and sends the browser to the app's `/console-sign-in`
      page with the verifier's S256 challenge, the Console origin and the
      Console page to return to.
   2. The app page signs the person in if they aren't already (any method the
      app offers), then `POST authorize` (app host, same-origin, the app
      session's cookie) issues a single-use code bound to that person, the
      challenge, the Console origin and the return path. Only a hash of the
      code is stored, for sixty seconds.
   3. `GET callback` (Console host) consumes the code atomically, checks the
      cookie's verifier against the challenge and the origin it reached, and
      creates Console's own Better Auth session through the ordinary session
      hook (allowed addresses, canonical identity and login-binding status).

   Every redirect target is a configured Console origin plus a relative
   `/console` path, so the handoff can't be turned into an open redirect.
   -------------------------------------------------------------------------- */

export const CONSOLE_SIGN_IN_CODE_TTL_MS = 60 * 1_000;
/** How long the Console host waits for the person to sign in on the app host. */
export const CONSOLE_SIGN_IN_STATE_TTL_SECONDS = 10 * 60;
/** Codes one person may mint per minute (each one is a stored row). */
export const CONSOLE_SIGN_IN_CODES_PER_MINUTE = 20;
const CODE_IDENTIFIER_PREFIX = "opengeni-console-sign-in-code:";
const CODE = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER = /^[A-Za-z0-9_-]{43}$/u;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PROVIDERS = ["credential", "google", "github", "passkey"] as const;

const AuthorizeBody = z
  .object({
    consoleOrigin: z.string().min(1).max(512),
    returnPath: z.string().min(1).max(CONSOLE_SIGN_IN_RETURN_MAX_LENGTH),
    codeChallenge: z.string().regex(CHALLENGE),
  })
  .strict();

const StoredGrant = z
  .object({
    userId: z.string().min(1),
    providerId: z.enum(PROVIDERS),
    sourceSessionId: z.string().min(1),
    codeChallenge: z.string().regex(CHALLENGE),
    consoleOrigin: z.string().min(1),
    returnPath: z.string().min(1),
  })
  .strict();
type StoredGrant = z.infer<typeof StoredGrant>;

export function consoleSignInChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function codeIdentifier(code: string): string {
  return `${CODE_IDENTIFIER_PREFIX}${createHash("sha256").update(code, "utf8").digest("hex")}`;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The host-only cookie holding the Console side's verifier. `__Host-` on HTTPS
 * deployments, so it can never be given a Domain or set from another host.
 */
export function consoleSignInStateCookie(
  settings: Pick<ApiRouteDeps["settings"], "publicBaseUrl" | "betterAuthCookiePrefix">,
): { name: string; secure: boolean } {
  const secure = settings.publicBaseUrl?.startsWith("https://") ?? false;
  const name = `${settings.betterAuthCookiePrefix ?? "better-auth"}.console_sign_in`;
  return { name: secure ? `__Host-${name}` : name, secure };
}

/** The configured Console origin this request reached, or null on any other host. */
function requestConsoleOrigin(settings: ApiRouteDeps["settings"], request: Request): string | null {
  if (!settings.publicBaseUrl) return null;
  const base = managedAuthRequestBaseUrl(settings, request);
  const origin = new URL(base).origin;
  return managedAuthConsoleOrigins(settings).includes(origin) ? origin : null;
}

function outcomeUrl(
  consoleOrigin: string,
  returnPath: string,
  outcome: ConsoleSignInOutcome,
): string {
  const url = new URL(consoleSignInReturnPath(returnPath), consoleOrigin);
  url.searchParams.set(CONSOLE_SIGN_IN_OUTCOME_PARAM, outcome);
  return url.toString();
}

async function rows<T>(deps: ApiRouteDeps, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await deps.db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function noStore(context: Context): void {
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  context.header("referrer-policy", "no-referrer");
}

export function registerConsoleSignInRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = CONSOLE_SIGN_IN_API_PATH;
  const available = () =>
    deps.managedAuth !== null &&
    deps.managedAuth !== undefined &&
    // Browser login session sets (`dual`, `broker`) sign browsers in through
    // their own isolated transactions; Console keeps its own sign-in there.
    deps.settings.managedAuthSessionSetMode === "legacy" &&
    Boolean(deps.settings.publicBaseUrl);

  // Console host: start a handoff and send the browser to the app's sign-in.
  app.get(`${base}/start`, async (context) => {
    noStore(context);
    const consoleOrigin = requestConsoleOrigin(deps.settings, context.req.raw);
    if (!consoleOrigin) throw new HTTPException(404);
    const returnPath = consoleSignInReturnPath(context.req.query("return"));
    if (!available()) {
      return context.redirect(outcomeUrl(consoleOrigin, returnPath, "unavailable"), 302);
    }
    const verifier = randomBytes(32).toString("base64url");
    const cookie = consoleSignInStateCookie(deps.settings);
    setCookie(context, cookie.name, verifier, {
      path: "/",
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "Lax",
      maxAge: CONSOLE_SIGN_IN_STATE_TTL_SECONDS,
    });
    const target = new URL(CONSOLE_SIGN_IN_APP_PATH, deps.settings.publicBaseUrl);
    target.searchParams.set("console", consoleOrigin);
    target.searchParams.set("challenge", consoleSignInChallenge(verifier));
    target.searchParams.set("return", returnPath);
    return context.redirect(target.toString(), 302);
  });

  // App host: the signed-in browser asks for a code for the Console host.
  app.post(`${base}/authorize`, async (context) => {
    noStore(context);
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    if (!available()) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "This deployment can't sign Opengeni Console in from the app",
        retryable: false,
      });
    }
    await admitManagedSignInMutation(context, deps);
    // Codes are minted on the app host only: a Console session can't renew
    // itself through the handoff.
    if (requestConsoleOrigin(deps.settings, context.req.raw)) throw new HTTPException(404);
    const actor = await requireCanonicalHumanRequestIdentity(context, {
      db: deps.db,
      managedAuth: auth,
      managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
      managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
    });
    const body = parseRequestBody(AuthorizeBody, await context.req.json().catch(() => null), {
      status: 400,
      message: "Invalid Console sign-in request",
    });
    const consoleOrigin = managedAuthConsoleOrigins(deps.settings).find(
      (origin) => origin === body.consoleOrigin,
    );
    if (!consoleOrigin) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "That isn't this deployment's Opengeni Console",
        retryable: false,
      });
    }
    // Console's session is bound to the same sign-in method as the app's, so
    // the canonical identity checks treat both alike.
    const [approving] = await rows<{ loginBindingId: string | null }>(
      deps,
      sql`select login_binding_id as "loginBindingId" from auth_sessions
          where id = ${actor.authSessionId} and user_id = ${actor.authUserId}
            and expires_at > clock_timestamp()`,
    );
    const projection = await getCanonicalHumanIdentityProjection(deps.db, actor.authUserId);
    const binding = projection.loginBindings.find(
      (candidate) => candidate.id === approving?.loginBindingId && candidate.status === "active",
    );
    const providerId = PROVIDERS.find((provider) => provider === binding?.providerId);
    if (!providerId) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "Sign in to Opengeni again, then open Console",
        retryable: false,
      });
    }
    // Per-human, cross-replica admission: each code is a stored row.
    const [limit] = await rows<{ count: number }>(
      deps,
      sql`
      insert into auth_rate_limits(id,key,count,last_request)
      values(${`console-sign-in:${actor.authUserId}`},${`console-sign-in:${actor.authUserId}`},1,(extract(epoch from clock_timestamp())*1000)::bigint)
      on conflict(key) do update set
        count=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then 1 else least(auth_rate_limits.count+1,${CONSOLE_SIGN_IN_CODES_PER_MINUTE + 1}) end,
        last_request=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then (extract(epoch from clock_timestamp())*1000)::bigint else auth_rate_limits.last_request end
      returning count`,
    );
    if (!limit || Number(limit.count) > CONSOLE_SIGN_IN_CODES_PER_MINUTE) {
      throw new ApiHttpError(429, {
        code: "limit_exceeded",
        message: "Too many Console sign-in attempts; try again in one minute",
        retryable: true,
      });
    }
    const code = randomBytes(32).toString("base64url");
    const grant: StoredGrant = StoredGrant.parse({
      userId: actor.authUserId,
      providerId,
      sourceSessionId: actor.authSessionId,
      codeChallenge: body.codeChallenge,
      consoleOrigin,
      returnPath: consoleSignInReturnPath(body.returnPath),
    });
    await (
      await auth.$context
    ).internalAdapter.createVerificationValue({
      identifier: codeIdentifier(code),
      value: JSON.stringify(grant),
      expiresAt: new Date(Date.now() + CONSOLE_SIGN_IN_CODE_TTL_MS),
    });
    const redirect = new URL(`${base}/callback`, consoleOrigin);
    redirect.searchParams.set("code", code);
    return context.json({ redirectUrl: redirect.toString() });
  });

  // Console host: redeem the code for Console's own session.
  app.get(`${base}/callback`, async (context) => {
    noStore(context);
    const consoleOrigin = requestConsoleOrigin(deps.settings, context.req.raw);
    if (!consoleOrigin) throw new HTTPException(404);
    const cookie = consoleSignInStateCookie(deps.settings);
    const verifier = getCookie(context, cookie.name);
    // The verifier is good for one attempt, whatever its outcome.
    if (verifier !== undefined) {
      deleteCookie(context, cookie.name, {
        path: "/",
        httpOnly: true,
        secure: cookie.secure,
        sameSite: "Lax",
      });
    }
    const auth = deps.managedAuth;
    if (!auth || !available()) {
      return context.redirect(
        outcomeUrl(consoleOrigin, CONSOLE_SIGN_IN_DEFAULT_RETURN, "unavailable"),
        302,
      );
    }
    let returnPath = CONSOLE_SIGN_IN_DEFAULT_RETURN;
    let grant: StoredGrant | undefined;
    const refuse = async (reason: string) => {
      await recordConsoleSignInHandoff(deps.db, {
        outcome: "refused",
        reason,
        consoleOrigin,
        authUserId: grant?.userId ?? null,
        authSessionId: null,
        sourceAuthSessionId: grant?.sourceSessionId ?? null,
        providerId: grant?.providerId ?? null,
      }).catch(() => undefined);
      return context.redirect(outcomeUrl(consoleOrigin, returnPath, "failed"), 302);
    };
    let createdSessionId: string | null = null;
    try {
      const code = context.req.query("code");
      if (!code || !CODE.test(code)) return await refuse("invalid_request");
      const authContext = await auth.$context;
      // Atomic: a code is consumed by its first redemption, right or wrong.
      const stored = await authContext.internalAdapter.consumeVerificationValue(
        codeIdentifier(code),
      );
      if (!stored) return await refuse("invalid_grant");
      try {
        grant = StoredGrant.parse(JSON.parse(stored.value));
      } catch {
        return await refuse("invalid_grant");
      }
      const handoff = grant;
      returnPath = consoleSignInReturnPath(handoff.returnPath);
      if (
        !verifier ||
        !VERIFIER.test(verifier) ||
        !sameText(handoff.codeChallenge, consoleSignInChallenge(verifier))
      ) {
        return await refuse("state_mismatch");
      }
      if (handoff.consoleOrigin !== consoleOrigin) return await refuse("origin_mismatch");
      // The app session that approved the handoff must still be live: signing
      // out of the app in the meantime cancels it.
      const [source] = await rows<{ live: boolean }>(
        deps,
        sql`select true as live from auth_sessions
            where id = ${handoff.sourceSessionId} and user_id = ${handoff.userId}
              and expires_at > clock_timestamp()`,
      );
      if (!source) return await refuse("source_session_ended");
      // A refusal from the session hook (the account may no longer sign in) is
      // a denial, not a server failure.
      const userAgent = context.req.header("user-agent")?.slice(0, 512) ?? "";
      const session = await runManagedAuthProvider(handoff.providerId, () =>
        authContext.internalAdapter.createSession(handoff.userId, false, { userAgent }),
      ).catch((error: unknown) => {
        if (managedAuthRefusal(error)) return null;
        throw error;
      });
      if (session?.id) createdSessionId = session.id;
      if (!session?.token || new Date(session.expiresAt).getTime() <= Date.now()) {
        if (createdSessionId) await deleteSession(deps, createdSessionId);
        createdSessionId = null;
        return await refuse("access_denied");
      }
      // Console's session inherits the app session's sign-in time and passkey
      // confirmation (admin step-up), never fresher ones: the handoff is not a
      // sign-in, so re-authentication checks that read `created_at` still see
      // when the person last signed in. A passkey made on the app host can't
      // confirm again on the Console host, so step-up has to carry over.
      const inherited = await rows<{ id: string }>(
        deps,
        sql`update auth_sessions as console
            set created_at = least(console.created_at, app.created_at),
                mfa_verified_at = app.mfa_verified_at
            from auth_sessions as app
            where console.id = ${session.id} and console.user_id = ${handoff.userId}
              and app.id = ${handoff.sourceSessionId} and app.user_id = ${handoff.userId}
            returning console.id`,
      );
      if (inherited.length === 0) throw new Error("Console session could not inherit sign-in");
      await recordConsoleSignInHandoff(deps.db, {
        outcome: "signed_in",
        reason: null,
        consoleOrigin,
        authUserId: handoff.userId,
        authSessionId: session.id,
        sourceAuthSessionId: handoff.sourceSessionId,
        providerId: handoff.providerId,
      });
      const sessionCookies = await managedAuthSessionCookieHeaders(
        auth,
        session.token,
        context.req.header("cookie") ?? null,
      );
      // A Console session this browser already had is replaced, not orphaned,
      // once the new one is ready to take its place.
      const previous = await deps.managedAuthSessionAdapter
        ?.resolveAmbientSession(context.req.raw.headers)
        .catch(() => null);
      const previousId = previous?.session?.id;
      if (previousId && previousId !== session.id && previousId !== handoff.sourceSessionId)
        await deleteSession(deps, previousId);
      for (const value of sessionCookies) context.header("set-cookie", value, { append: true });
      return context.redirect(new URL(returnPath, consoleOrigin).toString(), 302);
    } catch (error) {
      // A failure after the code is spent leaves Console signed out with a
      // reason, never a raw error page or a retry loop.
      deps.observability?.error("Console sign-in handoff failed", { error });
      if (createdSessionId) await deleteSession(deps, createdSessionId).catch(() => undefined);
      return await refuse("server_error");
    }
  });
}

async function deleteSession(deps: ApiRouteDeps, id: string): Promise<void> {
  await deps.db.execute(sql`delete from auth_sessions where id = ${id}`);
}
