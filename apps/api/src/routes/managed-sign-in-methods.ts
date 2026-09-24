import {
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
  requestWithManagedAuthClientAddress,
  verifyManagedAuthPassword,
} from "../auth/managed-auth";
import { runManagedSignInConnect } from "../auth/managed-auth-attempt-context";
import { deliverManagedSignInNotification } from "../auth/managed-sign-in-notifications";
import { managedAuthSelectedProofHeaders } from "../auth/managed-auth-session-adapter";
import { trustedRequestSourceAddress } from "../http/request-source";
import { scrubManagedAuthProviderResponse } from "./managed-auth-session-sets";

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
  const origin = deps.settings.publicBaseUrl ? new URL(deps.settings.publicBaseUrl).origin : null;
  if (
    !origin ||
    context.req.header("origin") !== origin ||
    context.req.header("sec-fetch-site") !== "same-origin" ||
    context.req.header("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new HTTPException(403, { message: "Same-origin browser mutation required" });
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
        allowedOrigins: [origin],
        authority,
        signingSecret: deps.settings.betterAuthSecret!,
        expectedGeneration: snapshot.projection.generation,
      });
    } catch {
      throw new HTTPException(403, { message: "Browser session-set CSRF validation failed" });
    }
  }
}

function configured(deps: ApiRouteDeps, provider: "credential" | "google" | "github") {
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

function mutationError(context: Context, error: unknown): Response {
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && candidate instanceof Error;
    depth++, candidate = candidate.cause
  ) {
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
    const connected = (provider: string) =>
      accounts.some((a) => a.provider === provider && a.usable) &&
      projection.loginBindings.some((b) => b.providerId === provider && b.status === "active");
    const count = (["credential", "google", "github"] as const).filter(
      (p) => connected(p) && configured(deps, p),
    ).length;
    return context.json(
      ManagedSignInMethods.parse({
        ...user,
        identityId: projection.activeIdentity.id,
        identityRevision: projection.activeIdentity.identityRevision,
        freshAuthenticationRequired: !user.fresh,
        methods: (["credential", "google", "github"] as const).map((provider) => ({
          provider,
          connected: connected(provider),
          available: configured(deps, provider),
          canDisconnect:
            provider !== "credential" &&
            connected(provider) &&
            count - (configured(deps, provider) ? 1 : 0) > 0,
          implicitRelinkingSuppressed:
            !connected(provider) &&
            projection.loginBindings.some(
              (b) => b.providerId === provider && b.status !== "active",
            ),
        })),
      }),
    );
  });
  for (const kind of ["connect", "disconnect", "password"] as const) {
    app.post(`${base}/${kind}`, async (context) => {
      await admitManagedSignInMutation(context, deps);
      const actor = await identity(context, deps);
      const actorFence = getManagedAuthRequestActorLeaseStamp(context.req.raw);
      if (deps.settings.managedAuthSessionSetMode !== "legacy" && !actorFence)
        throw new HTTPException(409, { message: "Managed actor fence required" });
      const schema =
        kind === "password" ? ManagedSignInPasswordMutation : ManagedSignInProviderMutation;
      const parsed = schema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success)
        throw new HTTPException(422, { message: "Invalid sign-in method request" });
      const body = parsed.data;
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
      const request: Record<string, unknown> = {
        kind,
        operationId: body.operationId,
        requestDigest: managedAuthSecretRequestDigest(deps.settings.betterAuthSecret!, {
          kind,
          ...body,
        }),
        expectedIdentityRevision: body.expectedIdentityRevision,
        expectedIdentityId: body.expectedIdentityId,
        usableProviders: (["credential", "google", "github"] as const).filter((p) =>
          configured(deps, p),
        ),
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
    deps.managedAuth!.handler(
      requestWithManagedAuthClientAddress(
        isolated.request,
        trustedRequestSourceAddress(context, deps.settings.apiTrustedProxyHops),
      ),
    ),
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
