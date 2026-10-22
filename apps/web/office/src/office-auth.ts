// Sign-in for the add-in: the deployment's own device sign-in page
// (/native-sign-in) opens in an Office dialog, the person allows the add-in,
// and the callback page hands the one-time code back to this pane, which
// redeems it (PKCE) for the add-in's own revocable credential.
import { OpenGeniClient } from "@opengeni/sdk";
import { openOfficeDialog } from "@opengeni/sdk/office";

const TOKEN_KEY = "opengeni.office.token";
export const CALLBACK_PATH = "/office/auth-callback.html";

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function randomText(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** PKCE material, made ahead so the click opens the window without awaiting anything. */
export type SignInRequest = { verifier: string; challenge: string; state: string };

export async function prepareSignIn(): Promise<SignInRequest> {
  const verifier = randomText(48);
  return { verifier, challenge: await challengeFor(verifier), state: randomText(16) };
}

export async function signIn(apiBaseUrl: string, request: SignInRequest): Promise<string> {
  const { verifier, state } = request;
  const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
  const query = new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: request.challenge,
    state,
    platform: "office",
    device_name: "Excel",
  });
  const url = `${window.location.origin}/native-sign-in?${query}`;
  const message = await openOfficeDialog(url);
  const returned = new URLSearchParams(message);
  if (returned.get("state") !== state) throw new Error("The sign-in didn't match. Try again.");
  if (returned.get("error")) throw new Error("Sign-in was cancelled.");
  const code = returned.get("code");
  if (!code) throw new Error("The sign-in returned no code. Try again.");
  const token = await new OpenGeniClient({
    baseUrl: apiBaseUrl,
    onDeprecation: false,
  }).exchangeNativeAppCode({ code, codeVerifier: verifier, redirectUri });
  try {
    localStorage.setItem(TOKEN_KEY, token.accessToken);
  } catch {
    // Signed in for this pane only.
  }
  return token.accessToken;
}
