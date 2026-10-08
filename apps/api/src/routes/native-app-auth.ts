import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  getNativeAppManagedSession,
  NATIVE_APP_CREDENTIAL_PREFIX,
  type ApiRouteDeps,
} from "@opengeni/core";
import { requireCanonicalHumanRequestIdentity } from "@opengeni/core/canonical-human-identities";
import { getCanonicalHumanIdentityProjection } from "@opengeni/db/canonical-human-identities";
import {
  getNativePushDevice,
  NATIVE_PUSH_RULES,
  registerNativePushDevice,
  unregisterNativePushDevice,
} from "@opengeni/db";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runManagedAuthProvider } from "../auth/managed-auth-attempt-context";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";

// Native app sign-in (RFC 8252 shape: authorization code + PKCE over a custom
// scheme). The app opens `/native-sign-in` in the system auth browser; the
// person signs in there with any web method and approves the device. The
// signed-in browser asks for a one-time code bound to the app's PKCE challenge
// and is redirected to `<scheme>://auth/callback`. The app exchanges the code
// for its own Better Auth session, presented as `Bearer ogapp_<token>`: the
// person's own authority on that device, revocable on its own.

export const NATIVE_APP_CODE_TTL_MS = 2 * 60 * 1_000;
const CODE_IDENTIFIER_PREFIX = "opengeni-native-app-code:";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const MANAGED_PROVIDERS = ["credential", "google", "github"] as const;

const AuthorizeBody = z.object({
  redirectUri: z.string().min(1).max(512),
  codeChallenge: z.string().regex(PKCE_CHALLENGE),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().min(8).max(256).optional(),
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const TokenBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(PKCE_VERIFIER),
  redirectUri: z.string().min(1).max(512),
});

const PushDeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  appId: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/u),
  environment: z.enum(["development", "production"]),
  token: z.string().min(8).max(4096),
  rules: z.array(z.enum(NATIVE_PUSH_RULES)).max(NATIVE_PUSH_RULES.length),
});

const StoredGrant = z.object({
  userId: z.string().min(1),
  providerId: z.enum(MANAGED_PROVIDERS),
  redirectUri: z.string(),
  codeChallenge: z.string().regex(PKCE_CHALLENGE),
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().nullable(),
});

/** A registered native callback: exactly `<allowed scheme>://auth/callback`. */
export function nativeAppRedirectAllowed(redirectUri: string, schemes: readonly string[]): boolean {
  return schemes.some((scheme) => redirectUri === `${scheme}://auth/callback`);
}

export function pkceS256Challenge(verifier: string): string {
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

function bearer(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

async function rows<T>(deps: ApiRouteDeps, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await deps.db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export function registerNativeAppAuthRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/native-app";
  app.use(`${base}/*`, async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });

  // The signed-in browser approves one device: same-origin, cookie-authenticated.
  app.post(`${base}/authorize`, async (context) => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    await admitManagedSignInMutation(context, deps);
    const actor = await requireCanonicalHumanRequestIdentity(context, {
      db: deps.db,
      managedAuth: auth,
      managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
      managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
    });
    const parsed = AuthorizeBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      throw new HTTPException(400, { message: "Invalid native sign-in request" });
    const body = parsed.data;
    if (!nativeAppRedirectAllowed(body.redirectUri, deps.settings.nativeAppSchemes)) {
      throw new HTTPException(400, { message: "Unregistered native app redirect" });
    }
    // The device session is bound to the same sign-in method as the approving
    // browser session, so the canonical identity checks treat them alike.
    const [approving] = await rows<{ loginBindingId: string | null }>(
      deps,
      sql`select login_binding_id as "loginBindingId" from auth_sessions
          where id = ${actor.authSessionId} and user_id = ${actor.authUserId}`,
    );
    const projection = await getCanonicalHumanIdentityProjection(deps.db, actor.authUserId);
    const binding = projection.loginBindings.find(
      (candidate) => candidate.id === approving?.loginBindingId && candidate.status === "active",
    );
    const providerId = MANAGED_PROVIDERS.find((provider) => provider === binding?.providerId);
    if (!providerId) throw new HTTPException(409, { message: "Sign-in method unavailable" });
    const code = randomBytes(32).toString("base64url");
    const context_ = await auth.$context;
    await context_.internalAdapter.createVerificationValue({
      identifier: codeIdentifier(code),
      value: JSON.stringify(
        StoredGrant.parse({
          userId: actor.authUserId,
          providerId,
          redirectUri: body.redirectUri,
          codeChallenge: body.codeChallenge,
          platform: body.platform,
          deviceName: body.deviceName ?? null,
        }),
      ),
      expiresAt: new Date(Date.now() + NATIVE_APP_CODE_TTL_MS),
    });
    const redirect = new URL(body.redirectUri);
    redirect.searchParams.set("code", code);
    if (body.state) redirect.searchParams.set("state", body.state);
    return context.json({ redirectUrl: redirect.toString() });
  });

  // The app redeems its single-use code with the PKCE verifier.
  app.post(`${base}/token`, async (context) => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    const parsed = TokenBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    const body = parsed.data;
    const authContext = await auth.$context;
    const stored = await authContext.internalAdapter.consumeVerificationValue(
      codeIdentifier(body.code),
    );
    if (!stored) return context.json({ error: "invalid_grant" }, 400);
    let grant: z.infer<typeof StoredGrant>;
    try {
      grant = StoredGrant.parse(JSON.parse(stored.value));
    } catch {
      return context.json({ error: "invalid_grant" }, 400);
    }
    if (
      !sameText(grant.redirectUri, body.redirectUri) ||
      !sameText(grant.codeChallenge, pkceS256Challenge(body.codeVerifier))
    ) {
      return context.json({ error: "invalid_grant" }, 400);
    }
    const platform = grant.platform === "ios" ? "iOS" : "Android";
    const session = await runManagedAuthProvider(grant.providerId, () =>
      authContext.internalAdapter.createSession(grant.userId, false, {
        userAgent: `Opengeni app (${platform}${grant.deviceName ? `; ${grant.deviceName}` : ""})`,
      }),
    );
    if (!session?.token || new Date(session.expiresAt).getTime() <= Date.now()) {
      return context.json({ error: "access_denied" }, 403);
    }
    return context.json({
      accessToken: `${NATIVE_APP_CREDENTIAL_PREFIX}${session.token}`,
      tokenType: "Bearer",
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  // Sign the device out: revoke its own session only. Idempotent.
  app.post(`${base}/sign-out`, async (context) => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    const credential = bearer(context.req.header("authorization"));
    if (!credential?.startsWith(NATIVE_APP_CREDENTIAL_PREFIX)) {
      throw new HTTPException(401, { message: "Native app credential required" });
    }
    const session = await getNativeAppManagedSession(auth, credential, deps.db).catch(() => null);
    const authSessionId = session?.session?.id;
    if (typeof authSessionId === "string") {
      await deps.db.execute(sql`delete from auth_sessions where id = ${authSessionId}`);
    }
    return context.json({ signedOut: true });
  });

  // Push registration belongs to the app session that registered it: signing
  // the app out, or revoking its session anywhere, removes it.
  const appSessionId = async (authorization: string | undefined): Promise<string> => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    const credential = bearer(authorization);
    if (!credential?.startsWith(NATIVE_APP_CREDENTIAL_PREFIX)) {
      throw new HTTPException(401, { message: "Native app credential required" });
    }
    const session = await getNativeAppManagedSession(auth, credential, deps.db).catch(() => null);
    const id = session?.session?.id;
    if (typeof id !== "string") throw new HTTPException(401, { message: "Sign in again" });
    return id;
  };

  app.get(`${base}/push-device`, async (context) => {
    const id = await appSessionId(context.req.header("authorization"));
    return context.json({ device: await getNativePushDevice(deps.db, id) });
  });

  app.put(`${base}/push-device`, async (context) => {
    const id = await appSessionId(context.req.header("authorization"));
    const parsed = PushDeviceBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "Invalid push registration" });
    if (!deps.settings.nativeAppIds.includes(parsed.data.appId)) {
      throw new HTTPException(400, { message: "Unregistered native app" });
    }
    return context.json({
      device: await registerNativePushDevice(deps.db, { authSessionId: id, ...parsed.data }),
    });
  });

  app.delete(`${base}/push-device`, async (context) => {
    const id = await appSessionId(context.req.header("authorization"));
    await unregisterNativePushDevice(deps.db, id);
    return context.json({ device: null });
  });
}
