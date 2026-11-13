import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  apnsEnvironment,
  pushRegistrationIsStale,
  pushRegistrationProblem,
} from "./push-registration";

// The server's answer when it can't push to this app build (an app ID it
// doesn't list, or no APNs credentials): retrying never helps.
const unavailable = new OpenGeniApiError(
  409,
  JSON.stringify({
    error: {
      status: 409,
      code: "conflict",
      message: "This server isn't set up to send iOS notifications.",
      retryable: false,
      details: { code: "native_push_unavailable" },
    },
  }),
  { mutation: true },
);

test("a server that can't push to this app says so instead of asking to try again", () => {
  expect(pushRegistrationProblem(unavailable)).toBe(
    "This server isn't set up to send notifications to this app.",
  );
});

test("a build without push setup and other failures keep their messages", () => {
  expect(pushRegistrationProblem(new Error("Missing aps-environment entitlement"))).toBe(
    "This build of the app isn't set up for push notifications.",
  );
  expect(pushRegistrationProblem(new OpenGeniApiError(503, "", { mutation: true }))).toBe(
    "Notifications couldn't be turned on. Try again.",
  );
});

test("the APNs environment follows the signing profile, not development mode", async () => {
  // A release build installed from Xcode is signed for the APNs sandbox.
  expect(await apnsEnvironment(async () => "development", false)).toBe("development");
  expect(await apnsEnvironment(async () => "production", true)).toBe("production");
  // No profile (App Store, TestFlight) or no answer: the build mode decides.
  expect(await apnsEnvironment(async () => null, false)).toBe("production");
  expect(
    await apnsEnvironment(async () => {
      throw new Error("unavailable");
    }, true),
  ).toBe("development");
});

test("a stored registration for the wrong APNs environment is sent again", () => {
  const stored = {
    token: "apns-1",
    voipToken: "voip-1",
    environment: "production",
    appId: "ai.opengeni.app",
  };
  const current = {
    token: "apns-1",
    voipToken: "voip-1",
    environment: "production",
    appId: "ai.opengeni.app",
  };
  expect(pushRegistrationIsStale(stored, current)).toBe(false);
  // Turning notifications on registered it from the signing profile; the
  // background sync must not flip it back by build mode.
  expect(pushRegistrationIsStale(stored, { ...current, environment: "development" })).toBe(true);
  expect(pushRegistrationIsStale(stored, { ...current, token: "apns-2" })).toBe(true);
  expect(pushRegistrationIsStale(stored, { ...current, voipToken: "voip-2" })).toBe(true);
  // No call rules: the VoIP token doesn't matter.
  expect(pushRegistrationIsStale(stored, { ...current, voipToken: null })).toBe(false);
  expect(pushRegistrationIsStale(stored, { ...current, appId: "ai.opengeni.app.dev" })).toBe(true);
});
