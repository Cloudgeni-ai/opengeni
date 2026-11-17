// Sign-in for the add-in, through the deployment's own device sign-in page
// (/native-sign-in), redeemed (PKCE) for the add-in's own revocable credential.
//
// Excel on the web runs in the person's browser, so the page opens in an
// Office dialog and its callback page hands the one-time code back. Desktop
// Excel's dialog is an embedded webview without the person's saved sign-ins,
// passwords or passkeys, so there the page opens in the system browser
// instead. That browser can't reach the pane, so the server relays the code:
// the pane shows a short confirmation code the person types on the page, and
// polls with its verifier until the browser approves.
import { OpenGeniClient, type NativeAppRelayPoll } from "@opengeni/sdk";
import { office, openOfficeDialog } from "@opengeni/sdk/office";

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

/** Mac and Windows Excel sign in through the system browser; the rest in a dialog. */
export type SignInMode = "browser" | "dialog";

export function signInMode(platform: string | null | undefined): SignInMode {
  return platform === "Mac" || platform === "PC" ? "browser" : "dialog";
}

/** `Office.context.platform` (`PC`, `Mac`, `OfficeOnline`, …), or null outside Office. */
export function officePlatform(): string | null {
  try {
    const context = office().context;
    return context.platform ?? context.diagnostics?.platform ?? null;
  } catch {
    return null;
  }
}

function keep(token: string): string {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Signed in for this pane only.
  }
  return token;
}

const DEVICE_NAME = "Excel";

type RelayClient = Pick<
  OpenGeniClient,
  "createNativeAppRelay" | "pollNativeAppRelay" | "exchangeNativeAppCode"
>;

/** A browser sign-in in progress: the code to show, and ways to reopen or cancel it. */
export type BrowserSignIn = {
  confirmationCode: string;
  reopen(): void;
  cancel(): void;
  /** The credential once the browser approves; rejects on cancel, refusal or expiry. */
  done: Promise<string>;
};

export const SIGN_IN_CANCELLED = "Sign-in was cancelled.";

export async function startBrowserSignIn(
  options: {
    client: RelayClient;
    /** The web app's origin, which serves /native-sign-in and the callback page. */
    webOrigin: string;
    openBrowser: (url: string) => void;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
  request: SignInRequest,
): Promise<BrowserSignIn> {
  const { client, webOrigin, openBrowser } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const redirectUri = `${webOrigin}${CALLBACK_PATH}`;
  const relay = await client.createNativeAppRelay({
    redirectUri,
    codeChallenge: request.challenge,
    codeChallengeMethod: "S256",
    platform: "office",
    deviceName: DEVICE_NAME,
  });
  const url = `${webOrigin}/native-sign-in?${new URLSearchParams({
    relay: relay.relayId,
    platform: "office",
    device_name: DEVICE_NAME,
  })}`;
  const expiresAt = new Date(relay.expiresAt).getTime();
  const signal = { cancelled: false };
  const done = (async () => {
    while (!signal.cancelled) {
      await sleep(options.pollMs ?? 2_000);
      if (signal.cancelled) break;
      let result: NativeAppRelayPoll | null = null;
      try {
        result = await client.pollNativeAppRelay({
          relayId: relay.relayId,
          codeVerifier: request.verifier,
        });
      } catch {
        // A dropped or limited poll: ask again next time.
      }
      if (signal.cancelled) break;
      if (result?.status === "approved") {
        const token = await client.exchangeNativeAppCode({
          code: result.code,
          codeVerifier: request.verifier,
          redirectUri,
        });
        return keep(token.accessToken);
      }
      if (result?.status === "refused") throw new Error("Sign-in was refused. Try again.");
      // `gone` can also be the moment the browser approves; only time ends it.
      if (now() >= expiresAt) throw new Error("Sign-in timed out. Try again.");
    }
    throw new Error(SIGN_IN_CANCELLED);
  })();
  openBrowser(url);
  return {
    confirmationCode: relay.confirmationCode,
    reopen: () => openBrowser(url),
    cancel: () => {
      signal.cancelled = true;
    },
    done,
  };
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
  }).exchangeNativeAppCode({ code, codeVerifier: verifier, redirectUri });
  return keep(token.accessToken);
}
