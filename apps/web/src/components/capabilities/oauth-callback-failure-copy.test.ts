import { describe, expect, test } from "bun:test";

import { atlassianFailureMessage } from "@/components/capabilities/use-atlassian-integration";
import { googleDriveFailureMessage } from "@/components/capabilities/use-google-drive-integration";
import { oauthCallbackReasonMessage } from "@/lib/oauth-callback-messages";

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
      // Only a genuinely unknown failure points at configuration.
      expect(message("http_503")).toContain("configuration");
    });
  }
});
