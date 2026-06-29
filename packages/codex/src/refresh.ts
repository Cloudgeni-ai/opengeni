// Token refresh + JWT helpers + permanent-failure classification.
// Refresh is JSON-bodied (exchange is form-encoded — spec §1.1 contrasts these).
// Classification mirrors codex-rs manager.rs:180-184.

import { CODEX_CLIENT_ID, CODEX_ID_TOKEN_AUTH_CLAIM, CODEX_TOKEN_URL } from "./constants";
import type { CodexFetch } from "./device-code";

/** Permanent — the workspace must reconnect (status => needs_relogin). */
export class CodexReloginRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexReloginRequired";
  }
}

/** Transient — safe to retry later. */
export class CodexRefreshTransient extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRefreshTransient";
  }
}

/** Only present fields are returned (the server may rotate any subset). */
export type CodexRefreshTokens = {
  idToken?: string | undefined;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
};

/** POST {issuer}/oauth/token JSON {client_id, grant_type:"refresh_token", refresh_token}. manager.rs:1336-1340 */
export async function refreshCodexToken(
  refreshToken: string,
  fetchImpl: CodexFetch = fetch,
): Promise<CodexRefreshTokens> {
  const res = await fetchImpl(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = extractRefreshErrorCode(text);
    const msg = code ? PERMANENT_REFRESH_FAILURES[code] : undefined;
    if (msg) {
      throw new CodexReloginRequired(msg);
    }
    if (res.status === 401) {
      throw new CodexReloginRequired("Your Codex session could not be refreshed. Please disconnect and sign in again.");
    }
    throw new CodexRefreshTransient(`Failed to refresh Codex token: ${res.status}`);
  }
  const body = JSON.parse(text) as { id_token?: string; access_token?: string; refresh_token?: string };
  return { idToken: body.id_token, accessToken: body.access_token, refreshToken: body.refresh_token };
}

// Codes that mean the refresh token is permanently dead -> reconnect required.
// Includes the standard OAuth `invalid_grant` alongside the Codex-specific codes.
const PERMANENT_REFRESH_FAILURES: Record<string, string> = {
  refresh_token_expired: "Your Codex refresh token has expired. Please disconnect and sign in again.",
  refresh_token_reused: "Your Codex refresh token was already used. Please disconnect and sign in again.",
  refresh_token_invalidated: "Your Codex refresh token was revoked. Please disconnect and sign in again.",
  invalid_grant: "Your Codex session is no longer valid. Please disconnect and sign in again.",
};

/** Pull an error code from any of the shapes the auth server may return. */
function extractRefreshErrorCode(text: string): string | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const err = o.error;
    if (typeof err === "string") {
      return err; // { "error": "invalid_grant" }
    }
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      if (typeof e.code === "string") return e.code; // { "error": { "code": "..." } }
      if (typeof e.type === "string") return e.type;
    }
    if (typeof o.code === "string") return o.code; // { "code": "..." }
    if (typeof o.type === "string") return o.type;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Decode a JWT payload (base64url, no signature check). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** access-token `exp` claim -> Date | null. token_data.rs:101-105 */
export function accessTokenExpiry(accessToken: string): Date | null {
  const payload = decodeJwtPayload(accessToken);
  return typeof payload?.exp === "number" ? new Date(payload.exp * 1000) : null;
}

/** id_token -> {chatgptAccountId, planType, isFedramp}. server.rs:827-832; token_data.rs:71-99 */
export function parseIdToken(idToken: string): {
  chatgptAccountId: string | null;
  planType: string | null;
  isFedramp: boolean;
} {
  const payload = decodeJwtPayload(idToken);
  const auth = (payload?.[CODEX_ID_TOKEN_AUTH_CLAIM] ?? {}) as Record<string, unknown>;
  return {
    chatgptAccountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null,
    planType: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    isFedramp: auth.chatgpt_account_is_fedramp === true,
  };
}
