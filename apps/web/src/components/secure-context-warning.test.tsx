import { describe, expect, test } from "bun:test";

import {
  browserSecureContextIssue,
  shouldShowSecureContextWarning,
} from "./secure-context-warning";

const secureEnvironment = {
  window: { isSecureContext: true },
  crypto: { subtle: { digest: () => undefined } },
};

describe("secure context warning", () => {
  test("warns self-hosted deployments opened in an insecure browser context", () => {
    const environment = {
      ...secureEnvironment,
      window: { isSecureContext: false },
    };

    expect(browserSecureContextIssue(environment)).toBe("insecure_context");
    expect(shouldShowSecureContextWarning("local", environment)).toBe(true);
    expect(shouldShowSecureContextWarning("configured", environment)).toBe(true);
  });

  test("warns when Web Crypto is unavailable even if the browser reports a secure context", () => {
    const environment = {
      window: { isSecureContext: true },
      crypto: {},
    };

    expect(browserSecureContextIssue(environment)).toBe("web_crypto_unavailable");
    expect(shouldShowSecureContextWarning("local", environment)).toBe(true);
  });

  test("does not warn secure, non-browser, or managed surfaces", () => {
    expect(shouldShowSecureContextWarning("local", secureEnvironment)).toBe(false);
    expect(shouldShowSecureContextWarning("local", {})).toBe(false);
    expect(
      shouldShowSecureContextWarning("managed", {
        ...secureEnvironment,
        window: { isSecureContext: false },
      }),
    ).toBe(false);
  });
});
