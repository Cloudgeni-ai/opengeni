// Device-code (headless) login flow for a ChatGPT/Codex subscription.
// Grounded in codex-rs device_code_auth.rs:67-145 + server.rs:732-766 (spec §1.1).
// Every call takes an injectable fetch so tests can supply a fake.

import {
  CODEX_AUTH_BASE,
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_TOKEN_URL,
} from "./constants";

export type CodexFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type CodexDeviceStart = {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
};

export type CodexTokens = { idToken: string; accessToken: string; refreshToken: string };

export type CodexPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string };

export class CodexDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDeviceError";
  }
}

/** Step 1: POST {auth}/deviceauth/usercode {client_id}. device_code_auth.rs:67-95 */
export async function startDeviceCode(fetchImpl: CodexFetch = fetch): Promise<CodexDeviceStart> {
  const res = await fetchImpl(`${CODEX_AUTH_BASE}/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (res.status === 404) {
    throw new CodexDeviceError("device code login is not enabled for this Codex server");
  }
  if (!res.ok) {
    throw new CodexDeviceError(`device code request failed with status ${res.status}`);
  }
  const body = (await res.json()) as {
    device_auth_id: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code ?? body.usercode ?? "",
    verificationUri: CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds: normalizeInterval(body.interval),
  };
}

/** Clamp the poll interval to a sane minimum: a missing/0/NaN value must not become a 0-delay poll loop. */
function normalizeInterval(raw: string | number | undefined): number {
  const n = typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : raw;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? n : 5;
}

/** Step 3 (single, non-blocking): POST {auth}/deviceauth/token. 403/404 => pending. device_code_auth.rs:106-145 */
export async function pollDeviceCode(
  input: { deviceAuthId: string; userCode: string },
  fetchImpl: CodexFetch = fetch,
): Promise<CodexPollResult> {
  const res = await fetchImpl(`${CODEX_AUTH_BASE}/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: input.deviceAuthId, user_code: input.userCode }),
  });
  if (res.ok) {
    const body = (await res.json()) as { authorization_code: string; code_verifier: string };
    return {
      status: "authorized",
      authorizationCode: body.authorization_code,
      codeVerifier: body.code_verifier,
    };
  }
  if (res.status === 403 || res.status === 404) {
    return { status: "pending" };
  }
  throw new CodexDeviceError(`device auth failed with status ${res.status}`);
}

/** Step 4: POST {issuer}/oauth/token form-encoded grant_type=authorization_code. server.rs:732-766 */
export async function exchangeDeviceCode(
  input: { authorizationCode: string; codeVerifier: string },
  fetchImpl: CodexFetch = fetch,
): Promise<CodexTokens> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });
  const res = await fetchImpl(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new CodexDeviceError(`device code exchange failed with status ${res.status}`);
  }
  const body = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}
