import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessContext, type Permission } from "@opengeni/contracts";
import {
  hasVerifiedOwningUserAuthorization,
  requireAccessGrantAuthorization,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import * as policy from "@opengeni/db/organization-integration-policy";
import { createSignedState, githubOAuthAuthorizeUrl, readSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as managedSession from "../../../packages/core/src/managed-session";
import * as githubAccess from "../src/github-access";
import * as appConnect from "../src/integrations/github-app-connect";
import { registerGitHubRoutes } from "../src/routes/github";
import { registerPrReviewGitHubRoutes } from "../src/routes/pr-review-github";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const keyId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:native-owner";
const stateSecret = "github-continuation-state-fixture";
const delegationSecret = "github-continuation-bearer-fixture";
const permissions: Permission[] = [
  "account:admin",
  "workspace:read",
  "workspace:admin",
  "github:use",
  "github:manage",
  "secrets:write",
];
type Actor = "native" | "local" | "delegated" | "service" | "legacy-human" | "legacy-service";
const providers = [
  {
    id: "github-app",
    path: "/v1/github",
    cookie: "opengeni_github_state",
    install: "installation_authority_install",
    discovery: "installation_authority_discovery",
    oauth: "installation_authority_oauth",
  },
  {
    id: "github-lens",
    path: "/v1/pr-review/github",
    cookie: "opengeni_pr_review_github_state",
    install: "pr_review_github_install",
    discovery: "pr_review_github_discovery",
    oauth: "pr_review_github_oauth",
  },
] as const;
type Provider = (typeof providers)[number];

const restores: Array<() => void> = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
let live: AccessContext;
let providerCalls: number;
let keyPermissions: Permission[];
let keyAvailable: boolean;

beforeEach(() => {
  providerCalls = 0;
  keyAvailable = true;
  keyPermissions = [...permissions];
  live = {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId, subjectId, role: "owner", permissions: [...permissions] }],
    workspaceGrants: [
      {
        accountId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: [...permissions],
      },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  track(
    spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: "native-owner", name: "Native owner", email: "native@example.test" },
    ]),
  );
  track(
    spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () => structuredClone(live)),
  );
  track(
    spyOn(db, "bootstrapWorkspace").mockImplementation(async () => ({
      ...structuredClone(live),
      mode: "local",
      subjectId: "dev",
      accountGrants: live.accountGrants.map((grant) => ({ ...grant, subjectId: "dev" })),
      workspaceGrants: live.workspaceGrants.map((grant) => ({ ...grant, subjectId: "dev" })),
    })),
  );
  track(spyOn(db, "getWorkspaceGrant").mockResolvedValue(null));
  track(
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId,
      kind: "shared",
    } as never),
  );
  track(
    spyOn(db, "findActiveApiKeyByHash").mockImplementation(async () =>
      keyAvailable
        ? ({
            id: keyId,
            accountId,
            workspaceId: null,
            credentialKind: "organization",
            permissions: keyPermissions,
          } as never)
        : null,
    ),
  );
  track(
    spyOn(managedSession, "getManagedSession").mockImplementation(async (context) =>
      context.req.header("cookie")?.split("; ").includes("native-cookie=fixture")
        ? ({
            session: { id: "fixture-session" },
            user: {
              id: "native-owner",
              name: "Native owner",
              email: "native@example.test",
              emailVerified: true,
            },
          } as never)
        : null,
    ),
  );
  track(
    spyOn(policy, "withOrganizationIntegrationAcquisition").mockImplementation(
      async (database, _scope, _keys, use) => use(database),
    ),
  );
  track(spyOn(githubAccess, "listWorkspaceGitHubInstallationBindings").mockResolvedValue([]));
  track(spyOn(db, "listPrReviewAppRegistrations").mockResolvedValue([]));
  track(spyOn(db, "listPrReviewRepositoryBindings").mockResolvedValue([]));
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

function services(actor: Actor): ApiRouteDeps {
  const provider = {
    discoverInstallationBindingCandidates: async () => {
      providerCalls++;
      return [];
    },
    authorizeInstallationBinding: async () => {
      providerCalls++;
      return null;
    },
  };
  return {
    db: {} as db.Database,
    managedAuth: {},
    githubStateSecret: stateSecret,
    settings: testSettings({
      productAccessMode: actor === "local" ? "local" : "managed",
      publicBaseUrl: "https://console.example.test",
      sandboxBackend: "none",
      delegationSecret,
      environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
      githubAppId: "12345",
      githubClientId: "fixture-client",
      githubClientSecret: "fixture-secret",
      githubAppSlug: "fixture-app",
      githubAppPrivateKey: "fixture-key",
      prReviewGithubAppId: "54321",
      prReviewGithubClientId: "fixture-lens-client",
      prReviewGithubClientSecret: "fixture-lens-secret",
      prReviewGithubAppSlug: "fixture-lens",
      prReviewGithubAppPrivateKey: "fixture-lens-key",
      prReviewGithubWebhookSecret: "fixture-webhook",
    }),
    githubAppApi: provider,
    prReviewGithubAppApi: provider,
  } as unknown as ApiRouteDeps;
}

function harness(actor: Actor, stripBearer = false): Hono {
  const app = new Hono();
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  const deps = services(actor);
  if (stripBearer) {
    app.use("*", async (context, next) => {
      await requireAccessGrantAuthorization(context, deps, workspaceId);
      context.req.raw.headers.delete("authorization");
      context.req.raw.headers.set(
        "cookie",
        `${context.req.header("cookie")}; native-cookie=fixture`,
      );
      await next();
    });
  }
  registerGitHubRoutes(app, deps);
  registerPrReviewGitHubRoutes(app, deps);
  return app;
}

function actorSubject(actor: Actor): string {
  return actor === "service" ? `api_key:${keyId}` : actor === "local" ? "dev" : subjectId;
}

function state(provider: Provider, actor: Actor, patch: Record<string, unknown> = {}): string {
  return createSignedState(stateSecret, {
    accountId,
    workspaceId,
    intent: provider.install,
    initiatingSubjectId: actorSubject(actor),
    initiatingExpiresAt: Math.floor(Date.now() / 1_000) + 500,
    expectedInstallationId: 42,
    ...patch,
  });
}

async function request(
  actor: Actor,
  path: string,
  cookie?: string,
  proofPatch?: Partial<DelegatedHumanAuthorization>,
): Promise<Request> {
  const headers = new Headers();
  const cookies = cookie ? [cookie] : [];
  if (actor === "native") cookies.push("native-cookie=fixture");
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (actor === "service") headers.set("authorization", "Bearer fixture-organization-key");
  if (actor === "legacy-human" || actor === "legacy-service") {
    headers.set(
      "authorization",
      `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId,
        workspaceId,
        subjectId,
        permissions,
        principalKind: actor === "legacy-human" ? "human_session" : "service",
        exp: Math.floor(Date.now() / 1_000) + 3600,
      })}`,
    );
  }
  const raw = new Request(`https://console.example.test${path}`, { headers });
  if (actor === "delegated")
    stampDelegatedHumanAuthorization(raw, {
      organizationId: accountId,
      subjectId,
      permissions,
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      ...proofPatch,
    });
  return raw;
}

function setupPath(provider: Provider, raw: string, alias = "setup", action = "install"): string {
  return `${provider.path}/${alias}?${new URLSearchParams({ state: raw, setup_action: action, installation_id: "42" })}`;
}
function oauthPath(provider: Provider, raw: string): string {
  return `${provider.path}/oauth/callback?${new URLSearchParams({ state: raw, code: "fixture-code" })}`;
}

for (const provider of providers) {
  describe(`${provider.id} verified setup continuation`, () => {
    test.each(["native", "delegated", "service"] as const)(
      "%s initiation issues bound state and preserves its original expiry",
      async (actor) => {
        const app = harness(actor);
        const statusPath =
          provider.id === "github-app"
            ? `/v1/workspaces/${workspaceId}/github/app`
            : `/v1/workspaces/${workspaceId}/pr-review/github`;
        const status = await app.fetch(await request(actor, statusPath));
        expect(status.status).toBe(200);
        const response = await status.json();
        const startUrl = provider.id === "github-app" ? response.installUrl : response.connectUrl;
        const initialState = new URL(startUrl).searchParams.get("state")!;
        const initial = readSignedState(initialState, stateSecret)!;
        expect(initial.initiatingSubjectId).toBe(actorSubject(actor));
        expect(initial.initiatingExpiresAt).toBeGreaterThanOrEqual(initial.iat + 599);
        expect(initial.initiatingExpiresAt).toBeLessThanOrEqual(initial.iat + 600);
        const started = await app.fetch(
          await request(actor, new URL(startUrl).pathname + new URL(startUrl).search),
        );
        expect(started.status).toBe(302);
        const discoveryState = new URL(started.headers.get("location")!).searchParams.get("state")!;
        expect(readSignedState(discoveryState, stateSecret)).toMatchObject({
          initiatingSubjectId: actorSubject(actor),
          initiatingExpiresAt: initial.initiatingExpiresAt,
          intent: provider.discovery,
        });
        expect(providerCalls).toBe(0);
      },
    );
    test.each(["native", "local", "delegated", "service"] as const)(
      "%s may advance setup only toward consent",
      async (actor) => {
        const bind = track(spyOn(db, "bindAuthorizedGitHubInstallationRepositories"));
        const sync = track(spyOn(db, "syncManagedGitHubPrReviewInstallation"));
        for (const alias of ["setup", "install/callback"]) {
          const rawState = state(provider, actor);
          const raw = await request(
            actor,
            setupPath(provider, rawState, alias),
            actor === "native" || actor === "local" ? `${provider.cookie}=${rawState}` : undefined,
          );
          if (actor === "delegated") expect(raw.headers.has("cookie")).toBe(false);
          const response = await harness(actor).fetch(raw);
          expect(response.status, await response.clone().text()).toBe(302);
          expect(response.headers.has("set-cookie")).toBe(actor === "native" || actor === "local");
          const nextState = new URL(response.headers.get("location")!).searchParams.get("state")!;
          expect(readSignedState(nextState, stateSecret)).toMatchObject({
            accountId,
            workspaceId,
            installationId: 42,
            intent: provider.oauth,
            initiatingSubjectId: actorSubject(actor),
            initiatingExpiresAt: readSignedState(rawState, stateSecret)!.initiatingExpiresAt,
          });
        }
        expect(providerCalls).toBe(0);
        expect(bind).not.toHaveBeenCalled();
        expect(sync).not.toHaveBeenCalled();
      },
    );

    test.each(["delegated", "service"] as const)(
      "%s cannot substitute initiator, organization, workspace, or expiry",
      async (actor) => {
        for (const patch of [
          { initiatingSubjectId: "user:another-person" },
          { accountId: otherId },
          { workspaceId: otherId },
          { initiatingSubjectId: undefined, initiatingExpiresAt: undefined },
          { initiatingExpiresAt: Math.floor(Date.now() / 1_000) - 1 },
          { initiatingExpiresAt: Math.floor(Date.now() / 1_000) + 10_000 },
        ]) {
          const rawState = state(provider, actor, patch);
          const response = await harness(actor).fetch(
            await request(
              actor,
              setupPath(provider, rawState),
              `${provider.cookie}=${rawState}; native-cookie=fixture`,
            ),
          );
          expect(response.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400);
        }
        expect(providerCalls).toBe(0);
      },
    );

    test.each(["legacy-human", "legacy-service"] as const)(
      "signed %s shape is not verified setup authority",
      async (actor) => {
        const rawState = state(provider, actor);
        const response = await harness(actor).fetch(
          await request(actor, setupPath(provider, rawState), `${provider.cookie}=${rawState}`),
        );
        expect(response.status).toBe(403);
        expect(providerCalls).toBe(0);
      },
    );

    test("typed scope and fresh live permissions cannot be widened by signed state", async () => {
      const rawState = state(provider, "delegated");
      for (const proofPatch of [
        { workspaceScope: { kind: "selected" as const, workspaceIds: [otherId] } },
        { organizationId: otherId },
        { permissions: ["workspace:read"] as Permission[] },
      ]) {
        expect(
          (
            await harness("delegated").fetch(
              await request("delegated", setupPath(provider, rawState), undefined, proofPatch),
            )
          ).status,
        ).toBeGreaterThanOrEqual(400);
      }
      live.workspaceGrants[0]!.permissions = ["workspace:read"];
      expect(
        (
          await harness("delegated").fetch(
            await request("delegated", setupPath(provider, rawState)),
          )
        ).status,
      ).toBe(403);
      expect(providerCalls).toBe(0);
    });

    test("service revocation and permission ceilings fail before navigation", async () => {
      const rawState = state(provider, "service");
      keyPermissions = ["workspace:read"];
      expect(
        (await harness("service").fetch(await request("service", setupPath(provider, rawState))))
          .status,
      ).toBe(403);
      keyAvailable = false;
      expect(
        (await harness("service").fetch(await request("service", setupPath(provider, rawState))))
          .status,
      ).toBe(401);
      expect(providerCalls).toBe(0);
    });

    test("native setup can bootstrap bound browser state but cannot change the selected installation", async () => {
      const rawState = state(provider, "native");
      expect(
        (await harness("native").fetch(await request("native", setupPath(provider, rawState))))
          .status,
      ).toBe(302);
      const changed = state(provider, "native", { expectedInstallationId: 43 });
      expect(
        (
          await harness("native").fetch(
            await request("native", setupPath(provider, changed), `${provider.cookie}=${changed}`),
          )
        ).status,
      ).toBe(409);
      expect(providerCalls).toBe(0);
    });

    test("typed setup hands off to the exact native browser before code redemption", async () => {
      const rawState = state(provider, "delegated");
      const prepared = await harness("delegated").fetch(
        await request("delegated", setupPath(provider, rawState)),
      );
      expect(prepared.status).toBe(302);
      expect(prepared.headers.has("set-cookie")).toBe(false);
      const browser = await harness("native").fetch(
        await request("native", setupPath(provider, rawState)),
      );
      expect(browser.status).toBe(302);
      const cookie = browser.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect(cookie).toStartWith(`${provider.cookie}=`);
      const consentState = new URL(browser.headers.get("location")!).searchParams.get("state")!;
      expect(
        (
          await harness("native").fetch(
            await request("native", oauthPath(provider, consentState), cookie),
          )
        ).status,
      ).toBe(409);
      expect(providerCalls).toBe(1);
      for (const actor of ["delegated", "service"] as const) {
        expect(
          (
            await harness(actor).fetch(
              await request(
                actor,
                oauthPath(provider, consentState),
                `${cookie}; native-cookie=fixture`,
              ),
            )
          ).status,
        ).toBe(403);
      }
      expect(providerCalls).toBe(1);
    });

    test("copied, expired, or unbound setup links cannot bootstrap a native browser cookie", async () => {
      for (const patch of [
        { initiatingSubjectId: "user:another-person" },
        { accountId: otherId },
        { workspaceId: otherId },
        { initiatingExpiresAt: Math.floor(Date.now() / 1_000) - 1 },
        { initiatingSubjectId: undefined, initiatingExpiresAt: undefined },
      ]) {
        const rawState = state(provider, "delegated", patch);
        const response = await harness("native").fetch(
          await request("native", setupPath(provider, rawState)),
        );
        expect(response.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      live.workspaceGrants[0]!.permissions = ["workspace:read"];
      const rawState = state(provider, "delegated");
      const revoked = await harness("native").fetch(
        await request("native", setupPath(provider, rawState)),
      );
      expect(revoked.status).toBe(403);
      expect(revoked.headers.has("set-cookie")).toBe(false);
      expect(providerCalls).toBe(0);
    });

    test("verified delegation can read approval-pending outcome without consent or provider work", async () => {
      const rawState = state(provider, "delegated");
      expect(
        (
          await harness("delegated").fetch(
            await request("delegated", setupPath(provider, rawState, "setup", "request")),
          )
        ).status,
      ).toBe(200);
      expect(providerCalls).toBe(0);
    });

    test("request cloning loses typed setup proof", async () => {
      const rawState = state(provider, "delegated");
      const raw = await request("delegated", setupPath(provider, rawState));
      expect((await harness("delegated").fetch(raw.clone())).status).toBe(401);
      expect((await harness("delegated").fetch(raw)).status).toBe(302);
    });
  });

  describe(`${provider.id} actual OAuth consent callback`, () => {
    test.each(["service", "legacy-human", "legacy-service"] as const)(
      "cached %s without Authorization cannot borrow native cookie proof for redemption",
      async (actor) => {
        const rawState = state(provider, actor, { intent: provider.oauth, installationId: 42 });
        const raw = await request(
          actor,
          oauthPath(provider, rawState),
          `${provider.cookie}=${rawState}`,
        );
        expect((await harness(actor, true).fetch(raw)).status).toBe(403);
        expect(raw.headers.has("authorization")).toBe(false);
        expect(providerCalls).toBe(0);
      },
    );
    test.each(["delegated", "service", "legacy-human", "legacy-service"] as const)(
      "%s cannot redeem code even with matching state and a native cookie",
      async (actor) => {
        for (const intent of [provider.discovery, provider.oauth]) {
          const rawState = state(provider, actor, { intent, installationId: 42 });
          const response = await harness(actor).fetch(
            await request(
              actor,
              oauthPath(provider, rawState),
              `${provider.cookie}=${rawState}; native-cookie=fixture`,
            ),
          );
          expect(response.status).toBe(403);
        }
        expect(providerCalls).toBe(0);
      },
    );

    test.each(["native", "local"] as const)(
      "canonical %s consent still reaches the GitHub provider",
      async (actor) => {
        const app = harness(actor);
        for (const intent of [provider.discovery, provider.oauth]) {
          const rawState = state(provider, actor, { intent, installationId: 42 });
          const response = await app.fetch(
            await request(actor, oauthPath(provider, rawState), `${provider.cookie}=${rawState}`),
          );
          expect(response.status, await response.clone().text()).toBe(
            intent === provider.discovery ? 302 : 409,
          );
        }
        expect(providerCalls).toBe(2);
      },
    );

    test("native code redemption still requires exact state cookie and initiating person", async () => {
      const rawState = state(provider, "native", { intent: provider.oauth, installationId: 42 });
      const app = harness("native");
      expect((await app.fetch(await request("native", oauthPath(provider, rawState)))).status).toBe(
        400,
      );
      expect(
        (
          await app.fetch(
            await request("native", oauthPath(provider, rawState), `${provider.cookie}=different`),
          )
        ).status,
      ).toBe(400);
      const other = state(provider, "native", {
        intent: provider.oauth,
        installationId: 42,
        initiatingSubjectId: "user:another-person",
      });
      expect(
        (
          await app.fetch(
            await request("native", oauthPath(provider, other), `${provider.cookie}=${other}`),
          )
        ).status,
      ).toBe(403);
      expect(providerCalls).toBe(0);
    });
  });

  describe(`${provider.id} durable Connect route boundary`, () => {
    function browserHandoffPath(rawState: string): string {
      return `/v1/workspaces/${workspaceId}/${provider.id === "github-app" ? "github" : "pr-review/github"}/connect?${new URLSearchParams({ state: rawState })}`;
    }
    function connectState(actor: Actor, phase: string, patch: Record<string, unknown> = {}) {
      return createSignedState(stateSecret, {
        kind: "github_app_connect",
        accountId,
        workspaceId,
        subjectId: actorSubject(actor),
        personalOwnerVerified: actor === "native" || actor === "delegated" || actor === "local",
        connectAttemptId: otherId,
        phase,
        providerId: provider.id,
        ...patch,
      });
    }

    function browserState(response: Response, sourceState: string) {
      const raw = new URL(response.headers.get("location")!).searchParams.get("state")!;
      const source = readSignedState(sourceState, stateSecret)!;
      const wrapper = readSignedState(raw, stateSecret)!;
      const setCookie = response.headers.get("set-cookie")!;
      const cookie = setCookie.split(";", 1)[0]!;
      expect(raw).not.toBe(sourceState);
      expect(wrapper).toMatchObject({
        kind: "github_app_connect",
        accountId: source.accountId,
        workspaceId: source.workspaceId,
        subjectId: source.subjectId,
        personalOwnerVerified: source.personalOwnerVerified,
        connectAttemptId: source.connectAttemptId,
        phase: source.phase,
        providerId: provider.id,
        nativeBrowserSourceState: sourceState,
      });
      expect(wrapper.installationId).toBe(source.installationId);
      expect(wrapper.nonce).not.toBe(source.nonce);
      expect(wrapper.iat).toBeGreaterThanOrEqual(source.iat);
      expect(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))).toBe(raw);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      return { raw, cookie };
    }

    function signedBrowserWrapper(sourceState: string, patch: Record<string, unknown> = {}) {
      const source = readSignedState(sourceState, stateSecret)!;
      return createSignedState(stateSecret, {
        kind: "github_app_connect",
        accountId: source.accountId,
        workspaceId: source.workspaceId,
        subjectId: source.subjectId,
        personalOwnerVerified: source.personalOwnerVerified,
        connectAttemptId: source.connectAttemptId,
        phase: source.phase,
        providerId: provider.id,
        installationId: source.installationId,
        nativeBrowserSourceState: sourceState,
        ...patch,
      });
    }

    test("canonical local browser can bootstrap setup and Connect state without an initial cookie", async () => {
      const legacyState = state(provider, "local");
      const legacy = await harness("local").fetch(
        await request("local", setupPath(provider, legacyState)),
      );
      expect(legacy.status).toBe(302);
      const legacyCookie = legacy.headers.get("set-cookie")!.split(";", 1)[0]!;
      const legacyNext = new URL(legacy.headers.get("location")!).searchParams.get("state")!;
      expect(
        (
          await harness("local").fetch(
            await request("local", oauthPath(provider, legacyNext), legacyCookie),
          )
        ).status,
      ).toBe(409);
      expect(providerCalls).toBe(1);

      const bindState = connectState("local", "bind", { installationId: 42 });
      const providerUrl = githubOAuthAuthorizeUrl({
        clientId: "fixture-client",
        state: bindState,
        redirectUri: `https://console.example.test${provider.path}/oauth/callback`,
      });
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockImplementation(async (_deps, input) =>
          input.code
            ? new Response("local callback admitted")
            : new Response(null, { status: 302, headers: { location: providerUrl } }),
        ),
      );
      const installed = await harness("local").fetch(
        await request("local", setupPath(provider, connectState("local", "install"))),
      );
      expect(installed.status).toBe(302);
      const installBrowser = browserState(installed, bindState);
      expect(
        (
          await harness("local").fetch(
            await request("local", oauthPath(provider, installBrowser.raw), installBrowser.cookie),
          )
        ).status,
      ).toBe(200);

      for (const phase of ["discover", "bind"] as const) {
        const rawState = connectState("local", phase);
        const opened = await harness("local").fetch(
          await request("local", browserHandoffPath(rawState)),
        );
        expect(opened.status).toBe(302);
        const browser = browserState(opened, rawState);
        expect(
          (
            await harness("local").fetch(
              await request("local", oauthPath(provider, browser.raw), browser.cookie),
            )
          ).status,
        ).toBe(200);
        expect(finish).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ state: rawState, code: "fixture-code" }),
        );
      }
      expect(finish).toHaveBeenCalledTimes(4);
    });

    test("canonical local browser cannot bootstrap another signed actor or revoked scope", async () => {
      for (const raw of [
        connectState("local", "discover", { subjectId: "user:another-person" }),
        connectState("local", "discover", { accountId: otherId }),
        connectState("local", "discover", { workspaceId: otherId }),
      ]) {
        const response = await harness("local").fetch(
          await request("local", browserHandoffPath(raw)),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      const copiedSetup = state(provider, "local", { initiatingSubjectId: "user:another-person" });
      expect(
        (await harness("local").fetch(await request("local", setupPath(provider, copiedSetup))))
          .status,
      ).toBe(403);
      live.workspaceGrants[0]!.permissions = ["workspace:read"];
      for (const path of [
        browserHandoffPath(connectState("local", "discover")),
        setupPath(provider, connectState("local", "install")),
        setupPath(provider, state(provider, "local")),
      ]) {
        const response = await harness("local").fetch(await request("local", path));
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
    });

    test("copied authorization with forged local cookie flags is not resolved provenance", async () => {
      const resolve = core.requireAccessGrantAuthorization;
      track(
        spyOn(core, "requireAccessGrantAuthorization").mockImplementation(async (...args) => ({
          ...(await resolve(...args)),
          canonicalManagedHumanSession: true,
          canonicalLocalHumanSession: true,
        })),
      );
      for (const path of [
        browserHandoffPath(connectState("local", "discover")),
        setupPath(provider, connectState("local", "install")),
        setupPath(provider, state(provider, "local")),
      ]) {
        const response = await harness("local").fetch(await request("local", path));
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      expect(providerCalls).toBe(0);
    });

    test.each(["discover", "bind"] as const)(
      "a native browser can establish independent %s state at the existing Connect handoff",
      async (phase) => {
        const deps = services("delegated");
        const start = new Hono().get("/start", async (context) => {
          const access = await requireAccessGrantAuthorization(
            context,
            deps,
            workspaceId,
            provider.id === "github-app" ? "github:manage" : "workspace:admin",
          );
          return context.json(
            appConnect.githubAppConnectNavigation(
              deps,
              {
                accountId: access.grant.accountId,
                workspaceId: access.grant.workspaceId,
                subjectId: access.grant.subjectId,
                personalOwnerVerified: hasVerifiedOwningUserAuthorization(access),
              },
              otherId,
              context.req.url,
              phase,
              phase === "bind" ? 42 : undefined,
              provider.id,
            ),
          );
        });
        const started = await (await start.fetch(await request("delegated", "/start"))).json();
        const rawState = new URL(started.authorizationUrl).searchParams.get("state")!;
        const finish = track(
          spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
            new Response("native callback admitted"),
          ),
        );
        const response = await harness("native").fetch(
          await request("native", browserHandoffPath(rawState)),
        );
        expect(response.status).toBe(302);
        const next = new URL(response.headers.get("location")!);
        expect(next.origin + next.pathname).toBe("https://github.com/login/oauth/authorize");
        const browser = browserState(response, rawState);
        expect(finish).not.toHaveBeenCalled();
        // An agent can know the original durable stage and acquire a provider
        // code against it. Even the owner's browser must not redeem that code.
        for (const cookie of [browser.cookie, `${provider.cookie}=${rawState}`]) {
          expect(
            (
              await harness("native").fetch(
                await request("native", oauthPath(provider, rawState), cookie),
              )
            ).status,
          ).toBe(400);
        }
        expect(finish).not.toHaveBeenCalled();
        expect(providerCalls).toBe(0);
        expect(
          (
            await harness("native").fetch(
              await request("native", oauthPath(provider, browser.raw), browser.cookie),
            )
          ).status,
        ).toBe(200);
        expect(finish).toHaveBeenCalledTimes(1);
        expect(finish).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ state: rawState, code: "fixture-code" }),
        );
        expect(
          (
            await harness("delegated").fetch(
              await request(
                "delegated",
                oauthPath(provider, browser.raw),
                `${browser.cookie}; native-cookie=fixture`,
              ),
            )
          ).status,
        ).toBe(403);
        expect(finish).toHaveBeenCalledTimes(1);
      },
    );

    test.each(["delegated", "service", "legacy-human"] as const)(
      "%s cannot bootstrap browser state at the Connect handoff",
      async (actor) => {
        const rawState = connectState(actor, "discover");
        const response = await harness(actor).fetch(
          await request(actor, browserHandoffPath(rawState), "native-cookie=fixture"),
        );
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(providerCalls).toBe(0);
      },
    );

    test("the native Connect handoff refuses copied links, stale signatures, wrong stages, and revoked permission", async () => {
      for (const patch of [
        { subjectId: "user:another-person" },
        { accountId: otherId },
        { workspaceId: otherId },
        { providerId: provider.id === "github-app" ? "github-lens" : "github-app" },
        { phase: "install" },
      ]) {
        const rawState = connectState("native", "discover", patch);
        const response = await harness("native").fetch(
          await request("native", browserHandoffPath(rawState)),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      const expired = createSignedState(
        stateSecret,
        {
          kind: "github_app_connect",
          accountId,
          workspaceId,
          subjectId,
          phase: "discover",
          providerId: provider.id,
          personalOwnerVerified: true,
          connectAttemptId: otherId,
        },
        Math.floor(Date.now() / 1_000) - 601,
      );
      expect(
        (await harness("native").fetch(await request("native", browserHandoffPath(expired))))
          .status,
      ).toBe(400);
      live.workspaceGrants[0]!.permissions = ["workspace:read"];
      const rawState = connectState("native", "discover");
      const revoked = await harness("native").fetch(
        await request("native", browserHandoffPath(rawState)),
      );
      expect(revoked.status).toBe(403);
      expect(revoked.headers.has("set-cookie")).toBe(false);
      expect(providerCalls).toBe(0);
    });

    test("typed installation start can hand off to a real native browser and then the strict callback", async () => {
      const deps = services("delegated");
      const start = new Hono().get("/start", async (context) => {
        const access = await requireAccessGrantAuthorization(
          context,
          deps,
          workspaceId,
          provider.id === "github-app" ? "github:manage" : "workspace:admin",
        );
        return context.json(
          appConnect.githubAppConnectNavigation(
            deps,
            {
              accountId: access.grant.accountId,
              workspaceId: access.grant.workspaceId,
              subjectId: access.grant.subjectId,
              personalOwnerVerified: hasVerifiedOwningUserAuthorization(access),
            },
            otherId,
            context.req.url,
            "install",
            undefined,
            provider.id,
          ),
        );
      });
      const started = await (await start.fetch(await request("delegated", "/start"))).json();
      const initialState = new URL(started.authorizationUrl).searchParams.get("state")!;
      const next = appConnect.githubAppConnectNavigation(
        deps,
        { accountId, workspaceId, subjectId, personalOwnerVerified: true },
        otherId,
        "https://console.example.test",
        "bind",
        42,
        provider.id,
      );
      const nextState = new URL(next.authorizationUrl).searchParams.get("state")!;
      const directProviderUrl = githubOAuthAuthorizeUrl({
        clientId: "fixture-client",
        state: nextState,
        redirectUri: `https://console.example.test${provider.path}/oauth/callback`,
      });
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockImplementation(async (_deps, input) =>
          input.code
            ? new Response("native callback admitted")
            : new Response(null, { status: 302, headers: { location: directProviderUrl } }),
        ),
      );
      const agentResponse = await harness("delegated").fetch(
        await request("delegated", setupPath(provider, initialState), "native-cookie=fixture"),
      );
      expect(agentResponse.status).toBe(302);
      expect(agentResponse.headers.has("set-cookie")).toBe(false);
      const browser = await harness("native").fetch(
        await request("native", setupPath(provider, initialState)),
      );
      expect(browser.status).toBe(302);
      const consent = browserState(browser, nextState);
      expect(
        (
          await harness("native").fetch(
            await request("native", oauthPath(provider, consent.raw), consent.cookie),
          )
        ).status,
      ).toBe(200);
      expect(finish).toHaveBeenCalledTimes(3);
      expect(finish).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ state: nextState, code: "fixture-code" }),
      );
      expect(
        (
          await harness("delegated").fetch(
            await request(
              "delegated",
              oauthPath(provider, consent.raw),
              `${consent.cookie}; native-cookie=fixture`,
            ),
          )
        ).status,
      ).toBe(403);
      expect(finish).toHaveBeenCalledTimes(3);
    });

    test("wrong native initiator, expired state, and removed permissions cannot seed Connect browser state", async () => {
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(new Response("continued")),
      );
      for (const patch of [
        { subjectId: "user:another-person" },
        { accountId: otherId },
        { workspaceId: otherId },
      ]) {
        const rawState = connectState("native", "install", patch);
        const response = await harness("native").fetch(
          await request("native", setupPath(provider, rawState)),
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      const expired = createSignedState(
        stateSecret,
        {
          kind: "github_app_connect",
          accountId,
          workspaceId,
          subjectId,
          phase: "install",
          providerId: provider.id,
          personalOwnerVerified: true,
          connectAttemptId: otherId,
        },
        Math.floor(Date.now() / 1_000) - 601,
      );
      expect(
        (await harness("native").fetch(await request("native", setupPath(provider, expired))))
          .status,
      ).toBe(400);
      live.workspaceGrants[0]!.permissions = ["workspace:read"];
      expect(
        (
          await harness("native").fetch(
            await request("native", setupPath(provider, connectState("native", "install"))),
          )
        ).status,
      ).toBe(403);
      expect(finish).not.toHaveBeenCalled();
    });

    test("a service-owned installation cannot hand off by impersonating the service as a native person", async () => {
      const nextState = connectState("service", "bind");
      const nextUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams({ state: nextState })}`;
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
          new Response(null, { status: 302, headers: { location: nextUrl } }),
        ),
      );
      const initialState = connectState("service", "install");
      const agentResponse = await harness("service").fetch(
        await request("service", setupPath(provider, initialState), "native-cookie=fixture"),
      );
      expect(agentResponse.status).toBe(302);
      expect(agentResponse.headers.has("set-cookie")).toBe(false);
      const cached = await harness("service", true).fetch(
        await request("service", setupPath(provider, initialState)),
      );
      expect(cached.status).toBe(302);
      expect(cached.headers.has("set-cookie")).toBe(false);
      expect(
        (await harness("native").fetch(await request("native", setupPath(provider, initialState))))
          .status,
      ).toBe(403);
      expect(finish).toHaveBeenCalledTimes(2);
    });

    test("a changed signed redirect is not usable as native browser state", async () => {
      const initialState = connectState("native", "install");
      const finish = track(spyOn(appConnect, "completeGitHubAppConnect"));
      for (const patch of [
        { subjectId: "user:another-person" },
        { accountId: otherId },
        { workspaceId: otherId },
        { connectAttemptId: keyId },
        { providerId: provider.id === "github-app" ? "github-lens" : "github-app" },
      ]) {
        const nextState = connectState("native", "bind", patch);
        const nextUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams({ state: nextState })}`;
        finish.mockResolvedValue(
          new Response(null, { status: 302, headers: { location: nextUrl } }),
        );
        const response = await harness("native").fetch(
          await request("native", setupPath(provider, initialState)),
        );
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
    });
    test.each(["delegated", "service"] as const)(
      "%s may continue its own installation stage but cannot redeem OAuth code",
      async (actor) => {
        const finish = track(
          spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
            new Response("continued"),
          ),
        );
        const rawState = connectState(actor, "install");
        expect(
          (await harness(actor).fetch(await request(actor, setupPath(provider, rawState)))).status,
        ).toBe(200);
        expect(finish).toHaveBeenCalledTimes(1);
        const oauthState = connectState(actor, "bind");
        const redeem = await request(
          actor,
          oauthPath(provider, oauthState),
          `${provider.cookie}=${oauthState}; native-cookie=fixture`,
        );
        expect((await harness(actor).fetch(redeem)).status).toBe(403);
        expect(finish).toHaveBeenCalledTimes(1);
        const wrong = connectState(actor, "install", { subjectId: "user:other" });
        expect(
          (await harness(actor).fetch(await request(actor, setupPath(provider, wrong)))).status,
        ).toBe(403);
        expect(finish).toHaveBeenCalledTimes(1);
      },
    );

    test("native Connect OAuth rejects the raw initiation state even with an injected matching cookie", async () => {
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(new Response("continued")),
      );
      const rawState = connectState("native", "bind");
      expect(
        (await harness("native").fetch(await request("native", oauthPath(provider, rawState))))
          .status,
      ).toBe(400);
      expect(finish).not.toHaveBeenCalled();
      expect(
        (
          await harness("native").fetch(
            await request(
              "native",
              oauthPath(provider, rawState),
              `${provider.cookie}=${rawState}`,
            ),
          )
        ).status,
      ).toBe(400);
      expect(finish).not.toHaveBeenCalled();
      expect(providerCalls).toBe(0);
    });

    test.each(["native", "local"] as const)(
      "canonical %s browser wrapper requires an exact cookie and current native authority",
      async (actor) => {
        const finish = track(
          spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
            new Response("continued"),
          ),
        );
        const source = connectState(actor, "bind", { installationId: 42 });
        const opened = await harness(actor).fetch(await request(actor, browserHandoffPath(source)));
        const browser = browserState(opened, source);
        for (const cookie of [
          undefined,
          `${provider.cookie}=${source}`,
          `${provider.cookie}=wrong`,
        ]) {
          const response = await harness(actor).fetch(
            await request(actor, oauthPath(provider, browser.raw), cookie),
          );
          expect(response.status).toBe(400);
        }
        for (const cookie of [browser.cookie, `${provider.cookie}=${source}`]) {
          const knownState = await harness(actor).fetch(
            await request(actor, oauthPath(provider, source), cookie),
          );
          expect(knownState.status).toBe(400);
        }
        live.workspaceGrants[0]!.permissions = ["workspace:read"];
        const revoked = await harness(actor).fetch(
          await request(actor, oauthPath(provider, browser.raw), browser.cookie),
        );
        expect(revoked.status).toBe(403);
        expect(finish).not.toHaveBeenCalled();
        expect(providerCalls).toBe(0);
      },
    );

    test.each(["native", "local"] as const)(
      "canonical %s browser rejects forged wrappers, mismatched claims, and expired source stages",
      async (actor) => {
        const finish = track(
          spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
            new Response("continued"),
          ),
        );
        const source = connectState(actor, "bind", { installationId: 42 });
        const now = Math.floor(Date.now() / 1_000);
        const expiredSource = createSignedState(
          stateSecret,
          {
            kind: "github_app_connect",
            accountId,
            workspaceId,
            subjectId: actorSubject(actor),
            personalOwnerVerified: true,
            connectAttemptId: otherId,
            phase: "bind",
            providerId: provider.id,
            installationId: 42,
          },
          now - 601,
        );
        const wrappers = [
          ...[
            { accountId: otherId },
            { workspaceId: otherId },
            { subjectId: "user:another-person" },
            { connectAttemptId: keyId },
            { personalOwnerVerified: false },
            { phase: "discover" },
            { providerId: provider.id === "github-app" ? "github-lens" : "github-app" },
            { installationId: 43 },
            { nativeBrowserSourceState: "forged-source" },
            { nativeBrowserSourceState: signedBrowserWrapper(source) },
          ].map((patch) => signedBrowserWrapper(source, patch)),
          signedBrowserWrapper(expiredSource),
          createSignedState(
            stateSecret,
            readSignedState(signedBrowserWrapper(source), stateSecret)!,
            now - 601,
          ),
          signedBrowserWrapper(connectState(actor, "bind", { subjectId: "user:another-person" })),
          signedBrowserWrapper(connectState(actor, "bind", { accountId: otherId })),
          signedBrowserWrapper(connectState(actor, "bind", { workspaceId: otherId })),
          signedBrowserWrapper(source).slice(0, -1),
        ];
        for (const wrapper of wrappers) {
          const response = await harness(actor).fetch(
            await request(actor, oauthPath(provider, wrapper), `${provider.cookie}=${wrapper}`),
          );
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.headers.has("set-cookie")).toBe(false);
        }
        expect(finish).not.toHaveBeenCalled();
        expect(providerCalls).toBe(0);
      },
    );

    test.each(["delegated", "service", "legacy-human", "legacy-service"] as const)(
      "%s cannot borrow a genuine native browser wrapper for code redemption",
      async (actor) => {
        const finish = track(
          spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(
            new Response("continued"),
          ),
        );
        const source = connectState("native", "bind", { installationId: 42 });
        const opened = await harness("native").fetch(
          await request("native", browserHandoffPath(source)),
        );
        const browser = browserState(opened, source);
        const raw = await request(
          actor,
          oauthPath(provider, browser.raw),
          `${browser.cookie}; native-cookie=fixture`,
        );
        const response = await harness(actor, actor !== "delegated").fetch(raw);
        expect(response.status).toBe(403);
        expect(finish).not.toHaveBeenCalled();
        expect(providerCalls).toBe(0);
      },
    );

    test("native installation continuation through the existing API handoff never exposes the browser wrapper to the agent", async () => {
      const initialState = connectState("delegated", "install");
      const navigation = appConnect.githubAppConnectNavigation(
        services("delegated"),
        { accountId, workspaceId, subjectId, personalOwnerVerified: true },
        otherId,
        "https://console.example.test",
        "bind",
        42,
        provider.id,
      );
      const sourceState = new URL(navigation.authorizationUrl).searchParams.get("state")!;
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockImplementation(async (_deps, input) =>
          input.code
            ? new Response("native callback admitted")
            : new Response(null, {
                status: 302,
                headers: { location: navigation.authorizationUrl },
              }),
        ),
      );
      for (const actor of ["delegated", "native"] as const) {
        const setup = await harness(actor).fetch(
          await request(actor, setupPath(provider, initialState)),
        );
        expect(setup.status).toBe(302);
        expect(setup.headers.get("location")).toBe(navigation.authorizationUrl);
        expect(setup.headers.has("set-cookie")).toBe(false);
      }
      const opened = await harness("native").fetch(
        await request("native", browserHandoffPath(sourceState)),
      );
      const browser = browserState(opened, sourceState);
      expect(
        (
          await harness("native").fetch(
            await request("native", oauthPath(provider, browser.raw), browser.cookie),
          )
        ).status,
      ).toBe(200);
      expect(finish).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ state: sourceState, code: "fixture-code" }),
      );
    });

    test("external Connect retains its separate stored-origin path, not a raw delegated substitute", async () => {
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(new Response("continued")),
      );
      const rawState = connectState("native", "bind", { subjectId: `external_user:${otherId}` });
      expect(
        (
          await harness("native").fetch(
            new Request(`https://console.example.test${oauthPath(provider, rawState)}`),
          )
        ).status,
      ).toBe(200);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(
        (
          await harness("delegated").fetch(
            await request("delegated", oauthPath(provider, rawState)),
          )
        ).status,
      ).toBe(403);
      expect(finish).toHaveBeenCalledTimes(1);
    });

    test("setup never accepts an OAuth stage and OAuth never accepts an install stage", async () => {
      const finish = track(
        spyOn(appConnect, "completeGitHubAppConnect").mockResolvedValue(new Response("continued")),
      );
      const oauthState = connectState("delegated", "bind");
      expect(
        (
          await harness("delegated").fetch(
            await request("delegated", setupPath(provider, oauthState)),
          )
        ).status,
      ).toBe(400);
      const setupState = connectState("native", "install");
      expect(
        (
          await harness("native").fetch(
            await request(
              "native",
              oauthPath(provider, setupState),
              `${provider.cookie}=${setupState}`,
            ),
          )
        ).status,
      ).toBe(400);
      expect(finish).not.toHaveBeenCalled();
    });
  });
}
