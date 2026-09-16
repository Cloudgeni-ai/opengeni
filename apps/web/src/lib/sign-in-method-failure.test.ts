import { expect, test } from "bun:test";
import { ApiError } from "@/api";
import { signInMethodFailure } from "./sign-in-method-failure";

test("maps backend security errors to actionable and safe guidance", () => {
  const failure = (code: string) =>
    signInMethodFailure(new ApiError(403, "raw provider details must stay hidden", { code }));
  expect(failure("EMAIL_NOT_VERIFIED").message).toContain("Verify your OpenGeni account email");
  expect(failure("ACCOUNT_COLLISION").message).toContain("accounts are not merged");
  expect(failure("EXPLICIT_RECONNECT_REQUIRED").message).toContain("choose Reconnect");
  expect(failure("CURRENT_PASSWORD_REQUIRED").message).toContain("current password");
  expect(failure("PASSWORD_CHANGED").kind).toBe("reauth");
  expect(failure("SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED").kind).toBe("reauth");
  expect(failure("LAST_USABLE_METHOD").message).toContain("last usable");
  expect(failure("SIGN_IN_METHOD_LAST_USABLE_METHOD").message).toContain("last usable");
  expect(failure("SIGN_IN_METHOD_ACCOUNT_COLLISION").message).toContain("accounts are not merged");
  expect(failure("UNKNOWN").message).not.toContain("raw provider");
});
test("unknown transport and explicit outcome uncertainty never become definitive failure", () => {
  expect(signInMethodFailure(new Error("offline")).kind).toBe("unknown");
  expect(signInMethodFailure(new ApiError(503, "")).kind).toBe("unknown");
  expect(signInMethodFailure(new ApiError(409, "", { outcomeUnknown: true })).kind).toBe("unknown");
  expect(signInMethodFailure(new ApiError(409, "", { code: "REVISION_CONFLICT" })).kind).toBe(
    "rejected",
  );
});
