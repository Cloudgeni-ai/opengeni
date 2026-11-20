import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import { setupRefusalText, signInRefusalText } from "../src/connect-provider-refusal";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();

function setupFailure(details: Record<string, unknown>): OpenGeniApiError {
  return new OpenGeniApiError(
    422,
    JSON.stringify({
      error: { code: "validation_failed", message: "refused", retryable: false, details },
    }),
  );
}

describe("a service's refusal in plain words", () => {
  test("an app allow-list asks the provider to allow the product", () => {
    expect(
      setupRefusalText(
        t,
        setupFailure({
          oauthStage: "client_registration",
          providerRefusal: "app_not_allowed",
          providerError: "invalid_redirect_uri",
          providerErrorDescription: "Redirect URI 'https://app.example/cb' is not allowed.",
        }),
      ),
    ).toBe(
      "This service only accepts sign-ins from apps it has approved. Ask the provider to allow Opengeni.",
    );
    const embedded = createOpenGeniText({ productName: "Northstar" });
    expect(
      setupRefusalText(embedded, setupFailure({ providerError: "invalid_redirect_uri" })),
    ).toContain("allow Northstar.");
  });

  test("a service that admits only registered apps says so", () => {
    expect(
      setupRefusalText(
        t,
        setupFailure({
          providerRefusal: "app_registration_required",
          providerError: "access_denied",
        }),
      ),
    ).toBe(
      "This service doesn't let apps register themselves. Opengeni must be registered with it first.",
    );
  });

  test("an unfamiliar refusal shows the service's own reason", () => {
    expect(
      setupRefusalText(
        t,
        setupFailure({
          providerError: "invalid_client_metadata",
          providerErrorDescription: "Bad\nlogo_uri",
        }),
      ),
    ).toBe("Connection setup could not finish. The service said: Bad logo_uri");
    expect(setupRefusalText(t, setupFailure({ providerError: "invalid_client_metadata" }))).toBe(
      "Connection setup could not finish. The service said: invalid_client_metadata",
    );
  });

  test("other failures keep the card's own line", () => {
    expect(setupRefusalText(t, setupFailure({ oauthStage: "client_registration" }))).toBeNull();
    expect(setupRefusalText(t, setupFailure({ providerRefusal: "made_up" }))).toBeNull();
    expect(setupRefusalText(t, new Error("network down"))).toBeNull();
    expect(setupRefusalText(t, new OpenGeniApiError(500, "boom"))).toBeNull();
  });

  test("a refused sign-in uses the attempt's error code", () => {
    expect(
      signInRefusalText(t, { error: { code: "invalid_scope", message: "", retryable: false } }),
    ).toBe("This service didn't accept the access Opengeni asked for.");
    expect(
      signInRefusalText(t, {
        error: { code: "temporarily_unavailable", message: "", retryable: false },
      }),
    ).toBe("This service couldn't finish the sign-in. Try again later.");
    expect(
      signInRefusalText(t, { error: { code: "provider_denied", message: "", retryable: false } }),
    ).toBeNull();
    expect(
      signInRefusalText(t, { error: { code: "constructor", message: "", retryable: false } }),
    ).toBeNull();
    expect(signInRefusalText(t, null)).toBeNull();
  });
});
