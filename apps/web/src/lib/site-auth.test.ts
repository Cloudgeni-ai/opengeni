import { describe, expect, test } from "bun:test";

import {
  safeSiteRedirect,
  siteAuthCancelUrl,
  siteAuthRequest,
  siteAuthSearch,
  siteCallbackUrl,
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
    expect(siteAuthRequest(query)).toEqual({
      host,
      state: query.state,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: "S256",
      redirectUri: query.redirect_uri,
    });
  });

  test("refuses callbacks anywhere but the Site host's gateway callback", () => {
    for (const redirect_uri of [
      `https://evil.example/_og/auth/callback`,
      `http://${host}/_og/auth/callback`,
      `https://${host}/somewhere-else`,
      `https://user:pw@${host}/_og/auth/callback`,
      `javascript:alert(1)`,
      "not a url",
    ])
      expect(siteAuthRequest({ ...query, redirect_uri })).toBeNull();
    expect(siteAuthRequest({ ...query, code_challenge_method: "plain" })).toBeNull();
    expect(siteAuthRequest({ ...query, code_challenge: "short" })).toBeNull();
    expect(siteAuthRequest({ ...query, state: "short" })).toBeNull();
    expect(
      siteCallbackUrl("http://site.localhost:8787/_og/auth/callback", "site.localhost:8787"),
    ).not.toBeNull();
  });

  test("navigates only to the requested callback with the API's code", () => {
    const request = siteAuthRequest(query)!;
    expect(safeSiteRedirect(`${query.redirect_uri}?code=abc&state=${query.state}`, request)).toBe(
      `${query.redirect_uri}?code=abc&state=${query.state}`,
    );
    expect(safeSiteRedirect("https://evil.example/_og/auth/callback?code=abc", request)).toBeNull();
    expect(siteAuthCancelUrl(request)).toBe(
      `${query.redirect_uri}?error=access_denied&state=${query.state}`,
    );
  });
});
