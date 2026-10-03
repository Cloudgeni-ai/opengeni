import type { SignupAttribution } from "@opengeni/contracts";

/**
 * First-touch sign-up attribution and one-shot authentication return markers.
 *
 * Nothing here touches browser storage: campaign parameters are read from the
 * landing URL into memory, forwarded with the sign-up request (server-side
 * metrics), and carried through full-page auth redirects in the same-origin
 * return URL. Browser analytics may use them only after consent.
 */

/** One-shot query marker appended to Better Auth return URLs. */
export const AUTH_RETURN_PARAMETER = "auth_event";
export const AUTH_RETURN_EVENTS = [
  "email_verified",
  "google_signup",
  "google_signin",
  "github_signup",
  "github_signin",
] as const;
export type AuthReturnEvent = (typeof AUTH_RETURN_EVENTS)[number];

/**
 * Mirrors `SIGNUP_ATTRIBUTION_URL_PARAMETERS` and the value rules of the
 * `SignupAttribution` contract (a test pins them together). Kept local so the
 * boot path adds no shared contracts chunk to every page; the server
 * re-validates everything it receives.
 */
export const SIGNUP_ATTRIBUTION_PARAMETERS = {
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
  ref: "ref",
} as const satisfies Record<keyof SignupAttribution, string>;
export const SIGNUP_ATTRIBUTION_VALUE_MAX = 100;
export const SIGNUP_ATTRIBUTION_VALUE = /^[A-Za-z0-9._~+-]+$/;

type AttributionKey = keyof typeof SIGNUP_ATTRIBUTION_PARAMETERS;

let firstTouch: SignupAttribution | null = null;
let pendingAuthReturn: AuthReturnEvent | null = null;

/**
 * Capture landing-URL attribution and consume a return marker before the
 * router reads the location. Campaign parameters stay in the URL so consented
 * analytics can observe them natively; only the one-shot marker is removed.
 */
export function retainSignupAttribution(target: Window): void {
  try {
    const url = new URL(target.location.href);
    captureFirstTouch(url.searchParams);
    const marker = url.searchParams.get(AUTH_RETURN_PARAMETER);
    if (marker === null) return;
    url.searchParams.delete(AUTH_RETURN_PARAMETER);
    // Better Auth appends `error=` to the same return URL on failure.
    if (isAuthReturnEvent(marker) && !url.searchParams.has("error")) pendingAuthReturn = marker;
    target.history.replaceState(
      target.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // Attribution is optional and must never affect application boot.
  }
}

export function signupAttribution(): SignupAttribution | null {
  return firstTouch ? { ...firstTouch } : null;
}

/**
 * A same-origin return path carrying first-touch attribution (and optionally a
 * one-shot return marker) across a full-page authentication redirect.
 */
export function signupReturnPath(path: string, marker?: AuthReturnEvent): string {
  const url = new URL(path, "https://opengeni.invalid");
  if (firstTouch) {
    for (const [key, name] of Object.entries(SIGNUP_ATTRIBUTION_PARAMETERS)) {
      const value = firstTouch[key as AttributionKey];
      if (value && !url.searchParams.has(name)) url.searchParams.set(name, value);
    }
  }
  if (marker) url.searchParams.set(AUTH_RETURN_PARAMETER, marker);
  return `${url.pathname}${url.search}`;
}

/** Consume the return marker observed at boot, at most once. */
export function takePendingAuthReturn(): AuthReturnEvent | null {
  const marker = pendingAuthReturn;
  pendingAuthReturn = null;
  return marker;
}

/** Campaign super-properties for consented analytics, in provider naming. */
export function signupAttributionAnalyticsProperties(): Record<string, string> | null {
  if (!firstTouch) return null;
  const properties: Record<string, string> = {};
  for (const [key, name] of Object.entries(SIGNUP_ATTRIBUTION_PARAMETERS)) {
    const value = firstTouch[key as AttributionKey];
    if (value) properties[name] = value;
  }
  return Object.keys(properties).length > 0 ? properties : null;
}

export function resetSignupAttributionForTests(): void {
  firstTouch = null;
  pendingAuthReturn = null;
}

function captureFirstTouch(parameters: URLSearchParams): void {
  if (firstTouch) return;
  const captured: SignupAttribution = {};
  for (const [key, name] of Object.entries(SIGNUP_ATTRIBUTION_PARAMETERS)) {
    const value = parameters.get(name)?.trim();
    if (value && isSignupAttributionValue(value)) captured[key as AttributionKey] = value;
  }
  if (Object.keys(captured).length > 0) firstTouch = captured;
}

/** The same closed-charset token rule the server contract enforces. */
export function isSignupAttributionValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SIGNUP_ATTRIBUTION_VALUE_MAX &&
    SIGNUP_ATTRIBUTION_VALUE.test(value)
  );
}

function isAuthReturnEvent(value: string): value is AuthReturnEvent {
  return (AUTH_RETURN_EVENTS as readonly string[]).includes(value);
}
