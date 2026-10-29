import { expect, test } from "bun:test";
import {
  organizationSecurityReturnPath,
  readSignInCallbackError,
  securityReauthenticationPath,
  signInCallbackError,
} from "./sign-in-feedback";

test("callback failures provide a safe next step without rendering provider text", () => {
  expect(signInCallbackError("account_not_linked")).toContain("Personal settings → Security");
  expect(signInCallbackError("state_mismatch")).toContain("Start sign-in again");
  expect(signInCallbackError("email_not_verified")).toContain("Verify your email");
  expect(readSignInCallbackError("?error=TOKEN_EXPIRED")).toContain(
    "verification link has expired",
  );
  expect(readSignInCallbackError("?error=INVALID_TOKEN")).toContain("new verification email");
  expect(readSignInCallbackError("?error=%3Cscript%3E&error_description=secret")).not.toContain(
    "secret",
  );
  expect(readSignInCallbackError("?error=%3Cscript%3E")).not.toContain("<script>");
  expect(readSignInCallbackError("?error=access_denied&error=state_mismatch")).toContain(
    "couldn't be completed",
  );
});

test("Security reauthentication preserves only a bounded outcome on a fixed local route", () => {
  expect(
    securityReauthenticationPath(
      "?signInMethod=connected&returnTo=https://evil.example&token=secret",
    ),
  ).toBe("/settings/security?signInMethod=connected");
  expect(securityReauthenticationPath("?signInMethod=error&error_description=private")).toBe(
    "/settings/security?signInMethod=error",
  );
  expect(securityReauthenticationPath("?signInMethod=connected&signInMethod=error")).toBe(
    "/settings/security",
  );
  expect(securityReauthenticationPath("?signInMethod=arbitrary")).toBe("/settings/security");
});

test("signing in again from Security & data returns there, carrying nothing else", () => {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const page = `/workspaces/${workspace}/organization`;
  expect(
    organizationSecurityReturnPath(page, "?section=security&returnTo=https://evil.example"),
  ).toBe(`${page}?section=security`);
  expect(organizationSecurityReturnPath(page, "?section=billing")).toBeNull();
  expect(
    organizationSecurityReturnPath(`/workspaces/x/organization`, "?section=security"),
  ).toBeNull();
  expect(organizationSecurityReturnPath(`${page}/other`, "?section=security")).toBeNull();
});

test("integration callbacks and success hints cannot claim a login change", () => {
  expect(readSignInCallbackError("?github=connected&google=success")).toBeNull();
  expect(readSignInCallbackError("?signin=connected")).toBeNull();
  expect(signInCallbackError(null)).toBeNull();
});

test("a refused social sign-up while new accounts are paused says so and points to sign-in", () => {
  const message = readSignInCallbackError("?error=signup_disabled");
  expect(message).toContain("We're at capacity for new accounts right now.");
  expect(message).toContain("sign in with the method you used before");
});

test("a refused social sign-up for an unapproved address says who to ask", () => {
  const message = readSignInCallbackError("?error=signup_email_not_allowed");
  expect(message).toContain("Only approved email addresses");
  expect(message).toContain("Ask whoever runs this service to allow your email address");
  expect(message).not.toContain("Try again");
});

test("unchallenged OAuth signup directs the human through signup verification", () => {
  expect(readSignInCallbackError("?error=signup_challenge_required")).toContain(
    "complete verification",
  );
});
