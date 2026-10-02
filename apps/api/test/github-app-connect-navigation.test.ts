import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { readSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { githubAppConnectNavigation } from "../src/integrations/github-app-connect";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const stateSecret = "test-navigation-state";
const deps = {
  githubStateSecret: stateSecret,
  settings: testSettings({
    publicBaseUrl: "https://console.example.test",
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    githubAppManifestStateSecret: "test-manifest-state",
    githubAppId: "12345",
    githubClientId: "test-client",
    githubClientSecret: "test-client-secret",
    githubAppSlug: "test-app",
    githubAppPrivateKey: "test-private-key",
    prReviewGithubAppId: "54321",
    prReviewGithubClientId: "test-lens-client",
    prReviewGithubClientSecret: "test-lens-client-secret",
    prReviewGithubAppSlug: "test-lens-app",
    prReviewGithubAppPrivateKey: "test-lens-private-key",
    prReviewGithubWebhookSecret: "test-lens-webhook-secret",
  }),
} as ApiRouteDeps;

describe("GitHub Connect browser handoff navigation", () => {
  for (const providerId of ["github-app", "github-lens"] as const) {
    for (const phase of ["discover", "bind"] as const)
      test(`${providerId} ${phase} visits the native browser before provider consent`, () => {
        const result = githubAppConnectNavigation(
          deps,
          {
            accountId: organizationId,
            workspaceId,
            subjectId: "user:person",
            personalOwnerVerified: true,
          },
          attemptId,
          "https://api.example.test/start",
          phase,
          phase === "bind" ? 123 : undefined,
          providerId,
        );
        const url = new URL(result.authorizationUrl);
        expect(url.origin).toBe("https://console.example.test");
        expect(url.pathname).toBe(
          `/v1/workspaces/${workspaceId}/${providerId === "github-lens" ? "pr-review/github" : "github"}/connect`,
        );
        const state = readSignedState(url.searchParams.get("state")!, stateSecret)!;
        expect(state.subjectId).toBe("user:person");
        expect(state.accountId).toBe(organizationId);
        expect(state.workspaceId).toBe(workspaceId);
        expect(state.connectAttemptId).toBe(attemptId);
        expect(state.phase).toBe(phase);
        expect(state.providerId).toBe(providerId);
        expect(state.canonicalManagedHumanSession).toBeUndefined();
      });

    test(`${providerId} external installation continuation preserves its stored-origin path`, () => {
      const result = githubAppConnectNavigation(
        deps,
        {
          accountId: organizationId,
          workspaceId,
          subjectId: "external_user:person",
          personalOwnerVerified: true,
        },
        attemptId,
        "https://api.example.test/start",
        "bind",
        123,
        providerId,
      );
      const url = new URL(result.authorizationUrl);
      expect(url.origin).toBe("https://github.com");
      expect(url.pathname).toBe("/login/oauth/authorize");
      expect(new URL(url.searchParams.get("redirect_uri")!).pathname).toBe(
        `${providerId === "github-lens" ? "/v1/pr-review/github" : "/v1/github"}/oauth/callback`,
      );
      expect(readSignedState(url.searchParams.get("state")!, stateSecret)?.subjectId).toBe(
        "external_user:person",
      );
    });

    test(`${providerId} installation still opens GitHub installation, not a code callback`, () => {
      const result = githubAppConnectNavigation(
        deps,
        { accountId: organizationId, workspaceId, subjectId: "user:person" },
        attemptId,
        "https://api.example.test/start",
        "install",
        undefined,
        providerId,
      );
      const url = new URL(result.authorizationUrl);
      expect(url.origin).toBe("https://github.com");
      expect(url.pathname).toEndWith("/installations/new");
      expect(readSignedState(url.searchParams.get("state")!, stateSecret)?.phase).toBe("install");
    });
  }
});
