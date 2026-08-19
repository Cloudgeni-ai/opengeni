import { describe, expect, test } from "bun:test";

import {
  apiIntegrationOAuthReturnPath,
  pendingApiIntegrationOAuth,
} from "./use-api-integration-accounts";

describe("apiIntegrationOAuthReturnPath", () => {
  test("preserves unrelated route state while replacing every stale callback param", () => {
    const path = apiIntegrationOAuthReturnPath(
      "/workspaces/w1/capabilities",
      "?tab=connectors&integration_oauth=success&api_integration_definition=old&api_integration_instance=old-key&api_integration_name=Old&api_integration_ownership=personal&api_integration_expected=9&connectionId=stale&reason=stale",
      {
        definitionId: "microsoft-outlook-mail",
        instanceKey: "account-new",
        displayName: "Outlook Mail",
        ownership: "workspace",
      },
    );
    const url = new URL(path, "https://app.example.test");
    expect(url.pathname).toBe("/workspaces/w1/capabilities");
    expect(url.searchParams.get("tab")).toBe("connectors");
    expect(url.searchParams.get("api_integration_definition")).toBe("microsoft-outlook-mail");
    expect(url.searchParams.get("api_integration_instance")).toBe("account-new");
    expect(url.searchParams.get("api_integration_name")).toBe("Outlook Mail");
    expect(url.searchParams.get("api_integration_ownership")).toBe("workspace");
    // An interrupted earlier attempt must not leave anything behind that a
    // later callback could be read against.
    expect(url.searchParams.get("api_integration_expected")).toBeNull();
    expect(url.searchParams.get("integration_oauth")).toBeNull();
    expect(url.searchParams.get("connectionId")).toBeNull();
    expect(url.searchParams.get("reason")).toBeNull();
  });

  test("carries the optimistic instance version only when reconnecting an exact instance", () => {
    const withVersion = new URL(
      apiIntegrationOAuthReturnPath("/capabilities", "", {
        definitionId: "google-drive",
        instanceKey: "account-1",
        displayName: "Google Drive",
        ownership: "workspace",
        expectedInstanceVersion: 4,
      }),
      "https://app.example.test",
    );
    expect(withVersion.searchParams.get("api_integration_expected")).toBe("4");

    const withoutQuery = apiIntegrationOAuthReturnPath("/capabilities", "", {
      definitionId: "google-drive",
      instanceKey: "account-1",
      displayName: "Google Drive",
      ownership: "personal",
    });
    expect(withoutQuery.startsWith("/capabilities?")).toBe(true);
  });
});

describe("pendingApiIntegrationOAuth", () => {
  test("parses one complete callback", () => {
    expect(
      pendingApiIntegrationOAuth(
        "?integration_oauth=success&api_integration_definition=google-drive&api_integration_instance=account-1&api_integration_name=Drive%20Finance&api_integration_ownership=personal&api_integration_expected=3&connectionId=conn-1",
      ),
    ).toEqual({
      outcome: "success",
      definitionId: "google-drive",
      instanceKey: "account-1",
      displayName: "Drive Finance",
      ownership: "personal",
      connectionId: "conn-1",
      reason: null,
      expectedInstanceVersion: 3,
    });
  });

  test("keeps a failure outcome with its reason and no connection", () => {
    expect(
      pendingApiIntegrationOAuth(
        "?integration_oauth=error&api_integration_definition=google-drive&api_integration_instance=account-1&api_integration_name=Drive&api_integration_ownership=workspace&reason=provider_denied",
      ),
    ).toMatchObject({ outcome: "error", connectionId: null, reason: "provider_denied" });
  });

  test("rejects an incomplete or unknown ownership rather than defaulting one", () => {
    const complete =
      "integration_oauth=success&api_integration_definition=google-drive&api_integration_instance=account-1&api_integration_name=Drive&api_integration_ownership=workspace";
    expect(pendingApiIntegrationOAuth(`?${complete}`)).not.toBeNull();
    for (const missing of [
      "integration_oauth",
      "api_integration_definition",
      "api_integration_instance",
      "api_integration_name",
      "api_integration_ownership",
    ]) {
      const search = complete
        .split("&")
        .filter((pair) => !pair.startsWith(`${missing}=`))
        .join("&");
      expect(pendingApiIntegrationOAuth(`?${search}`)).toBeNull();
    }
    // A URL-supplied ownership is never coerced: only the two known values pass.
    expect(
      pendingApiIntegrationOAuth(
        complete.replace("api_integration_ownership=workspace", "api_integration_ownership=admin"),
      ),
    ).toBeNull();
    expect(pendingApiIntegrationOAuth("")).toBeNull();
  });

  test("drops a malformed optimistic instance version instead of sending it", () => {
    const base =
      "?integration_oauth=success&api_integration_definition=google-drive&api_integration_instance=account-1&api_integration_name=Drive&api_integration_ownership=workspace";
    for (const raw of ["0", "-2", "1.5", "abc", ""]) {
      expect(
        pendingApiIntegrationOAuth(`${base}&api_integration_expected=${raw}`),
      ).not.toHaveProperty("expectedInstanceVersion");
    }
    expect(pendingApiIntegrationOAuth(`${base}&api_integration_expected=7`)).toMatchObject({
      expectedInstanceVersion: 7,
    });
  });
});
