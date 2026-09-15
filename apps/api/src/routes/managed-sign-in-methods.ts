import {
  ManagedSignInMethods,
  ManagedSignInPasswordMutation,
  ManagedSignInProviderMutation,
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
  requireManagedAuthMutationAdmission,
} from "@opengeni/core/managed-auth-session-sets";
import { getManagedAuthSessionSetSnapshot } from "@opengeni/db/managed-auth-session-sets";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  isolatedManagedAuthOAuthCallbackRequest,
  hashManagedAuthPassword,
  verifyManagedAuthPassword,
} from "../auth/managed-auth";
import { runManagedSignInConnect } from "../auth/managed-auth-attempt-context";
import { scrubManagedAuthProviderResponse } from "./managed-auth-session-sets";

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

async function admitMutation(context: Context, deps: ApiRouteDeps) {
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

async function notify(deps: ApiRouteDeps, email: string, method: string, operationId: string) {
  try {
    const result = await deps.managedEmailTransport.send({
      kind: "sign_in_method_changed",
      from: deps.managedEmailTransport.sender,
      to: email,
      subject: "Your OpenGeni sign-in methods changed",
      idempotencyKey: `sign-in-method:${operationId}`,
      text: `Your OpenGeni ${method} sign-in method changed. If this was not you, reset your password and contact your administrator.`,
      html: `<p>Your OpenGeni ${method} sign-in method changed. If this was not you, reset your password and contact your administrator.</p>`,
    });
    return result.status;
  } catch {
    return "outcome_unknown" as const;
  }
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
        identityRevision: projection.activeIdentity.identityRevision,
        freshAuthenticationRequired: !user.fresh,
        methods: (["credential", "google", "github"] as const).map((provider) => ({
          provider,
          connected: connected(provider),
          available: configured(deps, provider),
          canDisconnect: provider !== "credential" && connected(provider) && count > 1,
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
      await admitMutation(context, deps);
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
      const [user] = await rows<{ email: string; token: string }>(
        deps,
        sql`select u.email,s.token from auth_users u join auth_sessions s on s.user_id=u.id where u.id=${actor.authUserId} and s.id=${actor.authSessionId}`,
      );
      if (!user) throw new HTTPException(401);
      const request: Record<string, unknown> = {
        kind,
        operationId: body.operationId,
        expectedIdentityRevision: body.expectedIdentityRevision,
        usableProviders: (["credential", "google", "github"] as const).filter((p) =>
          configured(deps, p),
        ),
        ...(actorFence ? { actorFence } : {}),
      };
      if ("provider" in body) {
        request.provider = body.provider;
        if (!configured(deps, body.provider))
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
          const cookies = await deps.managedAuthSessionAdapter!.createLegacySelectedSessionCookies(
            { token: user.token } as never,
            null,
          );
          const headers = new Headers({
            cookie: cookies.map((c) => c.split(";", 1)[0]).join("; "),
            origin: new URL(deps.settings.publicBaseUrl!).origin,
          });
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
          notification: await notify(
            deps,
            user.email,
            kind === "password" ? "password" : String(request.provider),
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
  let value: Record<string, any>;
  try {
    value = JSON.parse(verification.value);
  } catch {
    return null;
  }
  const proof = value.opengeniSignInMethod;
  if (!proof) return null;
  if (proof.provider !== provider || typeof proof.intentId !== "string")
    throw new HTTPException(403);
  const [intent] = await rows<{ value: string }>(
    deps,
    sql`select value from auth_verifications where identifier=${`managed-sign-in:${proof.intentId}`} and expires_at>clock_timestamp()`,
  );
  if (!intent) throw new HTTPException(403, { message: "Sign-in method connection expired" });
  const request = JSON.parse(intent.value);
  const authority = getCookie(context, MANAGED_AUTH_SESSION_SET_COOKIE);
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
  if (linked) await notify(deps, linked.email, provider, proof.intentId);
  if (response.status >= 400) {
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
