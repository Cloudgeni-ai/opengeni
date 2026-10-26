import {
  isPasskeyOnlyAccountEmail,
  ManagedPasskeyCeremony,
  ManagedPasskeyMutationResponse,
  ManagedPasskeyRegisterMutation,
  ManagedPasskeyRemoveMutation,
  ManagedSignInMethods,
  ManagedSignInPasswordMutation,
  ManagedSignInProviderMutation,
  ManagedSignInMutationResponse,
} from "@opengeni/contracts/managed-sign-in-methods";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  requireCanonicalHumanRequestIdentity,
  getManagedAuthRequestActorLeaseStamp,
  markManagedAuthRequestActorTransitionApplied,
} from "@opengeni/core/canonical-human-identities";
import {
  MANAGED_AUTH_SESSION_SET_COOKIE,
  managedAuthSha256,
  managedAuthSecretRequestDigest,
  requireManagedAuthMutationAdmission,
} from "@opengeni/core/managed-auth-session-sets";
import { getManagedAuthSessionSetSnapshot } from "@opengeni/db/managed-auth-session-sets";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  isolatedManagedAuthOAuthCallbackRequest,
  hashManagedAuthPassword,
  verifyManagedAuthPassword,
} from "../auth/managed-auth";
import { ApiHttpError } from "../http/api-error";
import { trustedBrowserOrigins } from "../http/browser-mutation-origin";
import { runManagedSignInConnect } from "../auth/managed-auth-attempt-context";
import { deliverManagedSignInNotification } from "../auth/managed-sign-in-notifications";
import { managedAuthSelectedProofHeaders } from "../auth/managed-auth-session-adapter";
import {
  consumeManagedPasskeyCeremony,
  listManagedPasskeyCredentials,
  ManagedPasskeyError,
  managedPasskeyRelyingParty,
  startManagedPasskeyRegistration,
  verifyManagedPasskeyRegistration,
} from "../auth/managed-passkeys";
import { admitManagedPasskeyAttempt, managedPasskeySignInOffered } from "./managed-passkeys";
import { scrubManagedAuthProviderResponse } from "./managed-auth-session-sets";
import { parseRequestBody } from "../http/request-body";

const ConnectState = z.object({
  opengeniSignInMethod: z.object({
    intentId: z.string().uuid(),
    provider: z.enum(["google", "github"]),
  }),
  link: z.object({ userId: z.string().min(1), email: z.string().email() }),
  callbackURL: z.string().url(),
  errorURL: z.string().url(),
});
const ConnectIntent = z.object({
  authUserId: z.string().min(1),
  authSessionId: z.string().min(1),
  expectedIdentityId: z.string().uuid(),
  actorFence: z
    .object({
      authorityHash: z.string().regex(/^[0-9a-f]{64}$/),
      actorEpoch: z.string().regex(/^[1-9][0-9]*$/),
      requestId: z.string().uuid(),
    })
    .optional(),
});

async function rows<T>(deps: ApiRouteDeps, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await deps.db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function identity(context: Context, deps: ApiRouteDeps) {
  return requireCanonicalHumanRequestIdentity(context, {
    db: deps.db,
    managedAuth: deps.managedAuth,
    managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
    managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
}

export async function admitManagedSignInMutation(context: Context, deps: ApiRouteDeps) {
  const origins = deps.settings.publicBaseUrl ? trustedBrowserOrigins(deps.settings) : [];
  const origin = context.req.header("origin");
  if (
    !origin ||
    !origins.includes(origin) ||
    context.req.header("sec-fetch-site") !== "same-origin" ||
    context.req.header("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "Same-origin JSON browser mutation required",
      details: { code: "SIGN_IN_METHOD_SAME_ORIGIN_REQUIRED" },
      retryable: false,
    });
  }
  const authority = getCookie(context, MANAGED_AUTH_SESSION_SET_COOKIE);
  if (deps.settings.managedAuthSessionSetMode !== "legacy" && authority) {
    const snapshot = await getManagedAuthSessionSetSnapshot(deps.db, {
      authorityHash: managedAuthSha256(authority),
      mode: deps.settings.managedAuthSessionSetMode,
      readOnly: true,
    });
    if (!snapshot) throw new HTTPException(401);
    try {
      requireManagedAuthMutationAdmission({
        request: context.req.raw,
        allowedOrigins: origins,
        authority,
        signingSecret: deps.settings.betterAuthSecret!,
        expectedGeneration: snapshot.projection.generation,
      });
    } catch {
      throw new HTTPException(403, { message: "Browser session-set CSRF validation failed" });
    }
  }
}

type MethodProvider = "credential" | "google" | "github" | "passkey";

/**
 * Whether the deployment offers a sign-in method to this account. An account
 * created with only a passkey has no email address, so it can't sign in with
 * a password or match a Google or GitHub account's email; passkeys are its
 * only method.
 */
function configured(deps: ApiRouteDeps, provider: MethodProvider, passkeyOnly = false) {
  if (provider === "passkey") return managedPasskeySignInOffered(deps);
  if (passkeyOnly) return false;
  return (
    provider === "credential" ||
    (provider === "google"
      ? Boolean(
          deps.settings.managedAuthGoogleClientId && deps.settings.managedAuthGoogleClientSecret,
        )
      : Boolean(
          deps.settings.managedAuthGithubClientId && deps.settings.managedAuthGithubClientSecret,
        ))
  );
}

function usableProviders(deps: ApiRouteDeps, passkeyOnly: boolean): MethodProvider[] {
  return (["credential", "google", "github", "passkey"] as const).filter((p) =>
    configured(deps, p, passkeyOnly),
  );
}

function mutationError(context: Context, error: unknown): Response {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && candidate instanceof Error;
    depth++, candidate = candidate.cause
  ) {
    if (candidate instanceof ManagedPasskeyError)
      return context.json(
        { code: candidate.code, message: candidate.message },
        candidate.code === "PASSKEY_ORIGIN_NOT_ALLOWED" ? 403 : 422,
      );
    const code = candidate.message.match(/SIGN_IN_METHOD_[A-Z_]+/)?.[0];
    if (code)
      return context.json(
        { code, message: code.toLowerCase().replaceAll("_", " ") },
        code.includes("CONFLICT") ||
          code.includes("REUSED") ||
          code.includes("CHANGED") ||
          code.includes("COLLISION") ||
          code.includes("ALREADY")
          ? 409
          : 403,
      );
  }
  throw error;
}

export function registerManagedSignInMethodRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/auth/sign-in-methods";
  app.use(`${base}*`, async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.get(base, async (context) => {
    const actor = await identity(context, deps);
    const projection = await getCanonicalHumanIdentityProjection(deps.db, actor.authUserId);
    const [user] = await rows<{ email: string; emailVerified: boolean; fresh: boolean }>(
      deps,
      sql`
      select u.email, u.email_verified as "emailVerified", s.created_at > clock_timestamp()-interval '5 minutes' as fresh
      from auth_users u join auth_sessions s on s.user_id=u.id where u.id=${actor.authUserId} and s.id=${actor.authSessionId}`,
    );
    if (!user) throw new HTTPException(401);
    const accounts = await rows<{ provider: string; usable: boolean }>(
      deps,
      sql`
      select provider_id as provider, (provider_id <> 'credential' or length(password)>0) as usable from auth_identities where user_id=${actor.authUserId}`,
    );
    const passkeys = await rows<{
      id: string;
      name: string;
      createdAt: string;
      lastUsedAt: string | null;
      backedUp: boolean;
    }>(
      deps,
      sql`
      select id, name, created_at::text as "createdAt", last_used_at::text as "lastUsedAt", backed_up as "backedUp"
      from auth_passkeys where user_id=${actor.authUserId} order by created_at, id`,
    );
    const passkeyOnly = isPasskeyOnlyAccountEmail(user.email);
    const connected = (provider: string) =>
      accounts.some((a) => a.provider === provider && a.usable) &&
      (provider !== "passkey" || passkeys.length > 0) &&
      projection.loginBindings.some((b) => b.providerId === provider && b.status === "active");
    const count = (["credential", "google", "github", "passkey"] as const).filter(
      (p) => connected(p) && configured(deps, p, passkeyOnly),
    ).length;
    const passkeysAvailable = configured(deps, "passkey");
    return context.json(
      ManagedSignInMethods.parse({
        ...user,
        identityId: projection.activeIdentity.id,
        identityRevision: projection.activeIdentity.identityRevision,
        freshAuthenticationRequired: !user.fresh,
        methods: (["credential", "google", "github"] as const).map((provider) => ({
          provider,
          connected: connected(provider),
          available: configured(deps, provider, passkeyOnly),
          canDisconnect:
            provider !== "credential" &&
            connected(provider) &&
            count - (configured(deps, provider, passkeyOnly) ? 1 : 0) > 0,
          implicitRelinkingSuppressed:
            !connected(provider) &&
            projection.loginBindings.some(
              (b) => b.providerId === provider && b.status !== "active",
            ),
        })),
        passkeys: passkeys.map((passkey) => ({
          ...passkey,
          createdAt: new Date(passkey.createdAt).toISOString(),
          lastUsedAt: passkey.lastUsedAt ? new Date(passkey.lastUsedAt).toISOString() : null,
        })),
        passkeysAvailable,
        // Another passkey, or another usable method, must remain.
        canRemovePasskey:
          passkeys.length > 1 || (connected("passkey") && count - (passkeysAvailable ? 1 : 0) > 0),
      }),
    );
  });

  app.post(`${base}/passkey/options`, async (context) => {
    await admitManagedSignInMutation(context, deps);
    const actor = await identity(context, deps);
    if (!configured(deps, "passkey"))
      return context.json(
        { code: "SIGN_IN_METHOD_UNAVAILABLE", message: "Passkeys aren't available here" },
        409,
      );
    try {
      const relyingParty = managedPasskeyRelyingParty(deps.settings, context.req.header("origin"));
      if (!(await admitManagedPasskeyAttempt(context, deps, `register:${actor.authUserId}`, 10)))
        return context.json(
          {
            code: "SIGN_IN_METHOD_RATE_LIMITED",
            message: "Too many sign-in method attempts; try again in one minute",
          },
          429,
        );
      const [user] = await rows<{ email: string; name: string }>(
        deps,
        sql`select email, name from auth_users where id=${actor.authUserId}`,
      );
      if (!user) throw new HTTPException(401);
      const label = isPasskeyOnlyAccountEmail(user.email) ? user.name : user.email;
      return context.json(
        ManagedPasskeyCeremony.parse(
          await startManagedPasskeyRegistration(deps.managedAuth!, {
            kind: "register",
            relyingParty,
            userId: actor.authUserId,
            userName: label,
            displayName: user.name || label,
            exclude: await listManagedPasskeyCredentials(deps.db, actor.authUserId),
          }),
        ),
      );
    } catch (error) {
      return mutationError(context, error);
    }
  });

  for (const kind of ["register", "delete"] as const) {
    app.post(
      kind === "register" ? `${base}/passkey` : `${base}/passkey/remove`,
      async (context) => {
        await admitManagedSignInMutation(context, deps);
        const actor = await identity(context, deps);
        const actorFence = getManagedAuthRequestActorLeaseStamp(context.req.raw);
        if (deps.settings.managedAuthSessionSetMode !== "legacy" && !actorFence)
          throw new HTTPException(409, { message: "Managed actor fence required" });
        const body = parseRequestBody(
          kind === "register" ? ManagedPasskeyRegisterMutation : ManagedPasskeyRemoveMutation,
          await context.req.json().catch(() => null),
          { status: 422, message: "Invalid sign-in method request" },
        );
        const currentIdentity = await getCanonicalHumanIdentityProjection(
          deps.db,
          actor.authUserId,
        );
        if (currentIdentity.activeIdentity.id !== body.expectedIdentityId)
          return context.json(
            {
              code: "SIGN_IN_METHOD_IDENTITY_CHANGED",
              message: "The signed-in account changed; reload security settings",
            },
            409,
          );
        const [user] = await rows<{ email: string }>(
          deps,
          sql`select email from auth_users where id=${actor.authUserId}`,
        );
        if (!user) throw new HTTPException(401);
        try {
          const request: Record<string, unknown> = {
            kind,
            operationId: body.operationId,
            requestDigest: managedAuthSecretRequestDigest(deps.settings.betterAuthSecret!, {
              kind: `passkey-${kind}`,
              ...body,
            }),
            expectedIdentityRevision: body.expectedIdentityRevision,
            expectedIdentityId: body.expectedIdentityId,
            usableProviders: usableProviders(deps, isPasskeyOnlyAccountEmail(user.email)),
            ...(actorFence ? { actorFence } : {}),
          };
          if ("passkeyId" in body) {
            request.passkeyId = body.passkeyId;
          } else {
            if (!configured(deps, "passkey"))
              return context.json(
                { code: "SIGN_IN_METHOD_UNAVAILABLE", message: "Passkeys aren't available here" },
                409,
              );
            const relyingParty = managedPasskeyRelyingParty(
              deps.settings,
              context.req.header("origin"),
            );
            const ceremony = await consumeManagedPasskeyCeremony(
              deps.managedAuth!,
              body.challengeId,
              {
                kind: "register",
                origin: relyingParty.origin,
              },
            );
            if (ceremony.userId !== actor.authUserId)
              return context.json(
                {
                  code: "SIGN_IN_METHOD_IDENTITY_CHANGED",
                  message: "The signed-in account changed; reload security settings",
                },
                409,
              );
            request.credential = await verifyManagedPasskeyRegistration(
              ceremony,
              body.response,
              body.name,
            );
          }
          const [result] = await rows<{ result: { reauthenticationRequired?: boolean } }>(
            deps,
            sql`select mutate_managed_passkey(${actor.authUserId},${actor.authSessionId},${JSON.stringify(request)}::jsonb) as result`,
          );
          const reauthenticationRequired = result?.result?.reauthenticationRequired === true;
          if (actorFence && reauthenticationRequired)
            markManagedAuthRequestActorTransitionApplied(context.req.raw);
          return context.json(
            ManagedPasskeyMutationResponse.parse({
              reauthenticationRequired,
              notification: isPasskeyOnlyAccountEmail(user.email)
                ? "none"
                : await deliverManagedSignInNotification(
                    deps.db,
                    deps.managedEmailTransport,
                    body.operationId,
                  ),
            }),
          );
        } catch (error) {
          return mutationError(context, error);
        }
      },
    );
  }

  for (const kind of ["connect", "disconnect", "password"] as const) {
    app.post(`${base}/${kind}`, async (context) => {
      await admitManagedSignInMutation(context, deps);
      const actor = await identity(context, deps);
      const actorFence = getManagedAuthRequestActorLeaseStamp(context.req.raw);
      if (deps.settings.managedAuthSessionSetMode !== "legacy" && !actorFence)
        throw new HTTPException(409, { message: "Managed actor fence required" });
      const schema =
        kind === "password" ? ManagedSignInPasswordMutation : ManagedSignInProviderMutation;
      const parsed = parseRequestBody(schema, await context.req.json().catch(() => null), {
        status: 422,
        message: "Invalid sign-in method request",
      });
      const body = parsed;
      const currentIdentity = await getCanonicalHumanIdentityProjection(deps.db, actor.authUserId);
      if (currentIdentity.activeIdentity.id !== body.expectedIdentityId)
        return context.json(
          {
            code: "SIGN_IN_METHOD_IDENTITY_CHANGED",
            message: "The signed-in account changed; reload security settings",
          },
          409,
        );
      const [user] = await rows<{ email: string; token: string }>(
        deps,
        sql`select u.email,s.token from auth_users u join auth_sessions s on s.user_id=u.id where u.id=${actor.authUserId} and s.id=${actor.authSessionId}`,
      );
      if (!user) throw new HTTPException(401);
      const passkeyOnly = isPasskeyOnlyAccountEmail(user.email);
      if (passkeyOnly && kind !== "disconnect")
        return context.json(
          {
            code: "SIGN_IN_METHOD_UNAVAILABLE",
            message: "An account without an email address signs in with passkeys",
          },
          409,
        );
      const request: Record<string, unknown> = {
        kind,
        operationId: body.operationId,
        requestDigest: managedAuthSecretRequestDigest(deps.settings.betterAuthSecret!, {
          kind,
          ...body,
        }),
        expectedIdentityRevision: body.expectedIdentityRevision,
        expectedIdentityId: body.expectedIdentityId,
        usableProviders: usableProviders(deps, passkeyOnly),
        ...(actorFence ? { actorFence } : {}),
      };
      try {
        const [prior] = await rows<{ result: unknown }>(
          deps,
          sql`select replay_managed_sign_in_method(${actor.authUserId},${actor.authSessionId},${JSON.stringify(request)}::jsonb) result`,
        );
        if (prior?.result)
          return context.json(
            kind === "connect"
              ? {
                  url: new URL(
                    "/settings/security?signInMethod=connected",
                    deps.settings.publicBaseUrl!,
                  ).toString(),
                }
              : ManagedSignInMutationResponse.parse(prior.result),
          );
      } catch (error) {
        return mutationError(context, error);
      }
      // Per-human, cross-replica admission before password hashing or creating
      // OAuth state. Successful committed-result replay does not spend a slot.
      const [limit] = await rows<{ count: number }>(
        deps,
        sql`
        insert into auth_rate_limits(id,key,count,last_request)
        values(${`sign-in-methods:${actor.authUserId}`},${`sign-in-methods:${actor.authUserId}`},1,(extract(epoch from clock_timestamp())*1000)::bigint)
        on conflict(key) do update set
          count=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then 1 else least(auth_rate_limits.count+1,11) end,
          last_request=case when auth_rate_limits.last_request < (extract(epoch from clock_timestamp())*1000)::bigint-60000 then (extract(epoch from clock_timestamp())*1000)::bigint else auth_rate_limits.last_request end
        returning count`,
      );
      if (!limit || limit.count > 10)
        return context.json(
          {
            code: "SIGN_IN_METHOD_RATE_LIMITED",
            message: "Too many sign-in method attempts; try again in one minute",
          },
          429,
        );
      if ("provider" in body) {
        request.provider = body.provider;
        if (kind === "connect" && !configured(deps, body.provider))
          throw new HTTPException(409, { message: "Sign-in provider is not configured" });
      } else {
        const [credential] = await rows<{ password: string | null }>(
          deps,
          sql`select password from auth_identities where user_id=${actor.authUserId} and provider_id='credential'`,
        );
        if (
          credential?.password &&
          (!body.currentPassword ||
            !(await verifyManagedAuthPassword(body.currentPassword, credential.password)))
        ) {
          return context.json(
            {
              code: "SIGN_IN_METHOD_CURRENT_PASSWORD_REQUIRED",
              message: "Enter your current password",
            },
            403,
          );
        }
        request.expectedPasswordHash = credential?.password ?? null;
        request.passwordHash = await hashManagedAuthPassword(body.newPassword);
      }
      try {
        await rows(
          deps,
          sql`select mutate_managed_sign_in_method(${actor.authUserId},${actor.authSessionId},${JSON.stringify(request)}::jsonb)`,
        );
        if (kind === "connect" && "provider" in body) {
          const headers = await managedAuthSelectedProofHeaders(deps.managedAuth!, user.token);
          headers.set("origin", new URL(deps.settings.publicBaseUrl!).origin);
          const callbackURL = new URL(
            "/settings/security?signInMethod=connected",
            deps.settings.publicBaseUrl!,
          ).toString();
          const errorCallbackURL = new URL(
            "/settings/security?signInMethod=error",
            deps.settings.publicBaseUrl!,
          ).toString();
          const result = await deps.managedAuth!.api.linkSocialAccount({
            headers,
            returnHeaders: true,
            body: {
              provider: body.provider,
              callbackURL,
              errorCallbackURL,
              disableRedirect: true,
              additionalData: {
                opengeniSignInMethod: { intentId: body.operationId, provider: body.provider },
              },
            },
          });
          for (const cookie of result.headers.getSetCookie())
            context.header("set-cookie", cookie, { append: true });
          return context.json({ url: result.response.url });
        }
        if (actorFence) markManagedAuthRequestActorTransitionApplied(context.req.raw);
        return context.json({
          reauthenticationRequired: true,
          notification: await deliverManagedSignInNotification(
            deps.db,
            deps.managedEmailTransport,
            body.operationId,
          ),
        });
      } catch (error) {
        return mutationError(context, error);
      }
    });
  }
}

/** Intercept only database-backed, product-issued explicit connect states. */
export async function handleManagedSignInConnectCallback(
  context: Context,
  deps: ApiRouteDeps,
  provider: "google" | "github",
): Promise<Response | null> {
  const state = context.req.query("state");
  if (!state || !deps.managedAuth) return null;
  const verification = await (
    await deps.managedAuth.$context
  ).internalAdapter.findVerificationValue(state);
  if (!verification?.value) return null;
  let rawState: unknown;
  try {
    rawState = JSON.parse(verification.value);
  } catch {
    return null;
  }
  if (!rawState || typeof rawState !== "object" || !("opengeniSignInMethod" in rawState))
    return null;
  const parsed = ConnectState.safeParse(rawState);
  if (!parsed.success)
    throw new HTTPException(403, { message: "Invalid sign-in method OAuth proof" });
  const value = parsed.data,
    proof = value.opengeniSignInMethod;
  if (
    proof.provider !== provider ||
    value.callbackURL !==
      new URL(
        "/settings/security?signInMethod=connected",
        deps.settings.publicBaseUrl!,
      ).toString() ||
    value.errorURL !==
      new URL("/settings/security?signInMethod=error", deps.settings.publicBaseUrl!).toString()
  )
    throw new HTTPException(403);
  const [intent] = await rows<{ value: string }>(
    deps,
    sql`select value from auth_verifications where identifier=${`managed-sign-in:${proof.intentId}`} and expires_at>clock_timestamp()`,
  );
  if (!intent) throw new HTTPException(403, { message: "Sign-in method connection expired" });
  const request = ConnectIntent.parse(JSON.parse(intent.value));
  const authority = getCookie(context, MANAGED_AUTH_SESSION_SET_COOKIE);
  if (!request.actorFence) {
    const ambient = await deps.managedAuthSessionAdapter?.resolveAmbientSession(
      context.req.raw.headers,
    );
    if (
      !ambient ||
      ambient.session.id !== request.authSessionId ||
      ambient.user.id !== request.authUserId
    ) {
      return context.redirect(
        new URL(
          "/settings/security?signInMethod=error&error=SIGN_IN_METHOD_IDENTITY_CHANGED",
          deps.settings.publicBaseUrl!,
        ).toString(),
      );
    }
  }
  if (
    request.actorFence &&
    (!authority || managedAuthSha256(authority) !== request.actorFence.authorityHash)
  )
    throw new HTTPException(403);
  if (value.link?.userId !== request.authUserId || value.link?.email === undefined)
    throw new HTTPException(403);
  const isolated = await isolatedManagedAuthOAuthCallbackRequest(deps.managedAuth, context.req.raw);
  const response = await runManagedSignInConnect(proof.intentId, () =>
    deps.managedAuth!.handler(isolated.request),
  );
  const [linked] = await rows<{ email: string }>(
    deps,
    sql`select u.email from auth_identities a join auth_users u on u.id=a.user_id where a.managed_link_intent_id=${proof.intentId}`,
  );
  if (linked)
    await deliverManagedSignInNotification(deps.db, deps.managedEmailTransport, proof.intentId);
  if (response.status >= 400 || !linked) {
    return context.redirect(
      new URL(
        "/settings/security?signInMethod=error&error=SIGN_IN_METHOD_CONNECT_FAILED",
        deps.settings.publicBaseUrl!,
      ).toString(),
    );
  }
  return scrubManagedAuthProviderResponse(response, {
    replacementCookies: [],
    preserveCookieNames: [isolated.stateCookieName],
  });
}
