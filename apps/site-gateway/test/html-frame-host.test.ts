import { describe, expect, test } from "bun:test";
import {
  HTML_FRAME_HOST_DOCUMENT,
  HTML_FRAME_HOST_PATH,
  HTML_FRAME_HOST_SANDBOX,
} from "@opengeni/contracts/html-frame-host";
import worker, { type GatewayEnv } from "../src/index";
import { TEST_SECRET } from "./helpers";

function env(environment = "production"): GatewayEnv {
  return {
    SITES_DOMAIN: "sites.test",
    API_ORIGIN: "http://127.0.0.1:9",
    APP_ORIGIN: "https://app.test",
    GATEWAY_SECRET: TEST_SECRET,
    ENVIRONMENT: environment,
    HOST_MAP: {
      // The frame host never looks up a Site.
      get: async () => {
        throw new Error("no host lookup expected");
      },
      put: async () => undefined,
    },
  } as unknown as GatewayEnv;
}

const ctx = { waitUntil: () => undefined };

describe("HTML frame host on og.<sites domain>", () => {
  test("serves the loader page framable only by the console, sandboxed itself", async () => {
    const response = await worker.fetch(
      new Request(`https://og.sites.test${HTML_FRAME_HOST_PATH}?parent=https%3A%2F%2Fapp.test`),
      env(),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(HTML_FRAME_HOST_DOCUMENT);
    const csp = response.headers.get("content-security-policy");
    expect(csp).toBe(`sandbox ${HTML_FRAME_HOST_SANDBOX}; frame-ancestors https://app.test`);
    expect(csp).not.toContain("allow-same-origin");
    // X-Frame-Options cannot name the console origin; frame-ancestors does.
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("answers HEAD without a body and refuses other paths and methods", async () => {
    const head = await worker.fetch(
      new Request(`https://og.sites.test${HTML_FRAME_HOST_PATH}`, { method: "HEAD" }),
      env(),
      ctx,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const request of [
      new Request("https://og.sites.test/"),
      new Request("https://og.sites.test/_og/api/sessions"),
      new Request(`https://og.sites.test${HTML_FRAME_HOST_PATH}`, { method: "POST", body: "x" }),
    ]) {
      const response = await worker.fetch(request, env(), ctx);
      expect(response.status).toBe(404);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("redirects plain HTTP to HTTPS outside development", async () => {
    const response = await worker.fetch(
      new Request(`http://og.sites.test${HTML_FRAME_HOST_PATH}`),
      env(),
      ctx,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://og.sites.test${HTML_FRAME_HOST_PATH}`);
  });
});
