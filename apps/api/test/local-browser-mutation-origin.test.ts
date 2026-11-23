import { Hono } from "hono";
import { describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";

import {
  requireSameOriginBrowserMutation,
  trustedBrowserOrigins,
} from "../src/http/browser-mutation-origin";

function app(
  settings: {
    productAccessMode: string;
    publicBaseUrl: string | null;
    webBaseUrl?: string;
    betterAuthTrustedOrigins?: string;
  } = {
    productAccessMode: "local",
    publicBaseUrl: null,
  },
) {
  const api = new Hono();
  api.on(["POST", "PUT", "PATCH", "DELETE"], "/mutation", (c) => {
    requireSameOriginBrowserMutation(c, { settings } as never);
    return c.json({ ok: true });
  });
  return api;
}

function request(
  origin: string,
  fetchSite: string,
  url = "http://127.0.0.1:8000/mutation",
  settings?: Parameters<typeof app>[0],
) {
  return app(settings).request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: new URL(url).host,
      origin,
      "sec-fetch-site": fetchSite,
    },
    body: "{}",
  });
}

describe("local browser mutation origin", () => {
  test("allows the local web and API on different ports", async () => {
    expect((await request("http://127.0.0.1:3000", "same-site")).status).toBe(200);
  });

  test("allows localhost-to-loopback alias used by local browser links", async () => {
    expect((await request("http://localhost:3000", "cross-site")).status).toBe(200);
  });

  test("rejects a non-local or mismatched browser origin", async () => {
    expect((await request("https://attacker.test", "cross-site")).status).toBe(403);
    expect((await request("http://other-host:3000", "same-site")).status).toBe(403);
  });
});

describe("managed browser mutation origin", () => {
  const managed = { productAccessMode: "managed", publicBaseUrl: "https://app.example.test" };
  const url = "https://api.example.test/mutation";
  const sameOrigin = { origin: managed.publicBaseUrl, "sec-fetch-site": "same-origin" };

  test("accepts body-less same-origin mutations without a content type over HTTP", async () => {
    const api = app(managed);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch });
    try {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        // Exercise the server's HTTP parser with explicit empty framing,
        // including for DELETE, rather than relying on fetch defaults.
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = httpRequest(
            new URL("/mutation", server.url),
            { method, headers: { ...sameOrigin, "content-length": "0" } },
            (res) => {
              res.on("error", reject);
              res.on("end", () => resolve(res.statusCode));
              res.resume();
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect({ method, status }).toEqual({ method, status: 200 });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("still requires a trusted Origin and same-origin fetch metadata without a body", async () => {
    const api = app(managed);
    for (const headers of [
      { "sec-fetch-site": "same-origin" },
      { origin: managed.publicBaseUrl },
      { ...sameOrigin, origin: "https://other.example.test" },
      { ...sameOrigin, "sec-fetch-site": "cross-site" },
    ]) {
      expect((await api.request(url, { method: "POST", headers })).status).toBe(403);
    }
  });

  test("rejects non-JSON content types and untyped payloads even from a trusted origin", async () => {
    const api = app(managed);
    for (const init of [
      { body: new URLSearchParams({ value: "form" }) },
      { body: Uint8Array.of(1) },
      { headers: { "content-type": "text/plain" } },
    ]) {
      const response = await api.request(url, {
        method: "POST",
        ...init,
        headers: { ...sameOrigin, ...init.headers },
      });
      expect(response.status).toBe(403);
    }
  });

  test("accepts only the public origin with same-origin fetch metadata", async () => {
    expect((await request("https://app.example.test", "same-origin", url, managed)).status).toBe(
      200,
    );
    expect((await request("https://app.example.test", "same-site", url, managed)).status).toBe(403);
    expect((await request("https://attacker.test", "same-origin", url, managed)).status).toBe(403);
  });

  test("never takes the local loopback allowance", async () => {
    expect(
      (
        await request(
          "http://127.0.0.1:3000",
          "same-site",
          "http://127.0.0.1:8000/mutation",
          managed,
        )
      ).status,
    ).toBe(403);
  });

  test("fails closed without a configured public origin", async () => {
    expect(
      (
        await request("https://app.example.test", "same-origin", url, {
          productAccessMode: "managed",
          publicBaseUrl: null,
        })
      ).status,
    ).toBe(503);
  });

  test("accepts a trusted second hostname of the same deployment", async () => {
    const twoHosts = {
      ...managed,
      betterAuthTrustedOrigins: " https://app.example.test , https://agents.example.org ",
    };
    expect((await request("https://agents.example.org", "same-origin", url, twoHosts)).status).toBe(
      200,
    );
    expect((await request("https://app.example.test", "same-origin", url, twoHosts)).status).toBe(
      200,
    );
    expect((await request("https://agents.example.org", "same-site", url, twoHosts)).status).toBe(
      403,
    );
    expect((await request("https://attacker.test", "same-origin", url, twoHosts)).status).toBe(403);
  });
});

describe("trusted browser origins", () => {
  test("normalizes configured URLs to origins and skips invalid entries", () => {
    expect(
      trustedBrowserOrigins({
        publicBaseUrl: "https://app.example.test/base/",
        webBaseUrl: "https://web.example.test:8443/",
        betterAuthTrustedOrigins: "https://app.example.test,not a url,,https://agents.example.org",
      }),
    ).toEqual([
      "https://app.example.test",
      "https://web.example.test:8443",
      "https://agents.example.org",
    ]);
  });
});
