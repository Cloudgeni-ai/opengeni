import { describe, expect, test } from "bun:test";
import {
  ATLASSIAN_NATIVE_RETIRED_MESSAGE,
  ATLASSIAN_NATIVE_RETIRED_REASON,
} from "@opengeni/contracts/atlassian-native-retirement";

import { atlassianFailureMessage } from "@/components/capabilities/use-atlassian-integration";
import { googleDriveFailureMessage } from "@/components/capabilities/use-google-drive-integration";
import {
  oauthCallbackFailureMessage,
  oauthCallbackReasonMessage,
} from "@/lib/oauth-callback-messages";

describe("provider OAuth callback failure copy", () => {
  for (const [provider, message] of [
    ["Google Drive", googleDriveFailureMessage],
    ["Atlassian", atlassianFailureMessage],
  ] as const) {
    test(`${provider} explains expired, reused, and invalid links instead of blaming configuration`, () => {
      for (const reason of ["state_expired", "state_invalid", "state_replayed", "missing_code"]) {
        expect(message(reason)).toBe(oauthCallbackReasonMessage(reason)!);
        expect(message(reason)).not.toContain("configuration");
      }
      expect(message("state_expired")).toContain("expired");
    });

    test(`${provider} keeps its own copy for provider-specific reasons`, () => {
      expect(message("provider_denied")).toContain("not approved");
      expect(message("account_mismatch")).toContain("same");
      if (provider === "Atlassian") {
        // Native sync is retired; unknown failures cannot suggest configuring
        // an unavailable integration. Known callback reasons remain specific.
        for (const reason of ["http_503", null, ATLASSIAN_NATIVE_RETIRED_REASON]) {
          expect(message(reason)).toBe(ATLASSIAN_NATIVE_RETIRED_MESSAGE);
        }
      } else {
        expect(message("http_503")).toContain("configuration");
      }
    });
  }
});

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
