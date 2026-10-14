import { OpenGeniClient } from "@opengeni/sdk";
import { expoStreamingFetch } from "@opengeni/react-native/expo";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

/** The app's registered callback (app.json `scheme`). */
export const NATIVE_REDIRECT_URI = "opengeni://auth/callback";

export type WebSignInResult =
  | { kind: "signedIn"; accessToken: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function encodeQuery(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** The callback's query (React Native's URL has no full searchParams). */
export function callbackParams(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const query = url.split("#", 1)[0]!.split("?")[1] ?? "";
  for (const part of query.split("&")) {
    if (!part) continue;
    const [key = "", value = ""] = part.split("=");
    params.set(decodeURIComponent(key), decodeURIComponent(value.replace(/\+/gu, " ")));
  }
  return params;
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(Crypto.getRandomBytes(48));
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/**
 * Sign in through the deployment's own web sign-in (RFC 8252): the system auth
 * browser opens `/native-sign-in`, the person signs in with any web method and
 * allows this device, and the app redeems the one-time code with its PKCE
 * verifier for its own revocable credential.
 */
export async function signInThroughWeb(baseUrl: string): Promise<WebSignInResult> {
  const { verifier, challenge } = await pkcePair();
  const state = base64Url(Crypto.getRandomBytes(16));
  const deviceName = Constants.deviceName?.trim();
  const query = encodeQuery({
    redirect_uri: NATIVE_REDIRECT_URI,
    code_challenge: challenge,
    state,
    platform: Platform.OS === "android" ? "android" : "ios",
    ...(deviceName ? { device_name: deviceName.slice(0, 80) } : {}),
  });
  const result = await WebBrowser.openAuthSessionAsync(
    `${baseUrl}/native-sign-in?${query}`,
    NATIVE_REDIRECT_URI,
  );
  if (result.type !== "success") return { kind: "cancelled" };
  const callback = callbackParams(result.url);
  if (callback.get("state") !== state) {
    return { kind: "failed", message: "The sign-in didn't match this request. Try again." };
  }
  if (callback.get("error")) return { kind: "cancelled" };
  const code = callback.get("code");
  if (!code) return { kind: "failed", message: "The sign-in returned no code. Try again." };
  try {
    const client = new OpenGeniClient({
      baseUrl,
      fetch: expoStreamingFetch,
      onDeprecation: false,
    });
    const token = await client.exchangeNativeAppCode({
      code,
      codeVerifier: verifier,
      redirectUri: NATIVE_REDIRECT_URI,
    });
    return { kind: "signedIn", accessToken: token.accessToken };
  } catch (caught) {
    return {
      kind: "failed",
      message: caught instanceof Error ? caught.message : "The sign-in couldn't finish.",
    };
  }
}
