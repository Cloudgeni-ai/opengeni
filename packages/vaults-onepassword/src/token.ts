import { VaultProviderError } from "./contract";

export const ONEPASSWORD_FAKE_TOKENS = ["ops_fake_healthy", "ops_fake_sync_error"] as const;
export type OnePasswordFakeToken = (typeof ONEPASSWORD_FAKE_TOKENS)[number];

export function isOnePasswordFakeToken(token: string): token is OnePasswordFakeToken {
  return (ONEPASSWORD_FAKE_TOKENS as readonly string[]).includes(token);
}

export type OnePasswordTokenDescription = {
  /** Sign-in host, for example "my.1password.com". Never secret. */
  accountName: string | null;
  fake: boolean;
};

const REQUIRED_KEYS = ["signInAddress", "deviceUuid", "email", "srpX", "muk", "secretKey"] as const;

/**
 * Offline service-account token check: `ops_` + base64 JSON carrying the sign-in
 * address and key material. It costs no 1Password request. The error message never
 * echoes the token.
 */
export function describeOnePasswordToken(
  token: string,
  options: { allowFakeTokens?: boolean } = {},
): OnePasswordTokenDescription {
  const trimmed = token.trim();
  if (options.allowFakeTokens && isOnePasswordFakeToken(trimmed)) {
    return { accountName: "fake.1password.test", fake: true };
  }
  const invalid = (detail: string) =>
    new VaultProviderError(
      "provider_auth_invalid",
      `This is not a 1Password service account token (${detail}). Create one in 1Password under Developer > Service accounts and paste the full token, which starts with "ops_".`,
    );
  if (!trimmed.startsWith("ops_")) throw invalid("missing the ops_ prefix");
  let decoded: unknown;
  try {
    const body = trimmed.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    decoded = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  } catch {
    throw invalid("it could not be decoded");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw invalid("it could not be decoded");
  }
  const record = decoded as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (typeof record[key] !== "string" && typeof record[key] !== "object") {
      throw invalid("it is incomplete");
    }
  }
  return { accountName: signInHost(record.signInAddress), fake: false };
}

function signInHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname || null;
  } catch {
    return null;
  }
}

/** Stable, non-reversible fingerprint used to key SDK clients per token. */
export async function onePasswordTokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.trim()));
  return Buffer.from(digest).subarray(0, 12).toString("hex");
}
