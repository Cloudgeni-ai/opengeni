import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import {
  IMAGE_PROXY_MAX_BYTES,
  IMAGE_PROXY_RESPONSE_CSP,
  registerImageProxyRoutes,
  sniffRasterImage,
} from "../src/routes/image-proxy";
import { PublicSetupRateLimiter } from "../src/routes/managed-onboarding";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Hosts resolve to whatever the test says; the real policy decides which addresses may be used. */
function proxy(
  upstream: Upstream,
  dns: Record<string, string> = {},
  options: { limiter?: PublicSetupRateLimiter; timeoutMs?: number } = {},
) {
  const fetched: Array<{ url: string; headers: Headers }> = [];
  const app = new Hono();
  registerImageProxyRoutes(app, {} as never, {
    subject: async () => "person-1",
    dnsLookup: async (hostname) => {
      const address = dns[hostname] ?? "93.184.216.34";
      return [{ address, family: address.includes(":") ? 6 : 4 }];
    },
    agentFactory: () => ({ close() {}, destroy() {} }) as never,
    fetchImpl: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push({ url, headers: new Headers(init?.headers) });
      return upstream(url, init ?? {});
    },
    ...options,
  });
  const get = (target: string, headers: HeadersInit = {}) =>
    app.request(`http://console.test/v1/image-proxy?url=${encodeURIComponent(target)}`, {
      headers,
    });
  return { app, get, fetched };
}

describe("image proxy", () => {
  test("serves a raster image inert, sniffed by its bytes, without forwarding credentials", async () => {
    const { get, fetched } = proxy(
      () => new Response(PNG, { headers: { "content-type": "text/html", "set-cookie": "a=b" } }),
    );
    const response = await get("https://images.example.com/a.png", { cookie: "session=secret" });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_PROXY_RESPONSE_CSP);
    expect(IMAGE_PROXY_RESPONSE_CSP).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="image.png"');
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.headers.get("cookie")).toBeNull();
    expect(fetched[0]!.headers.get("authorization")).toBeNull();
    expect(fetched[0]!.headers.get("referer")).toBeNull();
  });

  test("refuses non-https, credentialed and malformed upstream URLs before any request", async () => {
    const { get, fetched } = proxy(() => new Response(PNG));
    for (const target of [
      "http://images.example.com/a.png",
      "ftp://images.example.com/a.png",
      "https://user:pass@images.example.com/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect({ target, status: (await get(target)).status }).toEqual({ target, status: 400 });
    }
    expect(fetched).toHaveLength(0);
  });

  test("never reaches private, loopback, link-local, metadata, CGNAT or IPv6 internal addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      const { get, fetched } = proxy(() => new Response(PNG), { "internal.example.com": address });
      const response = await get("https://internal.example.com/a.png");
      expect({ address, status: response.status }).toEqual({ address, status: 403 });
      expect(fetched).toHaveLength(0);
    }
    // A literal address in the URL is checked the same way.
    const literal = proxy(() => new Response(PNG));
    expect((await literal.get("https://169.254.169.254/latest/meta-data")).status).not.toBe(200);
    expect(literal.fetched).toHaveLength(0);
  });

  test("re-checks every redirect hop and caps the number of redirects", async () => {
    const toPrivate = proxy(
      (url) =>
        url.startsWith("https://public.example.com")
          ? new Response(null, {
              status: 302,
              headers: { location: "https://internal.example.com/a.png" },
            })
          : new Response(PNG),
      { "internal.example.com": "10.0.0.7" },
    );
    expect((await toPrivate.get("https://public.example.com/a.png")).status).toBe(403);
    expect(toPrivate.fetched.map((entry) => entry.url)).toEqual([
      "https://public.example.com/a.png",
    ]);

    const toHttp = proxy((url) =>
      url.endsWith("/start")
        ? new Response(null, { status: 301, headers: { location: "http://public.example.com/a" } })
        : new Response(PNG),
    );
    expect((await toHttp.get("https://public.example.com/start")).status).toBe(400);
    expect(toHttp.fetched).toHaveLength(1);

    let hops = 0;
    const loop = proxy(() => {
      hops += 1;
      return new Response(null, {
        status: 307,
        headers: { location: `https://public.example.com/${hops}` },
      });
    });
    expect((await loop.get("https://public.example.com/0")).status).toBe(502);
    expect(loop.fetched).toHaveLength(4);

    const followed = proxy((url) =>
      url.endsWith("/start")
        ? new Response(null, { status: 308, headers: { location: "/final.jpg" } })
        : new Response(JPEG),
    );
    const final = await followed.get("https://public.example.com/start");
    expect(final.status).toBe(200);
    expect(final.headers.get("content-type")).toBe("image/jpeg");
  });

  test("refuses SVG, HTML and other non-raster bodies whatever their Content-Type says", async () => {
    for (const body of [SVG, HTML, new TextEncoder().encode("GIF")]) {
      const { get } = proxy(() => new Response(body, { headers: { "content-type": "image/png" } }));
      const response = await get("https://images.example.com/x.png");
      expect(response.status).toBe(415);
      expect(response.headers.get("content-type") ?? "").not.toContain("image/");
    }
    expect(sniffRasterImage(SVG)).toBeNull();
    expect(sniffRasterImage(PNG)?.contentType).toBe("image/png");
  });

  test("caps the size, the time and upstream failures", async () => {
    const huge = new Uint8Array(IMAGE_PROXY_MAX_BYTES + 1);
    huge.set(PNG);
    expect((await proxy(() => new Response(huge)).get("https://images.example.com/a")).status).toBe(
      413,
    );
    expect(
      (await proxy(() => new Response("gone", { status: 404 })).get("https://images.example.com/a"))
        .status,
    ).toBe(502);
    const slow = proxy(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      {},
      { timeoutMs: 50 },
    );
    expect((await slow.get("https://images.example.com/a")).status).toBe(504);
  });

  test("refuses Authorization headers and rate limits each person", async () => {
    const { get, fetched } = proxy(
      () => new Response(PNG),
      {},
      {
        limiter: new PublicSetupRateLimiter({
          globalCapacity: 100,
          globalRefillPerSecond: 0,
          clientCapacity: 2,
          clientRefillPerSecond: 0,
          maxClientKeys: 10,
        }),
      },
    );
    expect((await get("https://images.example.com/a", { authorization: "Bearer k" })).status).toBe(
      403,
    );
    expect((await get("https://images.example.com/a")).status).toBe(200);
    expect((await get("https://images.example.com/a")).status).toBe(200);
    expect((await get("https://images.example.com/a")).status).toBe(429);
    expect(fetched).toHaveLength(2);
  });

  test("requires a signed-in session in the real app", async () => {
    const app = createApp({
      settings: testSettings({ productAccessMode: "managed" }),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const response = await app.request(
      `http://localhost/v1/image-proxy?url=${encodeURIComponent("https://images.example.com/a.png")}`,
    );
    expect(response.status).toBe(401);
    // GET only.
    expect([404, 405]).toContain(
      (await app.request("http://localhost/v1/image-proxy?url=x", { method: "POST" })).status,
    );
  });
});
