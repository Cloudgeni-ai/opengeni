import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import { completeFikenOAuthCallback } from "../src/integrations/fiken";
import { completeMcpOAuthCallback } from "../src/integrations/oauth-client";
import { completePersonalGitHubOAuthCallback } from "../src/integrations/personal-github";
import { completeApiIntegrationProviderOAuth } from "../src/integrations/provider-oauth";
import { completeSocialOAuthCallback } from "../src/integrations/social-oauth";

// A provider that refuses authorization may redirect with `error` and no
// `state`. Fiken production did exactly this ("user is not in the list of
// approved users or owner of app"), and every callback reported it as "This
// connection link is no longer valid or was already used". Unreadable state
// is rejected before any database read, so these run without PostgreSQL.
const settings = testSettings({
  integrationsStateSecret: "stateless-provider-error-secret",
  publicBaseUrl: "https://api.example.test",
  webBaseUrl: "https://app.example.test",
}) as Settings;
const deps = { db: {} as never, settings } as unknown as ApiRouteDeps;
const refusal = {
  error: "error",
  errorDescription: "Avviser API tilgang fordi bruker ikke er godkjent",
  requestUrl: "https://api.example.test/v1/integrations/x/callback?error=error",
};

function reasonOf(redirectTo: string): string | null {
  return new URL(redirectTo, "https://app.example.test").searchParams.get("reason");
}

describe("a provider refusal that arrives without state", () => {
  test("Fiken reports the provider error", async () => {
    const result = await completeFikenOAuthCallback(deps, refusal);
    expect(reasonOf(result.redirectTo)).toBe("provider_error");
  });

  test("curated provider OAuth reports the provider error", async () => {
    const result = await completeApiIntegrationProviderOAuth(deps, refusal);
    expect(reasonOf(result.redirectTo)).toBe("provider_error");
  });

  test("MCP OAuth reports the provider error", async () => {
    const result = await completeMcpOAuthCallback({ db: {} as never, settings }, refusal);
    expect(reasonOf(result.redirectTo)).toBe("provider_error");
  });

  test("social OAuth reports the provider error", async () => {
    const result = await completeSocialOAuthCallback({ db: {} as never, settings }, refusal);
    expect(reasonOf(result.redirectTo)).toBe("provider_error");
  });

  test("personal GitHub reports the provider error", async () => {
    const result = await completePersonalGitHubOAuthCallback(deps, refusal);
    expect(reasonOf(result.redirectTo)).toBe("provider_error");
  });

  test("a cancel without state is reported as cancelled", async () => {
    const result = await completeFikenOAuthCallback(deps, { ...refusal, error: "access_denied" });
    expect(reasonOf(result.redirectTo)).toBe("provider_denied");
  });

  test("a callback with neither state nor error is still a stale link", async () => {
    const result = await completeFikenOAuthCallback(deps, { requestUrl: refusal.requestUrl });
    expect(reasonOf(result.redirectTo)).toBe("state_invalid");
  });
});
