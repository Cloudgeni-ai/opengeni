import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createSignedState, stateMaxAgeSeconds } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { registerGitHubRoutes } from "../src/routes/github";

const stateSecret = "github-binding-disabled-test-secret";
const accountId = "00000000-0000-4000-8000-000000000101";
const workspaceId = "00000000-0000-4000-8000-000000000102";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000103";

function appWithProviderCounter(counter: { calls: number }): Hono {
  const app = new Hono();
  registerGitHubRoutes(app, {
    settings: testSettings(),
    githubStateSecret: stateSecret,
    githubAppApi: {
      authorizeUser: async () => {
        counter.calls += 1;
        return [];
      },
      verifyInstallationAccessForUser: async () => {
        counter.calls += 1;
        throw new Error("provider authority must not be consulted");
      },
      getInstallation: async () => {
        counter.calls += 1;
        throw new Error("provider installation must not be consulted");
      },
    },
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be consulted");
        },
      },
    ),
  } as unknown as ApiRouteDeps);
  return app;
}

describe("disabled GitHub installation binding routes", () => {
  test("valid current and legacy states terminate before cookies, provider calls, or writes", async () => {
    const counter = { calls: 0 };
    const app = appWithProviderCounter(counter);
    const states = [
      createSignedState(stateSecret, { accountId, workspaceId, intent: "install" }),
      createSignedState(stateSecret, { accountId, workspaceId, intent: "link_existing" }),
      createSignedState(stateSecret, {
        accountId,
        workspaceId,
        intent: "link_installation",
        installationId: 123,
      }),
      createSignedState(stateSecret, { accountId, workspaceId }),
    ];

    for (const state of states) {
      for (const request of [
        new Request(
          `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(state)}`,
        ),
        new Request(
          `http://test/v1/github/setup?installation_id=123&setup_action=request&state=${encodeURIComponent(state)}`,
        ),
        new Request(
          `http://test/v1/github/install/callback?installation_id=999&setup_action=install&state=${encodeURIComponent(state)}`,
        ),
        new Request(
          `http://test/v1/github/oauth/callback?code=untrusted&installation_id=999&state=${encodeURIComponent(state)}`,
        ),
      ]) {
        const response = await app.request(request);
        expect(response.status).toBe(410);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.text()).toContain("Connecting a GitHub App installation is disabled");
      }
    }

    const chooser = await app.request(
      `http://test/v1/workspaces/${workspaceId}/github/installations`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "oauth_state=stale&installation_ticket=forged",
      },
    );
    expect(chooser.status).toBe(410);
    expect(counter.calls).toBe(0);
  });

  test("missing, tampered, expired, and cross-workspace state remains invalid", async () => {
    const counter = { calls: 0 };
    const app = appWithProviderCounter(counter);
    const validState = createSignedState(stateSecret, { accountId, workspaceId });
    const expiredState = createSignedState(
      stateSecret,
      { accountId, workspaceId },
      Math.floor(Date.now() / 1_000) - stateMaxAgeSeconds - 1,
    );

    for (const url of [
      `http://test/v1/workspaces/${workspaceId}/github/connect`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=tampered`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(expiredState)}`,
      `http://test/v1/workspaces/${otherWorkspaceId}/github/connect?state=${encodeURIComponent(validState)}`,
      "http://test/v1/github/setup?installation_id=123",
      "http://test/v1/github/oauth/callback?state=tampered",
    ]) {
      expect((await app.request(url)).status).toBe(400);
    }
    expect(counter.calls).toBe(0);
  });
});
