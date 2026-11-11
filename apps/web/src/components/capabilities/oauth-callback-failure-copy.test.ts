import { describe, expect, test } from "bun:test";
import {
  oauthCallbackFailureMessage,
  oauthCallbackReasonMessage,
} from "@opengeni/react/app/lib/oauth-callback-messages";

describe("generic OAuth callback failure copy", () => {
  test("uses the shared copy for a known reason", () => {
    expect(oauthCallbackFailureMessage("state_expired")).toBe(
      oauthCallbackReasonMessage("state_expired")!,
    );
  });

  test("keeps an unknown reason visible for support", () => {
    expect(oauthCallbackFailureMessage("token_exchange_failed")).toBe(
      "Couldn't connect. Please try again. Reason: token_exchange_failed.",
    );
    expect(oauthCallbackFailureMessage(null)).toBe("Couldn't connect. Please try again.");
    expect(oauthCallbackFailureMessage("  ")).toBe("Couldn't connect. Please try again.");
  });
});

test("MCP duplicate failures give actionable guidance without raw codes", () => {
  for (const reason of [
    "account_mismatch",
    "account_already_connected",
    "account_identity_unavailable",
    "account_reconnect_required",
  ]) {
    const message = oauthCallbackFailureMessage(reason);
    expect(message).not.toContain(reason);
    expect(message.toLowerCase()).toContain("reconnect");
  }
  // A service that can't identify accounts allows one; the way out is disconnecting it.
  const single = oauthCallbackFailureMessage("account_limit_one");
  expect(single).not.toContain("account_limit_one");
  expect(single).toContain("Disconnect it to use a different one.");
});
