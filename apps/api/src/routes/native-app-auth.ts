import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  excelAddin,
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
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runManagedAuthProvider } from "../auth/managed-auth-attempt-context";
import { managedAuthSessionCookieHeaders } from "../auth/managed-auth-session-adapter";
import { managedAuthRefusal } from "../auth/managed-passkeys";
import { admitManagedSignInMutation } from "./managed-sign-in-methods";
import { parseRequestBody } from "../http/request-body";
import { ApiHttpError } from "../http/api-error";
import { nativePushConfigured } from "../native-push-dispatch";
import { trustedRequestSourceRateLimitKey } from "../http/request-source";
import { TokenBucket } from "./enrollments";
import {
  createNativeAppRelays,
  NATIVE_APP_RELAY_ID,
  relayRateLimitScope,
  type NativeAppRelayStore,
} from "./native-app-relay";
import { NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE } from "@opengeni/contracts";

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
export const NATIVE_APP_PLATFORMS = [
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "office",
] as const;
type NativeAppPlatform = (typeof NATIVE_APP_PLATFORMS)[number];
const PLATFORM_LABELS: Record<NativeAppPlatform, string> = {
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  office: "Office add-in",
};

/** The device label shown in the person's signed-in sessions. */
export function nativeAppSessionUserAgent(
  platform: NativeAppPlatform,
  deviceName: string | null,
): string {
  return `Opengeni app (${PLATFORM_LABELS[platform]}${deviceName ? `; ${deviceName}` : ""})`;
}

const AuthorizeBody = z.object({
  redirectUri: z.string().min(1).max(512),
  codeChallenge: z.string().regex(PKCE_CHALLENGE),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().min(8).max(256).optional(),
  platform: z.enum(NATIVE_APP_PLATFORMS),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const TokenBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeVerifier: z.string().regex(PKCE_VERIFIER),
  redirectUri: z.string().min(1).max(512),
});

// A pane that can't receive a redirect (the Excel add-in on desktop Office)
// signs in through a relay; see native-app-relay.ts.
const RelayBody = z.object({
  redirectUri: z.string().min(1).max(512),
  codeChallenge: z.string().regex(PKCE_CHALLENGE),
  codeChallengeMethod: z.literal("S256"),
  platform: z.enum(NATIVE_APP_PLATFORMS),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const RelayApproveBody = z.object({
  relayId: z.string().regex(NATIVE_APP_RELAY_ID),
  confirmationCode: z.string().min(1).max(32),
});

const RelayPollBody = z.object({
  relayId: z.string().regex(NATIVE_APP_RELAY_ID),
  codeVerifier: z.string().regex(PKCE_VERIFIER),
});

const PushDeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  appId: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/u),
  environment: z.enum(["development", "production"]),
  token: z.string().min(8).max(4096),
  rules: z.array(z.enum(NATIVE_PUSH_RULES)).max(NATIVE_PUSH_RULES.length),
  /** iOS PushKit token; agent calls ring it. Without one, iOS keeps no call rules. */
  voipToken: z.string().min(8).max(4096).nullish(),
});

const StoredGrant = z.object({
  userId: z.string().min(1),
  providerId: z.enum(MANAGED_PROVIDERS),
  redirectUri: z.string(),
  codeChallenge: z.string().regex(PKCE_CHALLENGE),
  platform: z.enum(NATIVE_APP_PLATFORMS),
  deviceName: z.string().nullable(),
});

/** Where the Office add-in, served by this deployment's web app, receives its code. */
export const OFFICE_ADDIN_CALLBACK_PATH = "/office/auth-callback.html";

/**
 * A registered native callback: exactly `<allowed scheme>://auth/callback`, or
 * the Office add-in's callback page on one of this deployment's own web origins.
 */
export function nativeAppRedirectAllowed(
  redirectUri: string,
  schemes: readonly string[],
  webOrigins: readonly string[] = [],
): boolean {
  return (
    schemes.some((scheme) => redirectUri === `${scheme}://auth/callback`) ||
    webOrigins.some((origin) => redirectUri === `${origin}${OFFICE_ADDIN_CALLBACK_PATH}`)
  );
}

/**
 * Why a native callback was refused, in words the person can act on. An Office
 * add-in callback on another web address means the add-in was installed from an
 * address this deployment doesn't sign in from (an older or internal one): the
 * pane still loads there, so only reinstalling from the current page helps.
 */
export function unregisteredNativeRedirectMessage(
  redirectUri: string,
  addin: { name: string; installUrl: string | null },
): string {
  let officeCallback = false;
  try {
    const url = new URL(redirectUri);
    officeCallback =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === OFFICE_ADDIN_CALLBACK_PATH;
  } catch {
    officeCallback = false;
  }
  if (!officeCallback) return "Unregistered native app redirect";
  const from = addin.installUrl ? ` from ${addin.installUrl}` : "";
  return `This copy of the ${addin.name} add-in is out of date: it was installed from an address that no longer signs in. Remove it from Excel, add the current one${from}, then sign in again.`;
}

function deploymentWebOrigins(settings: ApiRouteDeps["settings"]): string[] {
  return [settings.webBaseUrl, settings.publicBaseUrl].flatMap((url) => {
    if (!url) return [];
    try {
      const { origin, protocol } = new URL(url);
      return protocol === "https:" || protocol === "http:" ? [origin] : [];
    } catch {
      return [];
    }
  });
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

/** Per-source limits on the relay routes, which a signed-out pane can reach. */
export function nativeAppRelayLimiters() {
  return {
    // Each sign-in click makes one relay.
    create: new TokenBucket({ capacity: 10, refillPerSecond: 0.1 }),
    // Each pane polls its own relay every two seconds while the person is in
    // the browser; the address-wide limit leaves room for many people behind
    // one office address.
    poll: new TokenBucket({ capacity: 30, refillPerSecond: 1 }),
    pollAddress: new TokenBucket({ capacity: 300, refillPerSecond: 25 }),
    // A person types the code; a few retries cover typos.
    approve: new TokenBucket({ capacity: 10, refillPerSecond: 0.1 }),
  };
}

export function registerNativeAppAuthRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: {
    relayLimiters?: ReturnType<typeof nativeAppRelayLimiters>;
    relayStore?: NativeAppRelayStore;
  } = {},
): void {
  const base = "/v1/native-app";
  app.use(`${base}/*`, async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });

  // The signed-in person approving in this browser, and the sign-in method
  // their device session is bound to (the same as the approving browser
  // session's, so the canonical identity checks treat them alike).
  const approvingPerson = async (context: Context) => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    await admitManagedSignInMutation(context, deps);
    const actor = await requireCanonicalHumanRequestIdentity(context, {
      db: deps.db,
      managedAuth: auth,
      managedAuthSessionAdapter: deps.managedAuthSessionAdapter,
      managedAuthSessionSetMode: deps.settings.managedAuthSessionSetMode,
    });
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
    return { userId: actor.authUserId, providerId };
  };

  const checkRedirect = (redirectUri: string) => {
    if (
      !nativeAppRedirectAllowed(
        redirectUri,
        deps.settings.nativeAppSchemes,
        deploymentWebOrigins(deps.settings),
      )
    ) {
      throw new HTTPException(400, {
        message: unregisteredNativeRedirectMessage(redirectUri, excelAddin(deps.settings)),
      });
    }
  };

  /** A one-time code bound to the app's PKCE challenge and callback. */
  const issueCode = async (grant: z.infer<typeof StoredGrant>): Promise<string> => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    const code = randomBytes(32).toString("base64url");
    const context_ = await auth.$context;
    await context_.internalAdapter.createVerificationValue({
      identifier: codeIdentifier(code),
      value: JSON.stringify(StoredGrant.parse(grant)),
      expiresAt: new Date(Date.now() + NATIVE_APP_CODE_TTL_MS),
    });
    return code;
  };

  // The signed-in browser approves one device: same-origin, cookie-authenticated.
  app.post(`${base}/authorize`, async (context) => {
    const person = await approvingPerson(context);
    const body = parseRequestBody(AuthorizeBody, await context.req.json().catch(() => null), {
      status: 400,
      message: "Invalid native sign-in request",
    });
    checkRedirect(body.redirectUri);
    const code = await issueCode({
      ...person,
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      platform: body.platform,
      deviceName: body.deviceName ?? null,
    });
    const redirect = new URL(body.redirectUri);
    redirect.searchParams.set("code", code);
    if (body.state) redirect.searchParams.set("state", body.state);
    return context.json({ redirectUrl: redirect.toString() });
  });

  // Relays: public to create and poll (the pane isn't signed in yet), so each
  // route has its own per-source limit, and an approval needs the signed-in
  // browser plus the confirmation code the pane shows.
  const limiters = options.relayLimiters ?? nativeAppRelayLimiters();
  const limit = (context: Context, limiter: TokenBucket, scope = "") => {
    if (!limiter.take(`${trustedRequestSourceRateLimitKey(context, deps.settings)}${scope}`)) {
      throw new HTTPException(429, { message: "Too many sign-in attempts. Wait a moment." });
    }
  };
  const relays = async () => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    if (options.relayStore) return createNativeAppRelays(options.relayStore);
    const adapter = (await auth.$context).internalAdapter;
    const store: NativeAppRelayStore = {
      find: (identifier) => adapter.findVerificationValue(identifier),
      consume: (identifier) => adapter.consumeVerificationValue(identifier),
      create: (row) => adapter.createVerificationValue(row),
    };
    return createNativeAppRelays(store);
  };

  app.post(`${base}/relays`, async (context) => {
    limit(context, limiters.create);
    const body = parseRequestBody(RelayBody, await context.req.json().catch(() => null), {
      status: 400,
      message: "Invalid native sign-in request",
    });
    checkRedirect(body.redirectUri);
    const relay = await (
      await relays()
    ).create({
      redirectUri: body.redirectUri,
      codeChallenge: body.codeChallenge,
      platform: body.platform,
      deviceName: body.deviceName ?? null,
    });
    return context.json({ ...relay, expiresAt: relay.expiresAt.toISOString() });
  });

  app.post(`${base}/relays/approve`, async (context) => {
    limit(context, limiters.approve);
    const person = await approvingPerson(context);
    const body = parseRequestBody(RelayApproveBody, await context.req.json().catch(() => null), {
      status: 400,
      message: "Enter the code shown in the app.",
    });
    const result = await (
      await relays()
    ).approve(body.relayId, body.confirmationCode, (request) =>
      issueCode({
        ...person,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        platform: StoredGrant.shape.platform.parse(request.platform),
        deviceName: request.deviceName,
      }),
    );
    if (result.status === "mismatch") {
      throw new HTTPException(400, {
        message: "That code doesn't match the one in the app. Check it and try again.",
      });
    }
    if (result.status === "gone") {
      throw new HTTPException(410, {
        message: "This sign-in request has expired. Start again from the app.",
      });
    }
    return context.json({ approved: true });
  });

  app.post(`${base}/relays/poll`, async (context) => {
    limit(context, limiters.pollAddress);
    const parsed = RelayPollBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    limit(context, limiters.poll, `:${relayRateLimitScope(parsed.data.relayId)}`);
    const result = await (await relays()).poll(parsed.data.relayId, parsed.data.codeVerifier);
    return context.json(result);
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
    // A refusal from the session hook (the address was taken off the allowed
    // list after the web sign-in) is a denial, not a server failure.
    const session = await runManagedAuthProvider(grant.providerId, () =>
      authContext.internalAdapter.createSession(grant.userId, false, {
        nativeAppPlatform: grant.platform,
        userAgent: nativeAppSessionUserAgent(grant.platform, grant.deviceName),
      }),
    ).catch((error: unknown) => {
      if (managedAuthRefusal(error)) return null;
      throw error;
    });
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

  // A desktop app shows the deployment's own web app. It signs that window in
  // with the same device session, so the window is an ordinary first-party web
  // session and signing the device out ends both. The bearer is required: an
  // ambient browser request can never mint this cookie.
  app.post(`${base}/web-session`, async (context) => {
    const auth = deps.managedAuth;
    if (!auth) throw new HTTPException(404);
    if (deps.settings.managedAuthSessionSetMode === "broker") {
      throw new HTTPException(409, {
        message: "This deployment signs browser windows in through login session sets",
      });
    }
    const credential = bearer(context.req.header("authorization"));
    if (!credential?.startsWith(NATIVE_APP_CREDENTIAL_PREFIX)) {
      throw new HTTPException(401, { message: "Native app credential required" });
    }
    const session = await getNativeAppManagedSession(auth, credential, deps.db).catch(() => null);
    if (typeof session?.session?.id !== "string") {
      throw new HTTPException(401, { message: "Sign in again" });
    }
    for (const cookie of await managedAuthSessionCookieHeaders(
      auth,
      credential.slice(NATIVE_APP_CREDENTIAL_PREFIX.length),
      context.req.header("cookie") ?? null,
    )) {
      context.header("set-cookie", cookie, { append: true });
    }
    return context.json({ signedIn: true });
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
    const parsed = parseRequestBody(PushDeviceBody, await context.req.json().catch(() => null), {
      status: 400,
      message: "Invalid push registration",
    });
    // A registration this deployment could never deliver to is refused with a
    // stable reason, so the app can say so instead of offering "Try again":
    // an app build the deployment doesn't list, or a platform it has no push
    // credentials for (its pushes would only ever fail in the dispatcher).
    const unavailable = !deps.settings.nativeAppIds.includes(parsed.appId)
      ? `This server doesn't send notifications to the app "${parsed.appId}".`
      : !nativePushConfigured(deps.settings, parsed.platform)
        ? `This server isn't set up to send ${parsed.platform === "ios" ? "iOS" : "Android"} notifications.`
        : null;
    if (unavailable) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: unavailable,
        retryable: false,
        details: { code: NATIVE_PUSH_UNAVAILABLE_DETAIL_CODE },
      });
    }
    return context.json({
      device: await registerNativePushDevice(deps.db, { authSessionId: id, ...parsed }),
    });
  });

  app.delete(`${base}/push-device`, async (context) => {
    const id = await appSessionId(context.req.header("authorization"));
    await unregisterNativePushDevice(deps.db, id);
    return context.json({ device: null });
  });
}
