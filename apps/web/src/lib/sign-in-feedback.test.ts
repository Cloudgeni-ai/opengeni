import { expect, test } from "bun:test";
import {
  readSignInCallbackError,
  securityReauthenticationPath,
  signInCallbackError,
} from "./sign-in-feedback";

test("callback failures provide a safe next step without rendering provider text", () => {
  expect(signInCallbackError("account_not_linked")).toContain("Personal settings → Security");
  expect(signInCallbackError("state_mismatch")).toContain("Start sign-in again");
  expect(signInCallbackError("email_not_verified")).toContain("Verify your email");
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

test("integration callbacks and success hints cannot claim a login change", () => {
  expect(readSignInCallbackError("?github=connected&google=success")).toBeNull();
  expect(readSignInCallbackError("?signin=connected")).toBeNull();
  expect(signInCallbackError(null)).toBeNull();
});
