import { createHash, randomBytes } from "node:crypto";

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** An RFC 7636 verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64Url(randomBytes(16));
}

/** The address of the server's native sign-in page for this request. */
export function nativeSignInUrl(input: {
  baseUrl: string;
  redirectUri: string;
  challenge: string;
  state: string;
  platform: "macos" | "windows" | "linux";
  deviceName: string | null;
}): string {
  const url = new URL("/native-sign-in", input.baseUrl);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("state", input.state);
  url.searchParams.set("platform", input.platform);
  const deviceName = input.deviceName?.trim();
  if (deviceName) url.searchParams.set("device_name", deviceName.slice(0, 80));
  return url.toString();
}

export type SignInCallback =
  | { kind: "code"; state: string; code: string }
  | { kind: "error"; state: string | null; error: string };

/** The sign-in callback's parameters, or null when the URL is not one. */
export function parseSignInCallback(raw: string, redirectUri: string): SignInCallback | null {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(raw);
    expected = new URL(redirectUri);
  } catch {
    return null;
  }
  const path = (value: URL) =>
    `${value.protocol}//${value.host}${value.pathname}`.replace(/\/+$/u, "");
  if (path(url) !== path(expected)) return null;
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", state, error };
  const code = url.searchParams.get("code");
  if (!state || !code) return { kind: "error", state, error: "invalid_callback" };
  return { kind: "code", state, code };
}
