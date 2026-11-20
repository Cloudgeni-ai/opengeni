import { describe, expect, test } from "bun:test";
import {
  KNOWN_OAUTH_PROVIDER_ERRORS,
  OAUTH_PROVIDER_ERROR_DESCRIPTION_MAX,
  oauthProviderError,
  oauthProviderRefusal,
} from "../src/connect";

describe("a provider's OAuth error", () => {
  test("keeps a valid code and a cleaned, bounded description", () => {
    expect(
      oauthProviderError({
        error: "invalid_redirect_uri",
        error_description: "Redirect URI 'https://app.example/cb'\r\n  is not allowed.\u0007",
      }),
    ).toEqual({
      error: "invalid_redirect_uri",
      description: "Redirect URI 'https://app.example/cb' is not allowed.",
    });
    const long = oauthProviderError({
      error: "server_error",
      error_description: "y".repeat(5_000),
    });
    expect(Array.from(long?.description ?? "")).toHaveLength(OAUTH_PROVIDER_ERROR_DESCRIPTION_MAX);
    expect(long?.description?.endsWith("…")).toBe(true);
    // Invisible format characters go; a cut never splits a character.
    expect(
      oauthProviderError({
        error: "invalid_request",
        error_description: "safe\u202Etxt.exe\u200B\uFEFF done",
      })?.description,
    ).toBe("safetxt.exe done");
    const emoji = oauthProviderError({
      error: "server_error",
      error_description: "😀".repeat(400),
    });
    expect(Array.from(emoji?.description ?? "")).toHaveLength(OAUTH_PROVIDER_ERROR_DESCRIPTION_MAX);
    // With the u flag this matches only a lone surrogate.
    expect(emoji?.description).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(oauthProviderError({ error: "invalid_scope", error_description: 42 })).toEqual({
      error: "invalid_scope",
    });
  });

  test("rejects anything that is not an OAuth error code", () => {
    for (const payload of [
      null,
      "invalid_request",
      [],
      {},
      { error: "" },
      { error: "has spaces" },
      { error: "<script>" },
      { error: "x".repeat(81) },
      { error: 400 },
    ])
      expect(oauthProviderError(payload)).toBeNull();
  });

  test("maps the common refusals to their plain meaning", () => {
    expect(oauthProviderRefusal("invalid_redirect_uri")).toBe("app_not_allowed");
    expect(oauthProviderRefusal("unauthorized_client")).toBe("app_not_allowed");
    expect(oauthProviderRefusal("invalid_scope")).toBe("access_not_accepted");
    expect(oauthProviderRefusal("temporarily_unavailable")).toBe("provider_unavailable");
    expect(oauthProviderRefusal("invalid_client_metadata")).toBeNull();
    expect(oauthProviderRefusal("constructor")).toBeNull();
    expect(oauthProviderRefusal(undefined)).toBeNull();
    expect(KNOWN_OAUTH_PROVIDER_ERRORS.has("access_denied")).toBe(false);
  });
});
