import { describe, expect, test } from "bun:test";

import { OPENGENI_DESKTOP_APP_HEADER } from "@opengeni/contracts";
import { Hono } from "hono";

import {
  requireConnectReturnUrl,
  trustedConnectReturnOrigin,
} from "../src/integrations/connect-return-url";
import {
  OAUTH_BROWSER_BINDING_COOKIE,
  oauthBrowserBindingDigest,
  oauthBrowserBindingForStart,
  oauthCallbackBrowserAccepted,
  oauthStateBrowserBinding,
  type OAuthStateBrowserBinding,
} from "../src/integrations/oauth-browser-binding";

const settings = { publicBaseUrl: "https://app.example.test" } as never;
const person = "user:person-1";

async function startWith(
  headers: Record<string, string>,
  authorization: { subjectId: string; canonicalManagedHumanSession: boolean },
  externalContinuation?: unknown,
): Promise<{ binding: OAuthStateBrowserBinding; setCookie: string | null }> {
  let binding: OAuthStateBrowserBinding | undefined;
  const app = new Hono().post("/v1/start", (c) => {
    binding = oauthBrowserBindingForStart(
      c,
      settings,
      {
        grant: { subjectId: authorization.subjectId } as never,
        canonicalManagedHumanSession: authorization.canonicalManagedHumanSession,
      },
      { externalContinuation },
    );
    return c.body(null, 204);
  });
  const response = await app.request("https://app.example.test/v1/start", {
    method: "POST",
    headers,
  });
  return { binding: binding!, setCookie: response.headers.get("set-cookie") };
}

describe("how an OAuth start proves its callback", () => {
  test("a signed-in browser gets a cookie binding", async () => {
    const { binding, setCookie } = await startWith(
      { cookie: "session=x" },
      { subjectId: person, canonicalManagedHumanSession: true },
    );
    expect(binding.browserProof).toBe("cookie");
    // https deployments get the host-only cookie.
    const value = /__Host-opengeni_oauth_binding=([^;]+)/.exec(setCookie ?? "")![1]!;
    expect(setCookie).toContain("Path=/;");
    expect(setCookie).toContain("Secure");
    expect(binding.browserBinding).toBe(oauthBrowserBindingDigest(value));
    // The state carries only the digest, never the cookie itself.
    expect(binding.browserBinding).not.toContain(value);
  });

  test("the desktop app and native app credentials need the person signed in at the callback", async () => {
    for (const headers of [
      { cookie: "session=x", [OPENGENI_DESKTOP_APP_HEADER]: "macos" },
      { authorization: "Bearer ogapp_native" },
    ]) {
      const { binding, setCookie } = await startWith(headers, {
        subjectId: person,
        canonicalManagedHumanSession: true,
      });
      expect(binding).toEqual({ browserProof: "session" });
      expect(setCookie ?? "").not.toContain(OAUTH_BROWSER_BINDING_COOKIE);
    }
  });

  test("keys, delegated host tokens and host continuations rely on their own credential", async () => {
    expect(
      (
        await startWith(
          { authorization: "Bearer ogd_host" },
          { subjectId: person, canonicalManagedHumanSession: false },
        )
      ).binding,
    ).toEqual({ browserProof: "none" });
    expect(
      (
        await startWith(
          { cookie: "session=x" },
          { subjectId: person, canonicalManagedHumanSession: true },
          { actor: {} },
        )
      ).binding,
    ).toEqual({ browserProof: "none" });
    expect(
      (
        await startWith(
          { authorization: "Bearer og_key" },
          { subjectId: "api_key:k", canonicalManagedHumanSession: false },
        )
      ).binding,
    ).toEqual({ browserProof: "none" });
  });
});

describe("which callback browser may finish a state", () => {
  const digest = oauthBrowserBindingDigest("A".repeat(43));
  const cookieState = {
    subjectId: person,
    browserProof: "cookie" as const,
    browserBinding: digest,
  };
  const sessionState = { subjectId: person, browserProof: "session" as const };

  test("cookie proofs need the matching cookie", () => {
    expect(
      oauthCallbackBrowserAccepted(cookieState, {
        bindingDigests: [digest],
        signedInSubjectId: null,
      }),
    ).toBe(true);
    expect(
      oauthCallbackBrowserAccepted(cookieState, { bindingDigests: [], signedInSubjectId: person }),
    ).toBe(false);
    expect(oauthCallbackBrowserAccepted(cookieState, undefined)).toBe(false);
  });

  test("session proofs need the same signed-in person", () => {
    expect(
      oauthCallbackBrowserAccepted(sessionState, { bindingDigests: [], signedInSubjectId: person }),
    ).toBe(true);
    expect(
      oauthCallbackBrowserAccepted(sessionState, {
        bindingDigests: [],
        signedInSubjectId: "user:someone-else",
      }),
    ).toBe(false);
    expect(
      oauthCallbackBrowserAccepted(sessionState, { bindingDigests: [], signedInSubjectId: null }),
    ).toBe(false);
  });

  test("signed state fields parse strictly; a malformed cookie proof can never be met", () => {
    expect(oauthStateBrowserBinding({})).toBeUndefined();
    expect(oauthStateBrowserBinding({ browserProof: "session" })).toEqual({
      browserProof: "session",
    });
    const broken = oauthStateBrowserBinding({ browserProof: "cookie", browserBinding: "short" })!;
    expect(
      oauthCallbackBrowserAccepted(
        { subjectId: person, ...broken },
        { bindingDigests: [""], signedInSubjectId: person },
      ),
    ).toBe(false);
    // A state minted before binding keeps its ten-minute life through a rollout.
    expect(oauthCallbackBrowserAccepted({ subjectId: person }, undefined)).toBe(true);
  });
});

describe("this deployment's own connect return origins", () => {
  const origins = {
    publicBaseUrl: "https://api.example.test",
    webBaseUrl: "https://app.example.test",
    betterAuthTrustedOrigins: "https://alias.example.test",
    corsAllowOriginRegex: String.raw`https://console[.]example[.]test`,
    localAllowedOrigins: undefined,
  } as never;
  const trusted = (url: string) =>
    trustedConnectReturnOrigin(origins, new URL(url), "https://api.example.test/v1/x");

  test("own, trusted and cookie-CORS origins are trusted", () => {
    for (const url of [
      "https://api.example.test/connect/finished",
      "https://app.example.test/workspaces/w",
      "https://alias.example.test/",
      "https://console.example.test/a",
    ])
      expect(trusted(url), url).toBe(true);
  });

  test("lookalike and other origins are not", () => {
    for (const url of [
      "https://evil.example/",
      "https://app.example.test.evil.example/",
      "http://app.example.test/",
      "http://my-site.sites.example.test/",
      "https://evilsites.example.test/",
      // Anyone can publish a Site, so Sites are not this deployment's pages.
      "https://my-site.sites.example.test/page",
      "https://console.example.test.evil.example/",
      "https://evil.example/https://console.example.test",
      "https://app.example.test:8443/",
      "https://app.example.test@evil.example/",
    ])
      expect(trusted(url), url).toBe(false);
  });
});

describe("who the connect return rule applies to", () => {
  const origins = { publicBaseUrl: "https://app.example.test" } as never;
  async function status(
    headers: Record<string, string>,
    canonicalManagedHumanSession: boolean,
    returnUrl: string,
  ): Promise<number> {
    const app = new Hono().post("/v1/connect", (c) => {
      requireConnectReturnUrl(c, origins, { canonicalManagedHumanSession }, new URL(returnUrl));
      return c.body(null, 204);
    });
    return (await app.request("https://app.example.test/v1/connect", { method: "POST", headers }))
      .status;
  }

  test("a signed-in person returns only to this deployment, by cookie or native app bearer", async () => {
    for (const headers of [{ cookie: "session=x" }, { authorization: "Bearer ogapp_native" }]) {
      expect(await status(headers, true, "https://evil.example/")).toBe(400);
      expect(await status(headers, true, "https://app.example.test/back")).toBe(204);
    }
  });

  test("host credentials keep returning their users to the host's own pages", async () => {
    expect(
      await status({ authorization: "Bearer og_host_key" }, false, "https://host.example/back"),
    ).toBe(204);
  });
});
