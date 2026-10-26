import { randomUUID } from "node:crypto";
import {
  ManagedPasskeyCeremony,
  ManagedPasskeySignInRequest,
  ManagedPasskeySignInResponse,
  ManagedPasskeySignUpOptionsRequest,
  ManagedPasskeySignUpRequest,
  passkeyOnlyAccountEmail,
} from "@opengeni/contracts/managed-sign-in-methods";
import type { ApiRouteDeps } from "@opengeni/core";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { runManagedAuthProvider } from "../auth/managed-auth-attempt-context";
import { managedAuthSessionCookieHeaders } from "../auth/managed-auth-session-adapter";
import {
  consumeManagedPasskeyCeremony,
  ManagedPasskeyError,
  managedPasskeyRelyingParty,
  managedPasskeysAvailable,
  startManagedPasskeyRegistration,
  startManagedPasskeySignIn,
  verifyManagedPasskeyRegistration,
  verifyManagedPasskeySignIn,
} from "../auth/managed-passkeys";
import type { ManagedAuthNewSignupsGate } from "../auth/new-signups-gate";
import { runWithSignupChallenge, verifySignupChallenge } from "../auth/signup-challenge";
import { parseRequestBody } from "../http/request-body";
import {
  trustedRequestSourceAddress,
  trustedRequestSourceRateLimitKey,
  UNKNOWN_REQUEST_SOURCE_ADDRESS,
} from "../http/request-source";

/**
 * Passkey sign-in and passkey-only account creation for managed accounts.
 *
 * These product routes sit in front of Better Auth's `/v1/auth/*` handler
 * (register them first). They verify the WebAuthn ceremony themselves and
 * then create the provider session through Better Auth's own adapter, so the
 * usual session hooks (canonical identity, login binding and admission) run
 * exactly as for any other sign-in method. Sign-in methods on a signed-in
 * account, including adding and removing passkeys, live under
 * `/v1/auth/sign-in-methods`.
 */

const SIGN_IN_PER_MINUTE = 30;
const SIGN_UP_PER_MINUTE = 5;

/** Whether this deployment offers passkey sign-in in the browser. */
export function managedPasskeySignInOffered(deps: Pick<ApiRouteDeps, "settings">): boolean {
  return (
    deps.settings.productAccessMode === "managed" &&
    deps.settings.managedAuthSessionSetMode === "legacy" &&
    managedPasskeysAvailable(deps.settings)
  );
}

/** Whether new accounts may be created with only a passkey right now. */
export function managedPasskeySignUpOffered(
  deps: Pick<ApiRouteDeps, "settings">,
  newSignupsOpen: boolean,
): boolean {
  return (
    managedPasskeySignInOffered(deps) &&
    deps.settings.managedAuthPasskeySignUpEnabled &&
    deps.settings.managedAuthNewSignupsEnabled &&
    newSignupsOpen &&
    deps.settings.allowedUserEmails === undefined
  );
}

function refusal(status: 403 | 404 | 409 | 422 | 429, code: string, message: string): Response {
  return Response.json({ code, message }, { status, headers: { "cache-control": "no-store" } });
}

function passkeyRefusal(error: unknown): Response {
  if (error instanceof ManagedPasskeyError) {
    return refusal(
      error.code === "PASSKEY_ORIGIN_NOT_ALLOWED" ? 403 : 422,
      error.code,
      error.message,
    );
  }
  throw error;
}

async function rows<T>(deps: ApiRouteDeps, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await deps.db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** One shared, cross-replica fixed window per client address and purpose. */
export async function admitManagedPasskeyAttempt(
  context: Context,
  deps: ApiRouteDeps,
  purpose: string,
  perMinute: number,
): Promise<boolean> {
  const key = `passkey-${purpose}:${trustedRequestSourceRateLimitKey(context, deps.settings)}`;
  const [limit] = await rows<{ count: number }>(
    deps,
    sql`
      insert into auth_rate_limits(id,key,count,last_request)
      values(${key},${key},1,(extract(epoch from clock_timestamp())*1000)::bigint)
      on conflict(key) do update set
        count=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then 1 else least(auth_rate_limits.count+1,${perMinute + 1}) end,
        last_request=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then (extract(epoch from clock_timestamp())*1000)::bigint else auth_rate_limits.last_request end
      returning count`,
  );
  return Boolean(limit && Number(limit.count) <= perMinute);
}

function requireJson(context: Context): Response | null {
  return context.req.header("content-type")?.split(";", 1)[0] === "application/json"
    ? null
    : refusal(422, "PASSKEY_INVALID_REQUEST", "Send the passkey request as JSON");
}

async function body<T extends import("zod").ZodType>(context: Context, schema: T) {
  return parseRequestBody(schema, await context.req.json().catch(() => null), {
    status: 422,
    message: "Invalid passkey request",
  });
}

/**
 * Create the provider session for a person a passkey just proved, through the
 * same session hooks as every sign-in, and set its cookie on the response.
 */
async function signInVerifiedPerson(
  context: Context,
  deps: ApiRouteDeps,
  authUserId: string,
): Promise<Response> {
  const auth = deps.managedAuth!;
  const internal = (await auth.$context).internalAdapter;
  const address = trustedRequestSourceAddress(context, deps.settings);
  let session: { token: string } | null;
  try {
    session = await runManagedAuthProvider("passkey", () =>
      internal.createSession(authUserId, false, {
        ipAddress: address === UNKNOWN_REQUEST_SOURCE_ADDRESS ? "" : address,
        userAgent: context.req.header("user-agent") ?? "",
      }),
    );
  } catch {
    session = null;
  }
  if (!session?.token) {
    return refusal(403, "PASSKEY_SIGN_IN_REFUSED", "This account can't sign in right now");
  }
  for (const cookie of await managedAuthSessionCookieHeaders(
    auth,
    session.token,
    context.req.header("cookie"),
  )) {
    context.header("set-cookie", cookie, { append: true });
  }
  return context.json(ManagedPasskeySignInResponse.parse({ signedIn: true }));
}

export function registerManagedPasskeyRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { newSignupsGate: ManagedAuthNewSignupsGate },
): void {
  const base = "/v1/auth/passkey";
  app.use(`${base}/*`, async (context, next) => {
    context.header("cache-control", "no-store");
    if (!deps.managedAuth || !managedPasskeySignInOffered(deps)) {
      return refusal(404, "PASSKEY_UNAVAILABLE", "Passkey sign-in isn't available here");
    }
    await next();
  });

  app.post(`${base}/sign-in/options`, async (context) => {
    try {
      const relyingParty = managedPasskeyRelyingParty(deps.settings, context.req.header("origin"));
      if (!(await admitManagedPasskeyAttempt(context, deps, "sign-in", SIGN_IN_PER_MINUTE))) {
        return refusal(
          429,
          "PASSKEY_RATE_LIMITED",
          "Too many passkey attempts; try again in a minute",
        );
      }
      return context.json(
        ManagedPasskeyCeremony.parse(
          await startManagedPasskeySignIn(deps.managedAuth!, relyingParty),
        ),
      );
    } catch (error) {
      return passkeyRefusal(error);
    }
  });

  app.post(`${base}/sign-in`, async (context) => {
    const notJson = requireJson(context);
    if (notJson) return notJson;
    try {
      const relyingParty = managedPasskeyRelyingParty(deps.settings, context.req.header("origin"));
      const request = await body(context, ManagedPasskeySignInRequest);
      // Each verification consumes a single-use ceremony that the rate-limited
      // options request issued, so it needs no window of its own.
      const ceremony = await consumeManagedPasskeyCeremony(deps.managedAuth!, request.challengeId, {
        kind: "sign_in",
        origin: relyingParty.origin,
      });
      const proven = await verifyManagedPasskeySignIn(deps.db, ceremony, request.response);
      return await signInVerifiedPerson(context, deps, proven.authUserId);
    } catch (error) {
      return passkeyRefusal(error);
    }
  });

  app.post(`${base}/sign-up/options`, async (context) => {
    const notJson = requireJson(context);
    if (notJson) return notJson;
    try {
      const relyingParty = managedPasskeyRelyingParty(deps.settings, context.req.header("origin"));
      if (!managedPasskeySignUpOffered(deps, await options.newSignupsGate.signupsOpen())) {
        return refusal(
          403,
          "PASSKEY_SIGN_UP_UNAVAILABLE",
          "New accounts can't be created with a passkey here",
        );
      }
      const request = await body(context, ManagedPasskeySignUpOptionsRequest);
      if (!(await admitManagedPasskeyAttempt(context, deps, "sign-up", SIGN_UP_PER_MINUTE))) {
        return refusal(
          429,
          "PASSKEY_RATE_LIMITED",
          "Too many passkey attempts; try again in a minute",
        );
      }
      await verifySignupChallenge(deps.settings, request.signupChallengeToken);
      const userId = randomUUID();
      return context.json(
        ManagedPasskeyCeremony.parse(
          await startManagedPasskeyRegistration(deps.managedAuth!, {
            kind: "sign_up",
            relyingParty,
            userId,
            userName: request.name,
            displayName: request.name,
            name: request.name,
            signupChallengeVerified: deps.settings.signupChallengeEnabled,
            exclude: [],
          }),
        ),
      );
    } catch (error) {
      return passkeyRefusal(error);
    }
  });

  app.post(`${base}/sign-up`, async (context) => {
    const notJson = requireJson(context);
    if (notJson) return notJson;
    try {
      const relyingParty = managedPasskeyRelyingParty(deps.settings, context.req.header("origin"));
      const request = await body(context, ManagedPasskeySignUpRequest);
      const ceremony = await consumeManagedPasskeyCeremony(deps.managedAuth!, request.challengeId, {
        kind: "sign_up",
        origin: relyingParty.origin,
      });
      if (!managedPasskeySignUpOffered(deps, await options.newSignupsGate.signupsOpen())) {
        return refusal(
          403,
          "PASSKEY_SIGN_UP_UNAVAILABLE",
          "New accounts can't be created with a passkey here",
        );
      }
      const credential = await verifyManagedPasskeyRegistration(ceremony, request.response);
      const userId = ceremony.userId!;
      const [taken] = await rows<{ taken: boolean }>(
        deps,
        sql`select exists(select 1 from auth_passkeys where credential_id = ${credential.credentialId}) as taken`,
      );
      if (taken?.taken) {
        return refusal(
          409,
          "PASSKEY_ALREADY_REGISTERED",
          "This passkey already belongs to an account; sign in with it",
        );
      }
      const internal = (await deps.managedAuth!.$context).internalAdapter;
      let user: { id: string } | null;
      try {
        user = await runManagedAuthProvider("passkey", () =>
          runWithSignupChallenge(ceremony.signupChallengeVerified === true, () =>
            internal.createUser({
              id: userId,
              email: passkeyOnlyAccountEmail(userId),
              name: ceremony.name ?? "Passkey user",
              emailVerified: true,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof APIError) {
          const code = (error.body as { code?: unknown } | undefined)?.code;
          return refusal(
            403,
            typeof code === "string" ? code : "PASSKEY_SIGN_UP_REFUSED",
            "New accounts can't be created right now",
          );
        }
        throw error;
      }
      if (!user || user.id !== userId) {
        if (user) await deps.db.execute(sql`delete from auth_users where id = ${user.id}`);
        return refusal(403, "PASSKEY_SIGN_UP_REFUSED", "New accounts can't be created right now");
      }
      try {
        await deps.db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
            values (${randomUUID()}, ${userId}, 'passkey', ${userId}, clock_timestamp(), clock_timestamp())`);
          await tx.execute(sql`
            insert into auth_passkeys (user_id, credential_id, public_key, counter, transports,
              device_type, backed_up, aaguid, name, rp_id)
            values (${userId}, ${credential.credentialId}, ${credential.publicKey}, ${credential.counter},
              ${sql.raw("ARRAY[")}${sql.join(
                credential.transports.map((transport) => sql`${transport}`),
                sql`,`,
              )}${sql.raw("]::text[]")}, ${credential.deviceType}, ${credential.backedUp},
              ${credential.aaguid}, ${credential.name}, ${credential.rpId})`);
        });
      } catch (error) {
        // Without its passkey the new account has no way in: remove it.
        await deps.db.execute(sql`delete from auth_users where id = ${userId}`);
        throw error;
      }
      return await signInVerifiedPerson(context, deps, userId);
    } catch (error) {
      return passkeyRefusal(error);
    }
  });
}
