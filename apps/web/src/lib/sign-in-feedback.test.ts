import { expect, test } from "bun:test";
import { readSignInCallbackError, signInCallbackError } from "./sign-in-feedback";

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

test("integration callbacks and success hints cannot claim a login change", () => {
  expect(readSignInCallbackError("?github=connected&google=success")).toBeNull();
  expect(readSignInCallbackError("?signin=connected")).toBeNull();
  expect(signInCallbackError(null)).toBeNull();
});
