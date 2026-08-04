import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebHandler, demoApiProxyFromEnvironment } from "./server";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production web handler", () => {
  test("serves compressed immutable assets and revalidating SPA fallbacks", async () => {
    const root = await fixture();
    const handler = createWebHandler(root);
    const asset = await handler(
      new Request("https://example.test/assets/app-abc123.js", {
        headers: { "accept-encoding": "br, gzip" },
      }),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      await new Response(asset.body!.pipeThrough(new DecompressionStream("gzip"))).text(),
    ).toBe("export const ready = true;\n");

    const route = await handler(new Request("https://example.test/workspaces/ws/sessions/id"));
    expect(route.headers.get("cache-control")).toBe("no-cache");
    expect(await route.text()).toContain("OpenGeni");
  });

  test("does not turn missing assets or path traversal into the SPA shell", async () => {
    const root = await fixture();
    const handler = createWebHandler(root);
    expect((await handler(new Request("https://example.test/assets/missing.js"))).status).toBe(404);
    expect((await handler(new Request("https://example.test/%2e%2e%2fsecret"))).status).toBe(400);
  });

  test("serves the deployed public React demo without falling through to the app shell", async () => {
    const root = await fixture();
    await mkdir(join(root, "react-demo", "assets"), { recursive: true });
    await Bun.write(
      join(root, "react-demo", "index.html"),
      "<!doctype html><title>React demo</title>",
    );
    await Bun.write(
      join(root, "react-demo", "realtime.html"),
      "<!doctype html><title>Realtime demo</title>",
    );
    const handler = createWebHandler(root);

    const redirect = await handler(new Request("https://example.test/react-demo"));
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://example.test/react-demo/");
    expect(await (await handler(new Request("https://example.test/react-demo/"))).text()).toContain(
      "React demo",
    );
    expect(
      await (await handler(new Request("https://example.test/react-demo/realtime.html"))).text(),
    ).toContain("Realtime demo");
    expect(
      (await handler(new Request("https://example.test/react-demo/assets/missing.js"))).status,
    ).toBe(404);
  });

  test("proxies only demo API routes and keeps credentials server-side", async () => {
    const root = await fixture();
    const seen: { input?: string; init?: RequestInit; body?: string } = {};
    const serverApiValue = ["server", "api", "value"].join("-");
    const serverAccessValue = ["server", "access", "value"].join("-");
    const credentialHeaders = new Headers();
    credentialHeaders.set("authorization", ["Bearer", serverApiValue].join(" "));
    credentialHeaders.set("x-opengeni-access-key", serverAccessValue);
    const handler = createWebHandler(root, {
      demoApiProxy: {
        targetBaseUrl: "http://api.internal:8000",
        credentialHeaders,
        fetch: async (input, init) => {
          seen.input = String(input);
          seen.init = init;
          seen.body = init?.body ? await new Response(init.body).text() : "";
          return Response.json({ ok: true }, { status: 201 });
        },
      },
    });
    const browserHeaders = new Headers({
      "content-type": "application/json",
      connection: "keep-alive, x-browser-hop",
      forwarded: "for=spoofed;host=evil.example",
      origin: "https://example.test",
      "x-browser-hop": "browser-hop-value-that-must-not-be-forwarded",
      "x-forwarded-port": "4444",
      "x-opengeni-access-key": "browser-access-value-that-must-be-replaced",
      "x-real-ip": "203.0.113.10",
    });
    browserHeaders.set("authorization", "browser-value-that-must-be-replaced");
    const response = await handler(
      new Request("https://example.test/demo-api/v1/workspaces/ws/sessions?after=1", {
        method: "POST",
        headers: browserHeaders,
        body: '{"startMode":"realtime"}',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen.input).toBe("http://api.internal:8000/v1/workspaces/ws/sessions?after=1");
    const headers = new Headers(seen.init?.headers);
    expect(headers.get("authorization")).toBe(["Bearer", serverApiValue].join(" "));
    expect(headers.get("x-opengeni-access-key")).toBe(serverAccessValue);
    expect(headers.get("x-browser-hop")).toBeNull();
    expect(headers.get("forwarded")).toBeNull();
    expect(headers.get("x-forwarded-host")).toBe("example.test");
    expect(headers.get("x-forwarded-port")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(seen.init?.redirect).toBe("manual");
    expect(seen.body).toContain("realtime");

    expect(
      (
        await handler(
          new Request("https://example.test/demo-api/admin", {
            headers: { origin: "https://example.test" },
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          new Request("https://example.test/demo-api/v1/workspaces", {
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request("https://example.test/demo-api/v1/%252e%252e/admin", {
            headers: { origin: "https://example.test" },
          }),
        )
      ).status,
    ).toBe(400);
  });

  test("normalizes representation and hop-by-hop headers after upstream decoding", async () => {
    const root = await fixture();
    const seen: { acceptEncoding?: string | null } = {};
    const handler = createWebHandler(root, {
      demoApiProxy: {
        targetBaseUrl: "http://api.internal:8000",
        fetch: async (_input, init) => {
          seen.acceptEncoding = new Headers(init?.headers).get("accept-encoding");
          // This is the shape exposed by Bun when it has already decoded a
          // gzip response body but retained the upstream response headers.
          return new Response('{"error":"Unauthorized"}', {
            status: 401,
            headers: {
              connection: "keep-alive, x-upstream-hop",
              "content-encoding": "gzip",
              "content-length": "999",
              "content-type": "application/json",
              "transfer-encoding": "chunked",
              "x-upstream-hop": "upstream-hop-value-that-must-not-be-forwarded",
            },
          });
        },
      },
    });

    const response = await handler(
      new Request("https://example.test/demo-api/v1/workspaces/ws/sessions", {
        headers: { "accept-encoding": "br, gzip" },
      }),
    );

    expect(seen.acceptEncoding).toBe("identity");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("x-upstream-hop")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });

    const head = await handler(
      new Request("https://example.test/demo-api/v1/workspaces/ws/sessions", {
        method: "HEAD",
      }),
    );
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect(head.headers.get("content-length")).toBe("999");
    expect(head.headers.get("x-upstream-hop")).toBeNull();
    expect(await head.text()).toBe("");
  });

  test("ignores malformed connection options while stripping valid hop-by-hop names", async () => {
    const root = await fixture();
    let upstreamRequestHeaders = new Headers();
    const handler = createWebHandler(root, {
      demoApiProxy: {
        targetBaseUrl: "http://api.internal:8000",
        fetch: async (_input, init) => {
          upstreamRequestHeaders = new Headers(init?.headers);
          return new Response('{"ok":true}', {
            headers: {
              connection: "keep-alive, bad name, x-upstream-hop",
              "content-type": "application/json",
              "x-upstream-hop": "must-not-be-forwarded",
            },
          });
        },
      },
    });

    const response = await handler(
      new Request("https://example.test/demo-api/v1/workspaces", {
        headers: {
          connection: "keep-alive, bad name, x-browser-hop",
          "x-browser-hop": "must-not-be-forwarded",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamRequestHeaders.get("connection")).toBeNull();
    expect(upstreamRequestHeaders.get("x-browser-hop")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("x-upstream-hop")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  test("derives optional authority headers from environment names", () => {
    expect(demoApiProxyFromEnvironment({})).toBeUndefined();
    expect(() =>
      demoApiProxyFromEnvironment({ OPENGENI_DEMO_API_URL: "file:///tmp/not-an-api" }),
    ).toThrow("must use http or https");
    const apiValue = ["api", "value"].join("-");
    const accessValue = ["access", "value"].join("-");
    const env = {
      OPENGENI_DEMO_API_URL: "https://api.example.test",
      [["OPENGENI", "DEMO", "API", "KEY"].join("_")]: apiValue,
      [["OPENGENI", "DEMO", "ACCESS", "KEY"].join("_")]: accessValue,
    };
    const options = demoApiProxyFromEnvironment(env);
    expect(options?.targetBaseUrl).toBe("https://api.example.test");
    const headers = new Headers(options?.credentialHeaders);
    expect(headers.get("authorization")).toBe(["Bearer", apiValue].join(" "));
    expect(headers.get("x-opengeni-access-key")).toBe(accessValue);
  });

  test("reads optional demo authority from a dedicated mounted secret", () => {
    const paths: string[] = [];
    const options = demoApiProxyFromEnvironment(
      {
        OPENGENI_DEMO_API_URL: "https://api.example.test",
        OPENGENI_DEMO_CREDENTIALS_DIR: "/var/run/secrets/opengeni-demo",
      },
      (path) => {
        paths.push(path);
        if (path.endsWith("/api-key")) return "mounted-api-value";
        if (path.endsWith("/access-key")) return "mounted-access-value";
        return undefined;
      },
    );

    expect(paths).toEqual([
      "/var/run/secrets/opengeni-demo/api-key",
      "/var/run/secrets/opengeni-demo/access-key",
    ]);
    const headers = new Headers(options?.credentialHeaders);
    expect(headers.get("authorization")).toBe("Bearer mounted-api-value");
    expect(headers.get("x-opengeni-access-key")).toBe("mounted-access-value");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-web-handler-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await Bun.write(join(root, "index.html"), "<!doctype html><title>OpenGeni</title>");
  await Bun.write(join(root, "assets/app-abc123.js"), "export const ready = true;\n");
  await Bun.write(
    join(root, "assets/app-abc123.js.gz"),
    Bun.gzipSync("export const ready = true;\n"),
  );
  return root;
}
