import { describe, expect, test } from "bun:test";
import { getSettings, validateSitesDomain } from "../src/index";

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe("Sites domain", () => {
  test("must be separate from the console and API hosts", () => {
    const check = (sitesDomain: string, publicBaseUrl?: string, webBaseUrl?: string) => () =>
      validateSitesDomain({ sitesDomain, publicBaseUrl, webBaseUrl });
    expect(check("sites.example.test", "https://app.example.com")).not.toThrow();
    expect(
      check("opengeni.site", "https://app.opengeni.ai", "http://localhost:3000"),
    ).not.toThrow();
    // The console on the Sites domain, under it, or holding it.
    expect(check("opengeni.site", "https://opengeni.site")).toThrow(/OPENGENI_PUBLIC_BASE_URL/u);
    expect(check("opengeni.site", "https://app.opengeni.site")).toThrow(/separate domain/u);
    expect(check("sites.opengeni.ai", "https://opengeni.ai")).toThrow(/separate domain/u);
    expect(check("Opengeni.Site.", undefined, "https://APP.opengeni.site.")).toThrow(
      /OPENGENI_WEB_BASE_URL/u,
    );
    expect(check("not a domain")).toThrow(/OPENGENI_SITES_DOMAIN/u);
    expect(() => validateSitesDomain({})).not.toThrow();
  });

  test("is checked when settings load", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_SITES_DOMAIN: "opengeni.site",
          OPENGENI_PUBLIC_BASE_URL: "https://console.opengeni.site",
        },
        () => getSettings(),
      ),
    ).toThrow(/OPENGENI_SITES_DOMAIN/u);
    expect(
      withEnv(
        {
          OPENGENI_SITES_DOMAIN: "opengeni.site",
          OPENGENI_PUBLIC_BASE_URL: "https://app.opengeni.ai",
        },
        () => getSettings(),
      ).sitesDomain,
    ).toBe("opengeni.site");
  });
});
