import { describe, expect, test } from "bun:test";
import { classifyApiRequest, rateLimitKeys, readBodyCapped } from "../src/api";
import { gatewayConfig, GatewayConfigError } from "../src/env";
import { safeReturnPath } from "../src/return-path";
import { isSameOriginRequest } from "../src/site-context";
import { TEST_SECRET } from "./helpers";

describe("Site API routing", () => {
  test("allows exactly the Site operation allowlist and the tool methods", () => {
    expect(classifyApiRequest("GET", "/_og/api/sessions")).toMatchObject({
      kind: "operation",
      id: "sessions.list",
      suffix: "/sessions",
    });
    expect(classifyApiRequest("GET", "/_og/api")).toMatchObject({
      id: "workspace.get",
      suffix: "",
    });
    expect(classifyApiRequest("GET", "/_og/api/v1/config/client")).toMatchObject({
      id: "config.client",
    });
    expect(classifyApiRequest("GET", "/_og/api/sessions/s_1/events/stream")).toMatchObject({
      stream: true,
    });
    expect(
      classifyApiRequest("POST", "/_og/api/published-artifacts/current/data/write"),
    ).toMatchObject({ id: "data.write" });
    expect(classifyApiRequest("POST", "/_og/api/tools/invoke")).toMatchObject({
      kind: "tool",
      method: "invoke",
    });
  });

  test("refuses everything else before any request is made", () => {
    for (const [method, path] of [
      ["GET", "/_og/api/settings"],
      ["DELETE", "/_og/api/sessions/s_1"],
      ["GET", "/_og/api/tools/catalog"],
      ["POST", "/_og/api/tools/approve"],
      ["GET", "/_og/api/sessions/%2e%2e/x"],
      ["GET", "/_og/api/sessions/../tool-policy"],
      ["GET", "/_og/api/published-artifacts/other-id/data/x"],
      ["GET", "/_og/apix"],
      ["GET", "/_og/api/v1/workspaces/site-host/sessions"],
      ["POST", "/_og/api/sessions/s_1/tool-policy"],
    ] as const)
      expect(classifyApiRequest(method, path)).toBeNull();
  });

  test("rate limits always key the client IP, and the visitor too when known", () => {
    expect(rateLimitKeys({ hostname: "a-site.x.test", visitor: "v", clientIp: "1.2.3.4" })).toEqual(
      ["api:ip:a-site.x.test:1.2.3.4", "api:v:a-site.x.test:v"],
    );
    expect(
      rateLimitKeys({ hostname: "a-site.x.test", visitor: null, clientIp: "1.2.3.4" }, "report"),
    ).toEqual(["report:ip:a-site.x.test:1.2.3.4"]);
  });

  test("bodies are capped", async () => {
    const small = new Request("https://x.test/", { method: "POST", body: "12345" });
    expect(await readBodyCapped(small, 10)).toEqual(new TextEncoder().encode("12345"));
    const large = new Request("https://x.test/", { method: "POST", body: "x".repeat(11) });
    expect(await readBodyCapped(large, 10)).toBe("too_large");
  });

  test("same-origin proof uses Origin, then Fetch Metadata", () => {
    const origin = "https://a-site.sites.test";
    const make = (headers: Record<string, string>) =>
      new Request(`${origin}/_og/api/sessions`, { headers });
    expect(isSameOriginRequest(make({ origin }), origin)).toBe(true);
    expect(isSameOriginRequest(make({ origin: "null" }), origin)).toBe(false);
    expect(isSameOriginRequest(make({ origin: "https://evil.test" }), origin)).toBe(false);
    expect(isSameOriginRequest(make({ "sec-fetch-site": "same-origin" }), origin)).toBe(true);
    expect(isSameOriginRequest(make({ "sec-fetch-site": "cross-site" }), origin)).toBe(false);
    expect(isSameOriginRequest(make({}), origin)).toBe(false);
  });
});

describe("return paths", () => {
  test("accept same-origin relative paths only", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/dash?tab=2")).toBe("/dash?tab=2");
    expect(safeReturnPath("/a/../b")).toBe("/b");
    for (const value of [
      null,
      "",
      "dash",
      "//evil.test/x",
      "/\\evil.test",
      "https://evil.test/",
      "/%0d%0aSet-Cookie:x",
      "/x\n",
      "/_og/auth/login",
      "/_og",
      "javascript:alert(1)",
      `/${"a".repeat(3000)}`,
    ])
      expect(safeReturnPath(value)).toBe(value === "/%0d%0aSet-Cookie:x" ? value : null);
  });
});

describe("configuration", () => {
  const base = {
    SITES_DOMAIN: "Sites.Test",
    API_ORIGIN: "https://api.example.test",
    APP_ORIGIN: "https://app.example.test/",
    GATEWAY_SECRET: TEST_SECRET,
  };

  test("normalizes domains and origins and derives the abuse contact", () => {
    const config = gatewayConfig({ ...base });
    expect(config.sitesDomain).toBe("sites.test");
    expect(config.appOrigin).toBe("https://app.example.test");
    expect(config.abuseEmail).toBe("abuse@sites.test");
    expect(config.turnstile).toBeNull();
    expect(config.development).toBe(false);
    expect(gatewayConfig({ ...base, LOGIN_ONLY: "true", FORCE_NOINDEX: "1" })).toMatchObject({
      loginOnly: true,
      forceNoindex: true,
    });
  });

  test("Turnstile turns on only with both values", () => {
    expect(gatewayConfig({ ...base, TURNSTILE_SITE_KEY: "k" }).turnstile).toBeNull();
    expect(
      gatewayConfig({ ...base, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }).turnstile,
    ).toEqual({ siteKey: "k", secret: "s" });
  });

  test("refuses unsafe configuration", () => {
    for (const env of [
      { ...base, SITES_DOMAIN: "" },
      { ...base, GATEWAY_SECRET: "short" },
      { ...base, API_ORIGIN: "http://api.example.test" },
      { ...base, API_ORIGIN: "https://api.example.test/v1" },
      { ...base, APP_ORIGIN: "not a url" },
    ])
      expect(() => gatewayConfig(env)).toThrow(GatewayConfigError);
    expect(gatewayConfig({ ...base, API_ORIGIN: "http://127.0.0.1:8000" }).apiOrigin).toBe(
      "http://127.0.0.1:8000",
    );
  });
});
