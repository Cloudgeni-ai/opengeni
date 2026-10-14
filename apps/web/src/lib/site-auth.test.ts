import { describe, expect, test } from "bun:test";

import {
  isFramedWindow,
  safeSiteRedirect,
  siteAuthCancelUrl,
  siteAuthRequest,
  siteAuthSearch,
  siteCallbackUrl,
  siteHostUnderDomain,
} from "./site-auth";

const host = "team-crm-4k9x.sites.example.test";
const query = {
  host,
  state: "s".repeat(24),
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  redirect_uri: `https://${host}/_og/auth/callback`,
  return: "/reports",
};

const domain = "sites.example.test";

describe("Site viewer sign-in", () => {
  test("keeps only the known string parameters", () => {
    expect(siteAuthSearch({ ...query, extra: "x", state: 5 })).toEqual({
      host,
      code_challenge: query.code_challenge,
      code_challenge_method: "S256",
      redirect_uri: query.redirect_uri,
      return: "/reports",
    });
  });

  test("builds the authorize request from a well-formed query", () => {
    expect(siteAuthRequest(query, domain)).toEqual({
      host,
      state: query.state,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: "S256",
      redirectUri: query.redirect_uri,
    });
    expect(siteAuthRequest({ ...query, host: host.toUpperCase() }, domain)?.host).toBe(host);
  });

  test("accepts only Sites under the configured Sites domain", () => {
    expect(siteHostUnderDomain(host, domain)).toBe(host);
    for (const candidate of [
      "evil.example",
      `${host}.evil.example`,
      `a.b.${domain}`,
      `${host}.`,
      `${host}:8443`,
      domain,
    ])
      expect(siteHostUnderDomain(candidate, domain)).toBeNull();
    // No configured domain: nothing qualifies.
    expect(siteAuthRequest(query, null)).toBeNull();
    expect(siteAuthRequest(query, undefined)).toBeNull();
    const evilHost = "team-crm-4k9x.evil.example";
    expect(
      siteAuthRequest(
        { ...query, host: evilHost, redirect_uri: `https://${evilHost}/_og/auth/callback` },
        domain,
      ),
    ).toBeNull();
  });

  test("refuses callbacks anywhere but the Site host's gateway callback", () => {
    for (const redirect_uri of [
      `https://evil.example/_og/auth/callback`,
      `http://${host}/_og/auth/callback`,
      `https://${host}:8443/_og/auth/callback`,
      `https://${host}/somewhere-else`,
      `https://${host}/_og/auth/callback?code=preset`,
      `https://user:pw@${host}/_og/auth/callback`,
      `javascript:alert(1)`,
      "not a url",
    ])
      expect(siteAuthRequest({ ...query, redirect_uri }, domain)).toBeNull();
    expect(siteAuthRequest({ ...query, code_challenge_method: "plain" }, domain)).toBeNull();
    expect(siteAuthRequest({ ...query, code_challenge: "short" }, domain)).toBeNull();
    expect(siteAuthRequest({ ...query, state: "short" }, domain)).toBeNull();
    expect(
      siteCallbackUrl(
        "http://site.localhost:8787/_og/auth/callback",
        "site.localhost:8787",
        domain,
      ),
    ).toBeNull();
  });

  test("navigates only to the requested callback with the API's code", () => {
    const request = siteAuthRequest(query, domain)!;
    expect(
      safeSiteRedirect(`${query.redirect_uri}?code=abc&state=${query.state}`, request, domain),
    ).toBe(`${query.redirect_uri}?code=abc&state=${query.state}`);
    expect(
      safeSiteRedirect("https://evil.example/_og/auth/callback?code=abc", request, domain),
    ).toBeNull();
    expect(siteAuthCancelUrl(request, domain)).toBe(
      `${query.redirect_uri}?error=access_denied&state=${query.state}`,
    );
    // A different configured domain never yields a Site to go back to.
    expect(siteAuthCancelUrl(request, "sites.other.test")).toBeNull();
  });

  test("detects a framed window", () => {
    expect(isFramedWindow()).toBe(false);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    const self = {};
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { self, top: {} },
    });
    try {
      expect(isFramedWindow()).toBe(true);
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          self,
          get top(): never {
            throw new Error("cross-origin");
          },
        },
      });
      expect(isFramedWindow()).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
