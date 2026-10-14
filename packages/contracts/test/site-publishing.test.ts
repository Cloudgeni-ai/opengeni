import { describe, expect, test } from "bun:test";
import {
  matchSiteOperation,
  parseSiteHostname,
  siteGatewayCanonicalString,
  siteHostnameLabelProblem,
  SiteHostnameLabel,
  suggestSiteHostnameLabel,
} from "../src/site-publishing";

describe("Site hostname labels", () => {
  test("accepts ordinary flat labels", () => {
    for (const label of ["team-dashboard", "abc", "a1b2c3", "q3-report-4k9x"])
      expect(siteHostnameLabelProblem(label)).toBeNull();
  });

  test("refuses malformed, reserved and blocked labels", () => {
    expect(siteHostnameLabelProblem("ab")).toBe("length");
    expect(siteHostnameLabelProblem("a".repeat(64))).toBe("length");
    expect(siteHostnameLabelProblem("Team")).toBe("characters");
    expect(siteHostnameLabelProblem("_dmarc")).toBe("characters");
    expect(siteHostnameLabelProblem("a.b.c")).toBe("characters");
    expect(siteHostnameLabelProblem("-abc")).toBe("hyphen");
    expect(siteHostnameLabelProblem("abc-")).toBe("hyphen");
    expect(siteHostnameLabelProblem("xn--bcher-kva")).toBe("punycode");
    expect(siteHostnameLabelProblem("ab--cd")).toBe("punycode");
    for (const label of ["www", "api", "app", "admin", "abuse", "mail", "docs", "status"])
      expect(siteHostnameLabelProblem(label)).toBe("reserved");
    for (const label of ["paypal-help", "secure-bank", "my-wallet", "sign-in-now", "g-o-o-g-l-e"])
      expect(siteHostnameLabelProblem(label)).toBe("blocked");
    expect(SiteHostnameLabel.safeParse("www").success).toBe(false);
  });

  test("suggests valid labels with a suffix", () => {
    expect(suggestSiteHostnameLabel("Team Dashboard", "4k9x")).toBe("team-dashboard-4k9x");
    expect(suggestSiteHostnameLabel("!!!", "4k9x")).toBe("site-4k9x");
    expect(suggestSiteHostnameLabel("PayPal login", "4k9x")).toBe("site-4k9x");
    expect(suggestSiteHostnameLabel("Ærlig talt", "abcd")).toBe("rlig-talt-abcd");
    expect(siteHostnameLabelProblem(suggestSiteHostnameLabel("x".repeat(200), "abcd"))).toBeNull();
    expect(() => suggestSiteHostnameLabel("x", "ABCD")).toThrow();
  });

  test("parses only flat one-level hostnames under the configured domain", () => {
    expect(parseSiteHostname("team-4k9x.opengeni.site", "opengeni.site")).toBe("team-4k9x");
    expect(parseSiteHostname("TEAM-4k9x.opengeni.site.:443", "opengeni.site")).toBe("team-4k9x");
    expect(parseSiteHostname("opengeni.site", "opengeni.site")).toBeNull();
    expect(parseSiteHostname("a.team-4k9x.opengeni.site", "opengeni.site")).toBeNull();
    expect(parseSiteHostname("team-4k9x.evil.site", "opengeni.site")).toBeNull();
    expect(parseSiteHostname("www.opengeni.site", "opengeni.site")).toBeNull();
    expect(parseSiteHostname("x.example-staging.site", "example-staging.site")).toBeNull();
    expect(parseSiteHostname("abc.example-staging.site", "Example-Staging.site")).toBe("abc");
  });
});

describe("Site operation allowlist", () => {
  test("allows exactly the listed operations", () => {
    expect(matchSiteOperation("GET", "/v1/config/client")?.operation.id).toBe("config.client");
    expect(matchSiteOperation("POST", "/v1/workspaces/site-host/sessions")?.operation.id).toBe(
      "sessions.create",
    );
    expect(
      matchSiteOperation("POST", "/v1/workspaces/site-host/sessions/abc/events")?.operation.agent,
    ).toBe(true);
    expect(
      matchSiteOperation(
        "GET",
        "/v1/workspaces/site-host/published-artifacts/current/data/collections/x/records",
      )?.operation.id,
    ).toBe("data.read");
  });

  test("refuses everything else", () => {
    for (const [method, path] of [
      ["GET", "/v1/workspaces/site-host/scheduled-tasks"],
      ["POST", "/v1/workspaces/site-host/scheduled-tasks"],
      ["POST", "/v1/workspaces/site-host/automations"],
      ["GET", "/v1/workspaces/site-host/published-artifacts"],
      ["GET", "/v1/workspaces/site-host/published-artifacts/0000/data"],
      ["GET", "/v1/workspaces/site-host/sessions/abc/../../api-keys"],
      ["GET", "/v1/workspaces/site-host/sessions/a%2fb"],
      ["DELETE", "/v1/workspaces/site-host/sessions/abc"],
      ["GET", "/v1/workspaces/other/sessions"],
      ["GET", "/v1/accounts"],
    ] as const)
      expect(matchSiteOperation(method, path)).toBeNull();
  });
});

test("gateway canonical string is stable", () => {
  expect(
    siteGatewayCanonicalString({
      method: "post",
      pathWithQuery: "/v1/site-runtime/sessions?x=1",
      timestamp: 1_700_000_000,
      bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      host: "Team-4k9x.opengeni.site",
      session: "",
      visitor: "v1",
      clientIp: "203.0.113.9",
      human: "",
    }),
  ).toBe(
    "OGSG1\nPOST\nteam-4k9x.opengeni.site\n/v1/site-runtime/sessions?x=1\n1700000000\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\nv1\n203.0.113.9\n",
  );
});
