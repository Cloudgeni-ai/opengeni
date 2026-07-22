import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { createSignedState, stateMaxAgeSeconds } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { registerGitHubRoutes } from "../src/routes/github";

const stateSecret = "github-binding-disabled-test-secret";
const accountId = "00000000-0000-4000-8000-000000000101";
const otherAccountId = "00000000-0000-4000-8000-000000000104";
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

    const chooserState = createSignedState(stateSecret, { accountId, workspaceId });
    const chooser = await app.request(
      `http://test/v1/workspaces/${workspaceId}/github/installations`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `oauth_state=${encodeURIComponent(chooserState)}&installation_ticket=forged`,
      },
    );
    expect(chooser.status).toBe(410);
    expect(chooser.headers.get("set-cookie")).toBeNull();
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

  test("chooser authenticates signed account/workspace state before terminal 410", async () => {
    const counter = { calls: 0 };
    const app = appWithProviderCounter(counter);
    const validState = createSignedState(stateSecret, { accountId, workspaceId });
    const expiredState = createSignedState(
      stateSecret,
      { accountId, workspaceId },
      Math.floor(Date.now() / 1_000) - stateMaxAgeSeconds - 1,
    );
    const crossWorkspaceState = createSignedState(stateSecret, {
      accountId,
      workspaceId: otherWorkspaceId,
    });
    const crossAccountSubstitution = replaceAccountWithoutResigning(validState, otherAccountId);

    const cases = [
      { targetWorkspaceId: workspaceId, state: validState },
      { targetWorkspaceId: workspaceId, state: null },
      { targetWorkspaceId: workspaceId, state: crossAccountSubstitution },
      { targetWorkspaceId: workspaceId, state: expiredState },
      { targetWorkspaceId: workspaceId, state: crossWorkspaceState },
    ];
    const statuses: number[] = [];
    for (const testCase of cases) {
      const response = await app.request(
        `http://test/v1/workspaces/${testCase.targetWorkspaceId}/github/installations`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: testCase.state ? `oauth_state=${encodeURIComponent(testCase.state)}` : "",
        },
      );
      statuses.push(response.status);
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    expect(statuses).toEqual([410, 400, 400, 400, 400]);
    expect(
      (
        await app.request(`http://test/v1/workspaces/${workspaceId}/github/installations`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "oauth_state=malformed",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`http://test/v1/workspaces/${workspaceId}/github/installations`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `oauth_state=${encodeURIComponent(
            createSignedState(stateSecret, { workspaceId }),
          )}`,
        })
      ).status,
    ).toBe(400);
    expect(counter.calls).toBe(0);
  });

  test("keeps the browser-grant compatibility helper out of production imports", async () => {
    const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
    const productionImports: string[] = [];
    for await (const relativePath of new Bun.Glob("**/*.ts").scan({
      cwd: sourceRoot,
      onlyFiles: true,
    })) {
      if (relativePath === "github-browser-flow.ts") {
        continue;
      }
      const source = await Bun.file(`${sourceRoot}/${relativePath}`).text();
      if (source.includes("github-browser-flow")) {
        productionImports.push(relativePath);
      }
    }
    expect(productionImports).toEqual([]);
  });
});

function replaceAccountWithoutResigning(state: string, replacementAccountId: string): string {
  const [encoded, signature] = state.split(".", 2);
  if (!encoded || !signature) {
    throw new Error("expected signed state");
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const substituted = Buffer.from(
    JSON.stringify({ ...payload, accountId: replacementAccountId }),
  ).toString("base64url");
  return `${substituted}.${signature}`;
}
