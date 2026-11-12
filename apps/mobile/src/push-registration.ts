import { isNativePushUnavailableError } from "@opengeni/sdk";

/**
 * What Settings says when turning on notifications or calls fails. A server
 * that can't push to this app build says so, and retrying won't change it, so
 * the message doesn't ask to try again. A build without push setup (no
 * Firebase file, no `aps-environment` entitlement) says that instead.
 */
export function pushRegistrationProblem(caught: unknown): string {
  if (isNativePushUnavailableError(caught)) {
    return "This server isn't set up to send notifications to this app.";
  }
  const message = caught instanceof Error ? caught.message : "";
  return /firebase|googleServicesFile|aps-environment|entitlement/iu.test(message)
    ? "This build of the app isn't set up for push notifications."
    : "Notifications couldn't be turned on. Try again.";
}

/**
 * The APNs environment this build's tokens belong to. It follows the
 * provisioning profile the app was signed with, not whether JavaScript runs in
 * development mode: a release build installed from Xcode still gets sandbox
 * tokens. `fromProfile` reads the embedded profile and is null when there is
 * none (App Store and TestFlight builds, which use production).
 */
export async function apnsEnvironment(
  fromProfile: () => Promise<string | null>,
  isDevelopmentBuild: boolean,
): Promise<"development" | "production"> {
  const profile = await fromProfile().catch(() => null);
  if (profile === "development" || profile === "production") return profile;
  return isDevelopmentBuild ? "development" : "production";
}

/**
 * Whether the device's stored registration is out of date and must be sent
 * again: a rotated push or VoIP token, or an APNs environment or app ID that
 * no longer matches this build. A stale environment makes Apple reject every
 * push, so it re-registers even when the tokens are unchanged.
 */
export function pushRegistrationIsStale(
  stored: {
    token: string;
    voipToken?: string | null | undefined;
    environment: string;
    appId: string;
  },
  current: {
    token: string;
    /** This build's VoIP token when calls need one, else null. */
    voipToken: string | null;
    environment: string;
    appId: string;
  },
): boolean {
  return (
    current.token !== stored.token ||
    (current.voipToken !== null && current.voipToken !== (stored.voipToken ?? null)) ||
    current.environment !== stored.environment ||
    current.appId !== stored.appId
  );
}
