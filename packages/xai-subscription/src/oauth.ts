import {
  OAUTH_MAX_RESPONSE_BYTES,
  readResponseJsonBounded,
  validateHttpUrl,
} from "@opengeni/network";

import { runBoundedXaiOperation } from "./bounded-operation";
import {
  XAI_CLIENT_VERSION,
  XAI_DEVICE_AUTHORIZATION_URL,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_OPERATION_TIMEOUT_MS,
  XAI_OAUTH_SCOPES,
  XAI_TOKEN_URL,
  XAI_USERINFO_URL,
} from "./constants";
import {
  XaiSubscriptionError,
  XaiSubscriptionReloginRequired,
  XaiSubscriptionTransientError,
} from "./errors";

export type XaiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type XaiDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type XaiOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  tokenType: string | null;
  scope: string | null;
  expiresInSeconds: number;
};

export type XaiDevicePollResult =
  | { status: "pending"; intervalSeconds: number }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "authorized"; tokens: XaiOAuthTokens };

export type XaiVerifiedIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
};

type XaiOAuthOptions = {
  fetch?: XaiFetch;
  clientId?: string;
  deviceAuthorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  timeoutMs?: number;
};

function oauthHeaders(): Headers {
  return new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": `opengeni/${XAI_CLIENT_VERSION}`,
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-client-surface": "headless",
  });
}

function positiveSeconds(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : fallback;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new XaiSubscriptionError("invalid_response", `xAI OAuth response is missing ${field}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateUserCode(userCode: string): void {
  if (![...userCode].every((char) => /[A-Za-z0-9-]/.test(char))) {
    throw new XaiSubscriptionError("invalid_response", "xAI returned an invalid user code");
  }
}

function validateVerificationUri(uri: string): string {
  try {
    return validateHttpUrl(uri, {
      allowLoopbackHttp: true,
      label: "xAI device verification",
    });
  } catch {
    throw new XaiSubscriptionError("invalid_response", "xAI returned an invalid verification URL");
  }
}

async function boundedFetchJson(
  label: string,
  input: string,
  init: RequestInit,
  options: Pick<XaiOAuthOptions, "fetch" | "timeoutMs">,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? XAI_OAUTH_OPERATION_TIMEOUT_MS;
  const fetched = await runBoundedXaiOperation(async (signal) => {
    const response = await fetchImpl(input, { ...init, signal });
    const body = await readResponseJsonBounded<Record<string, unknown>>(
      response,
      OAUTH_MAX_RESPONSE_BYTES,
      label,
      { signal },
    );
    return { response, body };
  }, timeoutMs);
  if (!fetched.ok) {
    throw new XaiSubscriptionTransientError(`xAI ${label} ${fetched.reason}`);
  }
  return fetched.value;
}

export async function requestXaiDeviceCode(options: XaiOAuthOptions = {}): Promise<XaiDeviceCode> {
  const { response, body } = await boundedFetchJson(
    "device code request",
    options.deviceAuthorizationUrl ?? XAI_DEVICE_AUTHORIZATION_URL,
    {
      method: "POST",
      headers: oauthHeaders(),
      body: new URLSearchParams({
        client_id: options.clientId ?? XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPES.join(" "),
        referrer: "opengeni",
      }).toString(),
    },
    options,
  );
  if (response.status === 404) {
    throw new XaiSubscriptionError(
      "not_enabled",
      "SuperGrok device-code login is not enabled by xAI",
      404,
    );
  }
  if (!response.ok) {
    throw new XaiSubscriptionTransientError(
      `xAI device code request failed (${response.status})`,
      response.status,
    );
  }

  const deviceCode = requireNonEmptyString(body.device_code, "device_code");
  const userCode = requireNonEmptyString(body.user_code, "user_code");
  const verificationUri = validateVerificationUri(
    requireNonEmptyString(body.verification_uri, "verification_uri"),
  );
  const verificationUriComplete = nullableString(body.verification_uri_complete);
  validateUserCode(userCode);

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: verificationUriComplete
      ? validateVerificationUri(verificationUriComplete)
      : null,
    expiresInSeconds: positiveSeconds(body.expires_in, 5 * 60),
    intervalSeconds: Math.max(1, positiveSeconds(body.interval, 5)),
  };
}

export async function pollXaiDeviceCode(
  input: { deviceCode: string; intervalSeconds: number },
  options: XaiOAuthOptions = {},
): Promise<XaiDevicePollResult> {
  const { response, body } = await boundedFetchJson(
    "device token exchange",
    options.tokenUrl ?? XAI_TOKEN_URL,
    {
      method: "POST",
      headers: oauthHeaders(),
      body: new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        client_id: options.clientId ?? XAI_OAUTH_CLIENT_ID,
        device_code: input.deviceCode,
      }).toString(),
    },
    options,
  );

  if (response.ok) {
    return { status: "authorized", tokens: parseTokenResponse(body, true) };
  }
  const code = nullableString(body.error);
  if (code === "authorization_pending") {
    return { status: "pending", intervalSeconds: Math.max(1, input.intervalSeconds) };
  }
  if (code === "slow_down") {
    return { status: "slow_down", intervalSeconds: Math.max(1, input.intervalSeconds) + 5 };
  }
  if (code === "access_denied" || code === "authorization_denied") {
    return { status: "denied" };
  }
  if (code === "expired_token") {
    return { status: "expired" };
  }
  throw new XaiSubscriptionTransientError(
    `xAI device token exchange failed (${response.status})`,
    response.status,
  );
}

export async function refreshXaiToken(
  refreshToken: string,
  options: XaiOAuthOptions = {},
): Promise<XaiOAuthTokens> {
  const { response, body } = await boundedFetchJson(
    "token refresh",
    options.tokenUrl ?? XAI_TOKEN_URL,
    {
      method: "POST",
      headers: oauthHeaders(),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: options.clientId ?? XAI_OAUTH_CLIENT_ID,
      }).toString(),
    },
    options,
  );
  if (!response.ok) {
    const code = nullableString(body.error);
    if (
      response.status === 401 ||
      code === "invalid_grant" ||
      code === "invalid_token" ||
      code === "access_denied"
    ) {
      throw new XaiSubscriptionReloginRequired();
    }
    throw new XaiSubscriptionTransientError(
      `xAI token refresh failed (${response.status})`,
      response.status,
    );
  }
  const parsed = parseTokenResponse(body, false);
  return {
    ...parsed,
    refreshToken: parsed.refreshToken || refreshToken,
  };
}

function parseTokenResponse(
  body: Record<string, unknown>,
  requireRefresh: boolean,
): XaiOAuthTokens {
  const accessToken = requireNonEmptyString(body.access_token, "access_token");
  const refreshToken = nullableString(body.refresh_token);
  if (requireRefresh && !refreshToken) {
    throw new XaiSubscriptionError(
      "invalid_response",
      "xAI OAuth response is missing refresh_token",
    );
  }
  return {
    accessToken,
    refreshToken: refreshToken ?? "",
    idToken: nullableString(body.id_token),
    tokenType: nullableString(body.token_type),
    scope: nullableString(body.scope),
    expiresInSeconds: positiveSeconds(body.expires_in, 60 * 60),
  };
}

export async function fetchXaiVerifiedIdentity(
  accessToken: string,
  options: XaiOAuthOptions = {},
): Promise<XaiVerifiedIdentity> {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": `opengeni/${XAI_CLIENT_VERSION}`,
    "x-grok-client-version": XAI_CLIENT_VERSION,
  });
  const { response, body } = await boundedFetchJson(
    "userinfo request",
    options.userinfoUrl ?? XAI_USERINFO_URL,
    { method: "GET", headers },
    options,
  );
  if (response.status === 401 || response.status === 403) {
    throw new XaiSubscriptionReloginRequired();
  }
  if (!response.ok) {
    throw new XaiSubscriptionTransientError(
      `xAI userinfo request failed (${response.status})`,
      response.status,
    );
  }
  return {
    subject: requireNonEmptyString(body.sub, "userinfo sub"),
    email: nullableString(body.email),
    emailVerified: typeof body.email_verified === "boolean" ? body.email_verified : null,
    name: nullableString(body.name),
  };
}

/**
 * Derive stable account metadata from the token response returned directly by
 * xAI's HTTPS device-token endpoint. The access-token principal identifies the
 * selected user/team/org account when present; ID-token claims provide the
 * human-readable profile metadata. Provider requests still validate the access
 * token before any subscription capability is used.
 */
export function xaiIdentityFromDeviceTokens(tokens: XaiOAuthTokens): XaiVerifiedIdentity {
  const accessClaims = decodeXaiJwtPayload(tokens.accessToken);
  const idClaims = tokens.idToken ? decodeXaiJwtPayload(tokens.idToken) : null;
  const subject =
    nullableString(accessClaims?.principal_id) ??
    nullableString(accessClaims?.principalId) ??
    nullableString(idClaims?.sub) ??
    nullableString(accessClaims?.sub);
  if (!subject) {
    throw new XaiSubscriptionError(
      "invalid_response",
      "xAI OAuth token response is missing account identity",
    );
  }
  const givenName =
    nullableString(idClaims?.given_name) ?? nullableString(accessClaims?.given_name);
  const familyName =
    nullableString(idClaims?.family_name) ?? nullableString(accessClaims?.family_name);
  const combinedName = [givenName, familyName].filter(Boolean).join(" ") || null;
  const emailVerifiedClaim = idClaims?.email_verified ?? accessClaims?.email_verified;
  return {
    subject,
    email: nullableString(idClaims?.email) ?? nullableString(accessClaims?.email),
    emailVerified: typeof emailVerifiedClaim === "boolean" ? emailVerifiedClaim : null,
    name: nullableString(idClaims?.name) ?? nullableString(accessClaims?.name) ?? combinedName,
  };
}

export function decodeXaiJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function xaiAccessTokenExpiry(accessToken: string): Date | null {
  const payload = decodeXaiJwtPayload(accessToken);
  return typeof payload?.exp === "number" ? new Date(payload.exp * 1_000) : null;
}
