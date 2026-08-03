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
  });

  test("proxies only demo API routes and keeps credentials server-side", async () => {
    const root = await fixture();
    const seen: { input?: string; init?: RequestInit } = {};
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
          return Response.json({ ok: true }, { status: 201 });
        },
      },
    });
    const browserHeaders = new Headers({
      "content-type": "application/json",
      origin: "https://example.test",
      "x-opengeni-access-key": "browser-access-value-that-must-be-replaced",
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
    expect(headers.get("x-forwarded-host")).toBe("example.test");
    expect(new TextDecoder().decode(seen.init?.body as Uint8Array)).toContain("realtime");

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
  });

  test("derives optional authority headers from environment names", () => {
    expect(demoApiProxyFromEnvironment({})).toBeUndefined();
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
