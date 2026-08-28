import { describe, expect, test } from "bun:test";
import {
  injectSiteRuntimeBootstrap,
  isSiteRuntimeRequest,
  SITE_RUNTIME_CSP,
  siteRuntimeBootstrapScript,
} from "../src/site-runtime-browser";

describe("Site browser runtime", () => {
  test("injects the platform bridge without adding credentials or parent DOM authority", () => {
    const script = siteRuntimeBootstrapScript();
    expect(script).not.toContain("MessagePort");
    expect(script).toContain("event.source!==parent");
    expect(script).toContain("OpenGeniSite");
    expect(script).not.toMatch(/authorization|cookie|localStorage|sessionStorage/iu);
    const html = injectSiteRuntimeBootstrap(
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    expect(html.indexOf("data-opengeni-site-runtime")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(SITE_RUNTIME_CSP).toContain("connect-src 'none'");
    expect(SITE_RUNTIME_CSP).toContain("form-action 'none'");
  });

  test("exposes only the bounded AI RPC verbs", () => {
    const script = siteRuntimeBootstrapScript();
    expect(script).toContain('request("ai.start"');
    expect(script).toContain('request("ai.send"');
    expect(script).toContain('request("ai.cancel"');
    expect(script).not.toContain("fetch(");
    expect(
      isSiteRuntimeRequest({
        id: "request-1",
        method: "ai.start",
        params: { message: "Summarize approved data" },
      }),
    ).toBe(true);
    expect(
      isSiteRuntimeRequest({ id: "request-2", method: "fetch", params: { url: "https://x" } }),
    ).toBe(false);
  });
});
