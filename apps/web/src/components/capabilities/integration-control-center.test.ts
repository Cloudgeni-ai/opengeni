import { describe, expect, test } from "bun:test";

import {
  apiIntegrationOAuthReturnPath,
  pendingApiIntegrationOAuth,
} from "./integration-control-center";

describe("API integration OAuth continuation", () => {
  test("preserves unrelated route state while replacing stale callback parameters", () => {
    const returnPath = apiIntegrationOAuthReturnPath(
      "/workspaces/workspace-a/capabilities",
      "?filter=api&integration_oauth=error&connectionId=stale&reason=denied&api_integration_expected=2",
      {
        presetId: "google-gmail",
        instanceKey: "account-finance",
        displayName: "Gmail — Finance",
        ownership: "workspace",
        expectedInstanceVersion: 7,
      },
    );
    const url = new URL(returnPath, "https://opengeni.test");

    expect(url.pathname).toBe("/workspaces/workspace-a/capabilities");
    expect(url.searchParams.get("filter")).toBe("api");
    expect(url.searchParams.get("api_integration_preset")).toBe("google-gmail");
    expect(url.searchParams.get("api_integration_instance")).toBe("account-finance");
    expect(url.searchParams.get("api_integration_name")).toBe("Gmail — Finance");
    expect(url.searchParams.get("api_integration_ownership")).toBe("workspace");
    expect(url.searchParams.get("api_integration_expected")).toBe("7");
    expect(url.searchParams.has("integration_oauth")).toBe(false);
    expect(url.searchParams.has("connectionId")).toBe(false);
    expect(url.searchParams.has("reason")).toBe(false);
  });

  test("parses a complete successful callback for one exact named instance", () => {
    const pending = pendingApiIntegrationOAuth(
      "?integration_oauth=success&connectionId=connection-a&providerDomain=google.com" +
        "&api_integration_preset=google-gmail&api_integration_instance=account-finance" +
        "&api_integration_name=Gmail+%E2%80%94+Finance&api_integration_ownership=personal" +
        "&api_integration_expected=3",
    );

    expect(pending).toEqual({
      outcome: "success",
      presetId: "google-gmail",
      instanceKey: "account-finance",
      displayName: "Gmail — Finance",
      ownership: "personal",
      connectionId: "connection-a",
      reason: null,
      expectedInstanceVersion: 3,
    });
  });

  test("rejects incomplete ownership state and ignores malformed optimistic versions", () => {
    expect(
      pendingApiIntegrationOAuth(
        "?integration_oauth=success&api_integration_preset=google-gmail" +
          "&api_integration_instance=account-a&api_integration_name=Primary" +
          "&api_integration_ownership=organization",
      ),
    ).toBeNull();

    expect(
      pendingApiIntegrationOAuth(
        "?integration_oauth=error&reason=cancelled&api_integration_preset=google-gmail" +
          "&api_integration_instance=account-a&api_integration_name=Primary" +
          "&api_integration_ownership=personal&api_integration_expected=3.5",
      ),
    ).toEqual({
      outcome: "error",
      presetId: "google-gmail",
      instanceKey: "account-a",
      displayName: "Primary",
      ownership: "personal",
      connectionId: null,
      reason: "cancelled",
    });
  });
});
