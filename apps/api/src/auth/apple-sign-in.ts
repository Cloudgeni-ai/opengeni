import { createPrivateKey, sign } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { ManagedSignInProvider } from "@opengeni/contracts/managed-sign-in-methods";
import type { ManagedAuth } from "@opengeni/core";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { decryptOAuthToken } from "better-auth/oauth2";
import { z } from "zod";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_CALLBACK = "/v1/auth/callback/apple";
const SECONDS_PER_DAY = 86_400;
const NAME_PARAMETER = "apple_name";
const namePart = z.string().trim().max(80).optional().catch(undefined);
const appleName = z.object({ firstName: namePart, lastName: namePart });
const appleFormUser = z.object({ name: appleName });
const appleNameEnvelope = z.object({ state: z.string(), name: appleName });

function appleCredentials(settings: Settings) {
  const {
    managedAuthAppleClientId: clientId,
    managedAuthAppleTeamId: teamId,
    managedAuthAppleKeyId: keyId,
    managedAuthApplePrivateKey: privateKey,
  } = settings;
  return clientId && teamId && keyId && privateKey ? { clientId, teamId, keyId, privateKey } : null;
}

export function managedSocialClientId(settings: Settings, provider: ManagedSignInProvider) {
  switch (provider) {
    case "google":
      return settings.managedAuthGoogleClientSecret
        ? settings.managedAuthGoogleClientId
        : undefined;
    case "github":
      return settings.managedAuthGithubClientSecret
        ? settings.managedAuthGithubClientId
        : undefined;
    case "apple":
      return appleCredentials(settings)?.clientId;
  }
}

export function createAppleClientSecret(
  credentials: NonNullable<ReturnType<typeof appleCredentials>>,
  now = Date.now,
): () => string {
  let key;
  try {
    key = createPrivateKey(credentials.privateKey.replaceAll("\\n", "\n"));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error();
    }
  } catch {
    throw new Error("OPENGENI_MANAGED_AUTH_APPLE_PRIVATE_KEY must contain a P-256 PEM private key");
  }
  let cached: { secret: string; issuedAt: number; expiresAt: number } | undefined;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return () => {
    const issuedAt = Math.floor(now() / 1000);
    if (cached && issuedAt >= cached.issuedAt && cached.expiresAt - issuedAt > SECONDS_PER_DAY) {
      return cached.secret;
    }
    const expiresAt = issuedAt + 30 * SECONDS_PER_DAY;
    const header = encode({ alg: "ES256", kid: credentials.keyId });
    const claims = encode({
      iss: credentials.teamId,
      sub: credentials.clientId,
      aud: APPLE_ISSUER,
      iat: issuedAt,
      exp: expiresAt,
    });
    const payload = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" });
    cached = { secret: `${payload}.${signature.toString("base64url")}`, issuedAt, expiresAt };
    return cached.secret;
  };
}

export function managedAppleProviderOptions(
  settings: Settings,
  signup: { disableSignUp?: boolean } = {},
) {
  const credentials = appleCredentials(settings);
  if (!credentials) return null;
  const clientSecret = createAppleClientSecret(credentials);
  return {
    ...signup,
    clientId: credentials.clientId,
    get clientSecret() {
      // Better Auth's Apple provider reads the property on each token exchange.
      return clientSecret();
    },
    appBundleIdentifier: settings.managedAuthAppleAppBundleIdentifier,
    // Explicitly keep the Services ID audience even with a bundle ID override.
    audience: [
      ...new Set([
        credentials.clientId,
        settings.managedAuthAppleAppBundleIdentifier ?? credentials.clientId,
      ]),
    ],
    // Apple sends the name only on first consent. Do not override a returning
    // user's name, and give users whose original consent predates us a label.
    mapProfileToUser: (profile: { name?: string }) => ({
      name: profile.name?.trim() || "Apple user",
    }),
  };
}

/** Normalize Apple's cross-site form POST into the cookie-bearing GET that
 * runs the ordinary Better Auth state, session-set, and linking checks. No
 * Apple origin is trusted for other auth routes, and the profile name never
 * appears in the browser or proxy URL in plaintext. */
export async function redirectAppleFormPost(
  auth: ManagedAuth,
  request: Request,
): Promise<Response> {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  const invalid = () => new Response(null, { status: 400, headers });
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return invalid();
  }
  const form = await request.formData().catch(() => null);
  if (!form) return invalid();
  const params = new URLSearchParams();
  for (const field of ["state", "code", "error", "iss"] as const) {
    const values = form.getAll(field);
    if (values.length > 1) return invalid();
    if (typeof values[0] === "string" && values[0]) params.set(field, values[0]);
  }
  const state = params.get("state");
  if (!state || (!params.has("code") && !params.has("error"))) return invalid();
  const user = form.get("user");
  if (
    params.has("code") &&
    !params.has("error") &&
    typeof user === "string" &&
    user.length <= 4096
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(user);
    } catch {
      /* An optional display name must not block sign-in. */
    }
    const profile = appleFormUser.safeParse(parsed);
    if (profile.success) {
      params.set(
        NAME_PARAMETER,
        await symmetricEncrypt({
          key: (await auth.$context).secretConfig,
          data: JSON.stringify({ state, name: profile.data.name }),
        }),
      );
    }
  }
  return new Response(null, {
    status: 303,
    headers: { ...headers, location: `${APPLE_CALLBACK}?${params}` },
  });
}

/** Only the state-bound, sealed form name reaches Better Auth; it is display data, not identity proof. */
export async function appleCallbackProviderRequest(
  auth: ManagedAuth,
  request: Request,
): Promise<Request> {
  const url = new URL(request.url);
  const sealedName = url.searchParams.get(NAME_PARAMETER);
  if (!sealedName && !url.searchParams.has("user")) return request;
  url.searchParams.delete(NAME_PARAMETER);
  url.searchParams.delete("user");
  if (sealedName && sealedName.length <= 4096) {
    try {
      const data = await symmetricDecrypt({
        key: (await auth.$context).secretConfig,
        data: sealedName,
      });
      const envelope = appleNameEnvelope.safeParse(JSON.parse(data));
      if (envelope.success && envelope.data.state === url.searchParams.get("state")) {
        url.searchParams.set("user", JSON.stringify({ name: envelope.data.name }));
      }
    } catch {
      /* Invalid name data is ignored; OAuth state is still validated by Better Auth. */
    }
  }
  return new Request(url, { headers: request.headers });
}

/** Call before deleting the user's Better Auth identities. No Apple account
 * is a no-op; missing credentials/tokens or a failed revoke throws so the
 * caller can record or retry it before the token is erased. */
export async function revokeManagedAppleTokens(
  auth: ManagedAuth,
  settings: Settings,
  authUserId: string,
  options: { fetcher?: typeof fetch } = {},
): Promise<"revoked" | "not_linked"> {
  const context = await auth.$context;
  const accounts = (await context.internalAdapter.findAccounts(authUserId)).filter(
    (account) => account.providerId === "apple",
  );
  if (!accounts.length) return "not_linked";
  const credentials = appleCredentials(settings);
  if (!credentials) throw new Error("Sign in with Apple is not configured for token revocation");
  const clientSecret = createAppleClientSecret(credentials);
  for (const account of accounts) {
    const stored = account.refreshToken || account.accessToken;
    if (!stored) throw new Error("No stored Sign in with Apple token to revoke");
    const token = await decryptOAuthToken(stored, context);
    const response = await (options.fetcher ?? fetch)(`${APPLE_ISSUER}/auth/revoke`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: clientSecret(),
        token,
        token_type_hint: account.refreshToken ? "refresh_token" : "access_token",
      }),
    });
    if (response.status !== 200)
      throw new Error(`Apple token revocation failed (HTTP ${response.status})`);
  }
  return "revoked";
}
